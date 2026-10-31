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
import { errorExcerpt, exists, json5Parse, log, preferOwnTest, readFile, readJson, relPath, runAsync, stripAnsi, walkFiles, which, writeFile } from "../util.ts";
import type { Adapter, Doctor, FileKind, Module, RunRequest, TestCase, TestPlacement, TestRun } from "./types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM_DIR = path.join(HERE, "..", "data", "harmony");
const SUFFIX = ".unitgen.test.ets";
const arkui = createRequire(import.meta.url)(path.join(SHIM_DIR, "arkui.cjs")) as {
  stripArkUI(text: string): { text: string; names: string[] };
  codeLines(ts: unknown, text: string, fileName: string): Set<number>;
};
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

/** Installed @ohos/hypium: version and whether expect(...).message() exists (added in 1.0.19). */
export function hypiumInfo(root: string): { version?: string; hasMessage: boolean } | undefined {
  const ohm = path.join(root, "oh_modules");
  const store = path.join(ohm, ".ohpm");
  const dirs = [
    ...(exists(store) ? fs.readdirSync(store).filter((d) => d.startsWith("@ohos+hypium@")).sort().reverse().map((d) => path.join(store, d, "oh_modules", "@ohos", "hypium")) : []),
    path.join(ohm, "@ohos", "hypium"),
  ].filter((d) => exists(path.join(d, "oh-package.json5")));
  if (!dirs.length) return undefined;
  const dir = dirs[0];
  let version: string | undefined;
  try { version = json5Parse(readFile(path.join(dir, "oh-package.json5"))).version; } catch { /* unknown */ }
  const sources = walkFiles(path.join(dir, "src"), [".js", ".ts", ".ets"]).concat(walkFiles(dir, [".d.ts"]));
  return { version, hasMessage: sources.some((f) => /\bmessage\s*\(/.test(readFile(f))) };
}

/** a < b for dotted numeric versions. */
function versionLess(a: string, b: string): boolean {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

function json5ParseSafe(file: string): { name?: string } | undefined {
  try { return json5Parse(readFile(file)); } catch { return undefined; }
}

function profileIsReal(root: string): boolean {
  return exists(path.join(root, "build-profile.json5"));
}

interface Toolchain {
  hvigor: string;
  home?: string;
  sdk?: string;
  sdkVersion?: string;
  /** API level of the installed SDK (sdk/default/sdk-pkg.json). */
  sdkApi?: number;
  /** Extra environment for hvigor: DEVECO_SDK_HOME and the bundled node/ohpm on PATH. */
  env: Record<string, string>;
}

/**
 * DevEco Studio (macOS app bundle, Windows/Linux install dir) or Command Line Tools for HarmonyOS:
 * hvigorw, the bundled Node.js and ohpm, and the SDK. DEVECO_STUDIO_HOME / DEVECO_SDK_HOME override.
 */
export function findToolchain(root: string, env: NodeJS.ProcessEnv = process.env): Toolchain | undefined {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const homes = [env.DEVECO_STUDIO_HOME, env.DEVECO_HOME, env.HARMONYOS_CLT_HOME,
    "/Applications/DevEco-Studio.app/Contents", path.join(home, "Applications", "DevEco-Studio.app", "Contents"),
    "C:\\Program Files\\Huawei\\DevEco Studio", path.join(home, "command-line-tools"), "/opt/command-line-tools", "/opt/deveco-studio"]
    .filter((h): h is string => !!h && exists(h));
  const exe = process.platform === "win32" ? "hvigorw.bat" : "hvigorw";
  for (const h of homes) {
    const hvigor = [path.join(h, "tools", "hvigor", "bin", exe), path.join(h, "bin", exe), path.join(h, "hvigor", "bin", exe)].find(exists);
    if (!hvigor) continue;
    return toolchainAt(hvigor, h, env);
  }
  // Older projects ship their own wrapper; hvigorw on PATH (CI images).
  const local = [path.join(root, exe), which(exe)].find((x): x is string => !!x && exists(x));
  return local ? toolchainAt(local, undefined, env) : undefined;
}

function toolchainAt(hvigor: string, home: string | undefined, env: NodeJS.ProcessEnv): Toolchain {
  const bins = home ? [path.join(home, "tools", "node", "bin"), path.join(home, "tool", "node", "bin"), path.join(home, "tools", "node"),
    path.join(home, "tools", "ohpm", "bin"), path.join(home, "ohpm", "bin"), path.join(home, "bin")].filter(exists) : [];
  const sdk = env.DEVECO_SDK_HOME ?? (home && exists(path.join(home, "sdk")) ? path.join(home, "sdk") : undefined);
  let sdkVersion: string | undefined;
  let sdkApi: number | undefined;
  try {
    if (sdk) {
      const d = json5Parse(readFile(path.join(sdk, "default", "sdk-pkg.json"))).data;
      sdkVersion = d?.displayName;
      sdkApi = d?.apiVersion !== undefined ? Number(d.apiVersion) : undefined;
    }
  } catch { /* unknown layout */ }
  const out: Record<string, string> = {};
  if (sdk) out.DEVECO_SDK_HOME = sdk;
  if (bins.length) out.PATH = [...bins, env.PATH ?? ""].join(path.delimiter);
  return { hvigor, home, sdk, sdkVersion, sdkApi, env: out };
}

/** hypium's test_result.txt: `class=`, `test=`, message lines, `result=Success|Failure|Error|Ignore`. */
export function parseHypiumResults(text: string): TestCase[] {
  const out: TestCase[] = [];
  let cls = "";
  let name: string | undefined;
  let msg: string[] = [];
  for (const line of text.split("\n")) {
    let m: RegExpExecArray | null;
    if ((m = /^class=(.*)$/.exec(line))) { cls = m[1].trim(); continue; }
    if ((m = /^test=(.*)$/.exec(line))) { name = m[1].trim(); msg = []; continue; }
    if ((m = /^result=(\w+)/.exec(line)) && name !== undefined) {
      const r = m[1];
      const status = r === "Success" ? "passed" : r === "Ignore" ? "skipped" : "failed";
      // Failure = an assertion failed; Error = an exception or timeout (reported like a crash).
      const message = msg.join("\n").trim();
      out.push({ name: cls ? `${cls} > ${name}` : name, status, message: status === "failed" ? (r === "Error" ? `Error: ${message}` : `AssertionError: ${message}`) : undefined });
      name = undefined;
      continue;
    }
    if (name !== undefined && !/^Tests run:/.test(line)) msg.push(line);
  }
  return out;
}

type HvigorRegion = { startLoc: { line: number; col: number }; endLoc: { line: number; col: number }; count: number };
type HvigorFile = { path: string; functions?: { count: number; regions: HvigorRegion[] }[]; summary?: { lines?: { executedLineCount?: number[] } } };

/**
 * coverageReport.json from `hvigorw test -p ohos-test-coverage=true`: per file, executedLineCount[line]
 * (-1 = not executable). The tool also reports function *types* in annotations (`const f: (a: T) => U =`,
 * `fn: (v: T) => U`) as never-called functions; a zero line that only such regions touch is not code
 * that a test could run, so it is dropped. `source` reads a file (injectable for tests).
 */
export function parseHvigorCoverage(json: string, sourceRoots: string[], source: (f: string) => string = readFile): Coverage {
  const out: Coverage = {};
  let data: { files?: HvigorFile[] };
  try { data = JSON.parse(json); } catch { return out; }
  for (const f of data.files ?? []) {
    const file = path.resolve(f.path);
    if (!sourceRoots.some((r) => file.startsWith(r + path.sep))) continue;
    const counts = f.summary?.lines?.executedLineCount ?? [];
    let text: string[] = [];
    try { text = source(file).split("\n"); } catch { /* keep raw counts */ }
    const regionText = (r: HvigorRegion) => {
      const ls = text.slice(r.startLoc.line - 1, r.endLoc.line);
      if (!ls.length) return "";
      ls[ls.length - 1] = ls[ls.length - 1].slice(0, Math.max(0, r.endLoc.col - 1));
      ls[0] = ls[0].slice(Math.max(0, r.startLoc.col - 1));
      return ls.join("\n");
    };
    // In a type position (after `:`), without a body, and returning a type: `(a: T) => U | V[]`.
    // An object-literal arrow (`add: (a, b) => { ... }` or `=> a + b`) is real code.
    const phantom = (r: HvigorRegion) => {
      const before = (text[r.startLoc.line - 1] ?? "").slice(0, Math.max(0, r.startLoc.col - 1)).replace(/<[^<>]*>\s*$/, "").trimEnd();
      const body = regionText(r);
      return before.endsWith(":") && !body.includes("{") && /=>\s*[A-Za-z_$][\w$.]*(\s*<[^>]*>)?(\[\])*(\s*\|\s*[A-Za-z_$][\w$.]*(\s*<[^>]*>)?(\[\])*)*\s*$/.test(body);
    };
    const realZero = new Set<number>();
    const phantomZero = new Set<number>();
    for (const fn of f.functions ?? []) {
      for (const r of fn.regions ?? []) {
        if (r.count !== 0) continue;
        const target = fn.count === 0 && phantom(fn.regions[0]) ? phantomZero : realZero;
        for (let l = r.startLoc.line; l <= r.endLoc.line; l++) target.add(l);
      }
    }
    const lines: Record<number, number> = {};
    counts.forEach((c, i) => {
      if (typeof c !== "number" || c < 0 || i === 0) return;
      if (c === 0 && phantomZero.has(i) && !realZero.has(i)) return;
      lines[i] = c;
    });
    out[file] = lines;
  }
  return out;
}

/** ArkTS compiler / linter errors with their file positions. */
export function parseArkTsErrors(text: string): { file: string; line: number; col: number; message: string }[] {
  const out: { file: string; line: number; col: number; message: string }[] = [];
  for (const m of text.matchAll(/Error Message: (.*?) At File: (.+?):(\d+):(\d+)\s*$/gm)) out.push({ message: m[1].trim(), file: m[2].trim(), line: Number(m[3]), col: Number(m[4]) });
  for (const m of text.matchAll(/ArkTS:ERROR File: (.+?):(\d+):(\d+)\s*\n\s*(.+)/g)) out.push({ file: m[1].trim(), line: Number(m[2]), col: Number(m[3]), message: m[4].trim() });
  return out;
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
    return this.hvigorBlocker() ? "shim" : "hvigor";
  }

  /** Why the real toolchain cannot run this project's local unit tests (undefined = it can). */
  private hvigorBlocker(): string | undefined {
    if (!this.modules().length) return "no module with src/main/ets in the build profile";
    if (!this.toolchain()) return "no DevEco Studio / Command Line Tools for HarmonyOS found (set DEVECO_STUDIO_HOME)";
    if (!profileIsReal(this.root)) return "build-profile.json5 is missing (only a template is committed)";
    if (!this.hypiumDeclared()) return "no oh-package.json5 declares @ohos/hypium (devDependencies), which local unit tests need";
    if (!exists(path.join(this.root, "oh_modules"))) return "oh_modules/ is missing: run `ohpm install` in the project";
    // hvigor refuses an explicit compileSdkVersion other than the installed SDK's API level.
    const tc = this.toolchain()!;
    const want = this.compileApi();
    if (want !== undefined && tc.sdkApi !== undefined && want !== tc.sdkApi) {
      return `build-profile.json5 sets compileSdkVersion API ${want}, but the installed DevEco SDK is API ${tc.sdkApi} (hvigor refuses to build; remove compileSdkVersion or install the matching DevEco)`;
    }
    // A pinned hvigor plugin version is downloaded through npm, which needs ~/.npmrc.
    const cfg = path.join(this.root, "hvigor", "hvigor-config.json5");
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    if (exists(cfg) && /"@ohos\/hvigor(-ohos-plugin)?"\s*:\s*"[^"]+"/.test(readFile(cfg).replace(/\/\/.*$/gm, "")) && !exists(path.join(home, ".npmrc"))) {
      return "hvigor/hvigor-config.json5 pins an hvigor plugin version, which hvigor downloads with npm, but ~/.npmrc does not exist (configure the npm registry as in the DevEco docs, or open the project once in DevEco Studio)";
    }
    return undefined;
  }

  /** API level of an explicit compileSdkVersion ("6.1.1(24)" or 24), if any. */
  private compileApi(): number | undefined {
    try {
      const products = json5Parse(readFile(profilePath(this.root)!)).app?.products ?? [];
      const v = products.find((p: { name?: string }) => p.name === this.product())?.compileSdkVersion ?? products[0]?.compileSdkVersion;
      if (v === undefined) return undefined;
      const m = /\((\d+)\)\s*$/.exec(String(v)) ?? /^(\d+)$/.exec(String(v));
      return m ? Number(m[1]) : undefined;
    } catch { return undefined; }
  }

  private hyp?: ReturnType<typeof hypiumInfo> | null;
  hypium(): ReturnType<typeof hypiumInfo> {
    if (this.hyp === undefined) this.hyp = hypiumInfo(this.root) ?? null;
    return this.hyp ?? undefined;
  }

  /** Uses of hypium API the project's installed version does not have. */
  hypiumLint(text: string): string[] {
    const h = this.hypium();
    if (!h || h.hasMessage) return [];
    const out: string[] = [];
    text.split("\n").forEach((l, i) => {
      if (/\.message\s*\(/.test(l.replace(/\/\/.*$/, ""))) out.push(`${i + 1}: expect(...).message() does not exist in the project's @ohos/hypium ${h.version ?? ""} (added in 1.0.19): remove it`);
    });
    return out;
  }

  /** Packages a module's sources import that neither its oh-package.json5 nor `file:` deps declare. */
  private undeclaredDeps(m: Module): string[] {
    const pkg = path.join(m.dir, "oh-package.json5");
    let declared: Record<string, unknown> = {};
    try { const j = json5Parse(readFile(pkg)); declared = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) }; } catch { /* none */ }
    const used = new Set<string>();
    for (const f of this.sourceFiles(m)) {
      for (const x of readFile(f).matchAll(/from\s+['"]((?:@[\w-]+\/)?[\w][\w.-]*)[^'"]*['"]/g)) {
        if (!/^@(kit|ohos|system|arkts|hms)\./.test(x[1]) && !x[1].startsWith(".")) used.add(x[1].split("/").slice(0, x[1].startsWith("@") ? 2 : 1).join("/"));
      }
    }
    return [...used].filter((p) => !(p in declared) && p !== m.name && p !== json5ParseSafe(pkg)?.name);
  }

  private hypiumDeclared(): boolean {
    return [path.join(this.root, "oh-package.json5"), ...this.modules().map((m) => path.join(m.dir, "oh-package.json5"))]
      .filter(exists).some((p) => readFile(p).includes("@ohos/hypium"));
  }

  private tc?: Toolchain | null;
  private toolchain(): Toolchain | undefined {
    if (this.tc === undefined) this.tc = findToolchain(this.root) ?? null;
    return this.tc ?? undefined;
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
    const tc = this.toolchain();
    const blocker = this.hvigorBlocker();
    lines.push(`runner: ${mode}${mode === "shim"
      ? ` (Node + TypeScript + V8 coverage; pure-logic code only, platform APIs are stubbed${blocker && process.env.UNITGEN_HARMONY_MODE !== "shim" ? `. hvigor not used: ${blocker}` : ""})`
      : ` (hvigor local unit tests in the Previewer runtime: ${tc?.hvigor ?? "hvigorw not found"})`}`);
    if (tc) lines.push(`toolchain: ${tc.home ?? path.dirname(tc.hvigor)}${tc.sdk ? `; SDK ${tc.sdk}${tc.sdkVersion ? ` (${tc.sdkVersion})` : ""}` : ""}`);
    if (mode === "hvigor" && blocker) { ok = false; lines.push(`hvigor mode cannot run: ${blocker}`); }
    const hyp = this.hypium();
    if (hyp?.version) {
      lines.push(`hypium: ${hyp.version}${hyp.hasMessage ? "" : " (no expect().message())"}`);
      if (mode === "hvigor" && versionLess(hyp.version, "1.0.19")) {
        lines.push(`warning: @ohos/hypium ${hyp.version} reports coverage through printSync, which the Previewer does not deliver for larger runs (1.0.6 delivered none at all). Upgrade the devDependency to 1.0.19 or newer if verify reports a coverage problem.`);
      }
    }
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
    if (!this.hypiumDeclared() && pkgs.length) {
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
    // System APIs are stubs under the shim and mostly mocks in hvigor's Previewer runtime: either way
    // a unit test cannot exercise them, so such files rank below pure logic.
    // $r()/$rawfile() resource references load fine; enum/global *usage* in logic does not.
    // A few functions calling system APIs in an otherwise pure-logic file (url helpers with one
    // url.URL call) still make it a logic target: rank by how much of the code touches them.
    if (platformImports > 0 || /\b(Color|Alignment|ButtonStyleMode|AppStorage|getContext)\./.test(text)) {
      const names = [...usedPlatformImports(text), "Color", "Alignment", "ButtonStyleMode", "AppStorage", "getContext"];
      const body = text.split("\n").filter((l) => !/^\s*import\s/.test(l));
      const touching = body.filter((l) => names.some((n) => new RegExp(`\\b${n.replace(/\$/g, "\\$")}\\b`).test(l))).length;
      // Several kits, or many lines touching them (system objects kept in fields are not counted, so
      // breadth matters too): a platform file.
      const kits = new Set([...text.matchAll(/from\s+['"](@(?:kit|ohos|system|arkts|hms)\.[^'"]+)['"]/g)].map((m) => m[1]));
      if (kits.size >= 3 || touching * 10 >= estimateExecutable(text).length) return "platform";
    }
    if (this.mode() === "shim") {
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
      `Matchers: assertEqual (===), assertDeepEquals, assertTrue, assertFalse, assertNull, assertUndefined, assertContain, assertClose(v, eps), assertLarger/assertLess(OrEqual), assertInstanceOf('TypeName'), assertThrowError('exact message') on a function, assertNaN, .not().assertX(), await expect(p).assertPromiseIsResolvedWith(v) / assertPromiseIsRejected().${this.hypium()?.hasMessage ? " `.message('ctx')` before a matcher labels the failure." : " Do NOT use `.message()`: the project's @ohos/hypium does not have it (added in 1.0.19); put the context into the test name instead."}`,
      "expect() takes a value: never pass a call that returns void.",
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

  platformLines(text: string): Set<number> {
    const names = [...usedPlatformImports(text), "AppStorage", "AppStorageV2", "PersistentStorage", "getContext"];
    const out = new Set<number>();
    text.split("\n").forEach((l, i) => {
      if (/^\s*import\s/.test(l) || /^\s*\/\//.test(l)) return;
      if (names.some((n) => new RegExp(`(?<![\\w$.])${n.replace(/\$/g, "\\$")}\\s*[.(]`).test(l))) out.add(i + 1);
    });
    return out;
  }

  get platformLinesNote(): string {
    return this.mode() === "hvigor" ? "mostly a mock in the Previewer runtime" : "an inert stub under the Node shim";
  }

  /** Runner description for the brief and reports. */
  get runnerName(): string {
    return this.mode() === "hvigor" ? "hvigor (ArkTS compiler + Previewer runtime)" : "Node shim";
  }

  private async runShim(req: RunRequest): Promise<TestRun> {
    const start = Date.now();
    const logFile = path.join(this.stateDir, "logs", `${req.label}.log`);
    const mods = req.modules ?? this.modules();
    const files = req.testFiles ?? mods.flatMap((m) => walkFiles(m.testRoot, [".test.ets", ".test.ts"])
      .filter((f) => !/List\.test\.ets$/.test(f) && !(req.excludeGenerated && f.endsWith(SUFFIX))));
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
      return [...arktsLint(text, imported.map((x) => x.text).join("\n")), ...importLint(text, imported), ...this.hypiumLint(text)].map((x) => `${relPath(f, this.root)}:${x}`);
    });
    // Coverage comes straight from V8 (NODE_V8_COVERAGE) on the transpiled JS under <work>/gen and is
    // mapped back to .ets lines here; see v8LineCoverage for why c8's line rule is not used.
    const args = [process.execPath, path.join(work, "runner.cjs"), tsDir, results, exists(ohm) ? ohm : "-", ...files];
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
      const what = `the Node shim cannot parse ${[...new Set(prodSyntax)].map((f) => relPath(f, this.root)).join(", ")} (ArkTS syntax TypeScript does not support). Verify with hvigor/DevEco or pick another target.`;
      // For a mutant this simply means "does not compile"; verify reports it as an environment problem.
      return { ok: false, compiled: false, tests: [], logFile, seconds: (Date.now() - start) / 1000, excerpt: loadFail.map((t) => t.message).join("\n"),
        ...(req.testFiles ? { compileErrorOutsideTests: what } : { infraError: what }) };
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

  private listJournal(): string {
    return path.join(this.stateDir, "harmony-list.json");
  }

  recover(): void {
    this.restoreIfCrashed();
  }

  /** A run that was killed while List.test.ets was swapped for an isolated one: put the original back. */
  private restoreIfCrashed(): void {
    const j = readJson<{ list: string; backup: string | null }[] | null>(this.listJournal(), null);
    if (!j) return;
    for (const e of j) {
      if (e.backup === null) fs.rmSync(e.list, { force: true });
      else if (exists(e.backup)) { fs.copyFileSync(e.backup, e.list); fs.rmSync(e.backup, { force: true }); }
      log(`restored ${relPath(e.list, this.root)} after an interrupted run`);
    }
    fs.rmSync(this.listJournal(), { force: true });
  }

  /** Point List.test.ets at exactly these test files (hvigor compiles what the list imports). Returns a restore fn. */
  private swapList(m: Module, files: string[]): () => void {
    const list = path.join(m.testRoot, "List.test.ets");
    const backup = path.join(this.stateDir, `List.test.ets.${m.name.replace(/\W+/g, "_")}.backup`);
    fs.mkdirSync(this.stateDir, { recursive: true });
    const had = exists(list);
    if (had) fs.copyFileSync(list, backup);
    writeFile(this.listJournal(), JSON.stringify([{ list, backup: had ? backup : null }]));
    const imports: string[] = [];
    const calls: string[] = [];
    files.forEach((f, i) => {
      const fn = /export\s+default\s+function\s+(\w+)/.exec(readFile(f))?.[1];
      if (!fn) return;
      let rel = relPath(f, m.testRoot).replace(/\.ets$/, "");
      if (!rel.startsWith(".")) rel = `./${rel}`;
      imports.push(`import t${i} from '${rel}';`);
      calls.push(`  t${i}();`);
    });
    writeFile(list, `${imports.join("\n")}\n\nexport default function testsuite() {\n${calls.join("\n")}\n}\n`);
    return () => {
      if (had) { fs.copyFileSync(backup, list); fs.rmSync(backup, { force: true }); } else fs.rmSync(list, { force: true });
      fs.rmSync(this.listJournal(), { force: true });
    };
  }

  /** Test files List.test.ets currently imports (what a full hvigor run executes). */
  private listedTests(m: Module): string[] {
    const list = path.join(m.testRoot, "List.test.ets");
    if (!exists(list)) return [];
    return [...readFile(list).matchAll(/^\s*import\s+\w+\s+from\s+['"](\.[^'"]+)['"]/gm)]
      .map((x) => [path.resolve(m.testRoot, x[1]), path.resolve(m.testRoot, x[1]) + ".ets"].find((c) => exists(c) && fs.statSync(c).isFile()))
      .filter((f): f is string => !!f);
  }

  private async runHvigor(req: RunRequest): Promise<TestRun> {
    this.restoreIfCrashed();
    const start = Date.now();
    const logFile = path.join(this.stateDir, "logs", `${req.label}.log`);
    const tc = this.toolchain();
    const blocker = this.hvigorBlocker();
    if (!tc || blocker) {
      return { ok: false, compiled: false, tests: [], logFile, excerpt: "", seconds: 0, infraError: `hvigor mode cannot run: ${blocker ?? "toolchain missing"}. UNITGEN_HARMONY_MODE=shim runs pure-logic tests without it` };
    }
    let mods = req.modules ?? this.modules();
    if (req.testFiles) mods = mods.filter((m) => req.testFiles!.some((f) => this.moduleFor(f)?.name === m.name));
    // Old hypium versions compile `.message()` (loosely typed) but fail at runtime with an empty error.
    const pre = (req.testFiles ?? []).flatMap((f) => this.hypiumLint(readFile(f)).map((x) => `${relPath(f, this.root)}:${x}`));
    if (pre.length) {
      writeFile(logFile, pre.join("\n"));
      return { ok: false, compiled: false, tests: [], logFile, excerpt: pre.join("\n"), seconds: 0 };
    }
    const tests: TestCase[] = [];
    const coverage: Coverage = {};
    const excerpts: string[] = [];
    const notes: string[] = [];
    let ok = true, compiled = true;
    let infraError: string | undefined;
    let outside: string | undefined;
    let skipped = 0;
    const unbuildable: Record<string, string> = {};
    let coverageProblem: string | undefined;
    let combinedLog = "";
    for (const m of mods) {
      // hvigor's generated test entry imports src/test/List.test.ets: a module without one has no local tests.
      if (!req.testFiles && !exists(path.join(m.testRoot, "List.test.ets"))) continue;
      let files = req.testFiles?.filter((f) => this.moduleFor(f)?.name === m.name)
        ?? (req.excludeGenerated ? this.listedTests(m).filter((f) => !f.endsWith(SUFFIX)) : undefined);
      // A full run executes List.test.ets; existing tests that do not compile are dropped (and reported)
      // so one stale test file does not hide every other test's result.
      const dropped: string[] = [];
      let settled = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const r = await this.hvigorModuleRun(m, tc, files, req, `${req.label}-${m.name.replace(/\W+/g, "_")}${attempt ? `-retry${attempt}` : ""}`);
        combinedLog += r.log;
        if (r.infraError) {
          infraError = `${r.infraError}${r.infraError === "timeout" ? "" : " (hvigor environment problem; fix it, or set UNITGEN_HARMONY_MODE=shim to run pure-logic tests on Node)"}`;
          excerpts.push(r.excerpt); ok = false; settled = true; break;
        }
        if (!r.compiled) {
          const own = new Set((req.testFiles ?? []).map((f) => path.resolve(f)));
          const badTests = [...new Set(r.errorFiles.filter((f) => f.startsWith(m.testRoot + path.sep) && !own.has(f) && !/List\.test\.ets$/.test(f)))];
          // Anything outside this module's test sources: its own code, other modules, generated pages.
          const badProd = r.errorFiles.filter((f) => !f.startsWith(m.testRoot + path.sep));
          if (!req.testFiles && badTests.length && !badProd.length) {
            dropped.push(...badTests);
            files = (files ?? this.listedTests(m)).filter((f) => !badTests.includes(f));
            continue;
          }
          // Full runs: a module whose production code does not build in local-test mode (e.g. resources
          // of a dependency that hvigor does not resolve there) is reported and skipped, not fatal.
          if (!req.testFiles && badProd.length && mods.length > 1) {
            const undeclared = this.undeclaredDeps(m);
            const why = undeclared.length
              ? `it imports ${undeclared.join(", ")} without declaring ${undeclared.length > 1 ? "them" : "it"} in ${relPath(path.join(m.dir, "oh-package.json5"), this.root)}, so hvigor builds the module without ${undeclared.length > 1 ? "their" : "its"} resources (add ${undeclared.length > 1 ? "them" : "it"} to the module's dependencies)`
              : `its code does not compile with hvigor`;
            const reason = `${why}: ${[...new Set(badProd)].slice(0, 2).map((f) => relPath(f, this.root)).join(", ")}: ${r.excerpt.split("\n")[0].replace(/^.*?: /, "")}`;
            notes.push(`module ${m.name} skipped: ${reason}; its files cannot be verified with hvigor (UNITGEN_HARMONY_MODE=shim can test their pure logic)`);
            unbuildable[m.name] = reason;
            skipped++;
            settled = true;
            break;
          }
          compiled = false; ok = false;
          excerpts.push(r.excerpt);
          // Production code that does not compile is not the test's fault (verify reports it as an
          // environment problem); for a mutant it just means the mutant is discarded.
          if (badProd.length && !r.errorFiles.some((f) => own.has(f))) {
            outside = `production code does not compile with the ArkTS compiler: ${[...new Set(badProd)].map((f) => relPath(f, this.root)).join(", ")}`;
          }
          break;
        }
        tests.push(...r.tests);
        Object.assign(coverage, r.coverage);
        if (r.coverageProblem) coverageProblem = r.coverageProblem;
        if (r.tests.some((t) => t.status === "failed")) ok = false;
        if (!r.tests.length && r.excerpt) excerpts.push(r.excerpt);
        settled = true;
        break;
      }
      // Every attempt still found existing tests that do not compile: that is a failed run, not an empty one.
      if (!settled && !infraError && compiled) {
        compiled = false; ok = false;
        excerpts.push(`existing tests in module ${m.name} still do not compile after excluding ${dropped.length}: ${dropped.map((f) => relPath(f, this.root)).join(", ")}`);
      }
      if (dropped.length) notes.push(`excluded existing tests that do not compile with the ArkTS compiler: ${dropped.map((f) => relPath(f, this.root)).join(", ")}`);
    }
    writeFile(logFile, combinedLog);
    if (skipped && skipped === mods.filter((m) => req.testFiles || exists(path.join(m.testRoot, "List.test.ets"))).length) { compiled = false; ok = false; }
    const failedMsgs = tests.filter((t) => t.status === "failed").map((t) => `FAILED ${t.name}\n${t.message ?? ""}`);
    return {
      ok: ok && !infraError, compiled, tests, coverage: req.coverage ? coverage : undefined, logFile,
      excerpt: [...excerpts, ...failedMsgs.slice(0, 10)].filter(Boolean).join("\n"), seconds: (Date.now() - start) / 1000,
      infraError, note: [...notes, coverageProblem].filter(Boolean).join("; ") || undefined, emptyCoverageOk: true, compileErrorOutsideTests: outside, coverageProblem,
      ...(Object.keys(unbuildable).length ? { unbuildable } : {}),
    };
  }

  private async hvigorModuleRun(m: Module, tc: Toolchain, files: string[] | undefined, req: RunRequest, label: string):
    Promise<{ compiled: boolean; tests: TestCase[]; coverage: Coverage; errorFiles: string[]; excerpt: string; log: string; infraError?: string; coverageProblem?: string }> {
    const buildRoot = ".test";
    const out = path.join(m.dir, buildRoot, "default");
    const resultFile = path.join(out, "intermediates", "test", "coverage_data", "test_result.txt");
    const reportFile = path.join(out, "outputs", "test", "reports", "coverageReport.json");
    // Stale results survive a failed compile: never read a previous run's files.
    fs.rmSync(path.dirname(resultFile), { recursive: true, force: true });
    fs.rmSync(path.dirname(reportFile), { recursive: true, force: true });
    const product = this.product();
    const extra = process.env.UNITGEN_HVIGOR_TEST_ARGS?.split(/\s+/).filter(Boolean)
      ?? ["-p", "isLocalTest=true", "-p", "unitTestMode=true", "-p", `buildRoot=${buildRoot}`, ...(req.coverage ? ["-p", "ohos-test-coverage=true"] : []), "test",
        // The hvigor daemon makes repeated runs (verify, every mutant) ~3x faster (3.2 s -> 1.1 s on a
        // small module); it picks up source changes like a cold build. UNITGEN_HVIGOR_DAEMON=0 disables it.
        process.env.UNITGEN_HVIGOR_DAEMON === "0" ? "--no-daemon" : "--daemon"];
    const args = [tc.hvigor, "--mode", "module", "-p", `module=${m.name}@default`, "-p", `product=${product}`, ...extra];
    const restore = files ? this.swapList(m, files) : undefined;
    let r;
    try {
      r = await runAsync(args, { cwd: this.root, timeoutSec: req.timeoutSec ?? 1800, logFile: path.join(this.stateDir, "logs", `${label}.log`), env: tc.env });
    } finally {
      restore?.();
    }
    const text = stripAnsi(r.out);
    const log = `$ ${args.join(" ")}\n${text}\n`;
    if (r.timedOut) return { compiled: true, tests: [], coverage: {}, errorFiles: [], excerpt: "", log, infraError: "timeout" };
    const infra = /SDK (?:component|path)[^\n]*(?:missing|not found|invalid)[^\n]*|Unable to find the SDK[^\n]*|ohpm ERROR[^\n]*|Cannot find module '@ohos\/hypium'[^\n]*|Invalid value of 'DEVECO_SDK_HOME'[^\n]*|00303\d{3}[^\n]*/i.exec(text)?.[0];
    const errors = parseArkTsErrors(text);
    const compileFailed = /COMPILE RESULT:FAIL|ArkTS Compiler Error|Failed :[\w:]+@(?:UnitTest|Legacy)\w*ArkTS/.test(text);
    if (compileFailed) {
      const excerpt = errors.length ? errors.slice(0, 20).map((e) => `${relPath(e.file, this.root)}:${e.line}:${e.col}: ${e.message}`).join("\n") : errorExcerpt(text);
      return { compiled: false, tests: [], coverage: {}, errorFiles: errors.map((e) => e.file), excerpt, log, infraError: errors.length ? undefined : infra };
    }
    if (!exists(resultFile)) {
      return { compiled: true, tests: [], coverage: {}, errorFiles: [], excerpt: errorExcerpt(text), log,
        infraError: infra ?? (r.ok ? undefined : "hvigor failed before running the tests; see the log") };
    }
    const single = files?.length === 1 ? files[0] : undefined;
    const tests = parseHypiumResults(readFile(resultFile)).map((t) => ({ ...t, file: single }));
    const coverage = exists(reportFile) ? this.dropTypeOnlyLines(parseHvigorCoverage(readFile(reportFile), m.sourceRoots)) : {};
    // Tests ran and passed, but not one line anywhere was recorded: the coverage data never arrived.
    const passed = tests.filter((t) => t.status === "passed").length;
    const anyHit = Object.values(coverage).some((lines) => Object.values(lines).some((h) => h > 0));
    let coverageProblem: string | undefined;
    // Only suspicious when the tests that ran import project code (IDE template tests touch none).
    const ran = files ?? this.listedTests(m);
    const local = Object.keys(this.localDeps());
    const touchesProject = ran.some((f) => {
      const t = readFile(f);
      return /from\s+['"]\.{1,2}\/[^'"]*main\/ets\//.test(t) || local.some((d) => t.includes(`'${d}`) || t.includes(`"${d}`));
    });
    if (req.coverage && passed > 0 && !anyHit && touchesProject) {
      const v = this.hypium()?.version;
      coverageProblem = `hvigor recorded 0 executed lines although ${passed} test(s) passed${exists(reportFile) ? "" : " (no coverageReport.json)"}: the coverage data never reached hvigor. `
        + `${v && versionLess(v, "1.0.19") ? `@ohos/hypium ${v} sends it through printSync, which the Previewer drops: upgrade @ohos/hypium (devDependencies) to 1.0.19 or newer and run \`ohpm install\`. ` : ""}`
        + "Or use UNITGEN_HARMONY_MODE=shim for pure-logic files.";
    }
    return { compiled: true, tests, coverage, errorFiles: [], excerpt: "", log, coverageProblem };
  }

  /**
   * hvigor's coverage tool counts lines of a declaration's type annotation (`const f: (a: T) => U =`
   * spread over several lines) as executable and never covered. Keep only lines that produce code;
   * a line with hits is always kept.
   */
  private dropTypeOnlyLines(cov: Coverage): Coverage {
    const tsDir = this.tsDir();
    if (!tsDir) return cov;
    const ts = createRequire(import.meta.url)(tsDir);
    for (const [file, lines] of Object.entries(cov)) {
      let code: Set<number>;
      try { code = arkui.codeLines(ts, readFile(file), file); } catch { continue; }
      for (const ln of Object.keys(lines)) if (lines[Number(ln)] === 0 && !code.has(Number(ln))) delete lines[Number(ln)];
    }
    return cov;
  }

  private product(): string {
    try {
      return json5Parse(readFile(profilePath(this.root)!)).app?.products?.[0]?.name ?? "default";
    } catch { return "default"; }
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
    if (system.length) {
      out.push(this.mode() === "shim"
        ? `Imports system APIs that are stubbed under the Node shim (${system.join(", ")}): only test code paths whose results do not come from these APIs.`
        : `Imports system APIs (${system.join(", ")}): local unit tests run in the Previewer, where most of them are mocks or unavailable. Test the logic around them; do not assert on what they return.`);
    }
    const exported = exportedNames(text);
    if (exported && exported.size === 0) out.push("The file exports nothing, so a test cannot import any of its code (module-private functions/classes are unreachable). Pick another target; testing it needs the logic moved into an exported module.");
    if (UI_RE.test(text) && this.mode() === "shim") {
      const names = arkui.stripArkUI(text).names;
      out.push(`Declares ArkUI components/builders (${names.join(", ")}): under the Node shim they are replaced by empty stand-ins, so their members (including private methods and build()) cannot be tested here. Test the exported code outside them.`);
    }
    if (/@(ObservedV2|Trace|Observed|Track|Local|Param|Monitor|Computed)\b/.test(text)) {
      out.push(`Uses ArkUI state-management decorators${this.mode() === "shim" ? " (no change tracking under the Node shim: test plain logic, not reactivity)" : ""}. Arrays/Maps/Sets/Dates assigned to @Trace/@State fields are stored as observable proxies: compare them by content (assertDeepEquals, length, elements), never by identity (===).`);
    }
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
  for (const m of text.matchAll(/^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const\s+enum|class|interface|function\*?|const|let|var|enum|type|struct|namespace)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
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
  const voidFns = new Set([...`${text}\n${context}`.matchAll(/([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^()]*\)\s*:\s*void\b/g)].map((m) => m[1]));
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
    // hypium's expect(actualValue?: Object): a call to a function declared `: void` is not an Object.
    for (const m of l.matchAll(/\bexpect\(\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)*([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (voidFns.has(m[1])) out.push(`${i + 1}: expect() needs a value, but ${m[1]}() returns void: call it on its own line and assert on its effects`);
    }
    // Indexed access with a string literal is legal on Record<K, V> (and arrays), not on class instances.
    const byIndex = [...l.matchAll(/([A-Za-z_$][\w$]*)\s*\[\s*['"][A-Za-z_]\w*['"]\s*\]/g)].filter((m) => !records.has(m[1]));
    if (byIndex.length) out.push(`${i + 1}: arkts-no-props-by-index: use obj.prop instead of obj['prop'] (allowed only on Record types)`);
  });
  return out;
}
