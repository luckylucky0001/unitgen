// Mutation check: does an accepted test actually detect behaviour changes in the lines it covers?
// Each mutant flips one operator/literal on a covered line of the target, re-runs only that test
// file, and counts it as killed (a test failed) or survived (all passed). Mutants that do not
// compile are discarded. The source file is always restored, also after a crash (see recover()).
import * as fs from "node:fs";
import * as path from "node:path";
import type { Adapter } from "./adapters/types.ts";
import type { State } from "./state.ts";
import { exists, log, readFile, readJson, relPath, writeFile } from "./util.ts";
import { fileHash } from "./verify.ts";

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
  /** Content hash of the test file the outcome was measured with. */
  testHash?: string;
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
  /** Mutant runs of this invocation that produced no test results. */
  errors?: number;
}

export function mutationGate(r: MutationReport, minimum = 80): { status: "PASSED" | "FAILED" | "NOT_APPLICABLE"; minimum: number; reason?: string } {
  if (r.candidates === 0 || (r.results.length > 0 && r.results.every((x) => x.outcome === "equivalent"))) return { status: "NOT_APPLICABLE", minimum };
  const errors = r.results.filter((x) => x.outcome === "error"); // this run only
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
  // Not `$0` (Swift closure argument) and not a literal in a type union (`flag: 0 | 1`).
  ["0 -> 1", /(?<![\w.$])(?<!\|\s*)0(?![\w.x])(?!\s*\|)/, "1"],
  ["1 -> 0", /(?<![\w.$])(?<!\|\s*)1(?![\w.])(?!\s*\|)/, "0"],
];

/** Replace string/char literals with same-length placeholders so operators inside them are ignored. */
function maskStrings(line: string): string {
  return line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, (s) => "\u0000".repeat(s.length));
}

const KEYWORD_START = /^(return|val|var|let|const|if|else|for|while|do|throw|try|catch|finally|case|default|guard|defer|import|package|func|fun|class|struct|enum|interface|object|switch|when|break|continue|super|this\s*\(|init|override|private|public|internal|protected|static|export|function|async|await|yield|@)/;

/** Parentheses and braces balance (strings masked) and never go negative. */
function balanced(t: string): boolean {
  let p = 0, b = 0;
  for (const c of maskStrings(t)) {
    if (c === "(") p++;
    if (c === ")") p--;
    if (c === "{") b++;
    if (c === "}") b--;
    if (p < 0 || b < 0) return false;
  }
  return p === 0 && b === 0;
}

const CALL_START = /^(try\s+|await\s+|try\s+await\s+)?[A-Za-z_$][\w$]*(\??\.[A-Za-z_$][\w$]*)*(<[^>]*>)?\s*[({]/;

/**
 * A standalone call statement, balanced on one line: `foo.bar(x)`, `save()`, `list.add(y);`, and
 * trailing-closure calls `items.forEach { $0.reset() }` / `builder.add(x) { ... }`.
 */
function isCallStatement(t: string): boolean {
  if (KEYWORD_START.test(t.replace(/^(try|await)\s+/, "")) || /^[)\]}]/.test(t) || !CALL_START.test(t)) return false;
  if (!/(\)|\})\s*;?$/.test(t)) return false;
  // Before any closure body: no assignment (`a = f()`, `let x = ...`).
  const head = maskStrings(t).split("{")[0];
  return balanced(t) && !/[^=!<>]=[^=]/.test(head);
}

/** A member assignment statement on one line: `this.total = a + b;`, `self.state = .idle`. */
function isMemberAssignment(t: string): boolean {
  const m = maskStrings(t);
  return /^(this|self)\.[A-Za-z_$][\w$.]*\s*=[^=]/.test(m) && balanced(t) && !/[{]\s*$/.test(m);
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
    } else {
      // Swift/Kotlin-style without parentheses: `if flag {`, `guard isReady else {`, `while hasMore {`.
      const bare = /\b(if|guard|while)\s+(!?)([A-Za-z_$][\w$.]*(?:\(\))?)\s*(\{|else\b)/.exec(masked);
      if (bare && !/^(let|var|case)$/.test(bare[3])) {
        const at = bare.index + bare[0].indexOf(bare[2] + bare[3]);
        const mutated = original.slice(0, at) + (bare[2] ? original.slice(at + 1) : `!${original.slice(at)}`);
        out.push({ line: ln, op: "negate condition", original, mutated });
      }
    }
    // Integer constants other than 0/1 (limits, factors, sizes, error codes): n -> n + 1. In a
    // `case X: return 2001` line only the part after the label (the label itself is a pattern).
    const caseLabel = /^\s*case\b[^:]*:/.exec(masked);
    const from = caseLabel ? caseLabel[0].length : 0;
    const numRe = /(?<![\w.$#])(?<!\|\s*)([2-9]|[1-9]\d{1,5})(?![\w.])(?!\s*\|)/g;
    numRe.lastIndex = from;
    const num = /^\s*(import\b|#)/.test(original) ? null : numRe.exec(masked);
    if (num) {
      out.push({ line: ln, op: `${num[1]} -> ${Number(num[1]) + 1}`, original, mutated: original.slice(0, num.index) + String(Number(num[1]) + 1) + original.slice(num.index + num[1].length) });
    }
    // Returned string literals (messages, keys, formats): does a test look at the text at all?
    const ret = /\breturn\s+("(?:[^"\\]|\\.)+"|'(?:[^'\\]|\\.)+')/.exec(original);
    if (ret && !/\\\(|\$\{/.test(ret[1])) {
      const at = ret.index + ret[0].length - ret[1].length;
      const q = ret[1][0];
      out.push({ line: ln, op: "string -> empty", original, mutated: original.slice(0, at) + q + q + original.slice(at + ret[1].length) });
    }
    // Statement deletion: does any test notice the call (or the stored value) never happens?
    if (isCallStatement(t)) {
      out.push({ line: ln, op: "delete statement", original, mutated: original.replace(t, "/* unitgen: statement deleted */") });
    } else if (isMemberAssignment(t)) {
      out.push({ line: ln, op: "delete assignment", original, mutated: original.replace(t, "/* unitgen: assignment deleted */") });
    } else if (!KEYWORD_START.test(t.replace(/^(try|await)\s+/, "")) && (/^[A-Za-z_$][\w$]*(\??\.[A-Za-z_$][\w$]*)*\($/.test(t) || (CALL_START.test(t) && /\{\s*(\w+(\s*,\s*\w+)*\s+in)?\s*$/.test(t) && !/[^=!<>]=[^=]/.test(maskStrings(t).split("{")[0])))) {
      // Multi-line call: `dao.insert(` ... `)`, or a trailing closure `builder.add(x) {` ... `}`:
      // delete the whole statement if it closes cleanly.
      let p = 0, b = 0;
      let end = -1;
      for (let j = ln - 1; j < src.length && j < ln + 60; j++) {
        for (const c of maskStrings(src[j].replace(/\/\/.*$/, ""))) {
          if (c === "(") p++;
          if (c === ")") p--;
          if (c === "{") b++;
          if (c === "}") b--;
        }
        if (p === 0 && b === 0) {
          end = j + 1;
          break;
        }
      }
      if (end > ln && /(\)|\})\s*;?\s*$/.test(src[end - 1])) {
        const indent = original.slice(0, original.length - original.trimStart().length);
        out.push({ line: ln, endLine: end, op: "delete statement", original: src.slice(ln - 1, end).join("\n"), mutated: `${indent}/* unitgen: statement deleted */` });
      }
    }
  }
  return out;
}

const PRIORITY = (op: string): number =>
  op === "delete statement" || op === "delete assignment" ? 0 : op === "negate condition" ? 1 : /[<>=!]=?|&&|\|\|/.test(op.split(" ")[0]) ? 2 : /^[+\-*]/.test(op) ? 3 : /^\d+ -> \d+$/.test(op) && !/^[01] ->/.test(op) ? 5 : 4;

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
  const key = (mu: Mutant) => `${mu.line}|${mu.op}|${mu.mutated}`;
  // Mutants the user judged equivalent are not run: `12` = every mutant on line 12, `12.2` = one
  // mutant. Ids are resolved to a stable key (line, operator, mutated text) the first time they are
  // used, so a later unitgen version that numbers mutants differently cannot exclude the wrong one.
  const eqAll = (state.data.equivalent ??= {});
  const specs = (eqAll[relTest] ?? []).map(String).map((x) => {
    if (!/^\d+\.\d+$/.test(x)) return x;
    const mu = generated.find((g) => g.id === x);
    if (!mu) { log(`warning: --equivalent ${x}: no such mutant on the covered lines (ignored)`); return x; }
    return `key:${key(mu)}`;
  });
  eqAll[relTest] = [...new Set(specs)];
  state.save();
  const isEq = (mu: Mutant) => specs.includes(String(mu.line)) || specs.includes(`key:${key(mu)}`);
  const excluded = generated.filter(isEq);
  const all = generated.filter((mu) => !isEq(mu));
  // Re-runs: re-check previous survivors first (did strengthening work?), then mutants never tried,
  // then mutants whose outcome was measured with an older version of the test file. Outcomes are keyed
  // by line, operator and mutated text (changed code yields new mutants) and count only for the test
  // content they were measured with; a mutant that does not compile stays discarded.
  const testHash = fileHash(absTest);
  const prevFile = state.file("mutation", `${path.basename(absTest)}.json`);
  const prev = readJson<{ results?: MutantResult[] } | null>(prevFile, null)?.results ?? [];
  const prevBy = new Map(prev.map((r) => [key(r), r]));
  const valid = (r: MutantResult | undefined) => !!r && (r.outcome === "stillborn" || r.testHash === testHash);
  const rank = (mu: Mutant) => {
    const r = prevBy.get(key(mu));
    if (!r) return 1;
    if (r.outcome === "survived" || r.outcome === "error") return 0;
    return valid(r) ? 3 : 2;
  };
  const fresh = all.filter((mu) => rank(mu) < 3);
  // Pick more than needed: mutants that do not compile are replaced by the next candidates.
  const candidates = [0, 1, 2].flatMap((k) => pickMutants(fresh.filter((mu) => rank(mu) === k), max * 2));
  if (!all.length && !excluded.length) {
    const acc0 = state.data.accepted.find((a) => a.testFile === relTest);
    if (acc0) {
      acc0.mutation = { killed: 0, survived: 0, stillborn: 0, score: 1, first: acc0.mutation?.first, none: true };
      state.save();
    }
    return { testFile: relTest, target: relPath(absTarget, adapter.root), killed: 0, crashes: 0, survived: 0, stillborn: 0, score: 1, results: [], candidates: 0,
      feedback: `nothing to mutate: the ${lines.length} covered lines contain no operators, constants, simple conditions or statements unitgen can change` };
  }
  const results: MutantResult[] = [];
  if (candidates.length) {
    const backup = state.file("mutation.backup");
    fs.copyFileSync(absTarget, backup);
    writeFile(journal(state), JSON.stringify({ target: absTarget, backup }));
    const base = path.basename(absTest).replace(/\W+/g, "_");
    try {
      const clean = await adapter.runTests({ testFiles: [absTest], modules: [m], coverage: false, label: `mutant-${base}-0-clean` });
      if (!clean.ok || clean.tests.some((t) => t.status === "failed")) {
        throw new Error(`${relTest} does not pass on the unmodified code; fix it (unitgen verify) before mutating`);
      }
      // Mutants can loop forever (e.g. a binary search bound): cap each run and count a timeout as killed.
      // The clean run is a no-op incremental build, faster than a mutant's rebuild: start generous, then
      // follow what completed mutant runs actually took (3x the median + 10 s, never below 20 s).
      const done: number[] = [];
      const timeoutFor = () => {
        if (!done.length) return Math.max(60, Math.ceil(clean.seconds * 4) + 30);
        const median = [...done].sort((x, y) => x - y)[Math.floor(done.length / 2)];
        return Math.max(20, Math.ceil(clean.seconds * 2) + 10, Math.ceil(median * 3) + 10);
      };
      for (const [i, mu] of candidates.entries()) {
        if (results.filter((r) => r.outcome !== "stillborn").length >= max) break;
        const lines2 = original.split("\n");
        lines2.splice(mu.line - 1, (mu.endLine ?? mu.line) - mu.line + 1, mu.mutated);
        fs.writeFileSync(absTarget, lines2.join("\n"));
        const timeoutSec = timeoutFor();
        const r = await adapter.runTests({ testFiles: [absTest], modules: [m], coverage: false, label: `mutant-${base}-${mu.id}`, timeoutSec });
        const timedOut = r.infraError === "timeout" || /TIMEOUT after/.test(r.excerpt);
        if (!timedOut && r.seconds > 0) done.push(r.seconds);
        let outcome: MutantResult["outcome"];
        if (timedOut) outcome = "killed";
        else if (r.infraError) outcome = "error";
        else if (!r.compiled) outcome = "stillborn";
        else if (!r.ok || r.tests.some((t) => t.status === "failed")) {
          // Killed by a crash (ReferenceError/TypeError, index out of range, a process that died) rather than
          // by an assertion: still a detected change, but flag it.
          const asserted = r.tests.some((t) => t.status === "failed" && /assert|expect|Expectation|AssertionError|expected|XCTAssert|#require/i.test(t.message ?? ""));
          outcome = asserted ? "killed" : "killed-crash";
        }
        else outcome = r.tests.length ? "survived" : "error";
        results.push({ ...mu, outcome, testHash });
        const shown = outcome === "stillborn" ? "did not compile (discarded)" : timedOut ? `killed (no result within ${timeoutSec}s: the mutant hangs)` : outcome;
        log(`  mutant ${i + 1} (budget ${max}, ${fresh.length} not yet killed of ${all.length}) [${mu.id}] line ${mu.line} (${mu.op}): ${shown}`);
      }
    } finally {
      fs.writeFileSync(absTarget, original);
      fs.unlinkSync(backup);
      fs.unlinkSync(journal(state));
    }
  }
  // Cumulative over every run: the latest outcome of each current candidate mutant.
  const latest = new Map<string, MutantResult>();
  for (const r of [...prev, ...results]) latest.set(key(r), r);
  const current: MutantResult[] = all.flatMap((mu) => {
    const r = latest.get(key(mu));
    return r && (valid(r) || r.outcome === "survived") ? [{ ...r, id: mu.id }] : [];
  });
  const count = (o: MutantResult["outcome"][]) => current.filter((r) => o.includes(r.outcome)).length;
  const killed = count(["killed", "killed-crash"]), crashes = count(["killed-crash"]), survived = count(["survived"]), stillborn = count(["stillborn"]);
  const score = killed + survived ? killed / (killed + survived) : 0;
  const surv = current.filter((r) => r.outcome === "survived");
  const feedback = surv.length
    ? `These changes to ${relPath(absTarget, adapter.root)} were NOT detected by any test. Add assertions that would fail for each:\n` +
      surv.map((x) => `- [${x.id}] line ${x.line} (${x.op}):\n    ${x.original.trim()}\n  → ${x.mutated.trim()}`).join("\n") +
      `\nIf a survivor cannot change observable behaviour (equivalent mutant), exclude just that mutant by its id, e.g. unitgen mutate ${relTest} --equivalent ${surv[0].id} (a bare line number excludes every mutant on the line), and say why with unitgen note`
    : "";
  const report: MutationReport = { testFile: relTest, target: relPath(absTarget, adapter.root), killed, crashes, survived, stillborn, score, results, feedback, candidates: all.length,
    excluded: excluded.length, triedTotal: current.length, history: [...latest.values()],
    errors: results.filter((r) => r.outcome === "error").length };
  const acc = state.data.accepted.find((a) => a.testFile === relTest);
  if (acc) {
    const first = acc.mutation?.first ?? Math.round(score * 100) / 100;
    acc.mutation = { killed, survived, stillborn, score: Math.round(score * 100) / 100, first, crashes, equivalent: excluded.length, testHash: fileHash(absTest) };
    state.save();
  }
  writeFile(prevFile, JSON.stringify({ ...report, results: report.history }, null, 2));
  return report;
}

export function formatMutation(r: MutationReport): string {
  if (!r.candidates) return `mutation: NOT_APPLICABLE — ${r.feedback || "every mutant is excluded as equivalent"}`;
  const ran = r.results.length;
  const tried = r.triedTotal ?? ran;
  const head = `mutation score: ${(r.score * 100).toFixed(0)}%  (killed ${r.killed}${r.crashes ? `, of which ${r.crashes} only by a crash, not an assertion` : ""}, survived ${r.survived}, did not compile ${r.stillborn})  ${r.testFile} -> ${r.target}`;
  const scope = tried >= r.candidates
    ? `all ${r.candidates} candidate mutants evaluated with the current test file (${ran ? `${ran} run now` : "nothing new to run; result from earlier runs"})`
    : `${tried} of ${r.candidates} candidate mutants evaluated with the current test file (${ran} run now); re-run to evaluate the rest, or use --max ${r.candidates}`;
  const note = `\n${scope}` + (r.excluded ? `\n${r.excluded} mutant(s) excluded as equivalent (not run)` : "");
  return r.feedback ? `${head}${note}\n\n${r.feedback}` : `${head}${note}`;
}
