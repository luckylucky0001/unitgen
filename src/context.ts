// Build the generation brief: everything a model needs to write one good test file.
import * as path from "node:path";
import type { Adapter, Module } from "./adapters/types.ts";
import { ranges } from "./coverage.ts";
import type { State } from "./state.ts";
import { estimateExecutable } from "./targets.ts";
import { coveredLines, executableLines } from "./coverage.ts";
import { exists, readFile, relPath, walkFiles } from "./util.ts";

export interface Brief {
  source: string;
  testPath: string;
  suiteName: string;
  markdown: string;
  uncovered: number[];
}

const RULES = `Rules (a test that breaks any of these is rejected):
1. Test observable behaviour through the public/internal API. Never modify production code, never use reflection to reach private members.
2. Every test must contain real assertions about results or state. No empty tests, no assertions that are always true.
3. Deterministic: no network, no real clocks/sleeps, no randomness without a fixed seed, no dependence on test order or machine locale/timezone (set them explicitly if needed).
4. Derive expected values by reading the code carefully. If the code looks buggy, still assert the CURRENT behaviour and add a comment starting with "// UNITGEN-SUSPECT:" explaining the suspected bug.
5. Aim at the lines marked "!" (not covered by any existing test): exercise each branch, error path and edge case (empty, nil/null, boundary values, invalid input).
6. Keep tests small, independent and named after the behaviour they check. Prefer 5-25 focused tests over one giant test.
7. Only use libraries that are already available (listed above). Do not add dependencies.`;

function declarationLines(text: string): string[] {
  const re = /^\s*(public |open |internal |private |fileprivate |protected |export |static |final |abstract |override |data |sealed |inline |suspend |async |mutating |@\w+\s+)*(func|fun|init|class|struct|enum|protocol|interface|object|typealias|val|var|let|case|constructor|function|type)\b/;
  return text.split("\n").filter((l) => re.test(l) && !/^\s*(private|fileprivate)\b/.test(l)).map((l) => l.replace(/\{\s*$/, "").trimEnd());
}

/** Signatures of other module files whose type names the target references. */
function relatedDeclarations(adapter: Adapter, m: Module, source: string, text: string, budget: number): string {
  const idents = new Set(text.match(/\b[A-Z][A-Za-z0-9_]{2,}\b/g) ?? []);
  const own = new Set((text.match(/\b(class|struct|enum|protocol|interface|object)\s+([A-Z]\w*)/g) ?? []).map((s) => s.split(/\s+/)[1]));
  const parts: string[] = [];
  let used = 0;
  const files = adapter.sourceFiles(m).filter((f) => f !== source);
  const scored = files.map((f) => {
    const t = readFile(f);
    const defs = (t.match(/\b(class|struct|enum|protocol|interface|object|typealias)\s+([A-Z]\w*)/g) ?? []).map((s) => s.split(/\s+/)[1]);
    const hits = defs.filter((d) => idents.has(d) && !own.has(d)).length;
    return { f, t, hits };
  }).filter((x) => x.hits > 0).sort((a, b) => b.hits - a.hits);
  for (const { f, t } of scored) {
    const decl = declarationLines(t).join("\n");
    if (!decl) continue;
    const chunk = `// ${relPath(f, adapter.root)}\n${decl}`;
    if (used + chunk.length > budget) break;
    parts.push(chunk);
    used += chunk.length;
  }
  return parts.join("\n\n");
}

/** Existing fakes/stubs in the module's test sources that implement types the target uses. */
function testDoubles(adapter: Adapter, m: Module, text: string, budget: number): string {
  const idents = new Set(text.match(/\b[A-Z][A-Za-z0-9_]{2,}\b/g) ?? []);
  const roots = [...new Set([path.dirname(m.testRoot), m.testRoot])].filter(exists);
  const exts = [".kt", ".java", ".swift", ".ets", ".ts"];
  const parts: string[] = [];
  let used = 0;
  const seen = new Set<string>();
  for (const root of roots) {
    for (const f of walkFiles(root, exts)) {
      if (seen.has(f) || /UnitGen|\.unitgen\./.test(path.basename(f))) continue;
      seen.add(f);
      const t = readFile(f);
      const impl = [...t.matchAll(/\b(?:class|object|struct)\s+(\w+)[^{\n]*?(?::|implements|extends)\s*([^{\n]+)/g)]
        .filter((mm) => (mm[2].match(/\b[A-Z]\w+/g) ?? []).some((x) => idents.has(x)));
      if (!impl.length) continue;
      const chunk = `// ${relPath(f, adapter.root)}\n${declarationLines(t).join("\n")}`;
      if (used + chunk.length > budget) return parts.join("\n\n");
      parts.push(chunk);
      used += chunk.length;
    }
  }
  return parts.join("\n\n");
}

function numbered(text: string, uncovered: Set<number>, executable: Set<number>, keep?: (ln: number) => boolean): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let skipping = false;
  lines.forEach((l, i) => {
    const ln = i + 1;
    if (keep && !keep(ln)) {
      if (!skipping) out.push("     …");
      skipping = true;
      return;
    }
    skipping = false;
    const mark = uncovered.has(ln) ? "!" : executable.has(ln) ? " " : " ";
    out.push(`${mark}${String(ln).padStart(5)}| ${l}`);
  });
  return out.join("\n");
}

function capRanges(lines: number[]): string {
  if (!lines.length) return "none";
  const parts = ranges(lines).split(", ");
  return parts.length > 40 ? `${parts.slice(0, 40).join(", ")}, … (${lines.length} lines, marked "!" below)` : parts.join(", ");
}

export function buildBrief(adapter: Adapter, state: State, source: string, opts: { maxSourceChars?: number; feedback?: string } = {}): Brief {
  const abs = path.resolve(source);
  if (!exists(abs)) throw new Error(`source file not found: ${source}`);
  const m = adapter.moduleFor(abs);
  if (!m) throw new Error(`${source} is not inside any detected module`);
  const text = readFile(abs);
  const cov = state.knownCoverage();
  const measured = cov[abs] !== undefined;
  const exec = measured ? executableLines(cov, abs) : new Set(estimateExecutable(text));
  const covered = measured ? coveredLines(cov, abs) : new Set<number>();
  const uncovered = [...exec].filter((l) => !covered.has(l)).sort((a, b) => a - b);
  const unc = new Set(uncovered);
  const place = adapter.placement(abs, m);
  const maxChars = opts.maxSourceChars ?? 70000;

  let src = numbered(text, unc, exec);
  if (src.length > maxChars) {
    // Large file: keep declarations plus a window around uncovered lines.
    const declSet = new Set<number>();
    text.split("\n").forEach((l, i) => {
      if (declarationLines(l).length) declSet.add(i + 1);
    });
    src = numbered(text, unc, exec, (ln) => declSet.has(ln) || uncovered.some((u) => Math.abs(u - ln) <= 4));
  }

  const examples = adapter.exampleTests(m, abs).map((f) => {
    const t = readFile(f).split("\n");
    return `// ${relPath(f, adapter.root)}${t.length > 120 ? " (first 120 lines)" : ""}\n${t.slice(0, 120).join("\n")}`;
  });

  const existingGenerated = exists(place.path) ? readFile(place.path) : "";
  const related = relatedDeclarations(adapter, m, abs, text, 12000);
  const doubles = testDoubles(adapter, m, text, 8000);
  const sections: string[] = [
    `# unitgen brief: ${relPath(abs, adapter.root)}`,
    "",
    `- Module: \`${m.name}\` (${m.kind})`,
    `- Write the test file to: \`${place.path}\``,
    `- Test suite/class name: \`${place.suiteName}\`${place.packageName ? `  (package \`${place.packageName}\`)` : ""}`,
    place.importHint ? `- Import: \`${place.importHint}\`` : "",
    `- Coverage: ${measured ? `${covered.size}/${exec.size} executable lines covered by existing tests` : "no coverage data for this file (estimated)"}; uncovered lines: ${capRanges(uncovered)}`,
    "",
    "## Conventions",
    adapter.conventions(m),
    "",
    "## " + RULES,
    "",
    "## Source under test (\"!\" = not covered yet)",
    "```",
    src,
    "```",
  ];
  if (related) sections.push("", "## Related declarations in the same module", "```", related, "```");
  if (doubles) sections.push("", "## Existing test doubles for types used by the target (prefer these over mocks)", "```", doubles, "```");
  if (examples.length) sections.push("", "## Existing tests in this module (follow their style, imports and fakes/helpers; the framework rules above win if they differ)", "```", examples.join("\n\n"), "```");
  if (existingGenerated) sections.push("", "## Current content of the generated test file (extend it; keep passing tests)", "```", existingGenerated, "```");
  if (opts.feedback) sections.push("", "## Feedback from the last attempt (fix these problems)", "```", opts.feedback, "```");
  sections.push("", "## Output", `Return the complete test file for \`${path.basename(place.path)}\` in a single fenced code block, nothing else.`);
  return { source: abs, testPath: place.path, suiteName: place.suiteName, markdown: sections.filter((s) => s !== undefined).join("\n"), uncovered };
}
