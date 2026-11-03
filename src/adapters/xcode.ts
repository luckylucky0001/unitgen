import { runAsync } from "../util.ts";
// iOS / macOS Xcode projects (.xcodeproj / .xcworkspace) via `xcodebuild test` + xccov.
//
// Generated tests go into the module's existing unit-test target. Targets that use Xcode 16
// synchronized folders pick the file up automatically; classic targets get it registered in
// project.pbxproj (a backup is kept in .unitgen/, and quarantine removes the entries again).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseXccovArchiveJson } from "../coverage.ts";
import { errorExcerpt, exists, preferOwnTest, readFile, readJson, relPath, run, stripAnsi, walkFiles, writeFile, writeJson } from "../util.ts";
import { classifyObjC, headerFor, isObjC, objcConventions, quotedImports, SOURCE_EXTS, stem, testExt } from "./objc.ts";
import { Pbxproj, type PbxTarget } from "./pbxproj.ts";
import type { Adapter, Doctor, FileKind, Module, RunRequest, TestCase, TestPlacement, TestRun } from "./types.ts";

const SUFFIX = "UnitGenTests";
/** Scheme unitgen writes for a run when no scheme of the project tests the test target. */
const OWN_SCHEME = "unitgen-";
const isSource = (f: string) => SOURCE_EXTS.some((x) => f.endsWith(x));

export class XcodeAdapter implements Adapter {
  readonly id = "xcode";
  readonly platform = "ios" as const;
  readonly testFileSuffix = `${SUFFIX}.swift`;
  readonly testFileSuffixes = SOURCE_EXTS.map((x) => `${SUFFIX}${x}`);
  readonly root: string;
  private readonly stateDir: string;
  private projectFile: string;
  private pbx?: Pbxproj;
  private mods?: Module[];

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
    const langs = (m: Module) => {
      const fs_ = m.meta?.files as string[];
      const objc = fs_.some(isObjC), swift = fs_.some((f) => f.endsWith(".swift"));
      return objc && swift ? " [Swift + Objective-C]" : objc ? " [Objective-C]" : "";
    };
    lines.push(`modules: ${mods.map((m) => `${m.name}${langs(m)} -> ${m.meta?.testTarget ?? "(no unit-test target)"}`).join(", ") || "none"}`);
    if (!mods.some((m) => m.meta?.testTarget)) {
      ok = false;
      lines.push("error: no unit-test target found; add one in Xcode (File > New > Target > Unit Testing Bundle)");
    }
    const sims = this.simulator();
    lines.push(sims ? `ios simulator: ${sims.name}` : "ios simulator: none (iOS-only targets need one: `xcodebuild -downloadPlatform iOS`)");
    return { ok, lines };
  }

  modules(): Module[] {
    this.mods ??= this.readModules();
    return this.mods;
  }

  private readModules(): Module[] {
    const ts = this.project().targets();
    const tests = ts.filter((t) => t.productType.includes("unit-test"));
    // Command-line tools too: their tests compile the tool's sources into the test bundle itself.
    const code = ts.filter((t) => /application|framework|library|bundle$|\.tool$/.test(t.productType) && !t.productType.includes("test"));
    const out: Module[] = [];
    for (const t of code) {
      const files = t.files.filter(isSource);
      const dirs = [...t.syncedDirs, ...commonDirs(files)];
      if (!dirs.length) continue;
      // A test file that `@testable import`s the module, or (Objective-C) imports one of its headers.
      const headers = new Set(files.filter(isObjC).map((f) => `${stem(f)}.h`));
      const imports = (f: string) => exists(f) && (f.endsWith(".swift")
        ? new RegExp(`@testable\\s+import\\s+${productModule(t.name)}\\b`).test(readFile(f))
        : isObjC(f) && quotedImports(readFile(f)).some((h) => headers.has(path.basename(h))));
      // "SwiftDate-iOS Tests" tests "SwiftDate-iOS": compare without spaces, dashes and underscores.
      const norm = (n: string) => n.replace(/[\s_-]+/g, "").toLowerCase();
      const test = tests.find((x) => x.name === `${t.name}Tests`)
        ?? tests.find((x) => norm(x.name) === norm(`${t.name}Tests`))
        // Xcode records which target a test bundle tests: its target dependency.
        ?? tests.find((x) => x.dependsOn.includes(t.id) && tests.filter((y) => y.dependsOn.includes(t.id)).length === 1)
        // The test bundle compiles some of the target's sources itself (tool and app sources added to the test target).
        ?? tests.find((x) => x.files.some((f) => files.includes(f) && !/main\.(m|mm|swift)$/.test(f)))
        ?? tests.find((x) => [...x.files, ...x.syncedDirs.flatMap((d) => walkFiles(d, SOURCE_EXTS))].some(imports))
        ?? (tests.length === 1 && code.length === 1 ? tests[0] : undefined);
      const testDir = test ? (test.syncedDirs[0] ?? commonDirs(test.files.filter(isSource))[0]) : undefined;
      out.push({
        name: t.name, dir: dirs[0], sourceRoots: dirs, testRoot: testDir ?? path.join(this.root, `${t.name}Tests`),
        kind: t.productType.split(".").pop() ?? "target",
        meta: { testTarget: test?.name, files, synced: !!test?.syncedDirs.length, testedDirectly: !!test?.dependsOn.includes(t.id) },
      });
    }
    // One framework built per platform from the same sources (Foo-iOS, Foo-tvOS, Foo-macOS) is one
    // module here: keep the variant with a unit-test target, preferably the one that test target
    // depends on (it is built for the test's platform), then iOS (it runs in the simulator).
    const byRoots = new Map<string, Module[]>();
    for (const m of out) {
      const k = [...m.sourceRoots].sort().join("|");
      byRoots.set(k, [...(byRoots.get(k) ?? []), m]);
    }
    const rank = (m: Module) => (m.meta?.testTarget ? 0 : 4) + (m.meta?.testedDirectly ? 0 : 2) + (/ios/i.test(m.name) ? 0 : 1);
    const kept = [...byRoots.values()].map((group) => [...group].sort((a, b) => rank(a) - rank(b))[0]);
    // Targets that compile some of the same files (a framework and a command-line tool built from its
    // sources): each file belongs to the best-ranked one; a target left with no file of its own goes.
    const claimed = new Set<string>();
    const owners = new Map<Module, string[]>();
    for (const m of [...kept].sort((a, b) => rank(a) - rank(b))) {
      const own = (m.meta?.files as string[]).filter((f) => !claimed.has(f));
      for (const f of own) claimed.add(f);
      owners.set(m, own);
    }
    return kept.flatMap((m) => {
      const own = owners.get(m)!;
      const files = m.meta?.files as string[];
      if (own.length === files.length) return [m];
      const synced = m.sourceRoots.filter((r) => !files.some((f) => f.startsWith(r + path.sep)));
      const dirs = [...synced, ...commonDirs(own)];
      return dirs.length ? [{ ...m, dir: dirs[0], sourceRoots: dirs, meta: { ...m.meta, files: own } }] : [];
    });
  }

  moduleFor(file: string): Module | undefined {
    const abs = path.resolve(file);
    const mods = this.modules();
    const testedIn = mods.filter((m) => abs.startsWith(m.testRoot + path.sep));
    return mods.find((m) => (m.meta?.files as string[]).includes(abs)) ??
      // Several modules share a test target (an app hosting a framework's tests): the one whose source
      // this generated test belongs to, else the one the test bundle builds against directly.
      (testedIn.length > 1 ? testedIn.find((m) => this.sourceFiles(m).some((s) => this.testPath(s, m) === abs)) ?? testedIn.find((m) => m.meta?.testedDirectly) : undefined) ??
      testedIn[0] ??
      mods.find((m) => m.sourceRoots.some((r) => abs.startsWith(r + path.sep)));
  }

  sourceFiles(m: Module): string[] {
    const listed = (m.meta?.files as string[]).filter(exists);
    // Synchronized folders compile everything inside them.
    const synced = m.sourceRoots.filter((r) => !listed.some((f) => f.startsWith(r + path.sep))).flatMap((r) => walkFiles(r, SOURCE_EXTS));
    return [...new Set([...listed, ...synced])];
  }

  headerFor(source: string, m = this.moduleFor(source)): string | undefined {
    return headerFor(source, m ? [...m.sourceRoots, this.root] : [this.root]);
  }

  private testPath(source: string, m: Module): string {
    return path.join(m.testRoot, `${stem(source).replace(/[^A-Za-z0-9_]/g, "_")}${SUFFIX}${testExt(source)}`);
  }

  classify(file: string, text: string): FileKind {
    if (isObjC(file)) {
      const h = this.headerFor(file);
      return classifyObjC(file, text, h ? readFile(h) : "");
    }
    if (/Generated|\.generated\./.test(file) || /^\/\/.*(generated|DO NOT EDIT)/im.test(text.slice(0, 400))) return "generated";
    if (/@main\b|UIApplicationDelegate|NSApplicationDelegate|SceneDelegate/.test(text)) return "entry";
    if (/:\s*(some\s+)?View\b|:\s*(UI|NS)\w*(View|Cell|Controller|Control|Window|Button|Label)\b|UIViewController|NSViewController|UIView\b|NSView\b/.test(text) && /import\s+(SwiftUI|UIKit|AppKit)/.test(text)) return "ui";
    const decls = (text.match(/\bfunc\s+\w+/g) ?? []).length + (text.match(/\b(init|subscript)\s*[(<]/g) ?? []).length;
    return decls === 0 ? "model" : "logic";
  }

  placement(source: string, m: Module): TestPlacement {
    const base = stem(source).replace(/[^A-Za-z0-9_]/g, "_");
    const header = this.headerFor(source, m);
    return {
      path: this.testPath(source, m), suiteName: `${base}${SUFFIX}`,
      importHint: isObjC(source) ? (header ? `#import "${path.basename(header)}"` : undefined) : `@testable import ${this.moduleName(m)}`,
    };
  }

  conventions(m: Module, source?: string): string {
    if (source && isObjC(source)) {
      const header = this.headerFor(source, m);
      // How the existing Objective-C tests import the module (`#import "Foo.h"` / `#import <Foo/Foo.h>` / `@import Foo;`).
      const styles = new Set<string>();
      for (const f of this.exampleTests(m, source).filter(isObjC)) {
        for (const im of readFile(f).matchAll(/^\s*(#\s*import\s+[<"][^>"]+[>"]|@import\s+\w+\s*;)/gm)) {
          if (!/XCTest|Foundation|UIKit|AppKit|Cocoa/.test(im[1])) styles.add(`\`${im[1].replace(/\s+/g, " ")}\``);
        }
      }
      return objcConventions({
        where: `Platform: Xcode target \`${m.name}\` (${m.kind}); tests go into the unit-test target \`${m.meta?.testTarget}\` (${relPath(m.testRoot, this.root)}).`,
        suite: this.placement(source, m).suiteName,
        header: header ? path.basename(header) : undefined,
        arc: (this.settings(m.meta?.testTarget as string | undefined).CLANG_ENABLE_OBJC_ARC ?? "YES") === "YES",
        examples: [...styles].slice(0, 4),
      });
    }
    const existing = this.exampleTests(m).filter((f) => f.endsWith(".swift")).concat((this.project().targets().find((t) => t.name === m.meta?.testTarget)?.syncedDirs ?? []).flatMap((d) => walkFiles(d, [".swift"])));
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
    const all = [...(t?.files ?? []), ...(t?.syncedDirs.flatMap((d) => walkFiles(d, SOURCE_EXTS)) ?? [])].filter((f) => isSource(f) && exists(f) && !f.includes(SUFFIX));
    // Examples in the language the new test is written in, when the target has any.
    const lang = (f: string) => (isObjC(f) ? "objc" : "swift");
    const same = all.filter((f) => lang(f) === lang(source ?? ".swift"));
    const files = same.length ? same : all;
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
    this.mods = undefined;
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
    this.mods = undefined;
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
    const cache = path.join(this.stateDir, "xcode-scheme-picks.json");
    const c = readJson<Record<string, string>>(cache, {});
    if (c[m.name]) return c[m.name];
    const r = run(["xcodebuild", "-list", "-json", ...this.containerArgs()], { cwd: this.root, timeoutSec: 600 });
    let schemes: string[] = [];
    try {
      const j = JSON.parse(r.out.slice(r.out.indexOf("{")));
      schemes = (j.project ?? j.workspace)?.schemes ?? [];
    } catch { /* fall through */ }
    // A scheme file says what its test action runs; schemes without one are generated by Xcode
    // (the scheme of a unit-test target tests that target).
    const files = schemeFiles([this.projectFile, this.workspace()].filter((x): x is string => !!x));
    const test = m.meta?.testTarget as string | undefined;
    const runs = (sch: string) => (files.has(sch) ? schemeTestTargets(files.get(sch)!, this.root).includes(test ?? "") : undefined);
    const order = [
      ...[m.name, test, ...schemes].filter((x) => x && runs(x) === true),
      ...[test].filter((x) => x && runs(x) === undefined),
    ].filter((x): x is string => !!x && schemes.includes(x));
    // No scheme tests it (schemes not shared, so Xcode generated one per target, and the library's has
    // no test action): runs use a scheme of unitgen's own, written for the run only.
    const pick = order[0] ?? (test && this.project().targets().some((t) => t.name === test) ? `${OWN_SCHEME}${test}` : [m.name, ...schemes].find((x) => schemes.includes(x)));
    if (pick) writeJson(cache, { ...c, [m.name]: pick });
    return pick;
  }

  private ownSchemeDir(): string {
    return path.join(this.projectFile, "xcuserdata", `${os.userInfo().username}.xcuserdatad`, "xcschemes");
  }

  /** Write unitgen's scheme for a test target; returns a function that removes it again. */
  private writeOwnScheme(scheme: string): () => void {
    const test = this.project().targets().find((t) => `${OWN_SCHEME}${t.name}` === scheme);
    if (!test) return () => {};
    const dir = this.ownSchemeDir();
    const created = [path.join(this.projectFile, "xcuserdata"), path.dirname(dir), dir].filter((d) => !exists(d));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${scheme}.xcscheme`);
    const ref = `<BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "${test.id}" BuildableName = "${test.product ?? `${test.name}.xctest`}" BlueprintName = "${test.name}" ReferencedContainer = "container:${path.basename(this.projectFile)}"></BuildableReference>`;
    writeFile(file, [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!-- Written by unitgen for one run; removed afterwards. -->`,
      `<Scheme LastUpgradeVersion = "1500" version = "1.7">`,
      `   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES"></BuildAction>`,
      `   <TestAction buildConfiguration = "Debug" shouldUseLaunchSchemeArgsEnv = "YES">`,
      `      <Testables><TestableReference skipped = "NO">${ref}</TestableReference></Testables>`,
      `   </TestAction>`,
      `   <LaunchAction buildConfiguration = "Debug" launchStyle = "0" useCustomWorkingDirectory = "NO" ignoresPersistentStateOnLaunch = "NO" debugDocumentVersioning = "YES" allowLocationSimulation = "YES"></LaunchAction>`,
      `</Scheme>`, "",
    ].join("\n"));
    return () => {
      fs.rmSync(file, { force: true });
      for (const d of created.reverse()) try { fs.rmdirSync(d); } catch { /* not empty */ }
    };
  }

  recover(): void {
    // A run killed before it could remove its scheme.
    for (const f of walkFiles(this.ownSchemeDir(), [".xcscheme"])) if (path.basename(f).startsWith(OWN_SCHEME)) fs.rmSync(f, { force: true });
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
    // The test bundle decides where tests run (a macOS test target of a multi-platform library).
    const platforms = this.settings(m.meta?.testTarget as string | undefined).SUPPORTED_PLATFORMS ?? this.settings(m.name).SUPPORTED_PLATFORMS ?? "";
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
      const why = !m || !m.meta?.testTarget ? "no module with a unit-test target (see `unitgen doctor`)"
        : !scheme ? "no scheme found for the test target"
        : "no destination: install an iOS simulator runtime (`xcodebuild -downloadPlatform iOS`)";
      return { ok: false, compiled: false, tests: [], logFile, excerpt: "", seconds: 0, infraError: why };
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
      for (const f of req.testFiles) args.push(`-only-testing:${m.meta.testTarget}/${stem(f)}`);
    } else if (m.meta?.testTarget) {
      // Only the test target of the scheme being run: another module's test bundle is usually not
      // part of this scheme, and xcodebuild refuses the whole run then.
      args.push(`-only-testing:${m.meta.testTarget}`);
      if (req.excludeGenerated) {
        for (const f of walkFiles(m.testRoot, this.testFileSuffixes)) args.push(`-skip-testing:${m.meta.testTarget}/${stem(f)}`);
      }
    }
    const removeScheme = scheme.startsWith(OWN_SCHEME) ? this.writeOwnScheme(scheme) : () => {};
    let r;
    try {
      r = await runAsync(args, { cwd: this.root, timeoutSec: req.timeoutSec ?? 3600, logFile });
    } finally {
      removeScheme();
    }
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
    const infra = /libarclite/.test(out)
      // Xcode 14.3+ dropped libarclite, which deployment targets below iOS 9 / macOS 10.11 link against.
      ? "the project's deployment target is too old for this Xcode (libarclite is gone since Xcode 14.3): raise IPHONEOS_DEPLOYMENT_TARGET / MACOSX_DEPLOYMENT_TARGET of the targets (iOS 12 / macOS 10.13 or later), then re-run"
      : /Unable to find a destination|no available devices|requires a provisioning profile|xcodebuild: error: Could not resolve package|Scheme .+ is not currently configured for the test action/.exec(out)?.[0];
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

/** Scheme name -> .xcscheme XML, from the project's and workspace's shared and per-user schemes. */
function schemeFiles(containers: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of containers) {
    const dirs = [path.join(c, "xcshareddata", "xcschemes")];
    try {
      for (const u of fs.readdirSync(path.join(c, "xcuserdata"))) dirs.push(path.join(c, "xcuserdata", u, "xcschemes"));
    } catch { /* no per-user data */ }
    for (const d of dirs) {
      try {
        for (const f of fs.readdirSync(d)) if (f.endsWith(".xcscheme") && !out.has(f.slice(0, -9))) out.set(f.slice(0, -9), readFile(path.join(d, f)));
      } catch { /* none */ }
    }
  }
  return out;
}

/** Test targets a scheme's test action runs: its testables, or the targets of its test plans (Xcode 11+). */
export function schemeTestTargets(xml: string, dir = ""): string[] {
  const action = /<TestAction[\s\S]*?<\/TestAction>/.exec(xml)?.[0] ?? "";
  const names = [...action.matchAll(/<TestableReference[\s\S]*?BlueprintName\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  for (const ref of action.matchAll(/<TestPlanReference[^>]*reference\s*=\s*"container:([^"]+)"/g)) {
    try {
      const plan = JSON.parse(readFile(path.resolve(dir, ref[1])));
      for (const t of plan.testTargets ?? []) if (t.target?.name) names.push(t.target.name);
    } catch { /* unreadable plan */ }
  }
  return names;
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
