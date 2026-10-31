import { runAsync } from "../util.ts";
// iOS / Swift via SwiftPM (`swift test --enable-code-coverage`).
//
// Generated tests live in a dedicated test target `<Target>UnitGenTests`, registered with a marked
// block appended to Package.swift. On machines with only the Command Line Tools (no Xcode) XCTest
// is unavailable, so test runs use a temporary manifest that drops XCTest-based targets and adds the
// flags Swift Testing needs; the original Package.swift is always restored.
import * as fs from "node:fs";
import * as path from "node:path";
import { parseLlvmCovJson } from "../coverage.ts";
import { errorExcerpt, exists, preferOwnTest, readFile, relPath, run, stripAnsi, walkFiles, which, writeFile } from "../util.ts";
import type { Adapter, Doctor, FileKind, Module, RunRequest, TestCase, TestPlacement, TestRun } from "./types.ts";

const BEGIN = "// unitgen:begin (generated test targets, managed by unitgen)";
const END = "// unitgen:end";
const RUNTIME = "// unitgen:runtime (temporary, restored after the run)";
const SUFFIX = "UnitGenTests";

interface DumpTarget {
  name: string;
  type: string;
  path?: string | null;
  dependencies?: any[];
}

export class SwiftPMAdapter implements Adapter {
  readonly id = "swiftpm";
  readonly platform = "ios" as const;
  readonly testFileSuffix = `${SUFFIX}.swift`;
  private dump: any;
  private resolved: Record<string, string> = {};
  private toolchain?: { clt: boolean; xctest: boolean; frameworksDir?: string; libDir?: string; swiftTestingFlag: boolean };

  readonly root: string;
  private readonly stateDir: string;

  constructor(root: string, stateDir: string) {
    this.root = root;
    this.stateDir = stateDir;
  }

  static detect(root: string): boolean {
    return exists(path.join(root, "Package.swift"));
  }

  private manifestPath(): string {
    return path.join(this.root, "Package.swift");
  }

  private loadDump(): any {
    if (this.dump) return this.dump;
    this.restoreIfCrashed();
    const r = run(["swift", "package", "dump-package"], { cwd: this.root, timeoutSec: 600 });
    if (!r.ok) throw new Error(`swift package dump-package failed:\n${errorExcerpt(r.out)}`);
    this.dump = JSON.parse(r.out.slice(r.out.indexOf("{")));
    // dump-package leaves `path` null for conventional layouts; `describe` has the resolved paths
    // (Sources/, Source/, src/ or srcs/ for regular targets).
    const desc = run(["swift", "package", "describe", "--type", "json"], { cwd: this.root, timeoutSec: 600 });
    if (desc.ok) {
      try {
        const dj = JSON.parse(desc.out.slice(desc.out.indexOf("{")));
        this.resolved = Object.fromEntries((dj.targets ?? []).map((t: any) => [t.name, t.path]));
      } catch { /* fall back to conventions */ }
    }
    return this.dump;
  }

  private tc() {
    if (this.toolchain) return this.toolchain;
    const dev = run(["xcode-select", "-p"]).out.trim();
    const clt = dev.includes("CommandLineTools") || !which("xcodebuild");
    const fw = "/Library/Developer/CommandLineTools/Library/Developer/Frameworks";
    const lib = "/Library/Developer/CommandLineTools/Library/Developer/usr/lib";
    // Xcode toolchains ship XCTest; the CLT ships Swift Testing only.
    const xctest = !clt || exists(path.join(fw, "XCTest.framework"));
    // SwiftPM enables Swift Testing by default only for tools-version >= 6.0 manifests; older packages
    // (most libraries) need --enable-swift-testing or their @Test functions silently never run.
    const swiftTestingFlag = run(["swift", "test", "--help"]).out.includes("--enable-swift-testing");
    this.toolchain = { clt, xctest, frameworksDir: clt ? fw : undefined, libDir: clt ? lib : undefined, swiftTestingFlag };
    return this.toolchain;
  }

  doctor(): Doctor {
    const lines: string[] = [];
    let ok = true;
    const v = run(["swift", "--version"]);
    if (!v.ok) {
      return { ok: false, lines: ["swift not found: install Xcode or the Command Line Tools"] };
    }
    lines.push(`swift: ${v.out.split("\n").find((l) => l.includes("Swift version"))?.trim()}`);
    const t = this.tc();
    lines.push(t.clt ? "toolchain: Command Line Tools (no Xcode) -> Swift Testing only, XCTest targets skipped during runs" : "toolchain: Xcode");
    try {
      const d = this.loadDump();
      const ts: DumpTarget[] = d.targets;
      const implicit = ts.filter((x) => x.type === "regular" && this.isImplicitExecutable(x));
      lines.push(`package: ${d.name} (${ts.filter((x) => x.type === "regular").length - implicit.length} library targets, ${ts.filter((x) => x.type === "executable").length + implicit.length} executable targets (not tested${implicit.length ? `; ${implicit.map((x) => x.name).join(", ")} declared as .target but has main.swift` : ""}), ${ts.filter((x) => x.type === "test").length} test targets)`);
      for (const m of this.modules()) {
        if (!exists(m.dir)) { ok = false; lines.push(`error: source directory of target ${m.name} not found: ${relPath(m.dir, this.root)}`); }
        else if (!this.sourceFiles(m).length) lines.push(`warning: target ${m.name} has no .swift files in ${relPath(m.dir, this.root)}`);
      }
      if (t.clt && ts.some((x) => x.type === "test")) {
        lines.push("note: existing XCTest suites cannot run without Xcode, so the baseline will be 0% here");
      }
      if (this.hasUIKitOnly()) {
        lines.push("warning: sources import UIKit; `swift test` on macOS cannot build them. Use an Xcode project/scheme with an iOS Simulator instead.");
      }
    } catch (e) {
      ok = false;
      lines.push(String((e as Error).message));
    }
    return { ok, lines };
  }

  /** An `import UIKit` outside any `#if` block (guarded imports build fine on macOS). */
  private hasUIKitOnly(): boolean {
    return this.modules().some((m) => this.sourceFiles(m).some((f) => {
      let depth = 0;
      for (const l of readFile(f).split("\n")) {
        const t = l.trim();
        if (t.startsWith("#if")) depth++;
        else if (t.startsWith("#endif")) depth = Math.max(0, depth - 1);
        else if (depth === 0 && /^import\s+UIKit\b/.test(t)) return true;
      }
      return false;
    }));
  }

  private targetDir(t: DumpTarget): string {
    if (t.path) return path.resolve(this.root, t.path);
    if (this.resolved[t.name]) return path.resolve(this.root, this.resolved[t.name]);
    const bases = t.type === "test" ? ["Tests", "Sources", "Source", "src", "srcs"] : ["Sources", "Source", "src", "srcs"];
    for (const b of bases) if (exists(path.join(this.root, b, t.name))) return path.join(this.root, b, t.name);
    return path.join(this.root, bases[0], t.name);
  }

  /** A plain `.target` with a top-level main.swift builds as an executable: tests cannot import it. */
  private isImplicitExecutable(t: DumpTarget): boolean {
    return exists(path.join(this.targetDir(t), "main.swift"));
  }

  modules(): Module[] {
    const d = this.loadDump();
    const targets: DumpTarget[] = d.targets;
    const testDirs = targets.filter((t) => t.type === "test").map((t) => this.targetDir(t));
    return targets
      .filter((t) => t.type === "regular" && !t.name.endsWith(SUFFIX) && !this.isImplicitExecutable(t))
      .map((t) => {
        const dir = this.targetDir(t);
        const conventional = path.join(this.root, "Tests", `${t.name}${SUFFIX}`);
        // Never nest our target inside another test target's directory (sources would overlap).
        const overlaps = testDirs.some((td) => !td.endsWith(SUFFIX) && (conventional + path.sep).startsWith(td + path.sep));
        const testRoot = overlaps ? path.join(this.root, "UnitGenTests", t.name) : conventional;
        return { name: t.name, dir, sourceRoots: [dir], testRoot, kind: "swiftpm-target", meta: { testTarget: `${t.name}${SUFFIX}` } };
      });
  }

  moduleFor(file: string): Module | undefined {
    const abs = path.resolve(file);
    return this.modules().find((m) => abs.startsWith(m.dir + path.sep) || abs.startsWith(m.testRoot + path.sep));
  }

  sourceFiles(m: Module): string[] {
    return walkFiles(m.dir, [".swift"]);
  }

  classify(file: string, text: string): FileKind {
    if (/Generated|\.generated\./.test(file) || /^\/\/.*(generated|DO NOT EDIT)/im.test(text.slice(0, 400))) return "generated";
    if (/:\s*(some\s+)?View\b|UIViewController|NSViewController|UIView\b|@main\b/.test(text) && /import\s+(SwiftUI|UIKit|AppKit)/.test(text)) return "ui";
    const decls = (text.match(/\bfunc\s+\w+/g) ?? []).length + (text.match(/\b(init|subscript)\s*[(<]/g) ?? []).length + (text.match(/\b(get|set)\s*\{/g) ?? []).length;
    if (decls === 0) return "model";
    return "logic";
  }

  placement(source: string, m: Module): TestPlacement {
    const base = path.basename(source, ".swift").replace(/[^A-Za-z0-9_]/g, "_");
    return {
      path: path.join(m.testRoot, `${base}${SUFFIX}.swift`),
      suiteName: `${base}${SUFFIX}`,
      importHint: `@testable import ${m.name}`,
    };
  }

  /** Major version from `// swift-tools-version:X.Y` (0 when unknown). */
  private toolsMajor(): number {
    const m = /^\/\/\s*swift-tools-version:\s*(\d+)/.exec(readFile(this.manifestPath()));
    return m ? Number(m[1]) : 0;
  }

  conventions(m: Module): string {
    const t = this.tc();
    // Before tools-version 6.0 a plain `swift test` (what the project's CI runs) skips Swift Testing:
    // generated tests must be XCTest there to keep running after unitgen is gone.
    const legacy = t.xctest && this.toolsMajor() > 0 && this.toolsMajor() < 6;
    const fw = legacy
      ? `Use XCTest (\`import XCTest\`, \`final class <the suite name above>: XCTestCase\`, \`func testX()\`, \`XCTAssertEqual\`, \`XCTUnwrap\`, \`XCTAssertThrowsError\`). This package declares swift-tools-version ${this.toolsMajor()}.x: a plain \`swift test\` (and its CI) runs Swift Testing only from 6.0 on, so Swift Testing tests would silently never run there.`
      : t.xctest
      ? "Use Swift Testing (`import Testing`, `@Suite struct ...`, `@Test func ...`, `#expect(...)`, `#require(...)`). XCTest is also available but prefer Swift Testing."
      : "Use Swift Testing ONLY (`import Testing`, `@Suite struct ...`, `@Test func ...`, `#expect(...)`, `try #require(...)`, `#expect(throws: SomeError.self) { ... }`). XCTest is NOT available in this environment: never `import XCTest`.";
    return [
      `Platform: iOS/Swift package, target \`${m.name}\`. Tests compile into the dedicated test target \`${m.meta?.testTarget}\` (directory ${relPath(m.testRoot, this.root)}).`,
      fw,
      `Start the file with \`import ${legacy ? "XCTest" : "Testing"}\`, \`import Foundation\` if needed, and \`@testable import ${m.name}\` (internal symbols are visible, private/fileprivate are not).`,
      "Tests run on macOS via `swift test`: do not use UIKit/AppKit, the network, the real file system outside a temporary directory, or timers.",
      legacy ? "For tables of inputs loop over an array of cases inside one test method; pass the case to XCTAssert's message." : "Use parameterized tests (`@Test(arguments: [...])`) for tables of inputs.",
      "Floating point: compare with a tolerance, e.g. `#expect(abs(x - 0.3) < 1e-9)`.",
      "Name clashes: Foundation (macOS 15+) defines types such as `Expression`, `Predicate`, `Measurement`. Only `import Foundation` when needed; if a type annotation is ambiguous, avoid the annotation or qualify it.",
      t.xctest ? "" : "The package's own XCTest suites cannot run here, but they are the best oracle: grep Tests/ for the API you test and reuse their inputs and expected values (port them to Swift Testing).",
      "Give closures in dictionary/array literals explicit types (`let f: SymbolEvaluator = { args in ... }`) — the type checker cannot infer multi-statement closures there.",
    ].filter(Boolean).join("\n");
  }

  exampleTests(m: Module, source?: string): string[] {
    const d = this.loadDump();
    const tests = (d.targets as DumpTarget[]).filter((t) => t.type === "test" && (t.dependencies ?? []).some((dep) => JSON.stringify(dep).includes(`"${m.name}"`)));
    const files = tests.flatMap((t) => walkFiles(this.targetDir(t), [".swift"]));
    return preferOwnTest(files, source, files.sort((a, b) => fs.statSync(a).size - fs.statSync(b).size).filter((f) => fs.statSync(f).size > 300));
  }

  prepareTestFile(testFile: string, m: Module): void {
    fs.mkdirSync(path.dirname(testFile), { recursive: true });
    this.ensureTarget(m);
  }

  /** Register `<Target>UnitGenTests` in Package.swift (idempotent). */
  ensureTarget(m: Module): void {
    const manifest = readFile(this.manifestPath());
    const name = m.meta?.testTarget as string;
    if (manifest.includes(`name: "${name}"`)) return;
    const line = `package.targets.append(.testTarget(name: "${name}", dependencies: ["${m.name}"], path: "${relPath(m.testRoot, this.root)}"))`;
    let next: string;
    if (manifest.includes(BEGIN)) {
      next = manifest.replace(END, `${line}\n${END}`);
    } else {
      next = `${manifest.trimEnd()}\n\n${BEGIN}\n${line}\n${END}\n`;
    }
    writeFile(this.manifestPath(), next);
    this.dump = undefined;
  }

  private backupPath(): string {
    return path.join(this.stateDir, "Package.swift.orig");
  }

  recover(): void {
    this.restoreIfCrashed();
  }

  private restoreIfCrashed(): void {
    if (exists(this.backupPath())) {
      fs.copyFileSync(this.backupPath(), this.manifestPath());
      fs.unlinkSync(this.backupPath());
    }
    this.unpark();
  }

  private parkJournal(): string {
    return path.join(this.stateDir, "swift-parked.json");
  }

  /**
   * Swift Testing on the CLT ignores --filter, so isolate a verify run by moving the other generated
   * test files of the same target aside; otherwise their coverage and test counts leak into this file's.
   */
  private park(keep: string[]): void {
    const keepSet = new Set(keep.map((f) => path.resolve(f)));
    const moved: { from: string; to: string }[] = [];
    const dirs = new Set(keep.map((f) => path.dirname(path.resolve(f))));
    for (const d of dirs) {
      for (const f of walkFiles(d, [".swift"])) {
        if (keepSet.has(f) || !f.endsWith(`${SUFFIX}.swift`)) continue;
        const to = path.join(this.stateDir, "swift-parked", relPath(f, this.root));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        moved.push({ from: f, to });
      }
    }
    if (!moved.length) return;
    writeFile(this.parkJournal(), JSON.stringify(moved));
    for (const m of moved) fs.renameSync(m.from, m.to);
  }

  private unpark(): void {
    if (!exists(this.parkJournal())) return;
    const moved = JSON.parse(readFile(this.parkJournal())) as { from: string; to: string }[];
    for (const m of moved) if (exists(m.to)) fs.renameSync(m.to, m.from);
    fs.unlinkSync(this.parkJournal());
  }

  /** Temporarily rewrite Package.swift so the run works on this toolchain. Returns a restore fn. */
  private applyRuntimeManifest(onlyOurs: boolean, withoutOurs = false): () => void {
    const t = this.tc();
    const d = this.loadDump();
    const original = readFile(this.manifestPath());
    const patches: string[] = [];
    let text = original;
    if (!t.xctest || onlyOurs) {
      patches.push(`package.targets.removeAll { $0.type == .test && !$0.name.hasSuffix("${SUFFIX}") }`);
    }
    if (withoutOurs) patches.push(`package.targets.removeAll { $0.type == .test && $0.name.hasSuffix("${SUFFIX}") }`);
    const hasOurTargets = original.includes(BEGIN);
    // Swift Testing needs macOS 10.15+ and tools-version >= 5.9 semantics.
    const mac = (d.platforms ?? []).find((p: any) => p.platformName === "macos");
    const macOk = mac && Number(String(mac.version).split(".")[0]) >= 11 || (mac && String(mac.version).startsWith("10.15"));
    if (hasOurTargets && !macOk) {
      const others = (d.platforms ?? []).filter((p: any) => p.platformName !== "macos");
      const swiftName: Record<string, string> = { ios: "iOS", tvos: "tvOS", watchos: "watchOS", maccatalyst: "macCatalyst", visionos: "visionOS", driverkit: "driverKit" };
      const list = others.filter((p: any) => swiftName[p.platformName]).map((p: any) => `.${swiftName[p.platformName]}("${p.version}")`);
      list.push(`.macOS("10.15")`);
      patches.push(`package.platforms = [${list.join(", ")}]`);
    }
    const tv = /^\/\/\s*swift-tools-version:\s*(\d+)\.(\d+)/.exec(original);
    if (hasOurTargets && tv && (Number(tv[1]) < 5 || (Number(tv[1]) === 5 && Number(tv[2]) < 9))) {
      text = text.replace(/^\/\/\s*swift-tools-version:\s*[\d.]+/, "// swift-tools-version:5.9");
    }
    if (!patches.length && text === original) return () => {};
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.copyFileSync(this.manifestPath(), this.backupPath());
    writeFile(this.manifestPath(), `${text.trimEnd()}\n\n${RUNTIME}\n${patches.join("\n")}\n`);
    return () => {
      fs.copyFileSync(this.backupPath(), this.manifestPath());
      fs.unlinkSync(this.backupPath());
    };
  }

  /** llvm-cov export of the raw profiles next to SwiftPM's codecov JSON path (same format as that JSON). */
  private async coverageFromProfraw(codecovJson: string): Promise<any | undefined> {
    const dir = path.dirname(codecovJson);
    const raws = walkFiles(dir, [".profraw"]);
    if (!raws.length) return undefined;
    const xcrun = process.platform === "darwin" ? ["xcrun"] : [];
    const profdata = path.join(this.stateDir, "merged.profdata");
    const merged = await runAsync([...xcrun, "llvm-profdata", "merge", "-sparse", ...raws, "-o", profdata], { cwd: this.root });
    if (!merged.ok) return undefined;
    const bundle = fs.readdirSync(path.dirname(dir)).find((f) => f.endsWith("PackageTests.xctest"));
    if (!bundle) return undefined;
    const b = path.join(path.dirname(dir), bundle);
    const bin = process.platform === "darwin" ? path.join(b, "Contents", "MacOS", bundle.replace(/\.xctest$/, "")) : b;
    if (!exists(bin)) return undefined;
    const exp = await runAsync([...xcrun, "llvm-cov", "export", "-format=text", "-instr-profile", profdata, bin], { cwd: this.root, stream: false });
    fs.rmSync(profdata, { force: true });
    if (!exp.ok) return undefined;
    try { return JSON.parse(exp.out.slice(exp.out.indexOf("{"))); } catch { return undefined; }
  }

  async runTests(req: RunRequest): Promise<TestRun> {
    const t = this.tc();
    const logFile = path.join(this.stateDir, "logs", `${req.label}.log`);
    const mods = req.modules ?? this.modules();
    const ours = req.testFiles !== undefined;
    const restore = this.applyRuntimeManifest(ours, !ours && !!req.excludeGenerated);
    if (ours) this.park(req.testFiles!);
    const start = Date.now();
    try {
      const args = ["swift", "test"];
      if (t.swiftTestingFlag) args.push("--enable-swift-testing");
      if (req.coverage) args.push("--enable-code-coverage");
      if (t.clt && t.frameworksDir) {
        args.push("-Xswiftc", `-F${t.frameworksDir}`, "-Xlinker", `-F${t.frameworksDir}`,
          "-Xlinker", "-rpath", "-Xlinker", t.frameworksDir, "-Xlinker", "-rpath", "-Xlinker", t.libDir!);
      }
      // No --filter: with the CLT toolchain Swift Testing ignores SwiftPM's filter ("No matching test
      // cases"). Isolated runs already drop every non-generated test target via the runtime manifest,
      // and coverage gains are computed against baseline + accepted, so co-running accepted files is harmless.
      // Raw profiles of an earlier run must not leak into this one (see coverageFromProfraw).
      const codecovJson = req.coverage ? (await runAsync(["swift", "test", "--show-codecov-path"], { cwd: this.root })).out.trim().split("\n").pop()! : "";
      if (codecovJson) for (const f of walkFiles(path.dirname(codecovJson), [".profraw"])) fs.rmSync(f, { force: true });
      const r = await runAsync(args, { cwd: this.root, timeoutSec: req.timeoutSec ?? 3600, logFile });
      const out = stripAnsi(r.out);
      const tests = parseSwiftTestOutput(out);
      const compiled = !/error: (emit-module|compile|link)|error: fatalError|: error: /.test(out) || tests.length > 0;
      let coverage;
      if (req.coverage && compiled) {
        const p = codecovJson;
        const dirs = mods.map((m) => m.dir + path.sep);
        if (exists(p)) {
          coverage = parseLlvmCovJson(JSON.parse(readFile(p)), (f) => dirs.some((d) => f.startsWith(d)));
          if (process.env.UNITGEN_KEEP_COV !== "1") fs.unlinkSync(p);
        } else {
          // SwiftPM writes the JSON only when every test passes; with failing tests (a baseline with
          // --allow-failing) the raw profiles are still there.
          const json = await this.coverageFromProfraw(p);
          if (json) coverage = parseLlvmCovJson(json, (f) => dirs.some((d) => f.startsWith(d)));
        }
      }
      const infraError = r.timedOut ? "timeout" : undefined;
      if (!ours && !t.xctest) {
        // Baseline on the CLT: XCTest targets were dropped by the runtime manifest.
        writeFile(logFile + ".note", "xctest-skipped");
      }
      const noTests = /error: no tests found/.test(out);
      return {
        ok: r.ok || (noTests && !ours), compiled, tests, coverage, logFile, seconds: (Date.now() - start) / 1000,
        excerpt: r.ok || (noTests && !ours) ? "" : errorExcerpt(out), infraError,
        note: !ours && !t.xctest ? "existing XCTest suites skipped: XCTest needs Xcode (only the Command Line Tools are installed)" : undefined,
      };
    } finally {
      this.unpark();
      restore();
    }
  }

  countAssertions(text: string): number {
    return (text.match(/#expect\s*\(|#require\s*\(|XCTAssert\w*\s*\(|XCTFail\s*\(|#expect\(throws/g) ?? []).length;
  }
}

/** Parse both Swift Testing (✔/✘ lines) and XCTest ("Test Case '-[A b]' passed") output. */
export function parseSwiftTestOutput(out: string): TestCase[] {
  const byName = new Map<string, TestCase>();
  for (const line of out.split("\n")) {
    // Issue lines first: "✘ Test foo() recorded an issue at F.swift:12:3: Expectation failed: ..." also contains "failed".
    let m = /^[✘􀢄]\s*Test (.+?) recorded an issue(?: with \d+ arguments? .*?)? at (\S+?:\d+:\d+): (.+)$/.exec(line.trim());
    if (m) {
      const name = m[1];
      const prev = byName.get(name) ?? { name, status: "failed" as const };
      prev.status = "failed";
      prev.message = ((prev.message ? prev.message + "\n" : "") + `${m[2]}: ${m[3]}`).slice(0, 2000);
      byName.set(name, prev);
      continue;
    }
    m = /^[✔✘􁁛􀢄↷]\s*Test (?!run with|case )(.+?) (passed|failed|skipped)(?: after| with|\.|$)/.exec(line.trim());
    if (m) {
      const name = m[1].replace(/ with \d+ test cases?$/, "");
      const prev = byName.get(name);
      const status = prev?.status === "failed" ? "failed" : (m[2] as TestCase["status"]);
      byName.set(name, { name, status, message: prev?.message });
      continue;
    }
    m = /^Test Case '-\[(\S+) (\S+)\]' (passed|failed|skipped)/.exec(line.trim());
    if (m) {
      const name = `${m[1]}.${m[2]}`;
      byName.set(name, { name, status: m[3] as TestCase["status"], message: byName.get(name)?.message });
      continue;
    }
    m = /^(.+?):(\d+): error: -\[(\S+) (\S+)\] : (.+)$/.exec(line.trim());
    if (m) {
      const name = `${m[3]}.${m[4]}`;
      byName.set(name, { name, status: "failed", message: `${m[1]}:${m[2]}: ${m[5]}` });
    }
  }
  return [...byName.values()];
}
