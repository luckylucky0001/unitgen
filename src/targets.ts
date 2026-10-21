// Rank source files by how much untested logic they contain.
import * as path from "node:path";
import { type Coverage, coveredLines, executableLines } from "./coverage.ts";
import type { Adapter, FileKind, Module } from "./adapters/types.ts";
import { readFile, relPath } from "./util.ts";

export interface Target {
  file: string;
  rel: string;
  module: string;
  kind: FileKind;
  executable: number;
  covered: number;
  uncovered: number;
  uncoveredLines: number[];
  branches: number;
  score: number;
  /** true when line data came from a real coverage report (vs. estimated). */
  measured: boolean;
  testPath: string;
}

const KIND_WEIGHT: Record<FileKind, number> = { logic: 1, model: 0.35, di: 0.05, ui: 0.1, generated: 0, test: 0, entry: 0.05, platform: 0.2 };

/** Rough executable-line estimate when no coverage data exists for a file. */
export function estimateExecutable(text: string): number[] {
  const lines = text.split("\n");
  const out: number[] = [];
  let inBlock = false;
  lines.forEach((raw, i) => {
    const l = raw.trim();
    if (inBlock) {
      if (l.includes("*/")) inBlock = false;
      return;
    }
    if (l.startsWith("/*")) {
      if (!l.includes("*/")) inBlock = true;
      return;
    }
    if (!l || l.startsWith("//") || l.startsWith("*") || l.startsWith("@") || l.startsWith("import ") || l.startsWith("package ")) return;
    if (/^[{}()\[\],;]+$/.test(l)) return;
    if (/^(public |private |internal |protected |open |final |abstract |data |sealed |export |static )*(class|struct|enum|protocol|interface|object|extension|namespace)\b/.test(l)) return;
    out.push(i + 1);
  });
  return out;
}

function countBranches(text: string): number {
  return (text.match(/\b(if|guard|switch|when|case|catch|while|for|else)\b|\?\?|\?:|&&|\|\|/g) ?? []).length;
}

export function rankTargets(adapter: Adapter, cov: Coverage, opts: { modules?: Module[]; includeKinds?: FileKind[]; minUncovered?: number } = {}): Target[] {
  const mods = opts.modules ?? adapter.modules();
  const minUncovered = opts.minUncovered ?? 3;
  const out: Target[] = [];
  const haveCoverage = Object.keys(cov).length > 0;
  for (const m of mods) {
    for (const file of adapter.sourceFiles(m)) {
      if (file.includes(adapter.testFileSuffix.replace(/\.\w+$/, ""))) continue;
      const text = readFile(file);
      const kind = adapter.classify(file, text);
      if (opts.includeKinds ? !opts.includeKinds.includes(kind) : KIND_WEIGHT[kind] === 0) continue;
      const measured = haveCoverage && cov[file] !== undefined;
      let exec: number[];
      let covered: Set<number>;
      if (measured) {
        exec = [...executableLines(cov, file)];
        covered = coveredLines(cov, file);
      } else {
        // Compiled into the coverage report's binary but absent => never loaded; or no report at all.
        exec = estimateExecutable(text);
        covered = new Set();
      }
      const uncoveredLines = exec.filter((l) => !covered.has(l)).sort((a, b) => a - b);
      if (uncoveredLines.length < minUncovered) continue;
      const branches = countBranches(text);
      const density = Math.min(2, 1 + branches / Math.max(1, exec.length));
      const score = uncoveredLines.length * KIND_WEIGHT[kind] * density;
      out.push({
        file, rel: relPath(file, adapter.root), module: m.name, kind,
        executable: exec.length, covered: covered.size, uncovered: uncoveredLines.length, uncoveredLines,
        branches, score: Math.round(score * 10) / 10, measured, testPath: adapter.placement(file, m).path,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export function formatTargets(ts: Target[], root: string): string {
  const rows = ts.map((t, i) => {
    const pct = t.executable ? ((100 * t.covered) / t.executable).toFixed(0) : "0";
    return `${String(i + 1).padStart(3)}  ${String(t.score).padStart(7)}  ${String(t.uncovered).padStart(5)}/${String(t.executable).padEnd(5)} ${pct.padStart(3)}%${t.measured ? " " : "~"} ${t.kind.padEnd(5)} ${t.rel}`;
  });
  return [`  #    score  uncov/exec  cov  kind  file   (~ = estimated, no coverage data)`, ...rows].join("\n") + `\n\nroot: ${root}`;
}

export function baseName(file: string): string {
  return path.basename(file);
}
