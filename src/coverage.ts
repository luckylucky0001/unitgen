// Line-coverage model plus parsers for every report format the adapters produce.
import * as path from "node:path";

/** absolute file path -> line number -> hit count (only executable lines present). */
export type Coverage = Record<string, Record<number, number>>;

export function emptyCoverage(): Coverage {
  return {};
}

export function mergeCoverage(...covs: Coverage[]): Coverage {
  const out: Coverage = {};
  for (const c of covs) {
    for (const [f, lines] of Object.entries(c)) {
      const dst = (out[f] ??= {});
      for (const [ln, hits] of Object.entries(lines)) {
        const k = Number(ln);
        dst[k] = Math.max(dst[k] ?? 0, hits);
      }
    }
  }
  return out;
}

export function coveredLines(c: Coverage, file: string): Set<number> {
  const s = new Set<number>();
  for (const [ln, hits] of Object.entries(c[file] ?? {})) if (hits > 0) s.add(Number(ln));
  return s;
}

export function executableLines(c: Coverage, file: string): Set<number> {
  return new Set(Object.keys(c[file] ?? {}).map(Number));
}

/** Lines covered by `cand` that are not covered in `base`, per file. */
export function newlyCovered(base: Coverage, cand: Coverage): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [f, lines] of Object.entries(cand)) {
    const b = base[f] ?? {};
    const gained = Object.entries(lines)
      .filter(([ln, hits]) => hits > 0 && !((b[Number(ln)] ?? 0) > 0))
      .map(([ln]) => Number(ln))
      .sort((a, b2) => a - b2);
    if (gained.length) out[f] = gained;
  }
  return out;
}

export interface FileSummary {
  file: string;
  executable: number;
  covered: number;
  pct: number;
}

export function summarize(c: Coverage, files?: string[]): { total: FileSummary; files: FileSummary[] } {
  const list = files ?? Object.keys(c);
  const rows: FileSummary[] = [];
  let ex = 0, cov = 0;
  for (const f of list) {
    const e = executableLines(c, f).size;
    const k = coveredLines(c, f).size;
    ex += e;
    cov += k;
    rows.push({ file: f, executable: e, covered: k, pct: e ? (100 * k) / e : 0 });
  }
  return { total: { file: "TOTAL", executable: ex, covered: cov, pct: ex ? (100 * cov) / ex : 0 }, files: rows };
}

/** Compress sorted line numbers into "3-7, 9, 12-14". */
export function ranges(lines: number[]): string {
  const s = [...lines].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// llvm-cov export JSON (SwiftPM `--enable-code-coverage`, `llvm-cov export`)
// segment = [line, col, count, hasCount, isRegionEntry, isGapRegion]
// Mirrors llvm::coverage::LineCoverageStats.
// ---------------------------------------------------------------------------
type Seg = [number, number, number, boolean, boolean, boolean?];

export function parseLlvmCovJson(json: any, keep: (file: string) => boolean = () => true): Coverage {
  const out: Coverage = {};
  for (const d of json.data ?? []) {
    for (const f of d.files ?? []) {
      const file = path.resolve(f.filename);
      if (!keep(file)) continue;
      const segs: Seg[] = f.segments ?? [];
      if (!segs.length) continue;
      const lines: Record<number, number> = {};
      let wrapped: Seg | undefined;
      let si = 0;
      const lastLine = segs[segs.length - 1][0];
      for (let line = segs[0][0]; line <= lastLine; line++) {
        const starts: Seg[] = [];
        while (si < segs.length && segs[si][0] === line) starts.push(segs[si++]);
        const isStartOfRegion = (s: Seg) => s[3] && s[4] && !s[5];
        const minRegionCount = starts.filter(isStartOfRegion).length;
        const startOfSkipped = starts.length > 0 && !starts[0][3] && starts[0][4];
        const mapped = !startOfSkipped && ((wrapped !== undefined && wrapped[3] && !wrapped[5]) || minRegionCount > 0);
        if (mapped) {
          let count = wrapped && wrapped[3] ? wrapped[2] : 0;
          for (const s of starts) if (isStartOfRegion(s)) count = Math.max(count, s[2]);
          lines[line] = count;
        }
        if (starts.length) wrapped = starts[starts.length - 1];
      }
      out[file] = lines;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// JaCoCo XML. Source files are reported as package/dir + file name, so the
// caller provides a resolver mapping "com/foo/Bar.kt" to an absolute path.
// ---------------------------------------------------------------------------
export function parseJacocoXml(xml: string, resolve: (pkgPath: string) => string | undefined): Coverage {
  const out: Coverage = {};
  const pkgRe = /<package name="([^"]*)">([\s\S]*?)<\/package>/g;
  let pm: RegExpExecArray | null;
  while ((pm = pkgRe.exec(xml))) {
    const pkg = pm[1];
    const sfRe = /<sourcefile name="([^"]+)">([\s\S]*?)<\/sourcefile>/g;
    let sm: RegExpExecArray | null;
    while ((sm = sfRe.exec(pm[2]))) {
      const abs = resolve(pkg ? `${pkg}/${sm[1]}` : sm[1]);
      if (!abs) continue;
      const lines = (out[abs] ??= {});
      const lineRe = /<line nr="(\d+)" mi="(\d+)" ci="(\d+)"/g;
      let lm: RegExpExecArray | null;
      while ((lm = lineRe.exec(sm[2]))) {
        const nr = Number(lm[1]);
        const ci = Number(lm[3]);
        lines[nr] = Math.max(lines[nr] ?? 0, ci > 0 ? ci : 0);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// LCOV (c8 / hvigor / llvm-cov -format=lcov)
// ---------------------------------------------------------------------------
export function parseLcov(text: string, baseDir: string, keep: (file: string) => boolean = () => true): Coverage {
  const out: Coverage = {};
  let cur: Record<number, number> | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const f = path.resolve(baseDir, line.slice(3));
      cur = keep(f) ? (out[f] ??= {}) : undefined;
    } else if (line.startsWith("DA:") && cur) {
      const [ln, hits] = line.slice(3).split(",");
      const k = Number(ln);
      cur[k] = Math.max(cur[k] ?? 0, Number(hits));
    } else if (line === "end_of_record") {
      cur = undefined;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// `xcrun xccov view --archive --json <xcresult>`: { "/abs/file.swift": [ {line, isExecutable, executionCount}, ... ] }
// ---------------------------------------------------------------------------
export function parseXccovArchiveJson(json: any, keep: (file: string) => boolean = () => true): Coverage {
  const out: Coverage = {};
  for (const [file, lines] of Object.entries(json as Record<string, any[]>)) {
    if (!keep(file) || !Array.isArray(lines)) continue;
    const dst: Record<number, number> = {};
    for (const l of lines) if (l.isExecutable) dst[l.line] = l.executionCount ?? 0;
    out[file] = dst;
  }
  return out;
}
