// Mutation check: does an accepted test actually detect behaviour changes in the lines it covers?
// Each mutant flips one operator/literal on a covered line of the target, re-runs only that test
// file, and counts it as killed (a test failed) or survived (all passed). Mutants that do not
// compile are discarded. The source file is always restored, also after a crash (see recover()).
import * as fs from "node:fs";
import * as path from "node:path";
import type { Adapter } from "./adapters/types.ts";
import type { State } from "./state.ts";
import { exists, log, readFile, readJson, relPath, writeFile } from "./util.ts";

export interface Mutant {
  line: number;
  /** Stable id `<line>.<n>` (n-th mutant generated for that line), for `--equivalent 12.2`. */
  id?: string;
  /** Last line replaced (multi-line statement deletion); defaults to `line`. */
  endLine?: number;
  op: string;
  original: string;
  mutated: string;
}

export interface MutantResult extends Mutant {
  outcome: "killed" | "killed-crash" | "survived" | "equivalent" | "stillborn" | "error";
}

export interface MutationReport {
  testFile: string;
  target: string;
  killed: number;
  /** Of `killed`: detected only because the code crashed, not by an assertion. */
  crashes: number;
  survived: number;
  stillborn: number;
  score: number;
  results: MutantResult[];
  feedback: string;
  /** Mutants that could be generated for the covered lines, minus excluded ones (a run samples up to --max). */
  candidates: number;
  /** Mutants not run because they were marked equivalent. */
  excluded?: number;
  /** Candidates evaluated in this or earlier runs. */
  triedTotal?: number;
  /** Latest outcome of every mutant evaluated so far (re-runs re-check survivors first). */
  history?: MutantResult[];
}

export function mutationGate(r: MutationReport, minimum = 80): { status: "PASSED" | "FAILED" | "NOT_APPLICABLE"; minimum: number; reason?: string } {
  if (r.candidates === 0 || (r.results.length > 0 && r.results.every((x) => x.outcome === "equivalent"))) return { status: "NOT_APPLICABLE", minimum };
  const errors = r.results.filter((x) => x.outcome === "error");
  if (errors.length) {
    return { status: "FAILED", minimum, reason: `${errors.length} mutant run(s) produced no test results (${errors.map((e) => `line ${e.line}`).join(", ")}): the test run crashed or exited early; see the mutant logs. Fix the cause (e.g. a test awaiting a promise that never settles) and re-run` };
  }
  if (r.killed + r.survived === 0) return { status: "FAILED", minimum, reason: "no mutant was evaluated (all were discarded or excluded)" };
  if (r.score * 100 < minimum) return { status: "FAILED", minimum, reason: `score ${(r.score * 100).toFixed(0)}% is below ${minimum}%` };
  return { status: "PASSED", minimum };
}

// [name, pattern, replacement]. Patterns require surrounding spaces where a token is ambiguous
// (generics `<T>`, arrows `->`/`=>`, unary minus, `++`).
const OPERATORS: [string, RegExp, string][] = [
  ["== -> !=", / == /, " != "],
  ["!= -> ==", / != /, " == "],
  ["=== -> !==", / === /, " !== "],
  ["!== -> ===", / !== /, " === "],
  ["<= -> <", / <= /, " < "],
  [">= -> >", / >= /, " > "],
  ["< -> <=", / < /, " <= "],
  ["> -> >=", / > /, " >= "],
  ["&& -> ||", / && /, " || "],
  ["|| -> &&", / \|\| /, " && "],
  ["+ -> -", / \+ /, " - "],
  ["- -> +", / - /, " + "],
  ["* -> /", / \* /, " / "],
  ["true -> false", /\btrue\b/, "false"],
  ["false -> true", /\bfalse\b/, "true"],
  ["0 -> 1", /(?<![\w.])0(?![\w.x])/, "1"],
  ["1 -> 0", /(?<![\w.])1(?![\w.])/, "0"],
];

/** Replace string/char literals with same-length placeholders so operators inside them are ignored. */
function maskStrings(line: string): string {
  return line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, (s) => "\u0000".repeat(s.length));
}

const KEYWORD_START = /^(return|val|var|let|const|if|else|for|while|do|throw|try|catch|finally|case|default|guard|defer|import|package|func|fun|class|struct|enum|interface|object|switch|when|break|continue|super|this\s*\(|init|override|private|public|internal|protected|static|export|function|async|await|yield|@)/;

/** A standalone call statement, balanced on one line: `foo.bar(x)`, `save()`, `list.add(y);`. */
function isCallStatement(t: string): boolean {
  if (KEYWORD_START.test(t) || /[=:{}]$/.test(t) || !/\)\s*;?$/.test(t) || /^[)\]]/.test(t)) return false;
  if (!/^[A-Za-z_$][\w$]*(\??\.[A-Za-z_$][\w$]*)*(<[^>]*>)?\(/.test(t)) return false;
  let depth = 0;
  for (const c of maskStrings(t)) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (depth < 0) return false;
  }
  return depth === 0 && !/[^=!<>]=[^=]/.test(maskStrings(t));
}

/** Logging statements: mutating them (or the string concatenation inside) changes nothing a test should check. */
const LOG_CALL = /^(console|hilog|Log|Logger|logger|log|Timber|print|println|debugPrint|NSLog|os_log)\b\s*[.(]/;

export function mutantsFor(text: string, lines: number[]): Mutant[] {
  const out = mutantsForLines(text, lines);
  const seen = new Map<number, number>();
  for (const m of out) {
    const n = (seen.get(m.line) ?? 0) + 1;
    seen.set(m.line, n);
    m.id = `${m.line}.${n}`;
  }
  return out;
}

function mutantsForLines(text: string, lines: number[]): Mutant[] {
  const src = text.split("\n");
  const out: Mutant[] = [];
  for (const ln of lines) {
    const original = src[ln - 1];
    if (original === undefined) continue;
    const t = original.trim();
    if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("import ") || t.startsWith("@") || /^(case|default)\b.*:$/.test(t)) continue;
    if (LOG_CALL.test(t)) continue;
    const masked = maskStrings(original.replace(/\/\/.*$/, (c) => " ".repeat(c.length)));
    for (const [op, re, rep] of OPERATORS) {
      const m = re.exec(masked);
      if (!m) continue;
      const mutated = original.slice(0, m.index) + rep + original.slice(m.index + m[0].length);
      out.push({ line: ln, op, original, mutated });
    }
    // Negate a simple condition: if (flag) / if (a.b) / if (list.isEmpty()) -> if (!(...)).
    const cond = /\bif\s*\(\s*(!?[A-Za-z_$][\w$.]*(?:\(\))?)\s*\)/.exec(masked);
    if (cond) {
      const inner = original.slice(cond.index, cond.index + cond[0].length).replace(/\(\s*(!?[A-Za-z_$][\w$.]*(?:\(\))?)\s*\)/, (_, x: string) => (x.startsWith("!") ? `(${x.slice(1)})` : `(!${x})`));
      out.push({ line: ln, op: "negate condition", original, mutated: original.slice(0, cond.index) + inner + original.slice(cond.index + cond[0].length) });
    }
    // Statement deletion: does any test notice the call never happens?
    if (isCallStatement(t)) {
      out.push({ line: ln, op: "delete statement", original, mutated: original.replace(t, "/* unitgen: statement deleted */") });
    } else if (/^[A-Za-z_$][\w$]*(\??\.[A-Za-z_$][\w$]*)*\($/.test(t) && !KEYWORD_START.test(t)) {
      // Multi-line call: `dao.insert(` ... `)` — delete the whole statement if it closes cleanly.
      let depth = 0;
      let end = -1;
      for (let j = ln - 1; j < src.length && j < ln + 40; j++) {
        for (const c of maskStrings(src[j])) {
          if (c === "(") depth++;
          if (c === ")") depth--;
        }
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
      if (end > ln && /\)\s*;?\s*$/.test(src[end - 1])) {
        const indent = original.slice(0, original.length - original.trimStart().length);
        out.push({ line: ln, endLine: end, op: "delete statement", original: src.slice(ln - 1, end).join("\n"), mutated: `${indent}/* unitgen: statement deleted */` });
      }
    }
  }
  return out;
}

const PRIORITY = (op: string): number =>
  op === "delete statement" ? 0 : op === "negate condition" ? 1 : /[<>=!]=?|&&|\|\|/.test(op.split(" ")[0]) ? 2 : /^[+\-*]/.test(op) ? 3 : 4;

/** Spread picks over distinct lines first (evenly spaced), then second operators per line, deterministically. */
export function pickMutants(all: Mutant[], max: number): Mutant[] {
  const byLine = new Map<number, Mutant[]>();
  for (const m of all) {
    if (!byLine.has(m.line)) byLine.set(m.line, []);
    byLine.get(m.line)!.push(m);
  }
  for (const list of byLine.values()) list.sort((a, b) => PRIORITY(a.op) - PRIORITY(b.op));
  const lines = [...byLine.keys()].sort((a, b) => a - b);
  const picked: Mutant[] = [];
  for (let round = 0; picked.length < max; round++) {
    const avail = lines.filter((l) => byLine.get(l)!.length > round);
    if (!avail.length) break;
    const need = Math.min(max - picked.length, avail.length);
    for (let k = 0; k < need; k++) picked.push(byLine.get(avail[Math.floor((k * avail.length) / need)])![round]);
  }
  return picked;
}

function journal(state: State): string {
  return state.file("mutation-in-progress.json");
}

/** Restore a target left mutated by an interrupted run. Safe to call on every start. */
export function recover(state: State): void {
  const j = readJson<{ target: string; backup: string } | null>(journal(state), null);
  if (!j) return;
  if (exists(j.backup)) {
    fs.copyFileSync(j.backup, j.target);
    fs.unlinkSync(j.backup);
    log(`restored ${j.target} after an interrupted mutation run`);
  }
  fs.unlinkSync(journal(state));
}

export async function mutate(adapter: Adapter, state: State, testFile: string, target: string, max = 15): Promise<MutationReport> {
  recover(state);
  const absTest = path.resolve(testFile);
  const absTarget = path.resolve(target);
  const relTest = relPath(absTest, adapter.root);
  const m = adapter.moduleFor(absTest) ?? adapter.moduleFor(absTarget);
  if (!m) throw new Error(`cannot determine module for ${testFile}`);
  const cov = state.perTestCoverage[relTest];
  if (!cov) throw new Error(`${relTest} has no recorded coverage: run \`unitgen verify\` until it is ACCEPTED first`);
  const lines = Object.entries(cov[absTarget] ?? {}).filter(([, h]) => h > 0).map(([l]) => Number(l));
  if (!lines.length) throw new Error(`${relTest} covers no line of ${relPath(absTarget, adapter.root)}`);
  const original = readFile(absTarget);
  const generated = mutantsFor(original, lines);
  // Mutants the user judged equivalent (`--equivalent 12` = whole line, `12.2` = one mutant) are not run.
  const eqSpec = new Set((state.data.equivalent ?? {})[relTest]?.map(String) ?? []);
  const isEq = (mu: Mutant) => eqSpec.has(String(mu.line)) || (mu.id !== undefined && eqSpec.has(mu.id));
  const excluded = generated.filter(isEq);
  const all = generated.filter((mu) => !isEq(mu));
  // Re-runs: re-check previous survivors first (did strengthening work?), then mutants never tried,
  // and only then ones already killed — so repeated runs walk through the whole candidate set.
  const prevFile = state.file("mutation", `${path.basename(absTest)}.json`);
  const prev = readJson<{ results?: MutantResult[] } | null>(prevFile, null)?.results ?? [];
  const key = (m: Mutant) => `${m.line}|${m.op}|${m.mutated}`;
  const prevOutcome = new Map(prev.map((r) => [key(r), r.outcome]));
  const rank = (m: Mutant) => { const o = prevOutcome.get(key(m)); return o === "survived" ? 0 : o === undefined ? 1 : 2; };
  const ordered = [...all].sort((a, b) => rank(a) - rank(b));
  const fresh = ordered.filter((m) => rank(m) < 2);
  // Pick more than needed: mutants that do not compile are replaced by the next candidates.
  const candidates = [...pickMutants(fresh, Math.min(fresh.length, max * 2)), ...pickMutants(ordered.filter((m) => rank(m) === 2), max * 2)];
  if (!candidates.length && !excluded.length) {
    const acc0 = state.data.accepted.find((a) => a.testFile === relTest);
    if (acc0) {
      acc0.mutation = { killed: 0, survived: 0, stillborn: 0, score: 1, first: acc0.mutation?.first, none: true };
      state.save();
    }
    return { testFile: relTest, target: relPath(absTarget, adapter.root), killed: 0, crashes: 0, survived: 0, stillborn: 0, score: 1, results: [], candidates: 0,
      feedback: `nothing to mutate: the ${lines.length} covered lines contain no operators, simple conditions or call statements unitgen can change` };
  }
  const backup = state.file("mutation.backup");
  fs.copyFileSync(absTarget, backup);
  writeFile(journal(state), JSON.stringify({ target: absTarget, backup }));
  const results: MutantResult[] = [];
  try {
    const clean = await adapter.runTests({ testFiles: [absTest], modules: [m], coverage: false, label: "mutant-0-clean" });
    if (!clean.ok || clean.tests.some((t) => t.status === "failed")) {
      throw new Error(`${relTest} does not pass on the unmodified code; fix it (unitgen verify) before mutating`);
    }
    // Mutants can loop forever (e.g. a binary search bound): cap each run and count a timeout as killed.
    const timeoutSec = Math.max(60, Math.ceil(clean.seconds * 4) + 30);
    if (!candidates.length) throw new Error("every remaining mutant is marked equivalent; nothing to run");
    for (const [i, mu] of candidates.entries()) {
      if (results.filter((r) => r.outcome !== "stillborn").length >= max) break;
      const lines2 = original.split("\n");
      lines2.splice(mu.line - 1, (mu.endLine ?? mu.line) - mu.line + 1, mu.mutated);
      fs.writeFileSync(absTarget, lines2.join("\n"));
      const r = await adapter.runTests({ testFiles: [absTest], modules: [m], coverage: false, label: `mutant-${i + 1}`, timeoutSec });
      let outcome: MutantResult["outcome"];
      if (r.infraError === "timeout" || /TIMEOUT after/.test(r.excerpt)) outcome = "killed";
      else if (r.infraError) outcome = "error";
      else if (!r.compiled) outcome = "stillborn";
      else if (!r.ok || r.tests.some((t) => t.status === "failed")) {
        // Killed by a crash (ReferenceError/TypeError) rather than an assertion: still a detected change, but flag it.
        const msgs = r.tests.filter((t) => t.status === "failed").map((t) => t.message ?? "").join("\n");
        outcome = msgs && !/assert|expect|Expectation|AssertionError|expected/i.test(msgs) ? "killed-crash" : "killed";
      }
      else outcome = r.tests.length ? "survived" : "error";
      results.push({ ...mu, outcome });
      const shown = outcome === "stillborn" ? "did not compile (discarded)" : outcome;
      log(`  mutant ${i + 1} (budget ${max}, ${all.length} candidates) [${mu.id}] line ${mu.line} (${mu.op}): ${shown}`);
    }
  } finally {
    fs.writeFileSync(absTarget, original);
    fs.unlinkSync(backup);
    fs.unlinkSync(journal(state));
  }
  const killed = results.filter((r) => r.outcome === "killed" || r.outcome === "killed-crash").length;
  const crashes = results.filter((r) => r.outcome === "killed-crash").length;
  const survived = results.filter((r) => r.outcome === "survived").length;
  const stillborn = results.filter((r) => r.outcome === "stillborn").length;
  const score = killed + survived ? killed / (killed + survived) : 0;
  const surv = results.filter((r) => r.outcome === "survived");
  const feedback = surv.length
    ? `These changes to ${relPath(absTarget, adapter.root)} were NOT detected by any test. Add assertions that would fail for each:\n` +
      surv.map((s) => `- [${s.id}] line ${s.line} (${s.op}):\n    ${s.original.trim()}\n  → ${s.mutated.trim()}`).join("\n") +
      `\nIf a survivor cannot change observable behaviour (equivalent mutant), exclude just that mutant by its id, e.g. unitgen mutate ${relTest} --equivalent ${surv[0].id} (a bare line number excludes every mutant on the line), and say why with unitgen note`
    : "";
  // Across runs: which candidates were ever evaluated (re-runs walk through the rest).
  const tried = new Set([...prev.filter((r) => r.outcome !== "stillborn").map(key), ...results.filter((r) => r.outcome !== "stillborn").map(key)]);
  const triedTotal = all.filter((mu) => tried.has(key(mu))).length;
  const report: MutationReport = { testFile: relTest, target: relPath(absTarget, adapter.root), killed, crashes, survived, stillborn, score, results, feedback, candidates: all.length,
    excluded: excluded.length, triedTotal, history: [...prev.filter((r) => !results.some((x) => key(x) === key(r))), ...results] };
  const acc = state.data.accepted.find((a) => a.testFile === relTest);
  if (acc) {
    const first = acc.mutation?.first ?? Math.round(score * 100) / 100;
    acc.mutation = { killed, survived, stillborn, score: Math.round(score * 100) / 100, first, crashes, equivalent: excluded.length };
    state.save();
  }
  writeFile(state.file("mutation", `${path.basename(absTest)}.json`), JSON.stringify({ ...report, results: report.history }, null, 2));
  return report;
}

export function formatMutation(r: MutationReport): string {
  if (!r.candidates) return `mutation: NOT_APPLICABLE — ${r.feedback}`;
  const sampled = r.results.filter((x) => x.outcome !== "stillborn").length;
  const tried = r.triedTotal ?? sampled;
  const note = (r.candidates > sampled
    ? tried >= r.candidates ? `\nran ${sampled} of ${r.candidates} mutants this time; all ${r.candidates} have been evaluated across runs`
      : `\nran ${sampled} of ${r.candidates} possible mutants (${tried} evaluated across runs); re-run to try the next ones, or use --max ${r.candidates} for all`
    : "") + (r.excluded ? `\n${r.excluded} mutant(s) excluded as equivalent (not run)` : "");
  const head0 = `mutation score: ${(r.score * 100).toFixed(0)}%  (killed ${r.killed}${r.crashes ? `, of which ${r.crashes} only by a crash, not an assertion` : ""}, survived ${r.survived}, did not compile ${r.stillborn})  ${r.testFile} -> ${r.target}`;
  const head = head0 + note;
  return r.feedback ? `${head}\n\n${r.feedback}` : head;
}
