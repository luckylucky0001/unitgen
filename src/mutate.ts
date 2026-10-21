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
  op: string;
  original: string;
  mutated: string;
}

export interface MutantResult extends Mutant {
  outcome: "killed" | "survived" | "stillborn" | "error";
}

export interface MutationReport {
  testFile: string;
  target: string;
  killed: number;
  survived: number;
  stillborn: number;
  score: number;
  results: MutantResult[];
  feedback: string;
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

export function mutantsFor(text: string, lines: number[]): Mutant[] {
  const src = text.split("\n");
  const out: Mutant[] = [];
  for (const ln of lines) {
    const original = src[ln - 1];
    if (original === undefined) continue;
    const t = original.trim();
    if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("import ") || t.startsWith("@") || /^(case|default)\b.*:$/.test(t)) continue;
    const masked = maskStrings(original.replace(/\/\/.*$/, (c) => " ".repeat(c.length)));
    for (const [op, re, rep] of OPERATORS) {
      const m = re.exec(masked);
      if (!m) continue;
      const mutated = original.slice(0, m.index) + rep + original.slice(m.index + m[0].length);
      out.push({ line: ln, op, original, mutated });
    }
    // Negate a simple condition: if (flag) / if (a.b) -> if (!(...)).
    const cond = /\bif\s*\(\s*(!?[A-Za-z_$][\w$.]*)\s*\)/.exec(masked);
    if (cond) {
      const inner = original.slice(cond.index, cond.index + cond[0].length).replace(/\(\s*(!?[A-Za-z_$][\w$.]*)\s*\)/, (_, x: string) => (x.startsWith("!") ? `(${x.slice(1)})` : `(!${x})`));
      out.push({ line: ln, op: "negate condition", original, mutated: original.slice(0, cond.index) + inner + original.slice(cond.index + cond[0].length) });
    }
    // Statement deletion: does any test notice the call never happens?
    if (isCallStatement(t)) {
      out.push({ line: ln, op: "delete statement", original, mutated: original.replace(t, "/* unitgen: statement deleted */") });
    }
  }
  return out;
}

/** Spread picks over distinct lines first (evenly spaced), then second operators per line, deterministically. */
export function pickMutants(all: Mutant[], max: number): Mutant[] {
  const byLine = new Map<number, Mutant[]>();
  for (const m of all) {
    if (!byLine.has(m.line)) byLine.set(m.line, []);
    byLine.get(m.line)!.push(m);
  }
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

export function mutate(adapter: Adapter, state: State, testFile: string, target: string, max = 10): MutationReport {
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
  const candidates = pickMutants(mutantsFor(original, lines), max);
  if (!candidates.length) {
    throw new Error(`no mutable operators, conditions or call statements on the ${lines.length} lines ${relTest} covers`);
  }
  const backup = state.file("mutation.backup");
  fs.copyFileSync(absTarget, backup);
  writeFile(journal(state), JSON.stringify({ target: absTarget, backup }));
  const results: MutantResult[] = [];
  const clean = adapter.runTests({ testFiles: [absTest], modules: [m], coverage: false, label: "mutant-0-clean" });
  if (!clean.ok || clean.tests.some((t) => t.status === "failed")) {
    throw new Error(`${relTest} does not pass on the unmodified code; fix it (unitgen verify) before mutating`);
  }
  // Mutants can loop forever (e.g. a binary search bound): cap each run and count a timeout as killed.
  const timeoutSec = Math.max(60, Math.ceil(clean.seconds * 4) + 30);
  try {
    for (const [i, mu] of candidates.entries()) {
      const lines2 = original.split("\n");
      lines2[mu.line - 1] = mu.mutated;
      fs.writeFileSync(absTarget, lines2.join("\n"));
      const r = adapter.runTests({ testFiles: [absTest], modules: [m], coverage: false, label: `mutant-${i + 1}`, timeoutSec });
      let outcome: MutantResult["outcome"];
      if (r.infraError === "timeout" || /TIMEOUT after/.test(r.excerpt)) outcome = "killed";
      else if (r.infraError) outcome = "error";
      else if (!r.compiled) outcome = "stillborn";
      else if (!r.ok || r.tests.some((t) => t.status === "failed")) outcome = "killed";
      else outcome = r.tests.length ? "survived" : "error";
      results.push({ ...mu, outcome });
      log(`  mutant ${i + 1}/${candidates.length} line ${mu.line} (${mu.op}): ${outcome}`);
    }
  } finally {
    fs.writeFileSync(absTarget, original);
    fs.unlinkSync(backup);
    fs.unlinkSync(journal(state));
  }
  const killed = results.filter((r) => r.outcome === "killed").length;
  const survived = results.filter((r) => r.outcome === "survived").length;
  const stillborn = results.filter((r) => r.outcome === "stillborn").length;
  const score = killed + survived ? killed / (killed + survived) : 0;
  const surv = results.filter((r) => r.outcome === "survived");
  const feedback = surv.length
    ? `These changes to ${relPath(absTarget, adapter.root)} were NOT detected by any test. Add assertions that would fail for each:\n` +
      surv.map((s) => `- line ${s.line} (${s.op}):\n    ${s.original.trim()}\n  → ${s.mutated.trim()}`).join("\n")
    : "";
  const report: MutationReport = { testFile: relTest, target: relPath(absTarget, adapter.root), killed, survived, stillborn, score, results, feedback };
  const acc = state.data.accepted.find((a) => a.testFile === relTest);
  if (acc) {
    acc.mutation = { killed, survived, stillborn, score: Math.round(score * 100) / 100 };
    state.save();
  }
  writeFile(state.file("mutation", `${path.basename(absTest)}.json`), JSON.stringify(report, null, 2));
  return report;
}

export function formatMutation(r: MutationReport): string {
  const head = `mutation score: ${(r.score * 100).toFixed(0)}%  (killed ${r.killed}, survived ${r.survived}, did not compile ${r.stillborn})  ${r.testFile} -> ${r.target}`;
  return r.feedback ? `${head}\n\n${r.feedback}` : head;
}
