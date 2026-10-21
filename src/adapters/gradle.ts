// Android (AGP) and plain JVM Kotlin/Java modules via Gradle + JaCoCo (injected init script).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type Coverage, mergeCoverage, parseJacocoXml } from "../coverage.ts";
import { errorExcerpt, exists, preferOwnTest, readFile, readJson, relPath, run, stripAnsi, walkFiles, writeJson } from "../util.ts";
import type { Adapter, Doctor, FileKind, Module, RunRequest, TestCase, TestPlacement, TestRun } from "./types.ts";

const INIT_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "unitgen-jacoco.init.gradle");
const SUFFIX = "UnitGenTest";

// Flags that keep our init script compatible with builds that opt into CC / isolated projects.
const COMPAT = ["--no-configuration-cache", "-Dorg.gradle.isolated-projects=false", "-Dorg.gradle.unsafe.isolated-projects=false", "--console=plain"];

export class GradleAdapter implements Adapter {
  readonly id = "gradle";
  readonly platform = "android" as const;
  readonly testFileSuffix = `${SUFFIX}.kt`;
  private mods?: Module[];

  readonly root: string;
  private readonly stateDir: string;

  constructor(root: string, stateDir: string) {
    this.root = root;
    this.stateDir = stateDir;
  }

  static detect(root: string): boolean {
    return ["settings.gradle.kts", "settings.gradle"].some((f) => exists(path.join(root, f)));
  }

  private gradlew(): string[] {
    const w = path.join(this.root, "gradlew");
    return exists(w) ? [w] : ["gradle"];
  }

  doctor(): Doctor {
    const lines: string[] = [];
    let ok = true;
    const j = run(["java", "-version"]);
    if (!j.ok) {
      ok = false;
      lines.push("java not found: set JAVA_HOME to a JDK 17+ (Android Gradle Plugin 8+ requirement)");
    } else {
      lines.push(`java: ${j.out.split("\n")[0]}`);
    }
    const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    const lp = path.join(this.root, "local.properties");
    const hasAndroid = this.modules().some((m) => m.kind === "android");
    if (hasAndroid && !sdk && !(exists(lp) && /sdk\.dir/.test(readFile(lp)))) {
      ok = false;
      lines.push("Android modules found but no SDK: set ANDROID_HOME or sdk.dir in local.properties");
    } else if (hasAndroid) {
      lines.push(`android sdk: ${sdk ?? "(local.properties)"}`);
    }
    lines.push(`modules: ${this.modules().length} (${this.modules().filter((m) => m.kind === "android").length} android, ${this.modules().filter((m) => m.kind === "jvm").length} jvm)`);
    return { ok, lines };
  }

  modules(): Module[] {
    if (this.mods) return this.mods;
    const settings = ["settings.gradle.kts", "settings.gradle"].map((f) => path.join(this.root, f)).find(exists)!;
    const text = readFile(settings).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const names = new Set<string>();
    for (const m of text.matchAll(/\binclude\s*\(?([^)\n]*)\)?/g)) {
      for (const s of m[1].matchAll(/["']([:\w.-]+)["']/g)) names.add(s[1].startsWith(":") ? s[1] : `:${s[1]}`);
    }
    const out: Module[] = [];
    if (exists(path.join(this.root, "src", "main"))) names.add(":");
    for (const name of names) {
      const dir = name === ":" ? this.root : path.join(this.root, ...name.slice(1).split(":"));
      const buildFile = ["build.gradle.kts", "build.gradle"].map((f) => path.join(dir, f)).find(exists);
      if (!buildFile) continue;
      const bt = readFile(buildFile);
      const android = exists(path.join(dir, "src", "main", "AndroidManifest.xml")) || /com\.android\.|android\s*\{|\.android\.(library|application)|android\.library|android\.application/.test(bt);
      const srcDirs = fs.existsSync(path.join(dir, "src")) ? fs.readdirSync(path.join(dir, "src")) : [];
      const sourceRoots = srcDirs
        .filter((d) => !/test|Test|testFixtures|androidTest|benchmark/i.test(d))
        .flatMap((d) => ["java", "kotlin"].map((l) => path.join(dir, "src", d, l)))
        .filter(exists);
      if (!sourceRoots.length) continue;
      const usesKotlin = sourceRoots.some((r) => walkFiles(r, [".kt"]).length > 0);
      // Use the test source set where the module's tests actually live: src/test, or a flavor set
      // like src/testDemo when the test helpers are only on testDemoImplementation.
      const testSets = srcDirs.filter((d) => /^test([A-Z]\w*)?$/.test(d));
      const counts = testSets.map((d) => ({ d, n: walkFiles(path.join(dir, "src", d), [".kt", ".java"]).length }));
      const plain = counts.find((c) => c.d === "test");
      const flavored = counts.filter((c) => c.d !== "test").sort((a, b) => b.n - a.n)[0];
      const flavorOnlyHelpers = /test[A-Z]\w*Implementation\s*\(\s*projects\.core\.testing|test[A-Z]\w*Implementation\s*\(\s*project\(\s*["']:[\w:-]*test/.test(bt);
      const set = flavored && flavored.n > 0 && (!plain || plain.n === 0 || (flavorOnlyHelpers && flavored.n >= plain.n)) ? flavored.d : "test";
      const testRoot = path.join(dir, "src", set, usesKotlin ? "kotlin" : "java");
      const altTestRoot = path.join(dir, "src", set, usesKotlin ? "java" : "kotlin");
      out.push({
        name, dir, sourceRoots,
        testRoot: exists(testRoot) || !exists(altTestRoot) ? testRoot : altTestRoot,
        kind: android ? "android" : "jvm",
        meta: { buildFile, kotlin: usesKotlin, buildText: bt },
      });
    }
    this.mods = out;
    return out;
  }

  moduleFor(file: string): Module | undefined {
    const abs = path.resolve(file);
    return this.modules()
      .filter((m) => abs.startsWith(m.dir + path.sep))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
  }

  sourceFiles(m: Module): string[] {
    return m.sourceRoots.flatMap((r) => walkFiles(r, [".kt", ".java"]));
  }

  classify(file: string, text: string): FileKind {
    if (/\/(generated|build)\//.test(file)) return "generated";
    if (/@Composable|: (ComponentActivity|AppCompatActivity|Activity|Fragment)\(|extends (Activity|Fragment)|@AndroidEntryPoint|@HiltAndroidApp/.test(text)) {
      // ViewModels in feature modules are logic even next to compose code.
      if (/: ViewModel\(|extends ViewModel/.test(text)) return "logic";
      return "ui";
    }
    if (/@Module\b/.test(text) && /@(Test)?InstallIn\b|@Provides\b|@Binds\b/.test(text)) return "di";
    if (/PreviewParameterProvider|@Preview\b/.test(text)) return "ui";
    // Thin wrappers over framework services (notifications, connectivity, broadcasts, WorkManager).
    if (/import android\.(app\.Notification|net\.Connectivity|content\.BroadcastReceiver|content\.Context\b|os\.Build)|import androidx\.(work|core\.app\.Notification)/.test(text) && !/: ViewModel\(/.test(text)) return "platform";
    if (/^\s*@(Dao|Database)\b/m.test(text)) return "generated"; // Room generates the implementation
    if (this.isTestSupport(file)) return "test";
    if (/: ViewModel\(/.test(text)) return "logic";
    const funs = (text.match(/\bfun\s+[\w.<>]+\s*\(/g) ?? []).length + (text.match(/\b(public|private|protected)?\s*[\w<>\[\]]+\s+\w+\s*\([^)]*\)\s*(throws [\w, ]+)?\s*\{/g) ?? []).length;
    if (funs === 0) return "model";
    if (/@Dao\b|@Entity\b|@Database\b/.test(text) && funs < 3) return "model";
    return "logic";
  }

  testSupportDirs(m: Module): string[] {
    const bt: string = m.meta?.buildText ?? "";
    const names = new Set<string>();
    for (const d of bt.matchAll(/test\w*Implementation\s*\(\s*project\(\s*["']([:\w-]+)["']\s*\)|test\w*Implementation\s*\(\s*projects\.([\w.]+)/g)) {
      names.add(d[1] ?? ":" + d[2].replace(/([A-Z])/g, "-$1").toLowerCase().replace(/\./g, ":"));
    }
    return this.modules().filter((x) => names.has(x.name) || [...names].some((n) => n.replace(/-/g, "") === x.name.replace(/-/g, ""))).flatMap((x) => x.sourceRoots);
  }

  /** Test-helper and benchmark modules (core:testing, *-test, benchmarks) are not targets. */
  private isTestSupport(file: string): boolean {
    const m = this.moduleFor(file);
    return !!m && /(^|[:-])(testing|test|benchmarks?|baselineprofile|ui-test[\w-]*)$/.test(m.name);
  }

  private packageOf(source: string): string | undefined {
    return /^\s*package\s+([\w.]+)/m.exec(readFile(source))?.[1];
  }

  placement(source: string, m: Module): TestPlacement {
    const pkg = this.packageOf(source);
    const base = path.basename(source).replace(/\.(kt|java)$/, "");
    const dir = path.join(m.testRoot, ...(pkg ? pkg.split(".") : []));
    const ext = m.testRoot.endsWith("java") && source.endsWith(".java") ? ".java" : ".kt";
    return { path: path.join(dir, `${base}${SUFFIX}${ext}`), suiteName: `${base}${SUFFIX}`, packageName: pkg };
  }

  /** Test libraries visible to the module's unit tests (best effort). Direct = module build file, else via convention plugins. */
  private testDeps(m: Module): { direct: string[]; indirect: string[] } {
    const direct = [m.meta?.buildText ?? ""];
    const indirect: string[] = [];
    const catalog = path.join(this.root, "gradle", "libs.versions.toml");
    const cat = exists(catalog) ? readFile(catalog) : "";
    for (const dir of ["build-logic", "buildSrc"]) {
      const d = path.join(this.root, dir);
      if (exists(d)) for (const f of walkFiles(d, [".kt", ".kts", ".gradle"])) indirect.push(readFile(f));
    }
    // Local test-helper modules (e.g. :core:testing) re-export their deps via `api(...)`.
    for (const dep of direct[0].matchAll(/testImplementation\s*\(\s*(?:project\()?\s*projects\.([\w.]+)|testImplementation\s*\(\s*project\(\s*["']([:\w-]+)["']/g)) {
      const name = dep[1] ? ":" + dep[1].replace(/([A-Z])/g, "-$1").toLowerCase().replace(/\./g, ":") : dep[2];
      const mod = this.modules().find((x) => x.name === name || x.name.replace(/-/g, "") === name.replace(/-/g, ""));
      if (mod?.meta?.buildText) direct.push(mod.meta.buildText);
    }
    // Expand `libs.foo.bar` aliases to their Maven coordinates so the patterns below can match.
    const expand = (t: string) => t.replace(/libs\.([\w.]+)/g, (all, alias: string) => {
      const key = alias.replace(/\./g, "[-._]");
      const line = new RegExp(`^${key}\\s*=.*$`, "m").exec(cat)?.[0];
      return line ? `${all} ${line}` : all;
    });
    const known: [RegExp, string][] = [
      [/junit-jupiter|junit5|org\.junit\.jupiter/i, "JUnit 5 (org.junit.jupiter.api.*)"],
      [/junit:junit|libs\.junit\b|junit4|\bjunit = |"junit"/i, "JUnit 4 (org.junit.Test, org.junit.Assert.*)"],
      [/kotlin-test|kotlin\("test"\)|kotlin\.test/i, "kotlin.test (kotlin.test.assertEquals ...)"],
      [/mockk/i, "MockK (io.mockk.*)"],
      [/mockito/i, "Mockito / mockito-kotlin"],
      [/truth/i, "Google Truth (com.google.common.truth.Truth.assertThat)"],
      [/assertj/i, "AssertJ"],
      [/turbine/i, "Turbine (app.cash.turbine.test) for Flow"],
      [/coroutines-test|kotlinx\.coroutines\.test/i, "kotlinx-coroutines-test (runTest, StandardTestDispatcher)"],
      [/robolectric/i, "Robolectric (@RunWith(RobolectricTestRunner::class))"],
      [/kotest/i, "Kotest assertions"],
    ];
    const d = expand(direct.join("\n"));
    const i = expand(indirect.join("\n"));
    const directHits = known.filter(([re]) => re.test(d)).map(([, s]) => s);
    return { direct: directHits, indirect: known.filter(([re]) => !re.test(d) && re.test(i)).map(([, s]) => s) };
  }

  conventions(m: Module): string {
    const { direct, indirect } = this.testDeps(m);
    const lang = m.meta?.kotlin ? "Kotlin" : "Java";
    return [
      `Platform: ${m.kind === "android" ? "Android library/app" : "JVM"} module \`${m.name}\`, local JVM unit tests (src/test), language ${lang}.`,
      `Test libraries declared by this module (use ONLY these; do not add dependencies): ${direct.length ? direct.join("; ") : "none found directly"}.`,
      indirect.length ? `Possibly added by convention plugins (only use if the existing tests above import them): ${indirect.join("; ")}.` : "",
      "Check the imports of the existing tests below: they show exactly what is on the test classpath.",
      m.kind === "android"
        ? "These are local unit tests on the JVM: android.* classes are stubs that throw unless Robolectric is used. Prefer testing pure logic; mock or fake Android types; never use Context unless Robolectric is available."
        : "Pure JVM tests: no Android APIs.",
      "Suspend functions / Flows: use kotlinx-coroutines-test `runTest { }` if available. Never use Thread.sleep or real dispatchers with delays.",
      "Prefer the project's own test doubles (look for Test*Repository / Fake* classes in the examples or test-helper modules) over mocking frameworks.",
      "The file must declare the same `package` as the class under test so internal members are accessible.",
      "android.util.Log and other android.* calls throw \"Method ... not mocked\" in local tests unless `unitTests.isReturnDefaultValues = true` or Robolectric is used: do not drive code paths that log via android.util.Log.",
    ].filter(Boolean).join("\n");
  }

  exampleTests(m: Module, source?: string): string[] {
    const srcDir = path.join(m.dir, "src");
    const sets = exists(srcDir) ? fs.readdirSync(srcDir).filter((d) => /^test([A-Z]\w*)?$/.test(d)) : [];
    const tests = sets.flatMap((d) => walkFiles(path.join(srcDir, d), [".kt", ".java"])).filter((f) => !f.includes(SUFFIX));
    const small = tests.filter((f) => fs.statSync(f).size > 400).sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
    return preferOwnTest(tests, source, small);
  }

  prepareTestFile(testFile: string): void {
    fs.mkdirSync(path.dirname(testFile), { recursive: true });
  }

  /** Map module -> preferred unit-test task (cached `tasks --all` output). */
  private testTasks(): Record<string, string | undefined> {
    const cache = path.join(this.stateDir, "gradle-test-tasks.json");
    const settingsMtime = this.modules().map((m) => fs.statSync(m.meta!.buildFile).mtimeMs).join(",");
    const c = readJson<{ key: string; tasks: Record<string, string | undefined> } | null>(cache, null);
    if (c && c.key === settingsMtime) return c.tasks;
    const r = run([...this.gradlew(), "-q", "tasks", "--all", ...COMPAT], { cwd: this.root, timeoutSec: 1800, logFile: path.join(this.stateDir, "logs", "gradle-tasks.log") });
    const byMod: Record<string, string[]> = {};
    for (const line of stripAnsi(r.out).split("\n")) {
      const m = /^([\w:.-]*?):?(test[A-Za-z0-9]*)\s+-\s/.exec(line.trim());
      if (!m) continue;
      const mod = m[1] ? `:${m[1]}` : ":";
      (byMod[mod] ??= []).push(m[2]);
    }
    const tasks: Record<string, string | undefined> = {};
    const listed = Object.keys(byMod).length > 0;
    for (const mod of this.modules()) {
      const ts = byMod[mod.name] ?? [];
      const unit = ts.filter((t) => /^test\w*DebugUnitTest$/.test(t)).sort((a, b) => a.length - b.length || a.localeCompare(b));
      // Modules without a unit-test task (e.g. com.android.test benchmarks) are skipped.
      tasks[mod.name] = unit[0] ?? (ts.includes("test") && mod.kind === "jvm" ? "test" : listed ? undefined : mod.kind === "jvm" ? "test" : "testDebugUnitTest");
    }
    writeJson(cache, { key: settingsMtime, tasks });
    return tasks;
  }

  private fqnOf(testFile: string): string {
    const pkg = /^\s*package\s+([\w.]+)/m.exec(readFile(testFile))?.[1];
    const cls = path.basename(testFile).replace(/\.(kt|java)$/, "");
    return pkg ? `${pkg}.${cls}` : cls;
  }

  runTests(req: RunRequest): TestRun {
    const logFile = path.join(this.stateDir, "logs", `${req.label}.log`);
    const start = Date.now();
    let mods = req.modules ?? this.modules();
    if (req.testFiles) {
      const owners = new Set(req.testFiles.map((f) => this.moduleFor(f)?.name));
      mods = this.modules().filter((m) => owners.has(m.name));
    }
    const tasks = this.testTasks();
    mods = mods.filter((m) => tasks[m.name]);
    if (!mods.length) {
      return { ok: false, compiled: true, tests: [], logFile, excerpt: "no unit-test task found for the selected module(s)", seconds: 0, infraError: "no unit-test task" };
    }
    const args = [...this.gradlew(), ...COMPAT, "--continue", "-I", INIT_SCRIPT];
    for (const m of mods) {
      const prefix = m.name === ":" ? ":" : `${m.name}:`;
      // Task options bind to the task immediately before them, so --tests must follow the test task.
      args.push(`${prefix}${tasks[m.name]}`);
      // Force execution for generated tests: up-to-date checks / build cache would hide flakiness.
      if (req.testFiles) args.push("--rerun");
      if (req.testFiles) for (const f of req.testFiles) if (this.moduleFor(f)?.name === m.name) args.push("--tests", this.fqnOf(f));
      if (req.coverage) args.push(`${prefix}unitgenJacocoReport`);
    }
    if (req.coverage) args.push(`-Punitgen.tasks=${mods.map((m) => `${m.name}=${tasks[m.name]}`).join(",")}`);
    // Clear stale results so we only parse this run.
    for (const m of mods) {
      fs.rmSync(path.join(m.dir, "build", "test-results", tasks[m.name]!), { recursive: true, force: true });
      fs.rmSync(path.join(m.dir, "build", "unitgen"), { recursive: true, force: true });
    }
    const r = run(args, { cwd: this.root, timeoutSec: req.timeoutSec ?? 3600, logFile });
    let out = r.out;
    out = stripAnsi(out);
    const tests: TestCase[] = [];
    for (const m of mods) tests.push(...parseJUnitXmlDir(path.join(m.dir, "build", "test-results", tasks[m.name]!)));
    const compileFailed = /Compilation error|e: file:|error: |compile\w*Kotlin' FAILED|compile\w*JavaWithJavac' FAILED|Execution failed for task '.*compile/i.test(out) && /BUILD FAILED/.test(out);
    const noTests = /No tests found for given includes/.test(out);
    let coverage: Coverage | undefined;
    if (req.coverage) {
      const covs: Coverage[] = [];
      for (const m of mods) {
        const xml = path.join(m.dir, "build", "unitgen", "jacoco.xml");
        if (exists(xml)) covs.push(parseJacocoXml(readFile(xml), (p) => this.resolveSource(m, p)));
      }
      coverage = mergeCoverage(...covs);
    }
    const coverageWarnings = [...new Set([...out.matchAll(/Execution data for class (\S+) does not match/g)].map((m) => m[1]))];
    const infra = /SDK location not found|Could not resolve all|Could not GET|Unable to locate a Java Runtime|TIMEOUT|Problem configuring task|Selection failed/.exec(out)?.[0];
    return {
      ok: r.ok && !noTests,
      compiled: !compileFailed,
      tests, coverage, logFile, seconds: (Date.now() - start) / 1000, coverageWarnings,
      excerpt: r.ok && !noTests ? "" : noTests ? "No tests found for given includes (class name / package mismatch?)" : errorExcerpt(out),
      infraError: r.timedOut ? "timeout" : infra && !compileFailed ? infra : undefined,
    };
  }

  private resolveCache = new Map<string, string[]>();

  private resolveSource(m: Module, pkgPath: string): string | undefined {
    let files = this.resolveCache.get(m.name);
    if (!files) {
      files = this.sourceFiles(m);
      this.resolveCache.set(m.name, files);
    }
    const hit = files.find((f) => f.endsWith(path.sep + pkgPath));
    if (hit) return hit;
    // Kotlin files whose package does not match the directory layout.
    const base = path.basename(pkgPath);
    const pkg = path.dirname(pkgPath).replace(/\//g, ".");
    return files.find((f) => path.basename(f) === base && new RegExp(`^\\s*package\\s+${pkg.replace(/\./g, "\\.")}\\s*$`, "m").test(readFile(f)));
  }

  countAssertions(text: string): number {
    return (text.match(/\bassert\w*\s*[(<{]|assertThat|\bshouldBe\b|\bshould\w+\(|\bverify\s*[({]|coVerify|\bexpect\w*\(|\.test\s*\{|awaitItem\(\)|\bfail\(/g) ?? []).length;
  }
}

export function parseJUnitXmlDir(dir: string): TestCase[] {
  if (!exists(dir)) return [];
  const out: TestCase[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".xml"))) {
    const xml = readFile(path.join(dir, f));
    for (const m of xml.matchAll(/<testcase name="([^"]*)" classname="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const body = m[4] ?? "";
      const fail = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/(?:failure|error)>|<(failure|error)\b([^>]*)\/>/.exec(body);
      const attrs = fail ? (fail[2] ?? fail[5] ?? "") : "";
      const msgAttr = /message="([^"]*)"/.exec(attrs)?.[1] ?? "";
      const skipped = /<skipped/.test(body);
      out.push({
        name: `${m[2]}.${m[1]}`,
        status: fail ? "failed" : skipped ? "skipped" : "passed",
        message: fail ? decodeXml(`${msgAttr}\n${fail[3] ?? ""}`).trim().split("\n").slice(0, 12).join("\n") : undefined,
      });
    }
  }
  return out;
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
}

export { relPath };
