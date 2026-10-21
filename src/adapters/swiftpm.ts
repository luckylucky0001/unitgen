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
  private toolchain?: { clt: boolean; xctest: boolean; frameworksDir?: string; libDir?: string };

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
    this.toolchain = { clt, xctest, frameworksDir: clt ? fw : undefined, libDir: clt ? lib : undefined };
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
      lines.push(`package: ${d.name} (${ts.filter((x) => x.type === "regular").length} source targets, ${ts.filter((x) => x.type === "test").length} test targets)`);
      if (this.hasUIKitOnly()) {
        lines.push("warning: sources import UIKit; `swift test` on macOS cannot build them. Use an Xcode project/scheme with an iOS Simulator instead.");
      }
    } catch (e) {
      ok = false;
      lines.push(String((e as Error).message));
    }
    return { ok, lines };
  }

  private hasUIKitOnly(): boolean {
    return this.modules().some((m) => this.sourceFiles(m).some((f) => /^\s*import\s+UIKit\b/m.test(readFile(f)) && !/canImport\(UIKit\)/.test(readFile(f))));
  }

  private targetDir(t: DumpTarget): string {
    if (t.path) return path.resolve(this.root, t.path);
    const base = t.type === "test" ? "Tests" : "Sources";
    return path.join(this.root, base, t.name);
  }

  modules(): Module[] {
    const d = this.loadDump();
    const targets: DumpTarget[] = d.targets;
    const testDirs = targets.filter((t) => t.type === "test").map((t) => this.targetDir(t));
    return targets
      .filter((t) => t.type === "regular" && !t.name.endsWith(SUFFIX))
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

  conventions(m: Module): string {
    const t = this.tc();
    const fw = t.xctest
      ? "Use Swift Testing (`import Testing`, `@Suite struct ...`, `@Test func ...`, `#expect(...)`, `#require(...)`). XCTest is also available but prefer Swift Testing."
      : "Use Swift Testing ONLY (`import Testing`, `@Suite struct ...`, `@Test func ...`, `#expect(...)`, `try #require(...)`, `#expect(throws: SomeError.self) { ... }`). XCTest is NOT available in this environment: never `import XCTest`.";
    return [
      `Platform: iOS/Swift package, target \`${m.name}\`. Tests compile into the dedicated test target \`${m.meta?.testTarget}\` (directory ${relPath(m.testRoot, this.root)}).`,
      fw,
      `Start the file with \`import Testing\`, \`import Foundation\` if needed, and \`@testable import ${m.name}\` (internal symbols are visible, private/fileprivate are not).`,
      "Tests run on macOS via `swift test`: do not use UIKit/AppKit, the network, the real file system outside a temporary directory, or timers.",
      "Use parameterized tests (`@Test(arguments: [...])`) for tables of inputs.",
      "Floating point: compare with a tolerance, e.g. `#expect(abs(x - 0.3) < 1e-9)`.",
      "Name clashes: Foundation (macOS 15+) defines types such as `Expression`, `Predicate`, `Measurement`. Only `import Foundation` when needed; if a type annotation is ambiguous, avoid the annotation or qualify it.",
      "Give closures in dictionary/array literals explicit types (`let f: SymbolEvaluator = { args in ... }`) — the type checker cannot infer multi-statement closures there.",
    ].join("\n");
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

  private restoreIfCrashed(): void {
    if (exists(this.backupPath())) {
      fs.copyFileSync(this.backupPath(), this.manifestPath());
      fs.unlinkSync(this.backupPath());
    }
  }

  /** Temporarily rewrite Package.swift so the run works on this toolchain. Returns a restore fn. */
  private applyRuntimeManifest(onlyOurs: boolean): () => void {
    const t = this.tc();
    const d = this.loadDump();
    const original = readFile(this.manifestPath());
    const patches: string[] = [];
    let text = original;
    if (!t.xctest || onlyOurs) {
      patches.push(`package.targets.removeAll { $0.type == .test && !$0.name.hasSuffix("${SUFFIX}") }`);
    }
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

  runTests(req: RunRequest): TestRun {
    const t = this.tc();
    const logFile = path.join(this.stateDir, "logs", `${req.label}.log`);
    const mods = req.modules ?? this.modules();
    const ours = req.testFiles !== undefined;
    const restore = this.applyRuntimeManifest(ours);
    const start = Date.now();
    try {
      const args = ["swift", "test"];
      if (req.coverage) args.push("--enable-code-coverage");
      if (t.clt && t.frameworksDir) {
        args.push("-Xswiftc", `-F${t.frameworksDir}`, "-Xlinker", `-F${t.frameworksDir}`,
          "-Xlinker", "-rpath", "-Xlinker", t.frameworksDir, "-Xlinker", "-rpath", "-Xlinker", t.libDir!);
      }
      // No --filter: with the CLT toolchain Swift Testing ignores SwiftPM's filter ("No matching test
      // cases"). Isolated runs already drop every non-generated test target via the runtime manifest,
      // and coverage gains are computed against baseline + accepted, so co-running accepted files is harmless.
      const r = run(args, { cwd: this.root, timeoutSec: 3600, logFile });
      const out = stripAnsi(r.out);
      const tests = parseSwiftTestOutput(out);
      const compiled = !/error: (emit-module|compile|link)|error: fatalError|: error: /.test(out) || tests.length > 0;
      let coverage;
      if (req.coverage && compiled) {
        const p = run(["swift", "test", "--show-codecov-path"], { cwd: this.root }).out.trim().split("\n").pop()!;
        if (exists(p)) {
          const dirs = mods.map((m) => m.dir + path.sep);
          coverage = parseLlvmCovJson(JSON.parse(readFile(p)), (f) => dirs.some((d) => f.startsWith(d)));
          if (process.env.UNITGEN_KEEP_COV !== "1") fs.unlinkSync(p);
        }
      }
      const infraError = r.timedOut ? "timeout" : /no such module 'XCTest'/.test(out) && !ours ? "XCTest unavailable" : undefined;
      return {
        ok: r.ok, compiled, tests, coverage, logFile, seconds: (Date.now() - start) / 1000,
        excerpt: r.ok ? "" : errorExcerpt(out), infraError,
      };
    } finally {
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
