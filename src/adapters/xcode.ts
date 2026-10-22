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
      const test = tests.find((x) => x.name === `${t.name}Tests`)
        ?? tests.find((x) => [...x.files, ...x.syncedDirs.flatMap((d) => walkFiles(d, [".swift"]))].some(imports))
        ?? (tests.length === 1 && code.length === 1 ? tests[0] : undefined);
      const testDir = test ? (test.syncedDirs[0] ?? commonDirs(test.files.filter((f) => f.endsWith(".swift")))[0]) : undefined;
      out.push({
        name: t.name, dir: dirs[0], sourceRoots: dirs, testRoot: testDir ?? path.join(this.root, `${t.name}Tests`),
        kind: t.productType.split(".").pop() ?? "target",
        meta: { testTarget: test?.name, files, synced: !!test?.syncedDirs.length },
      });
    }
    return out;
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
    if (/:\s*(some\s+)?View\b|UIViewController|NSViewController|UIView\b|NSView\b/.test(text) && /import\s+(SwiftUI|UIKit|AppKit)/.test(text)) return "ui";
    const decls = (text.match(/\bfunc\s+\w+/g) ?? []).length + (text.match(/\b(init|subscript)\s*[(<]/g) ?? []).length;
    return decls === 0 ? "model" : "logic";
  }

  placement(source: string, m: Module): TestPlacement {
    const base = path.basename(source, ".swift").replace(/[^A-Za-z0-9_]/g, "_");
    return { path: path.join(m.testRoot, `${base}${SUFFIX}.swift`), suiteName: `${base}${SUFFIX}`, importHint: `@testable import ${productModule(m.name)}` };
  }

  conventions(m: Module): string {
    const existing = this.exampleTests(m).concat((this.project().targets().find((t) => t.name === m.meta?.testTarget)?.syncedDirs ?? []).flatMap((d) => walkFiles(d, [".swift"])));
    const usesXCTest = existing.some((f) => /import XCTest/.test(readFile(f)));
    const usesTesting = existing.some((f) => /import Testing\b/.test(readFile(f)));
    return [
      `Platform: Xcode target \`${m.name}\` (${m.kind}); tests go into the unit-test target \`${m.meta?.testTarget}\` (${relPath(m.testRoot, this.root)}).`,
      usesTesting
        ? "Use Swift Testing like the existing tests (`import Testing`, `@Suite struct`, `@Test`, `#expect`, `#require`)."
        : usesXCTest
        ? "Use XCTest like the existing tests (`final class FooUnitGenTests: XCTestCase`, `func testX()`, XCTAssert*). Swift Testing also works if you prefer it."
        : "Use Swift Testing (`import Testing`, `@Suite struct`, `@Test`, `#expect`) or XCTest.",
      `Import the module with \`@testable import ${productModule(m.name)}\`.`,
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

  private destination(m: Module): string | undefined {
    const r = run(["xcodebuild", "-showBuildSettings", "-json", "-project", this.projectFile, "-target", m.name], { cwd: this.root, timeoutSec: 600 });
    let platforms = "";
    try {
      platforms = JSON.parse(r.out.slice(r.out.indexOf("[")))[0]?.buildSettings?.SUPPORTED_PLATFORMS ?? "";
    } catch { /* default to iOS */ }
    if (/macosx/.test(platforms)) return "platform=macOS";
    const sim = this.simulator();
    return sim ? `platform=iOS Simulator,id=${sim.udid}` : undefined;
  }

  runTests(req: RunRequest): TestRun {
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
    const args = ["xcodebuild", "test", ...this.containerArgs(), "-scheme", scheme, "-destination", dest, "-resultBundlePath", bundle,
      "CODE_SIGNING_ALLOWED=NO", "CODE_SIGN_IDENTITY=", "COMPILER_INDEX_STORE_ENABLE=NO"];
    if (req.coverage) args.push("-enableCodeCoverage", "YES");
    if (req.testFiles && m.meta?.testTarget) {
      for (const f of req.testFiles) args.push(`-only-testing:${m.meta.testTarget}/${path.basename(f, ".swift")}`);
    } else if (m.meta?.testTarget) {
      for (const x of mods) if (x.meta?.testTarget) args.push(`-only-testing:${x.meta.testTarget}`);
    }
    const r = run(args, { cwd: this.root, timeoutSec: req.timeoutSec ?? 3600, logFile });
    const out = stripAnsi(r.out);
    const tests = exists(bundle) ? xcresultTests(bundle) : [];
    const compiled = !/error: |\*\* BUILD FAILED \*\*|Testing cancelled because the build failed/.test(out) || tests.length > 0;
    let coverage;
    if (req.coverage && exists(bundle)) {
      const c = run(["xcrun", "xccov", "view", "--archive", "--json", bundle], { timeoutSec: 600 });
      if (c.ok) {
        const keep = new Set(mods.flatMap((x) => this.sourceFiles(x)));
        coverage = parseXccovArchiveJson(JSON.parse(c.out), (f) => keep.has(f));
      }
    }
    fs.rmSync(bundle, { recursive: true, force: true });
    const infra = /Unable to find a destination|no available devices|requires a provisioning profile|xcodebuild: error: Could not resolve package/.exec(out)?.[0];
    return {
      ok: r.ok, compiled, tests, coverage, logFile, seconds: (Date.now() - start) / 1000,
      excerpt: r.ok ? "" : errorExcerpt(out), infraError: r.timedOut ? "timeout" : infra,
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
