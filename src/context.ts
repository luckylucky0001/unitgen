// Build the generation brief: everything a model needs to write one good test file.
import * as fs from "node:fs";
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
7. Only use test libraries named in the Conventions section or imported by the existing tests below. Do not add dependencies.`;

export function declarationLines(text: string, file = ""): string[] {
  // A keyword followed by a name (`type Foo`, `object Bar`), not a field called `type:` / `object:`.
  const re = /^\s*(public |open |internal |private |fileprivate |protected |export |static |final |abstract |override |data |sealed |inline |suspend |async |mutating |@\w+\s+)*((func|fun|class|struct|enum|protocol|interface|object|typealias|val|var|let|const|case|function|type)\s+[A-Za-z_$`]|(init|constructor)\b)/;
  // TypeScript/ArkTS methods have no keyword: `sendMessage(x: string): Promise<void> {`.
  const tsMethod = /^\s+(public |protected |static |async |override |readonly )*[A-Za-z_$][\w$]*\s*(<[^>]*>)?\([^)]*\)\s*(:\s*[^={;]+)?\s*\{\s*$/;
  const isTs = /\.(ets|ts)$/.test(file);
  // Block nesting, so variables count only at top level or directly in a type body, never as locals
  // of a function (whatever the indentation style).
  const stack: ("type" | "code")[] = [];
  const typeHead = /\b(class|struct|enum|protocol|interface|object|extension|actor)\b/;
  const out: string[] = [];
  for (const l of text.split("\n")) {
    const code = l.replace(/\/\/.*$/, "").replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "\"\"");
    const inBody = stack.length === 0 || stack[stack.length - 1] === "type";
    let keep = false;
    if (/^\s*(private|fileprivate)\b/.test(l)) keep = false;
    else if (/^\s*(val|var|let|const)\b/.test(l)) keep = inBody;
    else if (re.test(l)) keep = inBody || /^\s*(public |internal |export |static |override |open )*(func|fun|function|init|constructor|case)\b/.test(l);
    else keep = isTs && inBody && tsMethod.test(l) && !/^\s*(if|for|while|switch|catch|return|function|else)\b/.test(l);
    if (keep) out.push(l.replace(/\{\s*$/, "").trimEnd());
    for (const c of code) {
      if (c === "{") stack.push(typeHead.test(code) && !/\b(func|fun|function)\b/.test(code) ? "type" : "code");
      else if (c === "}") stack.pop();
    }
  }
  return out;
}

/** Signatures of other module files whose type names the target references. */
function relatedDeclarations(adapter: Adapter, m: Module, source: string, text: string, budget: number): string {
  const idents = new Set(text.match(/\b[A-Z][A-Za-z0-9_]{2,}\b/g) ?? []);
  const own = new Set((text.match(/\b(class|struct|enum|protocol|interface|object)\s+([A-Z]\w*)/g) ?? []).map((s) => s.split(/\s+/)[1]));
  const parts: string[] = [];
  let used = 0;
  const files = adapter.sourceFiles(m).filter((f) => f !== source);
  // Types imported from other modules (DAO interfaces, entities, models): resolve `import a.b.Foo` by file name.
  const imported = new Set([...text.matchAll(/^import\s+(?:class\s+)?[\w.]*\.([A-Z]\w*)\s*$/gm)].map((m) => m[1]));
  if (imported.size) {
    for (const other of adapter.modules()) {
      if (other.name === m.name) continue;
      for (const f of adapter.sourceFiles(other)) {
        const base = path.basename(f).replace(/\.\w+$/, "");
        if (imported.has(base)) files.push(f);
      }
    }
  }
  // TS/ArkTS relative imports (`import { nowMs } from '../util/IdGen'`): those files are what the code
  // calls, functions included, so they come first whatever they define.
  const relImports = new Set<string>();
  for (const im of text.matchAll(/^\s*import\s+[^;]*?\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    const base = path.resolve(path.dirname(source), im[1]);
    const hit = [base, `${base}.ets`, `${base}.ts`, path.join(base, "index.ets"), path.join(base, "index.ts")].find((f) => exists(f) && fs.statSync(f).isFile());
    if (hit && hit !== source) relImports.add(hit);
  }
  for (const f of relImports) if (!files.includes(f)) files.push(f);
  const scored = files.map((f) => {
    const t = readFile(f);
    const defs = (t.match(/\b(class|struct|enum|protocol|interface|object|typealias)\s+([A-Z]\w*)/g) ?? []).map((s) => s.split(/\s+/)[1]);
    const hits = defs.filter((d) => idents.has(d) && !own.has(d)).length + (relImports.has(f) ? 1000 : 0);
    return { f, t, hits };
  }).filter((x) => x.hits > 0).sort((a, b) => b.hits - a.hits);
  for (const { f, t } of scored) {
    const decl = declarationLines(t, f).join("\n");
    if (!decl) continue;
    const chunk = `// ${relPath(f, adapter.root)}\n${decl}`;
    if (used + chunk.length > budget) break;
    parts.push(chunk);
    used += chunk.length;
  }
  return parts.join("\n\n");
}

// Supertypes too generic to say "this class can stand in for something the target uses".
const GENERIC_SUPERTYPES = new Set(["Error", "Exception", "RuntimeException", "Throwable", "Object", "Any", "NSObject", "Equatable", "Hashable", "Codable", "Serializable", "Comparable", "Sendable"]);

/** The source of the named type declarations only (from the declaration to its closing brace). */
function declarationsOf(text: string, names: string[]): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const name of names) {
    const start = lines.findIndex((l) => new RegExp(`\\b(class|object|struct|enum|actor)\\s+${name}\\b`).test(l));
    if (start < 0) continue;
    let depth = 0;
    for (let i = start; i < lines.length; i++) {
      out.push(lines[i]);
      for (const c of lines[i].replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/.*$/g, "")) {
        if (c === "{") depth++;
        if (c === "}") depth--;
      }
      if (depth <= 0 && i > start) break;
      if (depth <= 0 && lines[i].includes("}")) break;
    }
  }
  return out.join("\n");
}

/** Existing fakes/stubs in the module's test sources that implement types the target uses. */
function testDoubles(adapter: Adapter, m: Module, text: string, budget: number): string {
  const idents = new Set((text.match(/\b[A-Z][A-Za-z0-9_]{2,}\b/g) ?? []).filter((x) => !GENERIC_SUPERTYPES.has(x)));
  // Production sources are not test doubles unless they say so by name (FakeX, MockX, InMemoryX, ...).
  const prodRoots = adapter.modules().flatMap((mm) => mm.sourceRoots.map((r) => r + path.sep));
  const doubleName = /(Fake|Mock|Stub|InMemory|Dummy|Spy|Test)/;
  const roots = [...new Set([path.dirname(m.testRoot), m.testRoot, ...(adapter.testSupportDirs?.(m) ?? [])])].filter(exists);
  const exts = [".kt", ".java", ".swift", ".ets", ".ts"];
  const parts: string[] = [];
  let used = 0;
  const seen = new Set<string>();
  for (const root of roots) {
    for (const f of walkFiles(root, exts)) {
      if (seen.has(f) || /UnitGen|\.unitgen\./.test(path.basename(f))) continue;
      seen.add(f);
      if (prodRoots.some((r) => f.startsWith(r)) && !doubleName.test(path.basename(f))) continue;
      const t = readFile(f);
      if (/XCTestCase|@Test\b|@Suite\b|\bdescribe\(|@org\.junit|import org\.junit|import kotlin\.test/.test(t) && !/\b(Fake|Test|Stub|Mock|InMemory)\w*\s*[:(<{]/.test(t.replace(/class\s+\w+Tests?\b/g, ""))) continue;
      const impl = [...t.matchAll(/\b(?:class|object|struct)\s+(\w+)[^{\n]*?(?::|implements|extends)\s*([^{\n]+)/g)]
        .filter((mm) => (mm[2].match(/\b[A-Z]\w+/g) ?? []).some((x) => idents.has(x)));
      if (!impl.length) continue;
      // In a test file only the doubles themselves are useful, not every test method around them.
      const isTestFile = /XCTestCase|@Test\b|@Suite\b|\bdescribe\(|@org\.junit|import org\.junit|import kotlin\.test/.test(t);
      const body = isTestFile ? declarationsOf(t, impl.map((mm) => mm[1]).filter((n) => /Fake|Stub|Mock|InMemory|Dummy|Spy|Test\w+Repository/.test(n) || !/Tests?$/.test(n))) : t;
      if (!body.trim()) continue;
      const chunk = `// ${relPath(f, adapter.root)}\n${declarationLines(body, f).join("\n")}`;
      if (used + chunk.length > budget) return parts.join("\n\n");
      parts.push(chunk);
      used += chunk.length;
    }
  }
  return parts.join("\n\n");
}

function numbered(text: string, uncovered: Set<number>, executable: Set<number>, keep?: (ln: number) => boolean, platform: Set<number> = new Set()): string {
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
    const mark = uncovered.has(ln) ? (platform.has(ln) ? "!~" : "! ") : "  ";
    out.push(`${mark}${String(ln).padStart(5)}| ${l}`);
  });
  return out.join("\n");
}

/** Drop a leading license/copyright comment block: it costs tokens and carries no signal. */
function stripLicense(text: string): string {
  return text.replace(/^\s*(\/\*[\s\S]*?\*\/\s*|(\/\/[^\n]*\n)+\s*)/, (h) => (/copyright|license|licensed/i.test(h) ? "" : h));
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
  const exec = measured ? executableLines(cov, abs) : new Set(estimateExecutable(adapter.estimateText ? adapter.estimateText(text) : text));
  const covered = measured ? coveredLines(cov, abs) : new Set<number>();
  const uncovered = [...exec].filter((l) => !covered.has(l)).sort((a, b) => a - b);
  const unc = new Set(uncovered);
  const place = adapter.placement(abs, m);
  const maxChars = opts.maxSourceChars ?? 70000;

  // Lines that call system APIs which are stubs/mocks in this runner: covering them is possible,
  // asserting on what those APIs return is not.
  const platform = adapter.platformLines?.(text) ?? new Set<number>();
  let src = numbered(text, unc, exec, undefined, platform);
  if (src.length > maxChars) {
    // Large file: keep declarations plus a window around uncovered lines.
    const declSet = new Set<number>();
    text.split("\n").forEach((l, i) => {
      if (declarationLines(l).length) declSet.add(i + 1);
    });
    src = numbered(text, unc, exec, (ln) => declSet.has(ln) || uncovered.some((u) => Math.abs(u - ln) <= 4), platform);
  }

  const examples = adapter.exampleTests(m, abs).map((f) => {
    const t = stripLicense(readFile(f)).split("\n");
    const more = t.length > 120 ? ` (first 120 of ${t.length} lines; open the full file: its expected values and error messages are reliable oracles)` : "";
    return `// ${relPath(f, adapter.root)}${more}\n${t.slice(0, 120).join("\n")}`;
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
    `- Coverage: ${measured ? `${covered.size}/${exec.size} executable lines covered by existing tests` : `0% (no existing test loads this file; ~${exec.size} executable lines estimated)`}; uncovered lines: ${capRanges(uncovered)}`,
    ...(state.data.unbuildable?.[m.name] ? [`The last baseline could not build module \`${m.name}\` (${state.data.unbuildable[m.name]}): a test here cannot be verified with this runner. Pick a target in another module, or fix the module first.`] : [])
      .concat(adapter.briefWarnings?.(abs) ?? []).map((w) => `- ⚠️ ${w}`),
    "",
    "## Conventions",
    adapter.conventions(m),
    "",
    "## " + (examples.length ? RULES : RULES.replace("named in the Conventions section or imported by the existing tests below", "named in the Conventions section (this module has no existing tests to copy from, apart from IDE templates)")),
    "",
    `## Source under test ("!" = not covered yet${[...platform].some((l) => unc.has(l)) ? `; "!~" = not covered and calls a system API that is ${adapter.platformLinesNote ?? "not real here"}: cover the logic around it, never assert on what the API returns` : ""})`,
    "```",
    src,
    "```",
  ];
  if (related) sections.push("", "## Related declarations (this module, and types it imports from other modules)", "```", related, "```");
  if (doubles) sections.push("", "## Existing test doubles for types used by the target (prefer these over mocks)", "```", doubles, "```");
  if (examples.length) sections.push("", "## Existing tests in this module (follow their style, imports and fakes/helpers; the framework rules above win if they differ)", "```", examples.join("\n\n"), "```");
  if (existingGenerated) sections.push("", "## Current content of the generated test file (extend it; keep passing tests)", "```", existingGenerated, "```");
  if (opts.feedback) sections.push("", "## Feedback from the last attempt (fix these problems)", "```", opts.feedback, "```");
  sections.push("", "## Output", `Write the complete test file to \`${place.path}\` (agent mode), or return it in a single fenced code block and nothing else (\`unitgen generate\`).`);
  return { source: abs, testPath: place.path, suiteName: place.suiteName, markdown: sections.filter((s) => s !== undefined).join("\n"), uncovered };
}
