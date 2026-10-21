// Persistent per-project state under <root>/.unitgen/.
import * as path from "node:path";
import { type Coverage, mergeCoverage } from "./coverage.ts";
import { exists, readJson, writeFile, writeJson } from "./util.ts";

export interface AcceptedTest {
  testFile: string;
  target?: string;
  tests: number;
  gainedLines: number;
  gained: Record<string, number[]>;
  attempts: number;
  at: string;
  /** Latest mutation run; `first` keeps the score of the first run (before strengthening). */
  mutation?: { killed: number; survived: number; stillborn: number; score: number; first?: number };
}

export interface RejectedTest {
  testFile: string;
  target?: string;
  reason: string;
  attempts: number;
  quarantinedAs?: string;
  at: string;
}

export interface StateData {
  version: 1;
  adapter?: string;
  baseline?: { at: string; ok: boolean; tests: number; failed: number; note?: string; seconds: number };
  accepted: AcceptedTest[];
  rejected: RejectedTest[];
  notes: { at: string; text: string; kind: string }[];
  /** verify runs per test file (relative path), so the report shows real attempt counts. */
  attempts?: Record<string, number>;
}

export class State {
  readonly dir: string;
  data: StateData;

  readonly root: string;

  constructor(root: string) {
    this.root = root;
    this.dir = path.join(root, ".unitgen");
    this.data = readJson<StateData>(this.file("state.json"), { version: 1, accepted: [], rejected: [], notes: [] });
    if (!exists(this.file(".gitignore"))) {
      writeFile(this.file(".gitignore"), "# unitgen working files\nlogs/\nruns/\nbriefs/\nrejected/\nmutation/\n*.cov.json\nharmony-shim/\nswift-parked/\nmutation.backup\n");
    }
  }

  file(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  save(): void {
    writeJson(this.file("state.json"), this.data);
  }

  get baselineCoverage(): Coverage {
    return readJson<Coverage>(this.file("baseline.cov.json"), {});
  }

  set baselineCoverage(c: Coverage) {
    writeJson(this.file("baseline.cov.json"), c);
  }

  /** Covered lines contributed by each accepted test file (key: test file relative to root). */
  get perTestCoverage(): Record<string, Coverage> {
    return readJson<Record<string, Coverage>>(this.file("accepted.cov.json"), {});
  }

  setTestCoverage(testFile: string, c: Coverage | undefined): void {
    const all = this.perTestCoverage;
    if (c) all[testFile] = c;
    else delete all[testFile];
    writeJson(this.file("accepted.cov.json"), all);
  }

  /** Union of what every accepted test file covers, optionally leaving one file out. */
  acceptedCoverage(except?: string): Coverage {
    const all = this.perTestCoverage;
    return mergeCoverage(...Object.entries(all).filter(([k]) => k !== except).map(([, v]) => v));
  }

  /** Baseline plus everything unitgen already accepted (optionally excluding one test file). */
  knownCoverage(except?: string): Coverage {
    return mergeCoverage(this.baselineCoverage, this.acceptedCoverage(except));
  }

  bumpAttempts(testFile: string): number {
    const a = (this.data.attempts ??= {});
    a[testFile] = (a[testFile] ?? 0) + 1;
    return a[testFile];
  }

  hasBaseline(): boolean {
    return this.data.baseline !== undefined;
  }

  stamp(): string {
    return new Date().toISOString();
  }
}
