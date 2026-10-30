// The acceptance gate. A generated test file is kept only if it compiles, every test in it passes,
// it passes again on re-runs (flakiness), it contains real assertions, and it covers new lines.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Adapter, TestCase, TestRun } from "./adapters/types.ts";
import { type Coverage, mergeCoverage, newlyCovered, ranges } from "./coverage.ts";
import type { State } from "./state.ts";
import { exists, readFile, relPath } from "./util.ts";

export type Verdict = "accepted" | "compile_error" | "test_failures" | "flaky" | "no_assertions" | "no_gain" | "no_tests" | "infra_error" | "mutation_failures";

export interface VerifyResult {
  verdict: Verdict;
  testFile: string;
  target?: string;
  tests: TestCase[];
  failed: TestCase[];
  gained: Record<string, number[]>;
  gainedLines: number;
  targetGained: number;
  /** Target file coverage after accepting (baseline + all accepted tests). */
  targetCoverage?: { covered: number; executable: number; pct: number };
  /** Lines this version adds over the previously accepted version of the same file. */
  deltaLines?: number;
  suspects: string[];
  feedback: string;
  logFile?: string;
  seconds: number;
}

export interface VerifyOpts {
  target?: string;
  reruns?: number;
  allowNoGain?: boolean;
  /** quarantine = move rejected file into .unitgen/rejected (keeps the build green). */
  onFail?: "keep" | "quarantine";
  attempts?: number;
  record?: boolean;
}

function suiteTests(run: TestRun, adapter: Adapter, testFile: string): TestCase[] {
  const base = path.basename(testFile).replace(/\.\w+$/, "").replace(/\.test$/, "").replace(/\.unitgen$/, "");
  const re = new RegExp(`(^|[.\\s/>])${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([.\\s/>]|$)`);
  const mine = run.tests.filter((t) => t.file === testFile || re.test(t.name));
  if (mine.length) return mine;
  // Swift Testing reports bare function names (no suite): keep the ones declared in this file.
  const text = exists(testFile) ? readFile(testFile) : "";
  const declared = run.tests.filter((t) => {
    const fn = /([A-Za-z_]\w*)\s*\(/.exec(t.name)?.[1] ?? t.name.split(/[.>\s]+/).pop() ?? "";
    return fn && new RegExp(`\\bfunc\\s+${fn}\\b|\\bfun\\s+\`?${fn}\\b|it\\(\\s*['"]${fn}['"]`).test(text);
  });
  return declared.length ? declared : run.tests;
}

/** "// UNITGEN-SUSPECT: ..." plus any directly following comment lines. */
export function collectSuspects(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  lines.forEach((l, i) => {
    const at = l.indexOf("UNITGEN-SUSPECT");
    if (at < 0) return;
    let s = l.slice(at).replace(/^UNITGEN-SUSPECT:?\s*/, "").trim();
    for (let j = i + 1; j < lines.length && /^\s*\/\/(?!.*UNITGEN-SUSPECT)/.test(lines[j]); j++) s += " " + lines[j].trim().replace(/^\/\/\s?/, "");
    out.push(s);
  });
  return [...new Set(out)];
}

export async function verify(adapter: Adapter, state: State, testFile: string, opts: VerifyOpts = {}): Promise<VerifyResult> {
  const abs = path.resolve(testFile);
  const start = Date.now();
  const target = opts.target ? path.resolve(opts.target) : undefined;
  const res = (verdict: Verdict, extra: Partial<VerifyResult>): VerifyResult => {
    const r: VerifyResult = {
      verdict, testFile: abs, target, tests: [], failed: [], gained: {}, gainedLines: 0, targetGained: 0, suspects: [],
      feedback: "", seconds: (Date.now() - start) / 1000, ...extra,
    };
    finish(adapter, state, r, opts);
    return r;
  };
  if (!exists(abs)) throw new Error(`test file not found: ${testFile}`);
  if (target && !exists(target)) throw new Error(`target source not found: ${opts.target}`);
  const text = readFile(abs);
  const m = adapter.moduleFor(abs) ?? (target ? adapter.moduleFor(target) : undefined);
  if (!m) throw new Error(`cannot determine module for ${testFile}`);
  const suspects = collectSuspects(text);

  if (adapter.countAssertions(text) === 0) {
    return res("no_assertions", { suspects, feedback: "The file contains no assertions. Every test must assert on results." });
  }
  adapter.prepareTestFile(abs, m);

  const label = `verify-${path.basename(abs).replace(/\W+/g, "_")}-${Date.now()}`;
  const run = await adapter.runTests({ testFiles: [abs], modules: [m], coverage: true, label });
  if (run.infraError) {
    return res("infra_error", { feedback: `Environment problem: ${run.infraError}\n${run.excerpt}`, logFile: run.logFile, suspects });
  }
  if (!run.compiled && run.compileErrorOutsideTests) {
    return res("infra_error", { feedback: `Environment problem: ${run.compileErrorOutsideTests} (not caused by the test file)\n${run.excerpt}`, logFile: run.logFile, suspects });
  }
  if (!run.compiled) {
    return res("compile_error", { feedback: `Compilation failed:\n${run.excerpt}`, logFile: run.logFile, suspects });
  }
  const tests = suiteTests(run, adapter, abs);
  if (!tests.length) {
    return res("no_tests", { feedback: `No tests from this file were executed.\n${run.excerpt}`, logFile: run.logFile, suspects });
  }
  const failed = tests.filter((t) => t.status === "failed");
  if (failed.length || !run.ok) {
    const fb = failed.length
      ? failed.map((t) => `FAILED ${t.name}\n${t.message ?? ""}`).join("\n\n")
      : run.excerpt;
    // Environment notes (stubbed platform APIs, blanked UI components) explain many failures.
    const notes = run.excerpt.split("\n").filter((l) => l.startsWith("Note:"));
    const stubNote = notes.length ? `\n\nBefore treating this as a bug, check whether the failing values come from stubbed code:\n${notes.join("\n")}\nA value produced by a stub is meaningless: do not assert on it and do not mark it UNITGEN-SUSPECT; test another path instead.` : "";
    return res("test_failures", {
      tests, failed, logFile: run.logFile, suspects,
      feedback: `${failed.length || "Some"} test(s) failed. If the expectation was wrong, fix the expectation by re-reading the code; if the code is wrong, assert current behaviour and mark it with // UNITGEN-SUSPECT:.\n\n${fb}${stubNote}`,
    });
  }
  // Flakiness: re-run without coverage.
  for (let i = 0; i < (opts.reruns ?? 1); i++) {
    const again = await adapter.runTests({ testFiles: [abs], modules: [m], coverage: false, label: `${label}-rerun${i + 1}` });
    const bad = suiteTests(again, adapter, abs).filter((t) => t.status === "failed");
    if (!again.ok || bad.length) {
      return res("flaky", { tests, failed: bad, logFile: again.logFile, suspects, feedback: `Tests passed once, then failed on re-run ${i + 1} (non-deterministic):\n${bad.map((t) => `${t.name}: ${t.message ?? ""}`).join("\n") || again.excerpt}` });
    }
  }
  const cand: Coverage = run.coverage ?? {};
  const relTest = relPath(abs, adapter.root);
  const known = state.knownCoverage(relTest);
  const prev = state.perTestCoverage[relTest];
  // Gains of the generated file itself: don't count lines our previously accepted tests already hit.
  const gained = newlyCovered(known, cand);
  const gainedLines = Object.values(gained).reduce((a, b) => a + b.length, 0);
  const targetGained = target ? (gained[target]?.length ?? 0) : gainedLines;
  const deltaLines = prev ? Object.values(newlyCovered(mergeCoverage(known, prev), cand)).reduce((a, b) => a + b.length, 0) : undefined;
  const mismatch = (run.coverageWarnings ?? []).filter(Boolean);
  if (gainedLines === 0 && mismatch.length) {
    return res("infra_error", { tests, logFile: run.logFile, suspects, feedback: `Tests pass, but the coverage tool discarded data for: ${mismatch.slice(0, 5).join(", ")} (class files do not match the executed bytecode). This is a unitgen/build-setup problem, not your test.` });
  }
  // Re-verifying an already accepted file (e.g. after adding tests) keeps it even when newer files
  // now cover the same lines; NO_GAIN only gates files that never contributed.
  if (gainedLines === 0 && !opts.allowNoGain && !prev) {
    return res("no_gain", { tests, logFile: run.logFile, suspects, feedback: "All tests pass but they cover no line that was not already covered. Target the lines marked \"!\" in the brief." });
  }
  let targetCoverage;
  if (target) {
    const after = mergeCoverage(known, cand)[target] ?? {};
    const ex = Object.keys(after).length;
    const cv = Object.values(after).filter((h) => h > 0).length;
    targetCoverage = { covered: cv, executable: ex, pct: ex ? (100 * cv) / ex : 0 };
  }
  const r = res("accepted", { tests, gained, gainedLines, targetGained, deltaLines, targetCoverage, logFile: run.logFile, suspects });
  if (opts.record !== false) state.setTestCoverage(relTest, cand);
  return r;
}

function finish(adapter: Adapter, state: State, r: VerifyResult, opts: VerifyOpts): void {
  if (opts.record === false) return;
  const relTest = relPath(r.testFile, adapter.root);
  // Attempts = verify runs until first acceptance; strengthening an accepted file doesn't count.
  const alreadyAccepted = state.data.accepted.some((a) => a.testFile === relTest);
  const attempts = opts.attempts ?? (alreadyAccepted ? state.data.attempts?.[relTest] ?? 1 : state.bumpAttempts(relTest));
  state.data.accepted = state.data.accepted.filter((a) => a.testFile !== relTest);
  if (r.verdict === "accepted") {
    state.data.accepted.push({
      testFile: relTest, target: r.target ? relPath(r.target, adapter.root) : undefined, tests: r.tests.length,
      gainedLines: r.gainedLines,
      gained: Object.fromEntries(Object.entries(r.gained).map(([f, ls]) => [relPath(f, adapter.root), ls])),
      attempts, at: state.stamp(),
    });
    state.data.rejected = state.data.rejected.filter((x) => x.testFile !== relTest);
    state.data.notes = state.data.notes.filter((n) => !(n.kind === "suspect" && n.text.startsWith(`${relTest}: `)));
    for (const s of r.suspects) state.data.notes.push({ at: state.stamp(), kind: "suspect", text: `${relTest}: ${s}` });
  } else {
    // A previously accepted file that no longer passes stops counting, and must not stay
    // registered with the real test runner (it would break the build); the next verify re-registers it.
    state.setTestCoverage(relTest, undefined);
    const m = adapter.moduleFor(r.testFile);
    if (m && r.verdict !== "infra_error") adapter.forgetTestFile?.(r.testFile, m);
  }
  if (r.verdict !== "accepted" && opts.onFail === "quarantine" && exists(r.testFile)) {
    quarantine(adapter, state, r.testFile, r.verdict, attempts, r.target);
  }
  state.save();
}

/** Move a test file into .unitgen/rejected and undo its registration. */
export function quarantine(adapter: Adapter, state: State, testFile: string, reason: string, attempts?: number, target?: string): string {
  const relTest = relPath(testFile, adapter.root);
  const m = adapter.moduleFor(testFile);
  if (m) adapter.forgetTestFile?.(testFile, m);
  const q = state.file("rejected", `${Date.now()}-${path.basename(testFile)}`);
  fs.mkdirSync(path.dirname(q), { recursive: true });
  fs.renameSync(testFile, q);
  state.data.accepted = state.data.accepted.filter((a) => a.testFile !== relTest);
  state.setTestCoverage(relTest, undefined);
  state.data.rejected.push({
    testFile: relTest, target: target ? relPath(target, adapter.root) : undefined, reason,
    attempts: attempts ?? state.data.attempts?.[relTest] ?? 0, quarantinedAs: relPath(q, adapter.root), at: state.stamp(),
  });
  state.save();
  return q;
}

export function formatVerify(r: VerifyResult, root: string): string {
  const lines = [`verdict: ${r.verdict.toUpperCase()}  (${relPath(r.testFile, root)}, ${r.seconds.toFixed(0)}s)`];
  if (r.tests.length) lines.push(`tests: ${r.tests.length} run, ${r.failed.length} failed`);
  if (r.verdict === "accepted") {
    if (r.targetCoverage) lines.push(`target coverage now: ${r.targetCoverage.covered}/${r.targetCoverage.executable} lines (${r.targetCoverage.pct.toFixed(0)}%)`);
    lines.push(`lines covered only by this file: ${r.gainedLines}${r.target ? ` (in the target: ${r.targetGained})` : ""}${r.deltaLines !== undefined ? `; +${r.deltaLines} vs. its previously accepted version` : ""}`);
    for (const [f, ls] of Object.entries(r.gained)) lines.push(`  ${relPath(f, root)}: ${ranges(ls)}`);
  }
  if (r.suspects.length && r.verdict === "accepted") lines.push(`suspected bugs flagged: ${r.suspects.length}`, ...r.suspects.map((s) => `  ${s}`));
  if (r.feedback) lines.push("", r.feedback);
  if (r.logFile) lines.push("", `log: ${r.logFile}`);
  // Repeat the verdict last: long compiler output pushes the first line out of view.
  if (r.feedback.split("\n").length > 15) lines.push(`verdict: ${r.verdict.toUpperCase()}`);
  return lines.join("\n");
}
