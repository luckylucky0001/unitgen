import assert from "node:assert/strict";
import { test } from "node:test";
import { arktsLint } from "../src/adapters/harmony.ts";
import { parseJUnitXmlDir } from "../src/adapters/gradle.ts";
import { parseSwiftTestOutput } from "../src/adapters/swiftpm.ts";
import { mergeCoverage, newlyCovered, parseJacocoXml, parseLcov, parseLlvmCovJson, ranges, summarize } from "../src/coverage.ts";
import { extractCode } from "../src/llm.ts";
import { estimateExecutable } from "../src/targets.ts";
import { json5Parse, preferOwnTest } from "../src/util.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("llvm-cov segments -> line hits (wrapped regions, gaps, skipped)", () => {
  const json = {
    data: [{
      files: [{
        filename: "/p/A.swift",
        segments: [
          [1, 10, 3, true, true, false], // fn entry, count 3
          [2, 5, 0, true, true, false], // branch never taken
          [3, 1, 3, true, false, false], // back to outer region (not entry)
          [4, 1, 0, false, false, false], // end
          [6, 1, 0, false, true, false], // skipped region
          [7, 1, 0, false, false, false],
        ],
      }],
    }],
  };
  const cov = parseLlvmCovJson(json);
  // LLVM semantics: a line counts as executed if the region wrapping into it ran (line 2),
  // a line whose only region starts there with count 0 is not (line 3 via wrapped seg 2).
  assert.deepEqual(cov["/p/A.swift"], { 1: 3, 2: 3, 3: 0, 4: 3 });
});

test("llvm-cov lines inside a region that hold no code (blank, comment, #if) are not executable", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unitgen-llvm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "F.swift");
  fs.writeFileSync(file, ["func f() -> Int {", "  let x = 1", "", "  // note", "  #if os(iOS)", "  return x", "}"].join("\n"));
  const json = { data: [{ files: [{ filename: file, segments: [[1, 18, 0, true, true, false], [7, 2, 0, false, false, false]] }] }] };
  assert.deepEqual(Object.keys(parseLlvmCovJson(json)[fs.realpathSync(file)]).map(Number), [1, 2, 6, 7]);
});

test("jacoco xml resolves package paths", () => {
  const xml = `<report><package name="com/x"><class name="com/x/A"/><sourcefile name="A.kt"><line nr="3" mi="0" ci="2" mb="0" cb="0"/><line nr="4" mi="1" ci="0" mb="0" cb="0"/></sourcefile></package></report>`;
  const cov = parseJacocoXml(xml, (p) => (p === "com/x/A.kt" ? "/abs/com/x/A.kt" : undefined));
  assert.deepEqual(cov, { "/abs/com/x/A.kt": { 3: 2, 4: 0 } });
});

test("lcov parsing with keep filter", () => {
  const cov = parseLcov("SF:src/a.ets\nDA:1,1\nDA:2,0\nend_of_record\nSF:other.js\nDA:1,1\nend_of_record\n", "/r", (f) => f.endsWith(".ets"));
  assert.deepEqual(cov, { "/r/src/a.ets": { 1: 1, 2: 0 } });
});

test("newlyCovered / merge / summarize / ranges", () => {
  const base = { "/f": { 1: 1, 2: 0, 3: 0 } };
  const cand = { "/f": { 1: 1, 2: 4, 3: 0 }, "/g": { 5: 1 } };
  assert.deepEqual(newlyCovered(base, cand), { "/f": [2], "/g": [5] });
  const m = mergeCoverage(base, cand);
  assert.equal(summarize(m).total.covered, 3);
  assert.equal(ranges([1, 2, 3, 7, 9, 10]), "1-3, 7, 9-10");
});

test("swift testing output: issue lines are not test names", () => {
  const out = [
    "◇ Test foo() started.",
    "✘ Test foo() recorded an issue at T.swift:4:9: Expectation failed: (x → 1) == 2",
    "✘ Test foo() failed after 0.001 seconds with 1 issue.",
    "✔ Test bar() passed after 0.001 seconds.",
    "✔ Test baz(a:b:) with 3 test cases passed after 0.002 seconds.",
    "◇ Test case passing 2 arguments a → 1 to baz(a:b:) started.",
    "✔ Test run with 3 tests in 1 suite passed after 0.003 seconds.",
    "Test Case '-[MTests.X testA]' failed (0.001 seconds).",
  ].join("\n");
  const tests = parseSwiftTestOutput(out);
  const byName = Object.fromEntries(tests.map((t) => [t.name, t]));
  assert.equal(byName["foo()"].status, "failed");
  assert.match(byName["foo()"].message!, /Expectation failed/);
  assert.equal(byName["bar()"].status, "passed");
  assert.equal(byName["baz(a:b:)"].status, "passed");
  assert.equal(byName["MTests.X.testA"].status, "failed");
  assert.equal(tests.length, 4);
});

test("junit xml dir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ug-"));
  fs.writeFileSync(path.join(dir, "TEST-a.xml"), `<testsuite><testcase name="ok" classname="p.A" time="0"/><testcase name="bad" classname="p.A" time="0"><failure message="expected:&lt;1&gt;" type="AssertionError">trace</failure></testcase><testcase name="skip" classname="p.A"><skipped/></testcase></testsuite>`);
  const t = parseJUnitXmlDir(dir);
  assert.deepEqual(t.map((x) => [x.name, x.status]), [["p.A.ok", "passed"], ["p.A.bad", "failed"], ["p.A.skip", "skipped"]]);
  assert.match(t[1].message!, /expected:<1>/);
});

test("json5", () => {
  assert.deepEqual(json5Parse(`{ // c\n modules: [{ name: 'entry', srcPath: "./entry", }], /* x */ }`), { modules: [{ name: "entry", srcPath: "./entry" }] });
});

test("arkts lint flags common violations and ignores strings/comments", () => {
  const bad = ["let x: any = 1;", "var y = 2;", "const { a } = o;", "const f = function () {};", "delete o.k;", "const c = { ...o };", "o['key'];"].join("\n");
  // `const c = { ...o }` trips both no-spread and no-untyped-obj-literals.
  assert.equal(arktsLint(bad).length, 8);
  const ok = ["// var y: any", "const s = 'var x: any';", "const xs: number[] = [];", "expect(m.get('k')).assertEqual('v');", "const arr = list[0];"].join("\n");
  assert.deepEqual(arktsLint(ok), []);
});

test("estimateExecutable skips comments, braces, declarations", () => {
  const src = ["// c", "class A {", "  fun f() {", "    return 1", "  }", "}", "/* x", " y */", "val z = 2"].join("\n");
  assert.deepEqual(estimateExecutable(src), [3, 4, 9]);
});

test("extractCode picks the largest fenced block", () => {
  assert.equal(extractCode("hi\n```kotlin\nsmall\n```\n```kotlin\nlarger block\n```"), "larger block\n");
  assert.equal(extractCode("no fence"), "no fence\n");
});

test("preferOwnTest puts the matching test first", () => {
  const all = ["/t/OtherTest.kt", "/t/FooTest.kt", "/t/FooUnitGenTest.kt"];
  assert.deepEqual(preferOwnTest(all, "/src/Foo.kt", ["/t/OtherTest.kt"]), ["/t/FooTest.kt", "/t/OtherTest.kt"]);
});

test("mutants skip strings/comments/generics and spread across lines", async () => {
  const { mutantsFor, pickMutants } = await import("../src/mutate.ts");
  const src = ["if (a < b && c == 1) {", "  let s = \"x == y\" // a == b", "  return List<Int>()", "  x = y + 2", "}"].join("\n");
  const ms = mutantsFor(src, [1, 2, 3, 4]);
  assert.deepEqual(ms.filter((m) => m.line === 1).map((m) => m.op), ["== -> !=", "< -> <=", "&& -> ||", "1 -> 0"]);
  assert.equal(ms.filter((m) => m.line === 2 || m.line === 3).length, 0);
  assert.deepEqual(ms.filter((m) => m.line === 4).map((m) => m.mutated), ["  x = y - 2", "  x = y + 3"]);
  const picked = pickMutants(ms, 2);
  assert.deepEqual(picked.map((m) => m.line), [1, 4]);
});

test("collectSuspects joins continuation comment lines and dedupes", async () => {
  const { collectSuspects } = await import("../src/verify.ts");
  const t = ["// UNITGEN-SUSPECT: true + 1 is 2 because Bool", "// bridges to NSNumber", "x()", "// UNITGEN-SUSPECT: true + 1 is 2 because Bool", "// bridges to NSNumber"].join("\n");
  assert.deepEqual(collectSuspects(t), ["true + 1 is 2 because Bool bridges to NSNumber"]);
});

test("statement deletion and condition negation", async () => {
  const { mutantsFor } = await import("../src/mutate.ts");
  const src = ["    localDataSource.upsert(task.toLocal())", "    val x = foo(1)", "    if (followed) {", "    return bar()", "    saveTasksToNetwork()"].join("\n");
  const ops = mutantsFor(src, [1, 2, 3, 4, 5]).map((m) => `${m.line}:${m.op}`);
  assert.ok(ops.includes("1:delete statement"));
  assert.ok(ops.includes("5:delete statement"));
  assert.ok(ops.includes("3:negate condition"));
  assert.ok(!ops.some((o) => o.startsWith("2:delete") || o.startsWith("4:delete")));
});

test("v8LineCoverage: a line is covered only if all its code ran (switch cases after early return)", async () => {
  const { v8LineCoverage } = await import("../src/adapters/harmony.ts");
  const js = ["function f(v) {", "  if (typeof v === 'string') return 'S';", "  switch (v) {", "    case 1: return 'one';", "  }", "}"].join("\n");
  const at = (line: number, col = 0) => js.split("\n").slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + col;
  // V8 shape: whole function count 1; continuation after the early return count 0; case body count 0.
  const fns = [{ ranges: [
    { startOffset: 0, endOffset: js.length, count: 1 },
    { startOffset: at(2, 40), endOffset: at(6), count: 0 },
    { startOffset: at(4, 12), endOffset: at(4, 25), count: 0 },
  ] }];
  const cov = v8LineCoverage(js, fns);
  assert.equal(cov[1], 1);
  assert.equal(cov[3], 0);
  assert.equal(cov[4], 0);
  assert.equal(cov[2], 1);
});

test("xcresult test tree -> cases", async () => {
  const { parseXcresultNodes } = await import("../src/adapters/xcode.ts");
  const nodes = [{ nodeType: "Test Plan", children: [{ nodeType: "Unit test bundle", name: "AppTests", children: [{ nodeType: "Test Suite", name: "FooUnitGenTests", children: [
    { nodeType: "Test Case", name: "testA()", result: "Passed" },
    { nodeType: "Test Case", name: "testB()", result: "Failed", children: [{ nodeType: "Failure Message", name: "Foo.swift:12: XCTAssertEqual failed: (\"1\") is not equal to (\"2\")" }] },
  ] }] }] }];
  const t = parseXcresultNodes(nodes);
  assert.deepEqual(t.map((x) => [x.name, x.status]), [["FooUnitGenTests.testA()", "passed"], ["FooUnitGenTests.testB()", "failed"]]);
  assert.match(t[1].message!, /XCTAssertEqual failed/);
});

test("pbxproj: add and remove a test file round-trips", async () => {
  const { Pbxproj } = await import("../src/adapters/pbxproj.ts");
  const txt = [
    "// !$*UTF8*$!", "{", "\tobjects = {", "",
    "/* Begin PBXBuildFile section */",
    "\t\tDD0000000000000000000001 /* ATests.swift in Sources */ = {isa = PBXBuildFile; fileRef = EE0000000000000000000001 /* ATests.swift */; };",
    "/* End PBXBuildFile section */", "",
    "/* Begin PBXFileReference section */",
    "\t\tEE0000000000000000000001 /* ATests.swift */ = {isa = PBXFileReference; path = ATests.swift; sourceTree = \"<group>\"; };",
    "/* End PBXFileReference section */", "",
    "\t\tAA0000000000000000000000 = {", "\t\t\tisa = PBXGroup;", "\t\t\tchildren = (", "\t\t\t\tAA0000000000000000000001 /* Tests */,", "\t\t\t);", "\t\t\tsourceTree = \"<group>\";", "\t\t};",
    "\t\tAA0000000000000000000001 /* Tests */ = {", "\t\t\tisa = PBXGroup;", "\t\t\tchildren = (", "\t\t\t\tEE0000000000000000000001 /* ATests.swift */,", "\t\t\t);", "\t\t\tpath = Tests;", "\t\t\tsourceTree = \"<group>\";", "\t\t};",
    "\t\tBB0000000000000000000001 /* Sources */ = {", "\t\t\tisa = PBXSourcesBuildPhase;", "\t\t\tfiles = (", "\t\t\t\tDD0000000000000000000001 /* ATests.swift in Sources */,", "\t\t\t);", "\t\t};",
    "\t\tCC0000000000000000000001 /* ATests */ = {", "\t\t\tisa = PBXNativeTarget;", "\t\t\tbuildPhases = (", "\t\t\t\tBB0000000000000000000001 /* Sources */,", "\t\t\t);", "\t\t\tname = ATests;", "\t\t\tproductType = \"com.apple.product-type.bundle.unit-test\";", "\t\t};",
    "\t};", "}",
  ].join("\n");
  const p = new Pbxproj(txt, "/proj");
  const t = p.targets()[0];
  assert.deepEqual(t.files, ["/proj/Tests/ATests.swift"]);
  const ids = p.addSourceFile(t, "/proj/Tests/BUnitGenTests.swift")!;
  assert.deepEqual(p.targets()[0].files, ["/proj/Tests/ATests.swift", "/proj/Tests/BUnitGenTests.swift"]);
  p.removeIds([ids.fileRef, ids.buildFile]);
  assert.equal(p.text, txt);
  // ObjectMapper layout: group `Tests`, file references with a subdirectory (`Sub/ATests.swift`).
  const sub = new Pbxproj(txt.replace("path = ATests.swift;", "path = Sub/ATests.swift;"), "/proj");
  assert.deepEqual(sub.targets()[0].files, ["/proj/Tests/Sub/ATests.swift"]);
  sub.addSourceFile(sub.targets()[0], "/proj/Tests/Sub/BUnitGenTests.swift");
  assert.deepEqual(sub.targets()[0].files, ["/proj/Tests/Sub/ATests.swift", "/proj/Tests/Sub/BUnitGenTests.swift"]);
  assert.match(sub.text, /path = Sub\/BUnitGenTests\.swift;/);
});

test("gradle: settings includes over several lines, no includeBuild; failures per module with their reason", async () => {
  const { settingsIncludes, gradleFailures, gradleExcerpt } = await import("../src/adapters/gradle.ts");
  assert.deepEqual(settingsIncludes('rootProject.name = "x"\ninclude(\n    ":app",\n    ":feature:album",\n)\npluginManagement {\n    includeBuild("build-logic")\n}\ninclude ":core", \':data\'\n'), [":app", ":feature:album", ":core", ":data"]);
  const out = [
    "> Task :core:testDebugUnitTest",
    "w: Some API is deprecated. It will be removed in version 10.0 of the Android Gradle plugin.",
    "FAILURE: Build completed with 2 failures.",
    "1: Task failed with an exception.",
    "* What went wrong:",
    "Execution failed for task ':app:checkDebugAarMetadata' (registered by plugin 'com.android.internal.application').",
    "> A failure occurred while executing com.android.build.gradle.internal.tasks.CheckAarMetadataWorkAction",
    "   > 4 issues were found when checking AAR metadata:",
    "",
    "       1.  Dependency 'glide:5.0.9' requires libraries and applications that",
    "           depend on it to compile against version 37 or later of the",
    "           Android APIs.",
    "",
    "* Try:",
    "2: Task failed with an exception.",
    "* What went wrong:",
    "Execution failed for task ':feature:album:compileDebugKotlin'.",
    "> Compilation error. See log for more details",
    "e: file:///p/feature/album/src/main/kotlin/A.kt:3:5 Unresolved reference 'foo'.",
  ].join("\n");
  assert.deepEqual(gradleFailures(out).map((f) => [f.module, f.task]), [[":app", "checkDebugAarMetadata"], [":feature:album", "compileDebugKotlin"]]);
  assert.match(gradleFailures(out)[0].reason, /4 issues were found .* compile against version 37 or later/);
  assert.match(gradleFailures(out)[1].reason, /A\.kt:3:5 Unresolved reference 'foo'/);
  assert.match(gradleExcerpt(out).split("\n")[0], /^e: .*Unresolved reference/);
  assert.ok(!gradleExcerpt(out).includes("deprecated"));
});
