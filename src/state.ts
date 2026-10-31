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
  mutation?: { killed: number; survived: number; stillborn: number; score: number; first?: number; none?: boolean; crashes?: number; equivalent?: number; testHash?: string; stale?: boolean; evaluated?: number; candidates?: number;
    /** The latest run that evaluated every candidate (kept when a later run is only a sample). */
    complete?: { score: number; evaluated: number; testHash?: string; at: string } };
  /** Runner that measured this file (see Adapter.runnerName). */
  runner?: string;
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
  baseline?: { at: string; ok: boolean; tests: number; failed: number; note?: string; seconds: number; runner?: string };
  accepted: AcceptedTest[];
  rejected: RejectedTest[];
  notes: { at: string; text: string; kind: string }[];
  /** Accepted files whose latest verify failed: kept so their history returns once they pass again. */
  lapsed?: Record<string, AcceptedTest & { verdict: string }>;
  /** verify runs per test file (relative path), so the report shows real attempt counts. */
  attempts?: Record<string, number>;
  /** Modules the last baseline could not build (name -> reason). */
  unbuildable?: Record<string, string>;
  /** Per test file: lines (`12`) or single mutants (`12.2`) judged equivalent. */
  equivalent?: Record<string, (number | string)[]>;
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

  // Coverage files store source paths relative to the project root, so a project directory that is
  // moved, renamed or copied keeps its results (absolute keys from older versions still load).
  private toDisk(c: Coverage): Coverage {
    return Object.fromEntries(Object.entries(c).map(([f, v]) => {
      const rel = path.relative(this.root, f);
      return [rel.startsWith("..") || path.isAbsolute(rel) ? f : rel.split(path.sep).join("/"), v];
    }));
  }

  private fromDisk(c: Coverage): Coverage {
    return Object.fromEntries(Object.entries(c).map(([f, v]) => [path.isAbsolute(f) ? f : path.join(this.root, f), v]));
  }

  get baselineCoverage(): Coverage {
    return this.fromDisk(readJson<Coverage>(this.file("baseline.cov.json"), {}));
  }

  set baselineCoverage(c: Coverage) {
    writeJson(this.file("baseline.cov.json"), this.toDisk(c));
  }

  /** Covered lines contributed by each accepted test file (key: test file relative to root). */
  get perTestCoverage(): Record<string, Coverage> {
    const all = readJson<Record<string, Coverage>>(this.file("accepted.cov.json"), {});
    return Object.fromEntries(Object.entries(all).map(([t, c]) => [t, this.fromDisk(c)]));
  }

  setTestCoverage(testFile: string, c: Coverage | undefined): void {
    const all = readJson<Record<string, Coverage>>(this.file("accepted.cov.json"), {});
    if (c) all[testFile] = this.toDisk(c);
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
