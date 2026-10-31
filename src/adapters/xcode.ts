import { runAsync } from "../util.ts";
// iOS / macOS Xcode projects (.xcodeproj / .xcworkspace) via `xcodebuild test` + xccov.
//
// Generated tests go into the module's existing unit-test target. Targets that use Xcode 16
// synchronized folders pick the file up automatically; classic targets get it registered in
// project.pbxproj (a backup is kept in .unitgen/, and quarantine removes the entries again).
import * as fs from "node:fs";
import * as path from "node:path";
import { parseXccovArchiveJson } from "../coverage.ts";
import { errorExcerpt, exists, preferOwnTest, readFile, readJson, relPath, run, stripAnsi, walkFiles, writeFile, writeJson } from "../util.ts";
import { Pbxproj, type PbxTarget } from "./pbxproj.ts";
import type { Adapter, Doctor, FileKind, Module, RunRequest, TestCase, TestPlacement, TestRun } from "./types.ts";

const SUFFIX = "UnitGenTests";

export class XcodeAdapter implements Adapter {
  readonly id = "xcode";
  readonly platform = "ios" as const;
  readonly testFileSuffix = `${SUFFIX}.swift`;
  readonly root: string;
  private readonly stateDir: string;
  private projectFile: string;
  private pbx?: Pbxproj;

  constructor(root: string, stateDir: string) {
    this.root = root;
    this.stateDir = stateDir;
    const projs = fs.readdirSync(root).filter((f) => f.endsWith(".xcodeproj"));
    if (!projs.length) throw new Error(`no .xcodeproj in ${root}`);
    const preferred = process.env.UNITGEN_XCODEPROJ;
    this.projectFile = path.join(root, preferred ?? projs.sort((a, b) => a.length - b.length)[0]);
  }

  static detect(root: string): boolean {
    try {
      return fs.readdirSync(root).some((f) => f.endsWith(".xcodeproj"));
    } catch {
      return false;
    }
  }

  private workspace(): string | undefined {
    const ws = fs.readdirSync(this.root).filter((f) => f.endsWith(".xcworkspace"));
    return ws.length ? path.join(this.root, ws[0]) : undefined;
  }

  private pbxPath(): string {
    return path.join(this.projectFile, "project.pbxproj");
  }

  private project(): Pbxproj {
    if (!this.pbx) this.pbx = new Pbxproj(readFile(this.pbxPath()), this.root);
    return this.pbx;
  }

  private containerArgs(): string[] {
    const ws = this.workspace();
    return ws ? ["-workspace", ws] : ["-project", this.projectFile];
  }

  doctor(): Doctor {
    const lines: string[] = [];
    let ok = true;
    const v = run(["xcodebuild", "-version"]);
    if (!v.ok) {
      return { ok: false, lines: ["xcodebuild unavailable: install Xcode and run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`", v.out.trim()] };
    }
    lines.push(`xcode: ${v.out.split("\n")[0]}`);
    lines.push(`project: ${relPath(this.projectFile, this.root)}${this.workspace() ? ` (workspace ${relPath(this.workspace()!, this.root)})` : ""}`);
    const mods = this.modules();
    lines.push(`modules: ${mods.map((m) => `${m.name} -> ${m.meta?.testTarget ?? "(no unit-test target)"}`).join(", ") || "none"}`);
    if (!mods.some((m) => m.meta?.testTarget)) {
      ok = false;
      lines.push("error: no unit-test target found; add one in Xcode (File > New > Target > Unit Testing Bundle)");
    }
    const sims = this.simulator();
    lines.push(sims ? `ios simulator: ${sims.name}` : "ios simulator: none (iOS-only targets need one: `xcodebuild -downloadPlatform iOS`)");
    return { ok, lines };
  }

  modules(): Module[] {
    const ts = this.project().targets();
    const tests = ts.filter((t) => t.productType.includes("unit-test"));
    const code = ts.filter((t) => /application|framework|library|bundle$/.test(t.productType) && !t.productType.includes("test"));
    const out: Module[] = [];
    for (const t of code) {
      const files = t.files.filter((f) => f.endsWith(".swift"));
      const dirs = [...t.syncedDirs, ...commonDirs(files)];
      if (!dirs.length) continue;
      const imports = (f: string) => f.endsWith(".swift") && exists(f) && new RegExp(`@testable\\s+import\\s+${productModule(t.name)}\\b`).test(readFile(f));
      // "SwiftDate-iOS Tests" tests "SwiftDate-iOS": compare without spaces, dashes and underscores.
      const norm = (n: string) => n.replace(/[\s_-]+/g, "").toLowerCase();
      const test = tests.find((x) => x.name === `${t.name}Tests`)
        ?? tests.find((x) => norm(x.name) === norm(`${t.name}Tests`))
        // Xcode records which target a test bundle tests: its target dependency.
        ?? tests.find((x) => x.dependsOn.includes(t.id) && tests.filter((y) => y.dependsOn.includes(t.id)).length === 1)
        ?? tests.find((x) => [...x.files, ...x.syncedDirs.flatMap((d) => walkFiles(d, [".swift"]))].some(imports))
        ?? (tests.length === 1 && code.length === 1 ? tests[0] : undefined);
      const testDir = test ? (test.syncedDirs[0] ?? commonDirs(test.files.filter((f) => f.endsWith(".swift")))[0]) : undefined;
      out.push({
        name: t.name, dir: dirs[0], sourceRoots: dirs, testRoot: testDir ?? path.join(this.root, `${t.name}Tests`),
        kind: t.productType.split(".").pop() ?? "target",
        meta: { testTarget: test?.name, files, synced: !!test?.syncedDirs.length },
      });
    }
    // One framework built per platform from the same sources (Foo-iOS, Foo-tvOS, Foo-macOS) is one
    // module here: keep the variant with a unit-test target, iOS first (it runs in the simulator).
    const byRoots = new Map<string, Module[]>();
    for (const m of out) {
      const k = [...m.sourceRoots].sort().join("|");
      byRoots.set(k, [...(byRoots.get(k) ?? []), m]);
    }
    const rank = (m: Module) => (m.meta?.testTarget ? 0 : 2) + (/ios/i.test(m.name) ? 0 : 1);
    return [...byRoots.values()].map((group) => [...group].sort((a, b) => rank(a) - rank(b))[0]);
  }

  moduleFor(file: string): Module | undefined {
    const abs = path.resolve(file);
    const mods = this.modules();
    return mods.find((m) => (m.meta?.files as string[]).includes(abs)) ??
      mods.find((m) => abs.startsWith(m.testRoot + path.sep)) ??
      mods.find((m) => m.sourceRoots.some((r) => abs.startsWith(r + path.sep)));
  }

  sourceFiles(m: Module): string[] {
    const listed = (m.meta?.files as string[]).filter(exists);
    // Synchronized folders compile everything inside them.
    const synced = m.sourceRoots.filter((r) => !listed.some((f) => f.startsWith(r + path.sep))).flatMap((r) => walkFiles(r, [".swift"]));
    return [...new Set([...listed, ...synced])];
  }

  classify(file: string, text: string): FileKind {
    if (/Generated|\.generated\./.test(file) || /^\/\/.*(generated|DO NOT EDIT)/im.test(text.slice(0, 400))) return "generated";
    if (/@main\b|UIApplicationDelegate|NSApplicationDelegate|SceneDelegate/.test(text)) return "entry";
    if (/:\s*(some\s+)?View\b|:\s*(UI|NS)\w*(View|Cell|Controller|Control|Window|Button|Label)\b|UIViewController|NSViewController|UIView\b|NSView\b/.test(text) && /import\s+(SwiftUI|UIKit|AppKit)/.test(text)) return "ui";
    const decls = (text.match(/\bfunc\s+\w+/g) ?? []).length + (text.match(/\b(init|subscript)\s*[(<]/g) ?? []).length;
    return decls === 0 ? "model" : "logic";
  }

  placement(source: string, m: Module): TestPlacement {
    const base = path.basename(source, ".swift").replace(/[^A-Za-z0-9_]/g, "_");
    return { path: path.join(m.testRoot, `${base}${SUFFIX}.swift`), suiteName: `${base}${SUFFIX}`, importHint: `@testable import ${this.moduleName(m)}` };
  }

  conventions(m: Module): string {
    const existing = this.exampleTests(m).concat((this.project().targets().find((t) => t.name === m.meta?.testTarget)?.syncedDirs ?? []).flatMap((d) => walkFiles(d, [".swift"])));
    const usesXCTest = existing.some((f) => /import XCTest/.test(readFile(f)));
    const usesTesting = existing.some((f) => /import Testing\b/.test(readFile(f)));
    return [
      `Platform: Xcode target \`${m.name}\` (${m.kind}); tests go into the unit-test target \`${m.meta?.testTarget}\` (${relPath(m.testRoot, this.root)}).`,
      usesTesting
        ? "Use Swift Testing like the existing tests (`import Testing`, `@Suite struct`, `@Test`, `#expect`, `#require`)."
        : !this.swiftTestingAvailable(m)
        ? `Use XCTest (\`final class FooUnitGenTests: XCTestCase\`, \`func testX()\`, XCTAssert*): the test target's deployment target (${this.deploymentTarget(m) ?? "?"}) is older than Swift Testing supports (iOS/tvOS 13, macOS 10.15, watchOS 6).`
        : usesXCTest
        ? "Use XCTest like the existing tests (`final class FooUnitGenTests: XCTestCase`, `func testX()`, XCTAssert*). Swift Testing also works if you prefer it."
        : "Use Swift Testing (`import Testing`, `@Suite struct`, `@Test`, `#expect`) or XCTest.",
      `Import the module with \`@testable import ${this.moduleName(m)}\`.`,
      "Name the XCTestCase subclass / @Suite exactly as the brief says (it is used to run only this file).",
      "No network, no real keychain/file system outside temporary directories, no sleeps; UI code only through view models.",
    ].join("\n");
  }

  exampleTests(m: Module, source?: string): string[] {
    const t = this.project().targets().find((x) => x.name === m.meta?.testTarget);
    const files = [...(t?.files ?? []), ...(t?.syncedDirs.flatMap((d) => walkFiles(d, [".swift"])) ?? [])].filter((f) => f.endsWith(".swift") && exists(f) && !f.includes(SUFFIX));
    return preferOwnTest(files, source, files.filter((f) => fs.statSync(f).size > 300).sort((a, b) => fs.statSync(a).size - fs.statSync(b).size));
  }

  private registryFile(): string {
    return path.join(this.stateDir, "xcode-registered.json");
  }

  prepareTestFile(testFile: string, m: Module): void {
    fs.mkdirSync(path.dirname(testFile), { recursive: true });
    if (m.meta?.synced) return;
    const target = this.project().targets().find((t) => t.name === m.meta?.testTarget);
    if (!target) throw new Error(`module ${m.name} has no unit-test target`);
    const backup = path.join(this.stateDir, "project.pbxproj.orig");
    if (!exists(backup)) {
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.copyFileSync(this.pbxPath(), backup);
    }
    const ids = this.project().addSourceFile(target, path.resolve(testFile));
    if (!ids) return;
    writeFile(this.pbxPath(), this.project().text);
    const reg = readJson<Record<string, string[]>>(this.registryFile(), {});
    reg[relPath(testFile, this.root)] = [ids.fileRef, ids.buildFile];
    writeJson(this.registryFile(), reg);
  }

  forgetTestFile(testFile: string): void {
    const reg = readJson<Record<string, string[]>>(this.registryFile(), {});
    const key = relPath(testFile, this.root);
    if (!reg[key]) return;
    this.project().removeIds(reg[key]);
    writeFile(this.pbxPath(), this.project().text);
    delete reg[key];
    writeJson(this.registryFile(), reg);
  }

  private simulator(): { name: string; udid: string } | undefined {
    const r = run(["xcrun", "simctl", "list", "devices", "available", "-j"]);
    if (!r.ok) return undefined;
    try {
      const j = JSON.parse(r.out);
      const all = Object.entries(j.devices as Record<string, any[]>).filter(([rt]) => /iOS/.test(rt)).flatMap(([, ds]) => ds);
      const d = all.find((x) => x.state === "Booted" && /iPhone/.test(x.name)) ?? all.find((x) => /iPhone/.test(x.name));
      return d ? { name: d.name, udid: d.udid } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Scheme whose test action contains the module's test target (cached). */
  private scheme(m: Module): string | undefined {
    const cache = path.join(this.stateDir, "xcode-schemes.json");
    const c = readJson<Record<string, string>>(cache, {});
    if (c[m.name]) return c[m.name];
    const r = run(["xcodebuild", "-list", "-json", ...this.containerArgs()], { cwd: this.root, timeoutSec: 600 });
    let schemes: string[] = [];
    try {
      const j = JSON.parse(r.out.slice(r.out.indexOf("{")));
      schemes = (j.project ?? j.workspace)?.schemes ?? [];
    } catch { /* fall through */ }
    const order = [m.name, m.meta?.testTarget, ...schemes].filter((s): s is string => !!s && schemes.includes(s));
    const pick = order[0] ?? schemes[0];
    if (pick) writeJson(cache, { ...c, [m.name]: pick });
    return pick;
  }

  /** `xcodebuild -showBuildSettings` of a target, cached per pbxproj content. */
  private settings(target: string | undefined): Record<string, string> {
    if (!target) return {};
    const cache = path.join(this.stateDir, "xcode-settings.json");
    const stamp = `${fs.statSync(this.pbxPath()).mtimeMs}`;
    const c = readJson<Record<string, { stamp: string; settings: Record<string, string> }>>(cache, {});
    if (c[target]?.stamp === stamp) return c[target].settings;
    const r = run(["xcodebuild", "-showBuildSettings", "-json", "-project", this.projectFile, "-target", target], { cwd: this.root, timeoutSec: 600 });
    let settings: Record<string, string> = {};
    try { settings = JSON.parse(r.out.slice(r.out.indexOf("[")))[0]?.buildSettings ?? {}; } catch { /* unknown */ }
    if (r.ok) writeJson(cache, { ...c, [target]: { stamp, settings } });
    return settings;
  }

  /** The Swift module a target builds (PRODUCT_MODULE_NAME; `SwiftyJSON iOS` with PRODUCT_NAME=$(PROJECT_NAME) -> `SwiftyJSON`). */
  private moduleName(m: Module): string {
    const s = this.settings(m.name);
    return s.PRODUCT_MODULE_NAME || (s.PRODUCT_NAME ? productModule(s.PRODUCT_NAME) : productModule(m.name));
  }

  private deploymentTarget(m: Module): string | undefined {
    const s = this.settings(m.meta?.testTarget as string | undefined);
    const key = ["IPHONEOS_DEPLOYMENT_TARGET", "MACOSX_DEPLOYMENT_TARGET", "TVOS_DEPLOYMENT_TARGET", "WATCHOS_DEPLOYMENT_TARGET"]
      // SDKROOT is `iphoneos` or a full path to `.../iPhoneOS18.5.sdk`.
      .find((k) => s[k] && path.basename(s.SDKROOT ?? "").toLowerCase().startsWith({ IPHONEOS_DEPLOYMENT_TARGET: "iphone", MACOSX_DEPLOYMENT_TARGET: "macosx", TVOS_DEPLOYMENT_TARGET: "appletv", WATCHOS_DEPLOYMENT_TARGET: "watch" }[k]!));
    return key ? `${key.replace("_DEPLOYMENT_TARGET", "").replace("IPHONEOS", "iOS").replace("MACOSX", "macOS").replace("TVOS", "tvOS").replace("WATCHOS", "watchOS")} ${s[key]}` : undefined;
  }

  /** Swift Testing needs iOS/tvOS 13, macOS 10.15 or watchOS 6 as the test target's deployment target. */
  private swiftTestingAvailable(m: Module): boolean {
    const t = this.deploymentTarget(m);
    if (!t) return true;
    const [os, v] = t.split(" ");
    const need = { iOS: 13, tvOS: 13, macOS: 10.15, watchOS: 6 }[os] ?? 0;
    const [maj, min = "0"] = v.split(".");
    return Number(maj) + Number(min) / 100 >= need;
  }

  private destination(m: Module): string | undefined {
    const platforms = this.settings(m.name).SUPPORTED_PLATFORMS ?? "";
    if (/macosx/.test(platforms)) return "platform=macOS";
    const sim = this.simulator();
    return sim ? `platform=iOS Simulator,id=${sim.udid}` : undefined;
  }

  async runTests(req: RunRequest): Promise<TestRun> {
    const start = Date.now();
    const logFile = path.join(this.stateDir, "logs", `${req.label}.log`);
    let mods = req.modules ?? this.modules();
    if (req.testFiles) {
      const owners = new Set(req.testFiles.map((f) => this.moduleFor(f)?.name));
      mods = this.modules().filter((m) => owners.has(m.name));
    }
    const m = mods.find((x) => x.meta?.testTarget) ?? mods[0];
    const scheme = m ? this.scheme(m) : undefined;
    const dest = m ? this.destination(m) : undefined;
    if (!m || !scheme || !dest) {
      return { ok: false, compiled: false, tests: [], logFile, excerpt: "", seconds: 0, infraError: !dest ? "no destination: install an iOS simulator runtime (`xcodebuild -downloadPlatform iOS`)" : "no scheme found for the test target" };
    }
    const bundle = path.join(this.stateDir, "runs", `${req.label}.xcresult`);
    fs.rmSync(bundle, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    // Own build directory: nothing lands in ~/Library/Developer/Xcode/DerivedData, and an open Xcode
    // building the same project does not contend for its build database.
    const args = ["xcodebuild", "test", ...this.containerArgs(), "-scheme", scheme, "-destination", dest, "-resultBundlePath", bundle,
      "-derivedDataPath", path.join(this.stateDir, "DerivedData"),
      "CODE_SIGNING_ALLOWED=NO", "CODE_SIGN_IDENTITY=", "COMPILER_INDEX_STORE_ENABLE=NO",
      // For unitgen's runs only (the project is not changed): @testable import needs testability
      // (off in some projects' Debug config), and legacy gcov flags zero llvm's coverage counters.
      "ENABLE_TESTABILITY=YES", "GCC_INSTRUMENT_PROGRAM_FLOW_ARCS=NO", "GCC_GENERATE_TEST_COVERAGE_FILES=NO"];
    if (req.coverage) args.push("-enableCodeCoverage", "YES");
    if (req.testFiles && m.meta?.testTarget) {
      for (const f of req.testFiles) args.push(`-only-testing:${m.meta.testTarget}/${path.basename(f, ".swift")}`);
    } else if (m.meta?.testTarget) {
      // Only the test target of the scheme being run: another module's test bundle is usually not
      // part of this scheme, and xcodebuild refuses the whole run then.
      args.push(`-only-testing:${m.meta.testTarget}`);
      if (req.excludeGenerated) {
        for (const f of walkFiles(m.testRoot, [this.testFileSuffix])) args.push(`-skip-testing:${m.meta.testTarget}/${path.basename(f, ".swift")}`);
      }
    }
    const r = await runAsync(args, { cwd: this.root, timeoutSec: req.timeoutSec ?? 3600, logFile });
    const out = stripAnsi(r.out);
    const tests = exists(bundle) ? xcresultTests(bundle) : [];
    const compiled = !/error: |\*\* BUILD FAILED \*\*|Testing cancelled because the build failed/.test(out) || tests.length > 0;
    let coverage;
    if (req.coverage && exists(bundle)) {
      const c = await runAsync(["xcrun", "xccov", "view", "--archive", "--json", bundle], { timeoutSec: 600 });
      if (c.ok) {
        const keep = new Set(mods.flatMap((x) => this.sourceFiles(x)));
        coverage = parseXccovArchiveJson(JSON.parse(c.out), (f) => keep.has(f));
      }
    }
    fs.rmSync(bundle, { recursive: true, force: true });
    // Tests passed but not one line anywhere was hit: the counters never worked (not a real 0%).
    const passed = tests.filter((t) => t.status === "passed").length;
    const coverageProblem = req.coverage && coverage && passed > 0 && Object.keys(coverage).length > 0
      && !Object.values(coverage).some((ls) => Object.values(ls).some((h) => h > 0))
      ? `xccov recorded 0 executed lines although ${passed} test(s) passed: coverage was not collected. Check the scheme's "Gather coverage" and build settings that replace llvm coverage (GCC_INSTRUMENT_PROGRAM_FLOW_ARCS, OTHER_CFLAGS/OTHER_SWIFT_FLAGS with -profile-* or --coverage).`
      : undefined;
    const infra = /Unable to find a destination|no available devices|requires a provisioning profile|xcodebuild: error: Could not resolve package/.exec(out)?.[0];
    return {
      ok: r.ok, compiled, tests, coverage, logFile, seconds: (Date.now() - start) / 1000,
      // xcodebuild prints simulator/package noise first: lead with its own error lines.
      excerpt: r.ok ? "" : [...new Set(out.split("\n").filter((l) => /(^|\s)error:/.test(l)).map((l) => l.trim()))].slice(0, 10).join("\n") || errorExcerpt(out),
      infraError: r.timedOut ? "timeout" : infra,
      ...(coverageProblem ? { coverageProblem } : {}),
    };
  }

  countAssertions(text: string): number {
    return (text.match(/#expect\s*\(|#require\s*\(|XCTAssert\w*\s*\(|XCTFail\s*\(|XCTUnwrap\s*\(/g) ?? []).length;
  }
}

/** Product module name: target names with dashes/spaces become underscores. */
function productModule(target: string): string {
  return target.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Smallest set of directories containing the given files (one per top-level folder). */
function commonDirs(files: string[]): string[] {
  const dirs = [...new Set(files.map((f) => path.dirname(f)))].sort((a, b) => a.length - b.length);
  const out: string[] = [];
  for (const d of dirs) if (!out.some((o) => d === o || d.startsWith(o + path.sep))) out.push(d);
  return out;
}

/** Test cases from an .xcresult bundle (Xcode 16+ `xcresulttool get test-results tests`). */
export function xcresultTests(bundle: string): TestCase[] {
  const r = run(["xcrun", "xcresulttool", "get", "test-results", "tests", "--path", bundle], { timeoutSec: 300 });
  if (!r.ok) return [];
  let j: any;
  try {
    j = JSON.parse(r.out.slice(r.out.indexOf("{")));
  } catch {
    return [];
  }
  return parseXcresultNodes(j.testNodes ?? []);
}

export function parseXcresultNodes(nodes: any[], suite = ""): TestCase[] {
  const out: TestCase[] = [];
  for (const n of nodes) {
    if (n.nodeType === "Test Case") {
      const failures = (n.children ?? []).filter((c: any) => c.nodeType === "Failure Message").map((c: any) => c.name);
      out.push({
        name: suite ? `${suite}.${n.name}` : n.name,
        status: n.result === "Passed" ? "passed" : n.result === "Skipped" ? "skipped" : n.result === "Expected Failure" ? "passed" : "failed",
        message: failures.length ? failures.join("\n").slice(0, 2000) : undefined,
      });
    } else {
      out.push(...parseXcresultNodes(n.children ?? [], n.nodeType === "Test Suite" ? n.name : suite));
    }
  }
  return out;
}
