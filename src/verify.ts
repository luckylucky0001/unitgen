// The acceptance gate. A generated test file is kept only if it compiles, every test in it passes,
// it passes again on re-runs (flakiness), it contains real assertions, and it covers new lines.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Adapter, TestCase, TestRun } from "./adapters/types.ts";
import { type Coverage, newlyCovered, ranges } from "./coverage.ts";
import type { State } from "./state.ts";
import { exists, readFile, relPath } from "./util.ts";

export type Verdict = "accepted" | "compile_error" | "test_failures" | "flaky" | "no_assertions" | "no_gain" | "no_tests" | "infra_error";

export interface VerifyResult {
  verdict: Verdict;
  testFile: string;
  target?: string;
  tests: TestCase[];
  failed: TestCase[];
  gained: Record<string, number[]>;
  gainedLines: number;
  targetGained: number;
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
  // Swift Testing reports bare function names (no suite), so fall back to everything that ran.
  return mine.length ? mine : run.tests;
}

export function verify(adapter: Adapter, state: State, testFile: string, opts: VerifyOpts = {}): VerifyResult {
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
  const text = readFile(abs);
  const m = adapter.moduleFor(abs) ?? (target ? adapter.moduleFor(target) : undefined);
  if (!m) throw new Error(`cannot determine module for ${testFile}`);
  const suspects = text.split("\n").filter((l) => l.includes("UNITGEN-SUSPECT")).map((l) => l.trim());

  if (adapter.countAssertions(text) === 0) {
    return res("no_assertions", { suspects, feedback: "The file contains no assertions. Every test must assert on results." });
  }
  adapter.prepareTestFile(abs, m);

  const label = `verify-${path.basename(abs).replace(/\W+/g, "_")}-${Date.now()}`;
  const run = adapter.runTests({ testFiles: [abs], modules: [m], coverage: true, label });
  if (run.infraError) {
    return res("infra_error", { feedback: `Environment problem: ${run.infraError}\n${run.excerpt}`, logFile: run.logFile, suspects });
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
    return res("test_failures", {
      tests, failed, logFile: run.logFile, suspects,
      feedback: `${failed.length || "Some"} test(s) failed. If the expectation was wrong, fix the expectation by re-reading the code; if the code is wrong, assert current behaviour and mark it with // UNITGEN-SUSPECT:.\n\n${fb}`,
    });
  }
  // Flakiness: re-run without coverage.
  for (let i = 0; i < (opts.reruns ?? 1); i++) {
    const again = adapter.runTests({ testFiles: [abs], modules: [m], coverage: false, label: `${label}-rerun${i + 1}` });
    const bad = suiteTests(again, adapter, abs).filter((t) => t.status === "failed");
    if (!again.ok || bad.length) {
      return res("flaky", { tests, failed: bad, logFile: again.logFile, suspects, feedback: `Tests passed once, then failed on re-run ${i + 1} (non-deterministic):\n${bad.map((t) => `${t.name}: ${t.message ?? ""}`).join("\n") || again.excerpt}` });
    }
  }
  const cand: Coverage = run.coverage ?? {};
  const relTest = relPath(abs, adapter.root);
  const known = state.knownCoverage(relTest);
  // Gains of the generated file itself: don't count lines our previously accepted tests already hit.
  const gained = newlyCovered(known, cand);
  const gainedLines = Object.values(gained).reduce((a, b) => a + b.length, 0);
  const targetGained = target ? (gained[target]?.length ?? 0) : gainedLines;
  if (gainedLines === 0 && !opts.allowNoGain) {
    return res("no_gain", { tests, logFile: run.logFile, suspects, feedback: "All tests pass but they cover no line that was not already covered. Target the lines marked \"!\" in the brief." });
  }
  const r = res("accepted", { tests, gained, gainedLines, targetGained, logFile: run.logFile, suspects });
  if (opts.record !== false) state.setTestCoverage(relTest, cand);
  return r;
}

function finish(adapter: Adapter, state: State, r: VerifyResult, opts: VerifyOpts): void {
  if (opts.record === false) return;
  const relTest = relPath(r.testFile, adapter.root);
  state.data.accepted = state.data.accepted.filter((a) => a.testFile !== relTest);
  if (r.verdict === "accepted") {
    state.data.accepted.push({
      testFile: relTest, target: r.target ? relPath(r.target, adapter.root) : undefined, tests: r.tests.length,
      gainedLines: r.gainedLines,
      gained: Object.fromEntries(Object.entries(r.gained).map(([f, ls]) => [relPath(f, adapter.root), ls])),
      attempts: opts.attempts ?? 1, at: state.stamp(),
    });
    state.data.rejected = state.data.rejected.filter((x) => x.testFile !== relTest);
    for (const s of r.suspects) state.data.notes.push({ at: state.stamp(), kind: "suspect", text: `${relTest}: ${s}` });
  } else if (opts.onFail === "quarantine" && exists(r.testFile)) {
    const q = state.file("rejected", `${Date.now()}-${path.basename(r.testFile)}`);
    fs.mkdirSync(path.dirname(q), { recursive: true });
    fs.renameSync(r.testFile, q);
    state.data.rejected.push({ testFile: relTest, target: r.target ? relPath(r.target, adapter.root) : undefined, reason: r.verdict, attempts: opts.attempts ?? 1, quarantinedAs: relPath(q, adapter.root), at: state.stamp() });
  }
  state.save();
}

export function formatVerify(r: VerifyResult, root: string): string {
  const lines = [`verdict: ${r.verdict.toUpperCase()}  (${relPath(r.testFile, root)}, ${r.seconds.toFixed(0)}s)`];
  if (r.tests.length) lines.push(`tests: ${r.tests.length} run, ${r.failed.length} failed`);
  if (r.verdict === "accepted") {
    lines.push(`new covered lines: ${r.gainedLines}${r.target ? ` (target file: ${r.targetGained})` : ""}`);
    for (const [f, ls] of Object.entries(r.gained)) lines.push(`  ${relPath(f, root)}: ${ranges(ls)}`);
  }
  if (r.suspects.length) lines.push(`suspected bugs flagged: ${r.suspects.length}`, ...r.suspects.map((s) => `  ${s}`));
  if (r.feedback) lines.push("", r.feedback);
  if (r.logFile) lines.push("", `log: ${r.logFile}`);
  return lines.join("\n");
}
