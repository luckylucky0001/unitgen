// HarmonyOS / OpenHarmony (ArkTS) via hvigor when available, otherwise the Node "shim" runner.
//
// Shim mode transpiles .ets with TypeScript, runs hypium-style tests against a compatible API
// and collects coverage with c8. It is faithful for pure logic (utils, models, view-models without
// platform calls); anything touching @kit.* / @ohos.* APIs is stubbed and should be verified with
// hvigor on a real toolchain. Because the shim does not run the ArkTS compiler, generated tests are
// also linted against the ArkTS language restrictions (arkts-no-any-unknown, ...).
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLcov } from "../coverage.ts";
import { errorExcerpt, exists, json5Parse, readFile, readJson, relPath, run, walkFiles, which, writeFile } from "../util.ts";
import type { Adapter, Doctor, FileKind, Module, RunRequest, TestCase, TestPlacement, TestRun } from "./types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM_DIR = path.join(HERE, "..", "data", "harmony");
const SUFFIX = ".unitgen.test.ets";

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
    return exists(path.join(root, "build-profile.json5")) && (exists(path.join(root, "oh-package.json5")) || exists(path.join(root, "hvigorfile.ts")));
  }

  private mode(): "hvigor" | "shim" {
    if (process.env.UNITGEN_HARMONY_MODE === "shim") return "shim";
    if (process.env.UNITGEN_HARMONY_MODE === "hvigor") return "hvigor";
    return this.hvigor() ? "hvigor" : "shim";
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

  private c8(): string | undefined {
    const req = createRequire(import.meta.url);
    try {
      return path.join(path.dirname(req.resolve("c8/package.json", { paths: [path.join(HERE, "..", "..")] })), "bin", "c8.js");
    } catch {
      return undefined;
    }
  }

  doctor(): Doctor {
    const lines: string[] = [];
    let ok = true;
    const mode = this.mode();
    lines.push(`runner: ${mode}${mode === "shim" ? " (Node + TypeScript + c8; hvigorw not found. Pure-logic code only; platform APIs are stubbed)" : ` (${this.hvigor()})`}`);
    if (mode === "shim") {
      if (!this.tsDir()) { ok = false; lines.push("typescript not found: run `npm install` in the unitgen directory"); }
      if (!this.c8()) { ok = false; lines.push("c8 not found: run `npm install` in the unitgen directory"); }
    }
    const ms = this.modules();
    lines.push(`modules: ${ms.map((m) => `${m.name} (${m.kind})`).join(", ") || "none"}`);
    return { ok, lines };
  }

  modules(): Module[] {
    if (this.mods) return this.mods;
    const bp = json5Parse(readFile(path.join(this.root, "build-profile.json5")));
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

  classify(file: string, text: string): FileKind {
    if (/\/generated\//.test(file) || /BuildProfile\.ets$/.test(file)) return "generated";
    if (/@Entry|@Component|@ComponentV2|@CustomDialog|@Builder\b|^\s*(export\s+)?struct\s+\w+/m.test(text)) return "ui";
    if (/extends\s+(UIAbility|AbilityStage|FormExtensionAbility|\w*ExtensionAbility)\b/.test(text)) return "entry";
    const platformImports = (text.match(/from\s+['"]@(kit|ohos|system)\.[^'"]+['"]/g) ?? []).length;
    const fns = (text.match(/\bfunction\s+\w+|\b\w+\s*\([^)]*\)\s*(:\s*[\w<>\[\]|, ]+)?\s*\{|=>\s*\{/g) ?? []).length;
    if (fns === 0) return "model";
    if (platformImports > 0 && this.mode() === "shim") return "platform";
    return "logic";
  }

  placement(source: string, m: Module): TestPlacement {
    const base = path.basename(source).replace(/\.(ets|ts)$/, "");
    const p = path.join(m.testRoot, `${base}${SUFFIX}`);
    let imp = relPath(source, path.dirname(p)).replace(/\.(ets|ts)$/, "");
    if (!imp.startsWith(".")) imp = `./${imp}`;
    return { path: p, suiteName: `${base}UnitGenTest`, importHint: `import { ... } from '${imp}';` };
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

  exampleTests(m: Module): string[] {
    const dirs = [path.join(m.dir, "src", "test"), path.join(m.dir, "src", "ohosTest", "ets", "test")];
    const files = dirs.flatMap((d) => walkFiles(d, [".ets", ".ts"])).filter((f) => !f.endsWith(SUFFIX) && !/List\.test\.ets$/.test(f));
    return files.filter((f) => fs.statSync(f).size > 300).sort((a, b) => fs.statSync(a).size - fs.statSync(b).size).slice(0, 2);
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

  runTests(req: RunRequest): TestRun {
    return this.mode() === "hvigor" ? this.runHvigor(req) : this.runShim(req);
  }

  private runShim(req: RunRequest): TestRun {
    const start = Date.now();
    const logFile = path.join(this.stateDir, "logs", `${req.label}.log`);
    const mods = req.modules ?? this.modules();
    const files = req.testFiles ?? mods.flatMap((m) => walkFiles(m.testRoot, [".test.ets", ".test.ts"]).filter((f) => !/List\.test\.ets$/.test(f)));
    const tsDir = this.tsDir();
    const c8 = this.c8();
    if (!tsDir || !c8) {
      return { ok: false, compiled: false, tests: [], logFile, excerpt: "", seconds: 0, infraError: "typescript/c8 missing: run `npm install` in the unitgen directory" };
    }
    if (!files.length) {
      writeFile(logFile, "no test files");
      return { ok: true, compiled: true, tests: [], coverage: {}, logFile, excerpt: "", seconds: 0 };
    }
    const work = path.join(this.stateDir, "harmony-shim", req.label);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    for (const f of ["hypium.cjs", "runner.cjs", "stub.cjs"]) fs.copyFileSync(path.join(SHIM_DIR, f), path.join(work, f));
    const results = path.join(work, "results.json");
    const ohm = path.join(this.root, "oh_modules");
    const lint = files.flatMap((f) => arktsLint(readFile(f)).map((x) => `${relPath(f, this.root)}:${x}`));
    const args = ["node", c8, "--reporter=lcov", `--report-dir=${path.join(work, "cov")}`, `--temp-directory=${path.join(work, "tmp")}`,
      "--exclude-after-remap", "--exclude=**/*.test.ets", "--exclude=**/*.test.ts", "--exclude=**/harmony-shim/**", "--exclude=**/oh_modules/**", "--exclude-node-modules",
      "node", path.join(work, "runner.cjs"), tsDir, results, exists(ohm) ? ohm : "-", ...files];
    const r = run(args, { cwd: this.root, timeoutSec: 900, logFile });
    const tests: TestCase[] = readJson<any[]>(results, []).map((t) => ({ name: t.name, status: t.status, message: t.message, file: t.file }));
    const loadFail = tests.filter((t: any) => t.name.startsWith("load ") && t.status === "failed");
    const compiled = loadFail.length === 0 && lint.length === 0;
    let coverage;
    const lcov = path.join(work, "cov", "lcov.info");
    if (req.coverage && exists(lcov)) {
      const roots = mods.flatMap((m) => m.sourceRoots.map((s) => s + path.sep));
      coverage = parseLcov(readFile(lcov), this.root, (f) => roots.some((s) => f.startsWith(s)));
    }
    let excerpt = "";
    if (lint.length) excerpt += `ArkTS restriction violations (the real ArkTS compiler would reject these):\n${lint.join("\n")}\n`;
    if (loadFail.length) excerpt += loadFail.map((t) => t.message).join("\n");
    if (!r.ok && !excerpt) excerpt = errorExcerpt(r.out);
    return {
      ok: r.ok && compiled, compiled, tests: tests.filter((t) => !t.name.startsWith("load ")), coverage, logFile,
      excerpt, seconds: (Date.now() - start) / 1000,
    };
  }

  private runHvigor(req: RunRequest): TestRun {
    const start = Date.now();
    const logFile = path.join(this.stateDir, "logs", `${req.label}.log`);
    const mods = req.modules ?? this.modules();
    // Local unit tests (src/test). Override with UNITGEN_HVIGOR_TEST_ARGS if your toolchain differs.
    const extra = (process.env.UNITGEN_HVIGOR_TEST_ARGS ?? "test -p coverage=true --no-daemon").split(/\s+/).filter(Boolean);
    const args = [this.hvigor()!, ...mods.flatMap((m) => ["-p", `module=${m.name}@default`]), ...extra];
    const r = run(args, { cwd: this.root, timeoutSec: 3600, logFile });
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
}

/** Approximate the ArkTS linter for the most common violations in generated tests. */
export function arktsLint(text: string): string[] {
  const out: string[] = [];
  const rules: [RegExp, string][] = [
    [/:\s*(any|unknown)\b|\bas\s+(any|unknown)\b|<(any|unknown)>/, "arkts-no-any-unknown: `any`/`unknown` are not allowed"],
    [/^\s*var\s/, "arkts-no-var: use let/const"],
    [/\bfor\s*\(\s*(const|let)\s+\w+\s+in\b/, "arkts-no-for-in"],
    [/^\s*(const|let)\s*[\[{]/, "arkts-no-destruct-decls: destructuring declarations are not allowed"],
    [/=\s*function\s*\(|\(\s*function\s*\(/, "arkts-no-func-expressions: use arrow functions"],
    [/\bdelete\s+\w/, "arkts-no-delete"],
    [/\{\s*\.\.\.\w/, "arkts-no-spread (object spread)"],
    [/\w\s*\[\s*['"][A-Za-z_]\w*['"]\s*\]/, "arkts-no-props-by-index: use obj.prop instead of obj['prop']"],
    [/\bas\s+const\b/, "arkts-no-as-const"],
    [/@ts-ignore|@ts-nocheck|@ts-expect-error/, "ArkTS forbids @ts-ignore / @ts-nocheck"],
    [/\bSymbol\(/, "arkts-no-symbol"],
    [/\bglobalThis\b/, "arkts-no-globalthis"],
    [/\bfunction\s*\*|\byield\b/, "arkts-no-generators"],
  ];
  text.split("\n").forEach((line, i) => {
    const l = line.replace(/\/\/.*$/, "").replace(/'(?:\\.|[^'])*'|"(?:\\.|[^"])*"|`(?:\\.|[^`])*`/g, (s) => (/\[\s*$/.test(line.slice(0, line.indexOf(s))) ? s : "''"));
    for (const [re, msg] of rules) if (re.test(l)) out.push(`${i + 1}: ${msg}`);
  });
  return out;
}
