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
      writeFile(this.file(".gitignore"), "# unitgen working files\nlogs/\nruns/\nbriefs/\nrejected/\n*.cov.json\nharmony-shim/\n");
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

  get acceptedCoverage(): Coverage {
    return readJson<Coverage>(this.file("accepted.cov.json"), {});
  }

  set acceptedCoverage(c: Coverage) {
    writeJson(this.file("accepted.cov.json"), c);
  }

  /** Baseline plus everything unitgen already accepted. */
  get knownCoverage(): Coverage {
    return mergeCoverage(this.baselineCoverage, this.acceptedCoverage);
  }

  hasBaseline(): boolean {
    return this.data.baseline !== undefined;
  }

  stamp(): string {
    return new Date().toISOString();
  }
}
