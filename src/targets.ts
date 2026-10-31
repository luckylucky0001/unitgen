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
  let unavailable = false;
  let inImport = false;
  lines.forEach((raw, i) => {
    const l = raw.trim();
    // Multi-line `import { a, b } from '...'` (TS/ArkTS) is not executable code.
    if (inImport) {
      if (/\bfrom\s+['"]|^\}\s*;?$|['"]\s*;?$/.test(l)) inImport = false;
      return;
    }
    if (/^import\s*(type\s*)?\{[^}]*$/.test(l)) { inImport = true; return; }
    if (/@available\(\s*\*\s*,\s*unavailable/.test(l)) {
      unavailable = true;
      return;
    }
    if (unavailable) {
      // Skip the declaration that follows; a one-line `{ ... }` body ends it, otherwise its first line.
      if (l && !l.startsWith("@") && !l.startsWith("//")) unavailable = false;
      return;
    }
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
    // Continuation lines of a data literal (`'com', 'net', 'org',` / `0x1F, 0x20,`) are one expression.
    if (/^((['"`])(?:\\.|(?!\2).)*\2|-?(0x[\da-f]+|\d+(\.\d+)?)|true|false|null)(\s*,\s*((['"`])(?:\\.|(?!\8).)*\8|-?(0x[\da-f]+|\d+(\.\d+)?)|true|false|null))*\s*,?\s*[\])}]?[;,]?$/i.test(l)) return;
    // Field / interface member declarations without an initializer ("name?: string;", "val id: Int").
    if (/^(public |private |protected |readonly |static |override |val |var |let |declare )*[\w$]+[?!]?\s*:\s*[^=(){}]+[;,]?$/.test(l)) return;
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
    const files = adapter.sourceFiles(m);
    // The module was measured: files absent from the report have no executable code (interfaces, typealiases).
    const moduleMeasured = haveCoverage && files.some((f) => cov[f] !== undefined);
    for (const file of files) {
      if (file.includes(adapter.testFileSuffix.replace(/\.\w+$/, ""))) continue;
      const text = readFile(file);
      const kind = adapter.classify(file, text);
      if (opts.includeKinds ? !opts.includeKinds.includes(kind) : KIND_WEIGHT[kind] === 0) continue;
      const measured = haveCoverage && cov[file] !== undefined;
      // JaCoCo and llvm-cov/xccov report every compiled file that has executable code: in a measured
      // module, a missing file has none (constants, declarations). The HarmonyOS shim only sees loaded files.
      if (moduleMeasured && !measured && (adapter.platform === "android" || adapter.platform === "ios")) continue;
      let exec: number[];
      let covered: Set<number>;
      if (measured) {
        exec = [...executableLines(cov, file)];
        covered = coveredLines(cov, file);
      } else {
        // Compiled into the coverage report's binary but absent => never loaded; or no report at all.
        exec = estimateExecutable(adapter.estimateText ? adapter.estimateText(text) : text);
        covered = new Set();
      }
      const uncoveredLines = exec.filter((l) => !covered.has(l)).sort((a, b) => a - b);
      if (uncoveredLines.length < minUncovered) continue;
      const branches = countBranches(text);
      const density = Math.min(2, 1 + branches / Math.max(1, exec.length));
      // Measured tools count every line of a data literal (`red: 0.66,` in a color table) as code:
      // those weigh a fifth of a line of logic, so constant tables do not outrank real logic.
      const logic = measured ? new Set(estimateExecutable(adapter.estimateText ? adapter.estimateText(text) : text)) : undefined;
      const weight = logic ? uncoveredLines.reduce((n, l) => n + (logic.has(l) ? 1 : 0.2), 0) : uncoveredLines.length;
      const score = weight * KIND_WEIGHT[kind] * density;
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
