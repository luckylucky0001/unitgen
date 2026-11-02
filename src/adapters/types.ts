import type { Coverage } from "../coverage.ts";

export type Platform = "ios" | "android" | "harmony";

export interface Module {
  /** Adapter-specific identifier, e.g. SwiftPM target name or Gradle path ":core:data". */
  name: string;
  dir: string;
  sourceRoots: string[];
  /** Where unitgen writes new tests for this module. */
  testRoot: string;
  kind: string;
  meta?: Record<string, any>;
}

export interface TestCase {
  name: string;
  status: "passed" | "failed" | "skipped";
  message?: string;
  file?: string;
}

export interface TestRun {
  /** Build + test command exited cleanly. */
  ok: boolean;
  /** Test sources compiled (false => compile/build error). */
  compiled: boolean;
  tests: TestCase[];
  coverage?: Coverage;
  logFile: string;
  excerpt: string;
  seconds: number;
  /** Environment problem, not the test's fault (missing SDK, timeout, ...). */
  infraError?: string;
  /** Coverage-tool warnings that make the numbers unreliable (e.g. JaCoCo class mismatch). */
  coverageWarnings?: string[];
  /** Informational remark for the user (e.g. suites skipped on this toolchain). */
  note?: string;
  /** Why failing existing tests are expected in this environment (the baseline then tolerates them). */
  failuresExplained?: string;
  /** Modules the runner could not build at all (name -> reason); their files cannot be verified. */
  unbuildable?: Record<string, string>;
  /** Coverage of the whole run is unusable (e.g. tests passed but no line was recorded anywhere). */
  coverageProblem?: string;
  /** The build failed in code other than the test files run (e.g. production code). */
  compileErrorOutsideTests?: string;
  /** Coverage is measured by unitgen itself, so "tests ran, nothing covered" really means 0%. */
  emptyCoverageOk?: boolean;
}

export interface RunRequest {
  /** Restrict to these test files (absolute paths). Undefined => all tests (baseline). */
  testFiles?: string[];
  /** Restrict to these modules. */
  modules?: Module[];
  /** Baseline: run only the project's own tests, not files unitgen generated (their gains are tracked separately). */
  excludeGenerated?: boolean;
  coverage: boolean;
  label: string;
  /** Hard limit for the whole run (default: adapter-specific, long). */
  timeoutSec?: number;
}

export type FileKind = "logic" | "ui" | "generated" | "di" | "model" | "test" | "entry" | "platform";

export interface TestPlacement {
  path: string;
  /** Suite/class name the test should declare. */
  suiteName: string;
  /** Package / module import hints for the prompt. */
  packageName?: string;
  importHint?: string;
}

export interface Doctor {
  ok: boolean;
  lines: string[];
}

export interface Adapter {
  readonly id: string;
  readonly platform: Platform;
  readonly root: string;
  doctor(): Doctor;
  modules(): Module[];
  moduleFor(file: string): Module | undefined;
  sourceFiles(m: Module): string[];
  classify(file: string, text: string): FileKind;
  placement(source: string, m: Module): TestPlacement;
  /** Prompt text describing framework, conventions and available test libraries for a module. */
  conventions(m: Module): string;
  /** Existing tests to show the model as a style reference (absolute paths); the source's own test first. */
  exampleTests(m: Module, source?: string): string[];
  /** Called before a new test file is verified (e.g. register a SwiftPM test target). */
  prepareTestFile(testFile: string, m: Module): void;
  /** Extra directories holding test helpers/fakes the module's tests can use (e.g. a :shared-test module). */
  testSupportDirs?(m: Module): string[];
  /** Lines that call system APIs which are stubs or mocks under this runner (marked `!~` in briefs). */
  platformLines?(text: string): Set<number>;
  /** How those APIs behave here, for the brief legend (e.g. "a mock in the Previewer"). */
  readonly platformLinesNote?: string;
  /** Source text used to estimate executable lines of a never-loaded file (e.g. without UI DSL blocks). */
  estimateText?(text: string): string;
  /** Warnings to put at the top of a brief (missing packages, stubbed APIs, ...). */
  briefWarnings?(source: string): string[];
  /** Undo temporary project edits a killed run left behind (parked files, swapped test lists). Runs under the project lock. */
  recover?(): void;
  /** Undo prepareTestFile side effects when a file is quarantined (optional). */
  forgetTestFile?(testFile: string, m: Module): void;
  runTests(req: RunRequest): Promise<TestRun>;
  /** Language-level hints: does the test file contain at least one real assertion? */
  countAssertions(text: string): number;
  readonly testFileSuffix: string;
  /** Which runner measures coverage (when an adapter has several, e.g. hvigor vs the Node shim). */
  readonly runnerName?: string;
}
