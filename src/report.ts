// Markdown summary of what unitgen measured and kept.
import type { Adapter } from "./adapters/types.ts";
import { mergeCoverage, summarize } from "./coverage.ts";
import type { State } from "./state.ts";
import { relPath } from "./util.ts";

export function buildReport(adapter: Adapter, state: State): string {
  const base = state.baselineCoverage;
  const now = mergeCoverage(base, state.acceptedCoverage());
  const files = [...new Set(adapter.modules().flatMap((m) => adapter.sourceFiles(m)))].filter((f) => !f.includes("UnitGen"));
  // Files the baseline never loaded still have executable lines: count them as 0 covered.
  const baseFilled = { ...base };
  for (const f of Object.keys(now)) if (!baseFilled[f]) baseFilled[f] = Object.fromEntries(Object.keys(now[f]).map((l) => [Number(l), 0]));
  const b = summarize(baseFilled, files.filter((f) => base[f] || now[f]));
  const a = summarize(now, files.filter((f) => base[f] || now[f]));
  const d = state.data;
  const lines: string[] = [
    `# unitgen report`,
    "",
    `- Project: \`${adapter.root}\` (${adapter.platform}, adapter \`${adapter.id}\`)`,
    `- Baseline: ${d.baseline ? `${d.baseline.tests} tests, ${d.baseline.failed} failing, ${d.baseline.seconds.toFixed(0)}s${d.baseline.note ? ` — ${d.baseline.note}` : ""}` : "not run"}`,
    `- Line coverage (files seen by the coverage tool): **${b.total.pct.toFixed(1)}% → ${a.total.pct.toFixed(1)}%** (${b.total.covered} → ${a.total.covered} of ${a.total.executable} lines)`,
    `- Generated test files: ${d.accepted.length} accepted (${d.accepted.reduce((s, x) => s + x.tests, 0)} tests), ${d.rejected.length} rejected`,
    "",
  ];
  if (d.accepted.length) {
    lines.push("## Accepted", "", "| test file | target | tests | new lines | attempts |", "|---|---|---:|---:|---:|");
    for (const x of d.accepted) lines.push(`| ${x.testFile} | ${x.target ?? ""} | ${x.tests} | ${x.gainedLines} | ${x.attempts} |`);
    lines.push("");
  }
  const perFile = a.files
    .map((f) => ({ f, before: b.files.find((x) => x.file === f.file) }))
    .filter(({ f, before }) => before && f.covered !== before.covered)
    .sort((x, y) => (y.f.covered - (y.before?.covered ?? 0)) - (x.f.covered - (x.before?.covered ?? 0)));
  if (perFile.length) {
    lines.push("## Coverage by file", "", "| file | before | after |", "|---|---:|---:|");
    for (const { f, before } of perFile) lines.push(`| ${relPath(f.file, adapter.root)} | ${before!.pct.toFixed(0)}% (${before!.covered}/${before!.executable}) | ${f.pct.toFixed(0)}% (${f.covered}/${f.executable}) |`);
    lines.push("");
  }
  if (d.rejected.length) {
    lines.push("## Rejected", "", "| test file | reason | attempts |", "|---|---|---:|");
    for (const x of d.rejected) lines.push(`| ${x.testFile} | ${x.reason} | ${x.attempts} |`);
    lines.push("");
  }
  const suspects = d.notes.filter((n) => n.kind === "suspect");
  const notes = d.notes.filter((n) => n.kind !== "suspect");
  if (suspects.length) lines.push("## Suspected bugs (tests assert current behaviour)", "", ...suspects.map((n) => `- ${n.text}`), "");
  if (notes.length) lines.push("## Notes", "", ...notes.map((n) => `- ${n.text}`), "");
  return lines.join("\n");
}
