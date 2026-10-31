// Markdown summary of what unitgen measured and kept.
import * as path from "node:path";
import type { Adapter } from "./adapters/types.ts";
import { mergeCoverage, summarize } from "./coverage.ts";
import type { State } from "./state.ts";
import { estimateExecutable } from "./targets.ts";
import { readFile, relPath } from "./util.ts";

export function buildReport(adapter: Adapter, state: State): string {
  const base = state.baselineCoverage;
  const now = mergeCoverage(base, state.acceptedCoverage());
  const files = [...new Set(adapter.modules().flatMap((m) => adapter.sourceFiles(m)))].filter((f) => !f.includes("UnitGen"));
  // Files the baseline never loaded still have executable lines: count them as 0 covered.
  const baseFilled = { ...base };
  for (const f of Object.keys(now)) if (!baseFilled[f]) baseFilled[f] = Object.fromEntries(Object.keys(now[f]).map((l) => [Number(l), 0]));
  const b = summarize(baseFilled, files.filter((f) => base[f] || now[f]));
  const a = summarize(now, files.filter((f) => base[f] || now[f]));
  // Whole codebase: unmeasured logic/model files count with estimated executable lines, 0 covered.
  let wholeExec = 0, wholeBefore = 0, wholeAfter = 0;
  for (const f of files) {
    const kind = adapter.classify(f, readFile(f));
    if (kind === "generated" || kind === "test") continue;
    if (now[f] || base[f]) {
      wholeExec += Object.keys(now[f] ?? base[f]).length;
      wholeBefore += Object.values(base[f] ?? {}).filter((h) => h > 0).length;
      wholeAfter += Object.values(now[f] ?? {}).filter((h) => h > 0).length;
    } else {
      const text = readFile(f);
      wholeExec += estimateExecutable(adapter.estimateText ? adapter.estimateText(text) : text).length;
    }
  }
  const pct = (a: number) => (wholeExec ? ((100 * a) / wholeExec).toFixed(1) : "0.0");
  const d = state.data;
  // Hide rejections superseded by a later accepted test for the same target.
  const acceptedTargets = new Set(d.accepted.map((a) => a.target).filter(Boolean));
  const rejected = d.rejected.filter((x) => !(x.target && acceptedTargets.has(x.target)) && !d.accepted.some((a) => a.testFile === x.testFile));

  const lines: string[] = [
    `# unitgen report`,
    "",
    `- Project: \`${adapter.root}\` (${adapter.platform}, adapter \`${adapter.id}\`)`,
    `- Baseline: ${d.baseline ? `${d.baseline.tests} tests, ${d.baseline.failed} failing, ${d.baseline.seconds.toFixed(0)}s${d.baseline.runner ? `, runner: ${d.baseline.runner}` : ""}${d.baseline.note ? ` — ${d.baseline.note}` : ""}` : "not run"} (the project's own tests; generated files are excluded)`,
    `- Line coverage, files the coverage tool saw: **${b.total.pct.toFixed(1)}% → ${a.total.pct.toFixed(1)}%** (${b.total.covered} → ${a.total.covered} of ${a.total.executable} lines)`,
    `- Whole codebase incl. never-loaded files (estimated lines): ${pct(wholeBefore)}% → ${pct(wholeAfter)}% (${wholeBefore} → ${wholeAfter} of ~${wholeExec} lines)`,
    `- Generated test files: ${d.accepted.length} accepted (${d.accepted.reduce((s, x) => s + x.tests, 0)} tests), ${rejected.length} rejected`,
    "",
  ];
  if (d.accepted.length) {
    const mixed = new Set(d.accepted.map((x) => x.runner).filter(Boolean)).size > 1;
    lines.push("## Accepted", "", `| test file | target | tests | new lines | attempts | mutation score | killed / survived (crash-only, did not compile, equivalent) |${mixed ? " runner |" : ""}`,
      `|---|---|---:|---:|---:|---:|---|${mixed ? "---|" : ""}`);
    for (const x of d.accepted) {
      const m = x.mutation;
      const ms = m?.none ? "n/a (nothing mutable)" : m
        ? `${m.first !== undefined && m.first !== m.score ? `${Math.round(m.first * 100)}% → ` : ""}${Math.round(m.score * 100)}%${m.stale ? " (stale: test changed since)" : ""}`
        : "—";
      const detail = m && !m.none ? `${m.killed} / ${m.survived} (${m.crashes ?? 0}, ${m.stillborn}, ${m.equivalent ?? 0})` : "";
      lines.push(`| ${x.testFile} | ${x.target ?? ""} | ${x.tests} | ${x.gainedLines} | ${x.attempts} | ${ms} | ${detail} |${mixed ? ` ${x.runner ?? ""} |` : ""}`);
    }
    if (mixed) lines.push("", "⚠️ Accepted files were measured with different runners; their coverage numbers are not comparable. Re-run `unitgen verify` on the files measured with another runner than the baseline.");
    if (d.accepted.some((x) => !x.mutation)) lines.push("", "Mutation score: `unitgen mutate <test-file>` (— = not run). Surviving mutants can be equivalent (no observable change); review them before adding assertions.");
    lines.push("");
  }
  const targets = new Set(d.accepted.map((x) => x.target && path.resolve(adapter.root, x.target)).filter((x): x is string => !!x));
  const perFile = a.files
    .map((f) => ({ f, before: b.files.find((x) => x.file === f.file) }))
    // Changed files, plus every target of an accepted test (an unchanged target is worth seeing too).
    .filter(({ f, before }) => before && (f.covered !== before.covered || targets.has(f.file)))
    .sort((x, y) => (y.f.covered - (y.before?.covered ?? 0)) - (x.f.covered - (x.before?.covered ?? 0)));
  if (perFile.length) {
    lines.push("## Coverage by file", "", "| file | before | after |", "|---|---:|---:|");
    for (const { f, before } of perFile) lines.push(`| ${relPath(f.file, adapter.root)} | ${before!.pct.toFixed(0)}% (${before!.covered}/${before!.executable}) | ${f.pct.toFixed(0)}% (${f.covered}/${f.executable}) |`);
    lines.push("");
  }
  if (rejected.length) {
    lines.push("## Rejected", "", "| test file | reason | attempts |", "|---|---|---:|");
    for (const x of rejected) lines.push(`| ${x.testFile} | ${x.reason} | ${x.attempts} |`);
    lines.push("");
  }
  const suspects = d.notes.filter((n) => n.kind === "suspect");
  const notes = d.notes.filter((n) => n.kind !== "suspect");
  if (suspects.length) lines.push("## Suspected bugs (tests assert current behaviour)", "", ...suspects.map((n) => `- ${n.text}`), "");
  if (notes.length) lines.push("## Notes", "", ...notes.map((n) => `- ${n.text}`), "");
  return lines.join("\n");
}
