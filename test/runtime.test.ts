import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { acquireProjectLock } from "../src/lock.ts";
import { runAsync, RunCancelled } from "../src/util.ts";
import { mutate, mutationGate, type MutationReport } from "../src/mutate.ts";
import { State } from "../src/state.ts";
import type { Adapter } from "../src/adapters/types.ts";
import { generate, recoverGeneration } from "../src/generate.ts";
import { GradleAdapter } from "../src/adapters/gradle.ts";

function temp(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unitgen-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("build output reaches the log before exit; result captures both streams", async (t) => {
  const dir = temp(t), logFile = path.join(dir, "live.log");
  const controller = new AbortController();
  t.after(() => controller.abort());
  const running = runAsync([process.execPath, "-e", "console.log('ready'); console.error('diagnostic'); setTimeout(() => console.log('done'), 500)"], { logFile, stream: false, signal: controller.signal });
  // Observe while the child is alive, using a bounded condition instead of a long fixed sleep.
  for (let i = 0; i < 100 && !/^ready$/m.test(fs.readFileSync(logFile, "utf8")); i++) await new Promise((r) => setTimeout(r, 10));
  const early = fs.readFileSync(logFile, "utf8");
  assert.match(early, /^ready$/m);
  assert.doesNotMatch(early, /# exit=/);
  const result = await running;
  assert.equal(result.ok, true);
  assert.match(result.out, /diagnostic/);
  assert.match(result.out, /done/);
  assert.match(fs.readFileSync(logFile, "utf8"), /# exit=0/);
});

test("timeout terminates a build; missing executables are infra failures", async () => {
  const result = await runAsync([process.execPath, "-e", "setInterval(() => {}, 1000)"], { timeoutSec: 0.1 });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.match(result.out, /TIMEOUT/);
  const missing = await runAsync(["unitgen-no-such-executable"]);
  assert.equal(missing.code, 127);
});

test("cancellation terminates child process groups", { skip: process.platform === "win32" }, async (t) => {
  const dir = temp(t), pidFile = path.join(dir, "child.pid");
  const controller = new AbortController();
  const running = runAsync([process.execPath, "-e", `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid)); setInterval(()=>{},1000);`], { signal: controller.signal });
  const rejected = assert.rejects(running, RunCancelled);
  for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fs.existsSync(pidFile), true);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  controller.abort();
  await rejected;
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (e) { assert.equal((e as NodeJS.ErrnoException).code, "ESRCH"); return; }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("descendant still alive after cancellation");
});

test("a second invocation cannot recover or mutate a locked project", (t) => {
  const dir = temp(t), { release } = acquireProjectLock(dir);
  fs.writeFileSync(path.join(dir, "settings.gradle"), "include ':app'\n");
  const target = path.join(dir, "A.kt"), backup = path.join(dir, "backup");
  fs.writeFileSync(target, "mutated"); fs.writeFileSync(backup, "original");
  fs.writeFileSync(path.join(dir, ".unitgen", "mutation-in-progress.json"), JSON.stringify({ target, backup }));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  try {
    assert.throws(() => acquireProjectLock(dir), /project locked/);
    const result = spawnSync(process.execPath, [cli, "note", "-C", dir, "--", "--help"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /project locked/);
    assert.equal(fs.readFileSync(target, "utf8"), "mutated");
  }
  finally { release(); }
  acquireProjectLock(dir).release();
});

test("a timeout also kills helpers the build started in their own process group (swiftpm-testing-helper)", { skip: process.platform === "win32" }, async (t) => {
  const dir = temp(t), pidFile = path.join(dir, "helper.pid");
  // The "build" starts a detached helper (new process group, like swift test does) and both hang.
  const helperJs = path.join(dir, "helper.js"), buildJs = path.join(dir, "build.js");
  fs.writeFileSync(helperJs, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  fs.writeFileSync(buildJs, `const h = require("node:child_process").spawn(process.execPath, [${JSON.stringify(helperJs)}], { detached: true, stdio: "ignore" }); h.unref(); setInterval(() => {}, 1000);`);
  const run = runAsync([process.execPath, buildJs], { timeoutSec: 2, stream: false });
  for (let i = 0; i < 1000 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 10));
  const helper = Number(fs.readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(helper, "SIGKILL"); } catch { /* gone */ } });
  const r = await run;
  assert.equal(r.timedOut, true);
  for (let i = 0; i < 200; i++) {
    try { process.kill(helper, 0); } catch { return; }
    await new Promise((res) => setTimeout(res, 10));
  }
  assert.fail(`helper ${helper} survived the timeout`);
});

test("a stale lock's recorded leftovers (same PID and start time) are stopped before taking over", { skip: process.platform === "win32" }, async (t) => {
  const dir = temp(t);
  fs.mkdirSync(path.join(dir, ".unitgen"), { recursive: true });
  const orphan = (await import("node:child_process")).spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(orphan.pid!, "SIGKILL"); } catch { /* gone */ } });
  await new Promise((r) => setTimeout(r, 100));
  const { processTable } = await import("../src/util.ts");
  const me = processTable().find((p) => p.pid === orphan.pid)!;
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  fs.writeFileSync(path.join(dir, ".unitgen", "run.lock"), JSON.stringify({ pid: Number(dead), at: "earlier", builds: [orphan.pid], procs: [{ pid: orphan.pid, start: me.start }] }));
  const msgs: string[] = [];
  acquireProjectLock(dir, (m) => msgs.push(m)).release();
  assert.match(msgs.join("\n"), new RegExp(`stopped 1 process.*${orphan.pid}`));
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => process.kill(orphan.pid!, 0), /ESRCH/);
});

test("a lock left by a killed command is taken over and the interrupted mutation restored", { skip: process.platform === "win32" }, (t) => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, "settings.gradle"), "include ':app'\n");
  fs.mkdirSync(path.join(dir, ".unitgen"), { recursive: true });
  const target = path.join(dir, "A.kt"), backup = path.join(dir, "backup");
  fs.writeFileSync(target, "mutated"); fs.writeFileSync(backup, "original");
  fs.writeFileSync(path.join(dir, ".unitgen", "mutation-in-progress.json"), JSON.stringify({ target, backup }));
  // A PID that cannot be running: the previous command and its builds are gone.
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  fs.writeFileSync(path.join(dir, ".unitgen", "run.lock"), JSON.stringify({ pid: Number(dead), at: "earlier", worker: Number(dead), builds: [Number(dead)] }));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "status", "-C", dir], { encoding: "utf8", env: { ...process.env, UNITGEN_QUIET: "1" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /removed a stale lock/);
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.equal(fs.existsSync(path.join(dir, ".unitgen", "run.lock")), false);
});

test("a stale lock whose build is still running is not taken over", { skip: process.platform === "win32" }, async (t) => {
  const dir = temp(t);
  fs.mkdirSync(path.join(dir, ".unitgen"), { recursive: true });
  const build = (await import("node:child_process")).spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-build.pid!, "SIGKILL"); } catch { /* gone */ } });
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  fs.writeFileSync(path.join(dir, ".unitgen", "run.lock"), JSON.stringify({ pid: Number(dead), at: "earlier", builds: [build.pid] }));
  assert.throws(() => acquireProjectLock(dir, () => {}), new RegExp(`still running \\(${build.pid}\\).*kill -TERM -${build.pid}`));
});

test("help and empty commands accept leading common options outside a project", (t) => {
  const dir = temp(t), cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  for (const args of [["--json", "help"], ["--json"], ["--module", ":app", "help"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: unitgen/);
  }
});

test("a forced-worker interruption invalidates pending generation acceptance", (t) => {
  const dir = temp(t), state = new State(dir);
  state.data.accepted.push({ testFile: "AUnitGenTest.kt", tests: 1, gainedLines: 1, gained: {}, attempts: 1, at: state.stamp() });
  state.setTestCoverage("AUnitGenTest.kt", { "A.kt": { 1: 1 } });
  state.save();
  fs.writeFileSync(state.file("generation-in-progress.json"), JSON.stringify({ testFile: "AUnitGenTest.kt" }));
  recoverGeneration(state);
  assert.equal(new State(dir).data.accepted.length, 0);
  assert.equal(Object.keys(state.perTestCoverage).length, 0);
  assert.equal(fs.existsSync(state.file("generation-in-progress.json")), false);
});

test("mutation quality gate rejects survivors below threshold and infrastructure errors", () => {
  const report = { candidates: 5, killed: 3, survived: 2, score: 0.6, results: [] } as unknown as MutationReport;
  assert.equal(mutationGate(report).status, "FAILED");
  assert.equal(mutationGate({ ...report, killed: 4, survived: 1, score: 0.8 }).status, "PASSED");
  assert.equal(mutationGate({ ...report, score: 1, results: [{ line: 1, op: "", original: "", mutated: "", outcome: "error" }] }).status, "FAILED");
  assert.equal(mutationGate({ ...report, candidates: 0 }).status, "NOT_APPLICABLE");
  assert.equal(mutationGate({ ...report, killed: 0, survived: 0, score: 0, results: [{ line: 1, op: "", original: "", mutated: "", outcome: "equivalent" }] }).status, "NOT_APPLICABLE");
});

test("mutation restores source and journal when the clean run throws", async (t) => {
  const dir = temp(t), target = path.join(dir, "Source.kt"), testFile = path.join(dir, "SourceUnitGenTest.kt");
  const original = "fun answer() = 1\n";
  fs.writeFileSync(target, original);
  fs.writeFileSync(testFile, "assertEquals(1, answer())");
  const state = new State(dir);
  state.setTestCoverage("SourceUnitGenTest.kt", { [target]: { 1: 1 } });
  const adapter = { root: dir, moduleFor: () => ({}), runTests: async () => { throw new RunCancelled(); } } as unknown as Adapter;
  await assert.rejects(mutate(adapter, state, testFile, target), RunCancelled);
  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.equal(fs.existsSync(state.file("mutation-in-progress.json")), false);
  assert.equal(fs.existsSync(state.file("mutation.backup")), false);
});

test("failed CLI baseline exits nonzero without replacing previous coverage", { skip: process.platform === "win32" }, async (t) => {
  const dir = temp(t);
  fs.mkdirSync(path.join(dir, "app", "src", "main", "java"), { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.gradle"), "include ':app'\n");
  fs.writeFileSync(path.join(dir, "app", "build.gradle"), "plugins { id 'com.android.application' }\n");
  fs.writeFileSync(path.join(dir, "app", "src", "main", "java", "A.kt"), "fun a() = 1\n");
  fs.writeFileSync(path.join(dir, "gradlew"), "#!/bin/sh\ncase \"$*\" in *tasks*) echo 'app:testDebugUnitTest - local tests'; exit 0;; esac\necho 'BUILD FAILED'; exit 1\n", { mode: 0o755 });
  const state = new State(dir);
  state.baselineCoverage = { [path.join(dir, "A.kt")]: { 1: 1 } };
  state.data.baseline = { at: state.stamp(), ok: true, tests: 1, failed: 0, seconds: 1 };
  state.save();
  const before = fs.readFileSync(state.file("baseline.cov.json"), "utf8");
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "baseline", "-C", dir, "--json"], { encoding: "utf8", env: { ...process.env, UNITGEN_QUIET: "1" } });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.equal(fs.readFileSync(state.file("baseline.cov.json"), "utf8"), before);
  assert.equal(new State(dir).data.baseline?.ok, false);
  assert.equal(fs.existsSync(state.file("run.lock")), false);
});

test("log I/O failure rejects after stopping the build, rather than bypassing cleanup", async (t) => {
  const dir = temp(t), logFile = path.join(dir, "logs", "live.log"), pidFile = path.join(dir, "pid");
  const running = runAsync([process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); console.log('ready'); setInterval(()=>console.log('tick'),100);`], { logFile, stream: false });
  const rejected = assert.rejects(running, /ENOENT/);
  for (let i = 0; i < 100 && !/^ready$/m.test(fs.readFileSync(logFile, "utf8")); i++) await new Promise((r) => setTimeout(r, 10));
  assert.match(fs.readFileSync(logFile, "utf8"), /^ready$/m);
  fs.rmSync(path.dirname(logFile), { recursive: true });
  await rejected;
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("CLI cancellation also stops synchronous doctor discovery and releases its lock", { skip: process.platform === "win32" }, async (t) => {
  const dir = temp(t), pidFile = path.join(dir, "java.pid");
  fs.mkdirSync(path.join(dir, "app", "src", "main", "java"), { recursive: true });
  fs.mkdirSync(path.join(dir, "jdk", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.gradle"), "include ':app'\n");
  fs.writeFileSync(path.join(dir, "app", "build.gradle"), "plugins { id 'java' }\n");
  fs.writeFileSync(path.join(dir, "app", "src", "main", "java", "A.java"), "class A {}\n");
  fs.writeFileSync(path.join(dir, "jdk", "bin", "java"), `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 60\n`, { mode: 0o755 });
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = spawn(process.execPath, [cli, "doctor", "-C", dir], { stdio: "ignore", env: { ...process.env, JAVA_HOME: path.join(dir, "jdk") } });
  t.after(() => child.kill("SIGKILL"));
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  for (let i = 0; i < 1000 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fs.existsSync(pidFile), true);
  child.kill("SIGTERM");
  assert.equal(await closed, 130);
  assert.equal(fs.existsSync(path.join(dir, ".unitgen", "run.lock")), false);
  assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, "utf8")), 0), /ESRCH/);
});

test("JDK17 requirement is Android-specific; JVM projects may use older JDKs", { skip: process.platform === "win32" }, (t) => {
  const dir = temp(t);
  fs.mkdirSync(path.join(dir, "app", "src", "main", "java"), { recursive: true });
  fs.mkdirSync(path.join(dir, "jdk", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.gradle"), "include ':app'\n");
  fs.writeFileSync(path.join(dir, "app", "build.gradle"), "plugins { id 'java' }\n");
  fs.writeFileSync(path.join(dir, "app", "src", "main", "java", "A.java"), "class A {}\n");
  fs.writeFileSync(path.join(dir, "jdk", "bin", "java"), '#!/bin/sh\necho \'openjdk version "11.0.1"\' >&2\n', { mode: 0o755 });
  const old = process.env.JAVA_HOME;
  process.env.JAVA_HOME = path.join(dir, "jdk");
  try { assert.equal(new GradleAdapter(dir, path.join(dir, ".unitgen")).doctor().ok, true); }
  finally { if (old === undefined) delete process.env.JAVA_HOME; else process.env.JAVA_HOME = old; }
});

test("TRAE installer preserves references, is repeatable and refuses existing user files", { skip: process.platform === "win32" }, (t) => {
  const dir = temp(t), project = path.join(dir, "project with spaces"), bin = path.join(dir, "bin");
  fs.mkdirSync(project);
  const installer = fileURLToPath(new URL("../scripts/install-trae.sh", import.meta.url));
  const install = () => spawnSync("sh", [installer, "--project", project], { encoding: "utf8", env: { ...process.env, UNITGEN_BIN_DIR: bin } });
  assert.equal(install().status, 0);
  assert.equal(install().status, 0);
  assert.equal(fs.existsSync(path.join(project, ".trae", "skills", "unitgen", "references", "android.md")), true);
  fs.unlinkSync(path.join(bin, "unitgen"));
  fs.writeFileSync(path.join(bin, "unitgen"), "user executable");
  assert.equal(install().status, 1);
  assert.equal(fs.readFileSync(path.join(bin, "unitgen"), "utf8"), "user executable");
});

test("generate feeds mutation failures back to the model and accepts strengthened assertions", async (t) => {
  const dir = temp(t), target = path.join(dir, "Answer.kt"), testFile = path.join(dir, "tests", "AnswerUnitGenTest.kt");
  fs.mkdirSync(path.dirname(testFile));
  fs.writeFileSync(target, "fun answer() = 1\n");
  const state = new State(dir);
  state.baselineCoverage = { [target]: { 1: 0 } };
  const module = { name: ":app", dir, sourceRoots: [dir], testRoot: path.dirname(testFile), kind: "android" };
  const adapter: Adapter = {
    id: "fixture", platform: "android", root: dir, testFileSuffix: "UnitGenTest.kt",
    doctor: () => ({ ok: true, lines: [] }), modules: () => [module], moduleFor: () => module,
    sourceFiles: () => [target], classify: () => "logic", conventions: () => "JUnit assertions",
    placement: () => ({ path: testFile, suiteName: "AnswerUnitGenTest" }), exampleTests: () => [],
    prepareTestFile: () => {}, countAssertions: () => 1,
    async runTests(req) {
      const failed = req.label.startsWith("mutant-") && !req.label.endsWith("-0-clean") && fs.readFileSync(testFile, "utf8").includes("strong");
      return { ok: !failed, compiled: true, tests: [{ name: "AnswerUnitGenTest.answer", status: failed ? "failed" : "passed", message: failed ? "AssertionError: expected 1" : undefined }],
        coverage: req.coverage ? { [target]: { 1: 1 } } : undefined, logFile: "fixture", excerpt: "", seconds: 0.01 };
    },
  };
  const prompts: string[] = [];
  const llm = { name: "fixture", async complete(prompt: string) { prompts.push(prompt); return prompts.length === 1 ? "assertEquals(1, answer())" : "assertEquals(1, answer()) // strong"; } };
  const results = await generate(adapter, state, llm, { files: [target], limit: 1, attempts: 2, reruns: 1, mutationMax: 1 });
  assert.equal(results[0].verdict, "accepted");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Mutation gate failed/);
  assert.equal(state.data.accepted[0].mutation?.score, 1);
  assert.equal(fs.readFileSync(target, "utf8"), "fun answer() = 1\n");

  const weak = { name: "weak", async complete() { return "assertEquals(1, answer())"; } };
  const failed = await generate(adapter, state, weak, { files: [target], limit: 1, attempts: 1, reruns: 1, mutationMax: 1 });
  assert.equal(failed[0].verdict, "mutation_failures");
  assert.equal(state.data.accepted.length, 0);
  assert.equal(state.data.rejected.at(-1)?.reason, "mutation_failures");
  assert.equal(fs.existsSync(testFile), false);

  const runTests = adapter.runTests;
  adapter.runTests = async (req) => {
    if (req.label.endsWith("-0-clean")) throw new RunCancelled();
    return await runTests(req);
  };
  await assert.rejects(generate(adapter, state, weak, { files: [target], limit: 1, attempts: 1, reruns: 1, mutationMax: 1 }), RunCancelled);
  assert.equal(state.data.accepted.length, 0);
  assert.equal(Object.keys(state.perTestCoverage).length, 0);
});
