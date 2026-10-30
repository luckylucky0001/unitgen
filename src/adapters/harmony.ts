import { runAsync } from "../util.ts";
// HarmonyOS / OpenHarmony (ArkTS) via hvigor when available, otherwise the Node "shim" runner.
//
// Shim mode transpiles .ets with TypeScript, runs hypium-style tests against a compatible API
// and collects V8 block coverage itself. It is faithful for pure logic (utils, models, view-models without
// platform calls); anything touching @kit.* / @ohos.* APIs is stubbed and should be verified with
// hvigor on a real toolchain. Because the shim does not run the ArkTS compiler, generated tests are
// also linted against the ArkTS language restrictions (arkts-no-any-unknown, ...).
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type Coverage, parseLcov } from "../coverage.ts";
import { estimateExecutable } from "../targets.ts";
import { errorExcerpt, exists, json5Parse, preferOwnTest, readFile, readJson, relPath, run, walkFiles, which, writeFile } from "../util.ts";
import type { Adapter, Doctor, FileKind, Module, RunRequest, TestCase, TestPlacement, TestRun } from "./types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM_DIR = path.join(HERE, "..", "data", "harmony");
const SUFFIX = ".unitgen.test.ets";
const arkui = createRequire(import.meta.url)(path.join(SHIM_DIR, "arkui.cjs")) as { stripArkUI(text: string): { text: string; names: string[] } };
const UI_RE = /@Entry|@Component|@ComponentV2|@CustomDialog|@Builder\b|^\s*(export\s+)?struct\s+\w+/m;
// System-API imports that do not make code platform-dependent: logging and error types.
const HARMLESS_IMPORTS = new Set(["hilog", "BusinessError"]);

/** build-profile.json5, or the committed template when the real one is git-ignored (it holds signing configs). */
function profilePath(root: string): string | undefined {
  for (const f of ["build-profile.json5", "build-profile.template.json5", "build-profile.example.json5", "build-profile.sample.json5"]) {
    if (exists(path.join(root, f))) return path.join(root, f);
  }
  return undefined;
}

/** Local names imported from @kit.* / @ohos.* / @system.* that the code (outside import lines) actually uses. */
export function usedPlatformImports(text: string): string[] {
  const body = text.replace(/^\s*import\s[^;\n]*(;|$)/gm, "");
  const out: string[] = [];
  for (const m of text.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]@(?:kit|ohos|system|arkts|hms)\.[^'"]+['"]/g)) {
    if (/^type\b/.test(m[0].replace(/^import\s+/, ""))) continue;
    const names = m[1].replace(/[{}]/g, " ").split(/[,\s]+/).filter(Boolean);
    // `a as b` -> b; `* as ns` -> ns
    const locals: string[] = [];
    for (let i = 0; i < names.length; i++) {
      if (names[i + 1] === "as") { locals.push(names[i + 2]); i += 2; } else if (names[i] !== "*" && names[i] !== "type") locals.push(names[i]);
    }
    for (const n of locals) if (n && !HARMLESS_IMPORTS.has(n) && new RegExp(`\\b${n.replace(/\$/g, "\\$")}\\b`).test(body)) out.push(n);
  }
  return [...new Set(out)];
}

export class HarmonyAdapter implements Adapter {
  readonly id = "harmony";
  readonly platform = "harmony" as const;
  readonly testFileSuffix = SUFFIX;
  private mods?: Module[];

  readonly root: string;
  private readonly stateDir: string;

  constructor(root: string, stateDir: string) {
    this.root = root;
    this.stateDir = stateDir;
  }

  static detect(root: string): boolean {
    return !!profilePath(root) && (exists(path.join(root, "oh-package.json5")) || exists(path.join(root, "hvigorfile.ts")));
  }

  private mode(): "hvigor" | "shim" {
    if (process.env.UNITGEN_HARMONY_MODE === "shim") return "shim";
    if (process.env.UNITGEN_HARMONY_MODE === "hvigor") return "hvigor";
    return this.hvigor() ? "hvigor" : "shim";
  }

  /** name -> absolute dir for `file:` dependencies (local modules), which need no ohpm install. */
  localDeps(): Record<string, string> {
    const out: Record<string, string> = {};
    const pkgs = [path.join(this.root, "oh-package.json5"), ...this.modules().map((m) => path.join(m.dir, "oh-package.json5"))].filter(exists);
    for (const p of pkgs) {
      try {
        const j = json5Parse(readFile(p));
        for (const [k, v] of Object.entries({ ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) })) {
          if (typeof v === "string" && v.startsWith("file:")) out[k] = path.resolve(path.dirname(p), v.slice(5));
        }
      } catch { /* ignore unreadable package files */ }
    }
    return out;
  }

  private remoteDeps(): Record<string, string> {
    const out: Record<string, string> = {};
    const pkgs = [path.join(this.root, "oh-package.json5"), ...this.modules().map((m) => path.join(m.dir, "oh-package.json5"))].filter(exists);
    for (const p of pkgs) {
      try {
        const j = json5Parse(readFile(p));
        for (const [k, v] of Object.entries(j.dependencies ?? {})) if (typeof v === "string" && !v.startsWith("file:")) out[k] = v;
      } catch { /* ignore */ }
    }
    return out;
  }

  private hvigor(): string | undefined {
    const local = path.join(this.root, "hvigorw");
    if (exists(local)) return local;
    return which("hvigorw");
  }

  private tsDir(): string | undefined {
    const req = createRequire(import.meta.url);
    for (const base of [process.env.UNITGEN_TS_DIR, path.join(HERE, "..", "..")].filter(Boolean) as string[]) {
      try {
        return path.dirname(req.resolve("typescript/package.json", { paths: [base] }));
      } catch { /* try next */ }
    }
    return undefined;
  }

  doctor(): Doctor {
    const lines: string[] = [];
    let ok = true;
    const mode = this.mode();
    lines.push(`runner: ${mode}${mode === "shim" ? " (Node + TypeScript + V8 coverage; hvigorw not found. Pure-logic code only; platform APIs are stubbed)" : ` (${this.hvigor()})`}`);
    if (mode === "shim") {
      if (!this.tsDir()) { ok = false; lines.push("typescript not found: run `npm install` in the unitgen directory"); }
    }
    const ms = this.modules();
    lines.push(`modules: ${ms.map((m) => `${m.name} (${m.kind})`).join(", ") || "none"}`);
    const profile = profilePath(this.root)!;
    if (path.basename(profile) !== "build-profile.json5") {
      lines.push(`note: build-profile.json5 is missing (git-ignored?); modules read from ${path.basename(profile)}. Copy it to build-profile.json5 before building with hvigor/DevEco.`);
      if (mode === "hvigor") { ok = false; lines.push("hvigor needs build-profile.json5: create it from the template, or use UNITGEN_HARMONY_MODE=shim"); }
    }
    if (!ms.length) { ok = false; lines.push("no module with src/main/ets found in the build profile"); }
    const declared = [path.join(this.root, "oh-package.json5"), ...ms.map((m) => path.join(m.dir, "oh-package.json5"))].filter(exists)
      .some((p) => /"dependencies"\s*:\s*\{\s*"/.test(readFile(p).replace(/\/\/.*$/gm, "")));
    if (declared && !exists(path.join(this.root, "oh_modules")) && Object.keys(this.remoteDeps()).length) {
      lines.push("warning: oh-package.json5 declares dependencies but oh_modules/ is missing: run `ohpm install`. Until then files importing those packages are ranked as `platform` and cannot be verified.");
    }
    const pkgs = [path.join(this.root, "oh-package.json5"), ...ms.map((m) => path.join(m.dir, "oh-package.json5"))].filter(exists);
    if (!pkgs.some((p) => readFile(p).includes("@ohos/hypium"))) {
      lines.push("warning: no oh-package.json5 declares @ohos/hypium; add it to devDependencies before running the generated tests with hvigor/DevEco (the Node shim does not need it)");
    }
    return { ok, lines };
  }

  modules(): Module[] {
    if (this.mods) return this.mods;
    const bp = json5Parse(readFile(profilePath(this.root)!));
    const out: Module[] = [];
    for (const m of bp.modules ?? []) {
      const dir = path.resolve(this.root, m.srcPath ?? m.name);
      const ets = path.join(dir, "src", "main", "ets");
      if (!exists(ets)) continue;
      const modJson = path.join(dir, "src", "main", "module.json5");
      let kind = "har";
      try {
        kind = json5Parse(readFile(modJson)).module?.type ?? "har";
      } catch { /* keep default */ }
      out.push({ name: m.name, dir, sourceRoots: [ets], testRoot: path.join(dir, "src", "test"), kind });
    }
    this.mods = out;
    return out;
  }

  moduleFor(file: string): Module | undefined {
    const abs = path.resolve(file);
    return this.modules().filter((m) => abs.startsWith(m.dir + path.sep)).sort((a, b) => b.dir.length - a.dir.length)[0];
  }

  sourceFiles(m: Module): string[] {
    return m.sourceRoots.flatMap((r) => walkFiles(r, [".ets", ".ts"])).filter((f) => !f.endsWith(".d.ts") && !f.endsWith(".d.ets"));
  }

  /** Code outside ArkUI structs/builders: what the shim actually runs and measures. */
  estimateText(text: string): string {
    return UI_RE.test(text) ? arkui.stripArkUI(text).text : text;
  }

  classify(file: string, full: string): FileKind {
    if (/\/generated\//.test(file) || /BuildProfile\.ets$/.test(file)) return "generated";
    let text = full;
    if (UI_RE.test(full)) {
      // Components often sit next to exported helpers / view models in the same file: those are logic.
      text = arkui.stripArkUI(full).text;
      const exported = /^\s*export\s+(default\s+)?(abstract\s+)?(class|function|const|let)\s+\w+/m.test(text.replace(/^\s*export\s+(default\s+)?class\s+\w+\s*\{\}\s*$/gm, ""));
      if (!exported || estimateExecutable(text).length < 5) return "ui";
    }
    if (/extends\s+(UIAbility|AbilityStage|FormExtensionAbility|\w*ExtensionAbility)\b/.test(text)) return "entry";
    const platformImports = usedPlatformImports(text).length;
    const fns = (text.match(/\bfunction\s+\w+|\b\w+\s*\([^)]*\)\s*(:\s*[\w<>\[\]|, ]+)?\s*\{|=>\s*\{/g) ?? []).length;
    if (fns === 0) return "model";
    if (this.mode() === "shim") {
      // $r()/$rawfile() resource references load fine as stubs; enum/global *usage* in logic does not.
      if (platformImports > 0 || /\b(Color|Alignment|ButtonStyleMode|AppStorage|getContext)\./.test(text)) return "platform";
      const ohm = path.join(this.root, "oh_modules");
      const third = [...text.matchAll(/from\s+['"](@[\w-]+\/[^'"]+|[a-z][^'".]*)['"]/g)].map((m) => m[1]).filter((p) => p !== "@ohos/hypium");
      const local = this.localDeps();
      if (third.some((p) => !exists(path.join(ohm, p)) && !local[p])) return "platform";
    }
    return "logic";
  }

  placement(source: string, m: Module): TestPlacement {
    let base = path.basename(source).replace(/\.(ets|ts)$/, "");
    // Several modules dirs often have a helpers.ets / utils.ets: prefix the parent dir(s) to keep names unique.
    const same = this.sourceFiles(m).filter((f) => path.basename(f).replace(/\.(ets|ts)$/, "") === base);
    if (same.length > 1) {
      const parts = path.dirname(source).split(path.sep).filter((p) => !["scripts", "utils", "src", "main", "ets"].includes(p));
      base = `${parts[parts.length - 1] ?? "x"}-${base}`;
    }
    const p = path.join(m.testRoot, `${base}${SUFFIX}`);
    let imp = relPath(source, path.dirname(p)).replace(/\.(ets|ts)$/, "");
    if (!imp.startsWith(".")) imp = `./${imp}`;
    const ident = base.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^[0-9]/, "_$&");
    const suite = `${ident[0].toUpperCase()}${ident.slice(1)}UnitGenTest`;
    // APIs -> apisUnitGenTest, JhUtils -> jhUtilsUnitGenTest, URLParser -> urlParserUnitGenTest
    const fn = suite.replace(/^([A-Z]+)(?=[A-Z][a-z]|UnitGen)/, (r) => r.toLowerCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());
    return { path: p, suiteName: suite, importHint: `import { ... } from '${imp}';  // and: export default function ${fn}() { describe('${suite}', () => { ... }) }` };
  }

  conventions(m: Module): string {
    const shim = this.mode() === "shim";
    return [
      `Platform: HarmonyOS ArkTS module \`${m.name}\` (${m.kind}). Local unit test file in ${relPath(m.testRoot, this.root)}/ using @ohos/hypium.`,
      "Structure (exactly this shape):",
      "```ts",
      "import { describe, it, expect, beforeEach } from '@ohos/hypium';",
      "import { Foo } from '../main/ets/path/to/Foo';",
      "",
      "export default function fooUnitGenTest() {",
      "  describe('FooUnitGenTest', () => {",
      "    it('returnsEmptyForEmptyInput', 0, () => {",
      "      expect(new Foo().parse('')).assertDeepEquals([]);",
      "    });",
      "  });",
      "}",
      "```",
      "Matchers: assertEqual (===), assertDeepEquals, assertTrue, assertFalse, assertNull, assertUndefined, assertContain, assertClose(v, eps), assertLarger/assertLess(OrEqual), assertInstanceOf('TypeName'), assertThrowError('exact message') on a function, assertNaN, .not().assertX(), await expect(p).assertPromiseIsResolvedWith(v) / assertPromiseIsRejected().",
      "ArkTS restrictions (the real compiler rejects violations): no `any`/`unknown`; object literals must match a declared class/interface type; no destructuring assignment; no `var`; no function expressions (use arrows); no `for..in`; no indexed access on non-array objects (obj['k']); no `delete`; no object spread; declare explicit types for empty arrays (`const xs: number[] = []`).",
      "it(name, 0, fn): the second argument is the test attribute; always pass 0. Async tests: `it('x', 0, async () => { ... })`.",
      shim
        ? "This environment runs tests on Node with @kit.* / @ohos.* APIs stubbed (they do nothing). Only test code paths that do not depend on platform API results; do not assert on values returned by system APIs."
        : "Tests run with hvigor (local unit test).",
    ].join("\n");
  }

  exampleTests(m: Module, source?: string): string[] {
    const dirs = [path.join(m.dir, "src", "test"), path.join(m.dir, "src", "ohosTest", "ets", "test")];
    // Skip DevEco's generated boilerplate (LocalUnit.test.ets / Ability.test.ets templates).
    const files = dirs.flatMap((d) => walkFiles(d, [".ets", ".ts"]))
      .filter((f) => !f.endsWith(SUFFIX) && !/List\.test\.ets$/.test(f) && !/Defines a test suite|Presets an action/.test(readFile(f)));
    return preferOwnTest(files, source, files.filter((f) => fs.statSync(f).size > 300).sort((a, b) => fs.statSync(a).size - fs.statSync(b).size));
  }

  /** Register the file in src/test/List.test.ets so hvigor runs it too. */
  prepareTestFile(testFile: string, m: Module): void {
    fs.mkdirSync(path.dirname(testFile), { recursive: true });
    if (path.dirname(testFile) !== m.testRoot) return;
    const list = path.join(m.testRoot, "List.test.ets");
    const fnName = exists(testFile) ? /export\s+default\s+function\s+(\w+)/.exec(readFile(testFile))?.[1] : undefined;
    if (!fnName) return;
    const imp = `import ${fnName} from './${path.basename(testFile).replace(/\.ets$/, "")}';`;
    let text = exists(list) ? readFile(list) : "export default function testsuite() {\n}\n";
    if (text.includes(imp)) return;
    text = `${imp}\n${text}`.replace(/(export\s+default\s+function\s+\w+\s*\(\s*\)\s*\{)/, `$1\n  ${fnName}();`);
    writeFile(list, text);
  }

  forgetTestFile(testFile: string, m: Module): void {
    const list = path.join(m.testRoot, "List.test.ets");
    if (!exists(list)) return;
    const mod = path.basename(testFile).replace(/\.ets$/, "");
    const text = readFile(list);
    const imp = new RegExp(`^import\\s+(\\w+)\\s+from\\s+'\\./${mod.replace(/[.]/g, "\\.")}';\\n`, "m").exec(text);
    if (!imp) return;
    writeFile(list, text.replace(imp[0], "").replace(new RegExp(`^\\s*${imp[1]}\\(\\);\\n`, "m"), ""));
  }

  async runTests(req: RunRequest): Promise<TestRun> {
    return this.mode() === "hvigor" ? this.runHvigor(req) : this.runShim(req);
  }

  private async runShim(req: RunRequest): Promise<TestRun> {
    const start = Date.now();
    const logFile = path.join(this.stateDir, "logs", `${req.label}.log`);
    const mods = req.modules ?? this.modules();
    const files = req.testFiles ?? mods.flatMap((m) => walkFiles(m.testRoot, [".test.ets", ".test.ts"]).filter((f) => !/List\.test\.ets$/.test(f)));
    const tsDir = this.tsDir();
    if (!tsDir) {
      return { ok: false, compiled: false, tests: [], logFile, excerpt: "", seconds: 0, infraError: "typescript missing: run `npm install` in the unitgen directory" };
    }
    if (!files.length) {
      writeFile(logFile, "no test files");
      return { ok: true, compiled: true, tests: [], coverage: {}, logFile, excerpt: "", seconds: 0, emptyCoverageOk: true };
    }
    // One run at a time per project: clear leftovers from earlier runs (coverage JSONs are large).
    if (process.env.UNITGEN_KEEP_COV !== "1") fs.rmSync(path.join(this.stateDir, "harmony-shim"), { recursive: true, force: true });
    const work = path.join(this.stateDir, "harmony-shim", req.label);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    for (const f of ["hypium.cjs", "runner.cjs", "stub.cjs", "buildprofile.cjs", "arkui.cjs"]) fs.copyFileSync(path.join(SHIM_DIR, f), path.join(work, f));
    const results = path.join(work, "results.json");
    const ohm = path.join(this.root, "oh_modules");
    // Only unitgen's own files are linted: the project's existing tests already pass its ArkTS compiler.
    const lint = files.filter((f) => f.endsWith(SUFFIX)).flatMap((f) => {
      const text = readFile(f);
      const imported = importedSources(f, text);
      return [...arktsLint(text, imported.map((x) => x.text).join("\n")), ...importLint(text, imported)].map((x) => `${relPath(f, this.root)}:${x}`);
    });
    // Coverage comes straight from V8 (NODE_V8_COVERAGE) on the transpiled JS under <work>/gen and is
    // mapped back to .ets lines here; see v8LineCoverage for why c8's line rule is not used.
    const args = ["node", path.join(work, "runner.cjs"), tsDir, results, exists(ohm) ? ohm : "-", ...files];
    const r = await runAsync(args, { cwd: work, timeoutSec: req.timeoutSec ?? 900, logFile, env: {
      UNITGEN_LOCAL_DEPS: JSON.stringify(this.localDeps()), UNITGEN_ROOT: this.root,
      ...(req.coverage ? { NODE_V8_COVERAGE: path.join(work, "tmp") } : {}),
    } });
    const raw = readJson<any[]>(results, []);
    const tests: TestCase[] = raw.map((t) => ({ name: t.name, status: t.status, message: t.message, file: t.file }));
    // Failures of existing (non-unitgen) tests that called stubbed system APIs are shim limits.
    const failing = raw.filter((t) => t.status === "failed" && !t.name.startsWith("load "));
    const explained = failing.length > 0 && failing.every((t) => (t.stubs ?? []).length > 0 && !(t.file ?? "").endsWith(SUFFIX))
      ? `they call system APIs that are stubbed under the Node shim (${[...new Set(failing.flatMap((t) => t.stubs as string[]))].slice(0, 6).join(", ")}); run them in DevEco/hvigor`
      : undefined;
    if (!exists(results) && r.ok === false && !r.timedOut) {
      return { ok: false, compiled: false, tests: [], logFile, seconds: (Date.now() - start) / 1000, excerpt: errorExcerpt(r.out),
        infraError: "the Node shim runner crashed before writing results; see the log" };
    }
    const loadFail = tests.filter((t: any) => t.name.startsWith("load ") && t.status === "failed");
    // A syntax error inside production code (not the test file) is a shim limitation, not the test's fault.
    const prodSyntax = loadFail.map((t) => /SyntaxError: (\S+\.(?:ets|ts)):\d+/.exec(t.message ?? "")?.[1]).filter((f): f is string => !!f && !files.includes(f));
    if (prodSyntax.length) {
      return { ok: false, compiled: false, tests: [], logFile, seconds: (Date.now() - start) / 1000, excerpt: loadFail.map((t) => t.message).join("\n"),
        infraError: `the Node shim cannot parse ${[...new Set(prodSyntax)].map((f) => relPath(f, this.root)).join(", ")} (ArkTS syntax TypeScript does not support). Verify with hvigor/DevEco or pick another target.` };
    }
    const compiled = loadFail.length === 0 && lint.length === 0;
    let coverage;
    const v8dir = path.join(work, "tmp");
    if (req.coverage && exists(v8dir)) {
      const roots = mods.flatMap((m) => m.sourceRoots.map((s) => s + path.sep));
      const maps = readJson<Record<string, { source: string; lines: (number | null)[]; segs?: [number, number, number][] }>>(path.join(work, "linemaps.json"), {});
      const mapped: Coverage = {};
      for (const f of fs.readdirSync(v8dir).filter((x) => x.endsWith(".json"))) {
        for (const script of readJson<any>(path.join(v8dir, f), { result: [] }).result) {
          const gen = script.url.startsWith("file://") ? fileURLToPath(script.url) : script.url;
          const m = maps[gen];
          if (!m || !roots.some((s) => m.source.startsWith(s)) || /\.test\.(ets|ts)$/.test(m.source)) continue;
          const dst = (mapped[m.source] ??= {});
          if (m.segs) {
            for (const [k, hits] of Object.entries(segmentLineCoverage(readFile(gen), script.functions, m.segs))) {
              const ln = Number(k);
              dst[ln] = dst[ln] === undefined ? hits : Math.min(dst[ln], hits);
            }
            continue;
          }
          for (const [ln, hits] of Object.entries(v8LineCoverage(readFile(gen), script.functions))) {
            const src = m.lines[Number(ln)];
            if (!src) continue;
            // Several JS lines can come from one .ets line: the line counts as covered only if all ran.
            dst[src] = dst[src] === undefined ? hits : Math.min(dst[src], hits);
          }
        }
      }
      coverage = dropNonCode(mapped);
    }
    const stubs = readJson<{ modules: string[]; globals: string[]; ui?: { file: string; names: string[] }[] }>(results.replace(/\.json$/, ".stubs.json"), { modules: [], globals: [] });
    const missing = [...new Set(tests.map((t) => /UNITGEN_MISSING_PACKAGE (\S+)/.exec(t.message ?? "")?.[1]).filter(Boolean))];
    if (missing.length) {
      return { ok: false, compiled: false, tests: [], logFile, seconds: (Date.now() - start) / 1000, excerpt: "",
        infraError: `ohpm packages not installed: ${missing.join(", ")}. Run \`ohpm install\` in ${this.root} (needs the DevEco/ohpm toolchain), then verify again.` };
    }
    // A ReferenceError for a global the project never declares is an ArkUI/system global the shim lacks.
    const projectText = mods.flatMap((m) => this.sourceFiles(m)).map((f) => readFile(f)).join("\n");
    const missingGlobals = [...new Set(tests.flatMap((t) => [...(t.message ?? "").matchAll(/ReferenceError: ([A-Za-z_$][\w$]*) is not defined/g)].map((m) => m[1])))]
      .filter((g) => !new RegExp(`\\b(class|enum|interface|function|const|let|var|namespace|struct)\\s+${g.replace(/\$/g, "\\$")}\\b`).test(projectText));
    if (missingGlobals.length) {
      return { ok: false, compiled: false, tests: [], logFile, seconds: (Date.now() - start) / 1000, excerpt: "",
        infraError: `the code under test uses ArkUI/system globals the Node shim does not provide: ${missingGlobals.join(", ")}. Test only paths that avoid them, verify with hvigor/DevEco, or pick another target.` };
    }
    let excerpt = "";
    if (stubs.modules.length || stubs.globals.length) {
      excerpt += `Note: stubbed under the Node shim (values are meaningless, do not assert on them): ${[...stubs.modules, ...stubs.globals].join(", ")}\n`;
    }
    for (const u of stubs.ui ?? []) excerpt += `Note: ArkUI components in ${relPath(u.file, this.root)} (${u.names.join(", ")}) are empty stand-ins under the Node shim.\n`;
    if (lint.length) excerpt += `ArkTS restriction violations (the real ArkTS compiler would reject these):\n${lint.join("\n")}\n`;
    if (loadFail.length) excerpt += loadFail.map((t) => t.message).join("\n");
    if (!r.ok && !excerpt) excerpt = errorExcerpt(r.out);
    if (process.env.UNITGEN_KEEP_COV !== "1") fs.rmSync(work, { recursive: true, force: true });
    return {
      ok: r.ok && compiled, compiled, tests: tests.filter((t) => !t.name.startsWith("load ")), coverage, logFile,
      excerpt, seconds: (Date.now() - start) / 1000, infraError: r.timedOut ? "timeout" : undefined,
      failuresExplained: explained, emptyCoverageOk: true,
    };
  }

  private async runHvigor(req: RunRequest): Promise<TestRun> {
    const start = Date.now();
    const logFile = path.join(this.stateDir, "logs", `${req.label}.log`);
    const mods = req.modules ?? this.modules();
    // Local unit tests (src/test). Override with UNITGEN_HVIGOR_TEST_ARGS if your toolchain differs.
    const extra = (process.env.UNITGEN_HVIGOR_TEST_ARGS ?? "test -p coverage=true --no-daemon").split(/\s+/).filter(Boolean);
    const args = [this.hvigor()!, ...mods.flatMap((m) => ["-p", `module=${m.name}@default`]), ...extra];
    const r = await runAsync(args, { cwd: this.root, timeoutSec: 3600, logFile });
    const tests: TestCase[] = [];
    for (const line of r.out.split("\n")) {
      const m = /(?:OHOS_REPORT_STATUS: test=|\[(?:pass|fail)\]\s*)(\S+)/i.exec(line);
      if (m) tests.push({ name: m[1], status: /fail/i.test(line) ? "failed" : "passed" });
    }
    let coverage;
    for (const m of mods) {
      const lcovs = walkFiles(path.join(m.dir, ".test"), [".info"]).concat(walkFiles(path.join(m.dir, "build"), ["lcov.info"]));
      for (const l of lcovs) coverage = { ...(coverage ?? {}), ...parseLcov(readFile(l), m.dir) };
    }
    const compiled = !/ArkTS:ERROR|ERROR: ArkTS|Compile failed/i.test(r.out);
    return { ok: r.ok, compiled, tests, coverage, logFile, excerpt: r.ok ? "" : errorExcerpt(r.out), seconds: (Date.now() - start) / 1000 };
  }

  countAssertions(text: string): number {
    return (text.match(/\.assert\w+\s*\(/g) ?? []).length;
  }

  /** Problems the model should know before writing a test for `source`. */
  briefWarnings(source: string): string[] {
    const text = readFile(source);
    const out: string[] = [];
    const ohm = path.join(this.root, "oh_modules");
    const pkgs = [...text.matchAll(/from\s+['"]([^'".][^'"]*)['"]/g)].map((m) => m[1]).filter((p) => p !== "@ohos/hypium");
    const system = pkgs.filter((p) => /^@(kit|ohos|system|arkts|hms)\./.test(p));
    const thirdParty = pkgs.filter((p) => !/^@(kit|ohos|system|arkts|hms)\./.test(p));
    const local = this.localDeps();
    const missing = thirdParty.filter((p) => !exists(path.join(ohm, p)) && !local[p]);
    if (missing.length) out.push(`Imports ohpm packages that are not installed (${missing.join(", ")}): tests will fail with INFRA_ERROR until \`ohpm install\` runs. Pick another target if you cannot install them.`);
    if (system.length && this.mode() === "shim") out.push(`Imports system APIs that are stubbed under the Node shim (${system.join(", ")}): only test code paths whose results do not come from these APIs.`);
    const exported = exportedNames(text);
    if (exported && exported.size === 0) out.push("The file exports nothing, so a test cannot import any of its code (module-private functions/classes are unreachable). Pick another target; testing it needs the logic moved into an exported module.");
    if (UI_RE.test(text) && this.mode() === "shim") {
      const names = arkui.stripArkUI(text).names;
      out.push(`Declares ArkUI components/builders (${names.join(", ")}): under the Node shim they are replaced by empty stand-ins, so their members (including private methods and build()) cannot be tested here. Test the exported code outside them.`);
    }
    if (/@(ObservedV2|Trace|Observed|Track|Local|Param|Monitor|Computed)\b/.test(text) && this.mode() === "shim") out.push("Uses ArkUI state-management decorators: they are no-ops under the shim (no change tracking), so test plain logic, not reactivity.");
    if (/(\b(Color|Alignment|FlexAlign|FontWeight|ButtonStyleMode|AppStorage|getContext)\b|\$r\s*\(|\$rawfile\s*\()/.test(text) && this.mode() === "shim") out.push("Uses ArkUI globals (Color, Alignment, $r, AppStorage, ...): they are inert stubs under the shim, so do not assert on their values.");
    return out;
  }
}

type V8Function = { ranges: { startOffset: number; endOffset: number; count: number }[] };

/**
 * V8 ranges relevant to line coverage, outermost first. V8 also reports ranges for short-circuited
 * sub-expressions (`a?.b()`, `x && f()`, `x ?? f()`, ternary branches); they start at the operator.
 * Those are branch coverage: a line whose statement ran is covered even if `?.b()` was skipped, so
 * they are dropped. Function ranges and statement-level block ranges (`{`, `case`, `return` after
 * an early exit) are kept.
 */
function lineRanges(js: string, functions: V8Function[]): V8Function["ranges"] {
  return functions.flatMap((f) => f.ranges.filter((r, i) => i === 0 || !/^[?&|:]/.test(js.slice(r.startOffset, r.startOffset + 1))))
    .sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
}

/**
 * Line hits from raw V8 block coverage: a line's count is the lowest count of the innermost range
 * covering each of its non-blank characters. c8/v8-to-istanbul instead treat a line as uncovered only
 * when one zero-count range spans the whole line, which marks `case X: return y;` lines as covered
 * when only the `return` part's range is zero.
 */
export function v8LineCoverage(js: string, functions: V8Function[]): Record<number, number> {
  const ranges = lineRanges(js, functions);
  const out: Record<number, number> = {};
  let offset = 0;
  js.split("\n").forEach((line, i) => {
    let min: number | undefined;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === " " || line[c] === "\t" || line[c] === "\r") continue;
      const o = offset + c;
      // Ranges are sorted outermost first: the last match is the innermost.
      let count: number | undefined;
      for (const r of ranges) if (r.startOffset <= o && o < r.endOffset) count = r.count;
      if (count !== undefined) min = min === undefined ? count : Math.min(min, count);
    }
    if (min !== undefined && line.trim()) out[i + 1] = min;
    offset += line.length + 1;
  });
  return out;
}

/**
 * Original-line hits from V8 block coverage and the transpiler's source-map segments: each segment
 * (a token position in the generated JS) takes the count of the innermost range around it, and an
 * original line gets the lowest count of its segments. Unlike mapping whole generated lines, this keeps
 * lines TypeScript merges into one (`if (` + first condition) and lines it splits. Block braces are
 * skipped: the `{` that opens a never-run block belongs to the block, not to the `if (...)` line.
 */
export function segmentLineCoverage(js: string, functions: V8Function[], segs: [number, number, number][]): Record<number, number> {
  const ranges = lineRanges(js, functions);
  const starts: number[] = [0];
  for (let i = 0; i < js.length; i++) if (js[i] === "\n") starts.push(i + 1);
  const out: Record<number, number> = {};
  for (const [genLine, genCol, srcLine] of segs) {
    const o = (starts[genLine - 1] ?? Infinity) + genCol;
    const ch = js[o];
    if (ch === undefined || ch === "{" || ch === "}" || /\s/.test(ch)) continue;
    let count: number | undefined;
    for (const r of ranges) if (r.startOffset <= o && o < r.endOffset) count = r.count;
    if (count !== undefined) out[srcLine] = out[srcLine] === undefined ? count : Math.min(out[srcLine], count);
  }
  return out;
}

/** V8 line coverage counts blank and comment lines; keep only lines with code on them. */
function dropNonCode(cov: Coverage): Coverage {
  const out: Coverage = {};
  for (const [file, lines] of Object.entries(cov)) {
    let inBlock = false;
    let typeDepth = 0;
    const code = new Set<number>();
    readFile(file).split("\n").forEach((raw, i) => {
      let l = raw.trim();
      // Interfaces and type aliases are erased by the compiler: never executable.
      if (typeDepth > 0 || /^(export\s+)?(declare\s+)?(interface|type)\s+\w+/.test(l)) {
        const opens = (l.match(/\{/g) ?? []).length;
        const closes = (l.match(/\}/g) ?? []).length;
        typeDepth += opens - closes;
        if (typeDepth < 0) typeDepth = 0;
        return;
      }
      if (/^import\s/.test(l) || /^export\s*\{[^}]*\}\s*(from\s.*)?;?$/.test(l)) return;
      if (inBlock) {
        const end = l.indexOf("*/");
        if (end < 0) return;
        inBlock = false;
        l = l.slice(end + 2).trim();
      }
      if (l.startsWith("/*")) {
        const end = l.indexOf("*/");
        if (end < 0) {
          inBlock = true;
          return;
        }
        l = l.slice(end + 2).trim();
      }
      // Lines with only closing brackets carry no logic of their own.
      if (l && !l.startsWith("//") && !/^[})\];,]+$/.test(l)) code.add(i + 1);
    });
    out[file] = Object.fromEntries(Object.entries(lines).filter(([ln]) => code.has(Number(ln))));
  }
  return out;
}

/** Relative imports of a test file that resolve to project sources: specifier, absolute path, text. */
function importedSources(testFile: string, text: string): { spec: string; file: string; text: string; line: number; names: string[] }[] {
  const out: { spec: string; file: string; text: string; line: number; names: string[] }[] = [];
  for (const m of text.matchAll(/^\s*import\s+(?:type\s+)?\{([^}]*)\}\s*from\s+['"](\.[^'"]+)['"]/gm)) {
    const base = path.resolve(path.dirname(testFile), m[2]);
    const file = [base, `${base}.ets`, `${base}.ts`, path.join(base, "Index.ets"), path.join(base, "index.ets"), path.join(base, "index.ts")]
      .find((c) => exists(c) && fs.statSync(c).isFile());
    if (!file) continue;
    const names = m[1].split(",").map((x) => x.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean);
    out.push({ spec: m[2], file, text: readFile(file), line: text.slice(0, m.index).split("\n").length + (m[0].match(/^\s*\n/)?.[0].split("\n").length ?? 1) - 1, names });
  }
  return out;
}

/** Names a module exports, or undefined when it re-exports with `export *` (cannot tell cheaply). */
export function exportedNames(text: string): Set<string> | undefined {
  if (/^\s*export\s+\*\s+from/m.test(text)) return undefined;
  const out = new Set<string>();
  for (const m of text.matchAll(/^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|interface|function\*?|const|let|var|enum|type|struct|namespace)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of text.matchAll(/^\s*export\s*(?:type\s*)?\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) out.add(name);
    }
  }
  return out;
}

/** `import { X } from '../main/ets/...'` where X is not exported: the ArkTS compiler rejects it, the shim would not. */
export function importLint(text: string, imported: { spec: string; text: string; line: number; names: string[] }[]): string[] {
  const out: string[] = [];
  for (const imp of imported) {
    const exported = exportedNames(imp.text);
    if (!exported) continue;
    const missing = imp.names.filter((n) => !exported.has(n));
    if (missing.length) out.push(`${imp.line}: ${missing.map((n) => `'${n}'`).join(", ")} ${missing.length > 1 ? "are" : "is"} not exported by '${imp.spec}' (module-private code can only be tested through what the module exports)`);
  }
  return out;
}

/**
 * Approximate the ArkTS linter for the most common violations in generated tests. `context` is the
 * source of the modules the test imports, used to recognise Record-typed fields (`obj['k']` is legal
 * on a Record<K, V>).
 */
export function arktsLint(text: string, context = ""): string[] {
  const out: string[] = [];
  const records = new Set([...`${text}\n${context}`.matchAll(/([A-Za-z_$][\w$]*)\??\s*:\s*Record\s*</g)].map((m) => m[1]));
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?=\s*[^;\n]*\bas\s+Record\s*</g)) records.add(m[1]);
  const rules: [RegExp, string][] = [
    [/:\s*(any|unknown)\b|\bas\s+(any|unknown)\b|<(any|unknown)>/, "arkts-no-any-unknown: `any`/`unknown` are not allowed"],
    [/^\s*var\s/, "arkts-no-var: use let/const"],
    [/\bfor\s*\(\s*(const|let)\s+\w+\s+in\b/, "arkts-no-for-in"],
    [/^\s*(const|let)\s*[\[{]/, "arkts-no-destruct-decls: destructuring declarations are not allowed"],
    [/=\s*function\s*\(|\(\s*function\s*\(/, "arkts-no-func-expressions: use arrow functions"],
    [/\bdelete\s+\w/, "arkts-no-delete"],
    [/\{\s*\.\.\.\w/, "arkts-no-spread (object spread)"],
    [/\bas\s+const\b/, "arkts-no-as-const"],
    [/@ts-ignore|@ts-nocheck|@ts-expect-error/, "ArkTS forbids @ts-ignore / @ts-nocheck"],
    [/\bSymbol\(/, "arkts-no-symbol"],
    [/\bglobalThis\b/, "arkts-no-globalthis"],
    [/^\s*(const|let)\s+\w+\s*=\s*\{/, "arkts-no-untyped-obj-literals: declare the variable with an interface/class type"],
    [/^\s*(const|let)\s+\w+\s*=\s*\[\s*\]/, "untyped empty array: write `const xs: T[] = []`"],
    [/\bfunction\s*\*|\byield\b/, "arkts-no-generators"],
  ];
  text.split("\n").forEach((line, i) => {
    const l = line.replace(/\/\/.*$/, "").replace(/'(?:\\.|[^'])*'|"(?:\\.|[^"])*"|`(?:\\.|[^`])*`/g, (s) => (/\[\s*$/.test(line.slice(0, line.indexOf(s))) ? s : "''"));
    for (const [re, msg] of rules) if (re.test(l)) out.push(`${i + 1}: ${msg}`);
    // Indexed access with a string literal is legal on Record<K, V> (and arrays), not on class instances.
    const byIndex = [...l.matchAll(/([A-Za-z_$][\w$]*)\s*\[\s*['"][A-Za-z_]\w*['"]\s*\]/g)].filter((m) => !records.has(m[1]));
    if (byIndex.length) out.push(`${i + 1}: arkts-no-props-by-index: use obj.prop instead of obj['prop'] (allowed only on Record types)`);
  });
  return out;
}
