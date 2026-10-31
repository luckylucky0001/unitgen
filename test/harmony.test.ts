import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { arktsLint, exportedNames, importLint, segmentLineCoverage, usedPlatformImports, v8LineCoverage } from "../src/adapters/harmony.ts";
import { mutantsFor } from "../src/mutate.ts";

const { stripArkUI } = createRequire(import.meta.url)("../src/data/harmony/arkui.cjs");

const at = (js: string, line: number, col = 0) => js.split("\n").slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + col;

test("segmentLineCoverage maps merged generated lines back to every original line", () => {
  // TypeScript prints `if (` and the first condition (two .ets lines) on one JS line.
  const js = "if ((a && b) ||\n    c) {\n    x();\n}";
  const fns = [{ ranges: [{ startOffset: 0, endOffset: js.length, count: 1 }, { startOffset: at(js, 2, 7), endOffset: at(js, 4, 1), count: 0 }] }];
  const segs: [number, number, number][] = [[1, 0, 1], [1, 5, 2], [1, 10, 2], [2, 4, 3], [2, 7, 3], [3, 4, 4]];
  const cov = segmentLineCoverage(js, fns, segs);
  assert.equal(cov[1], 1);
  assert.equal(cov[2], 1, "first condition on its own .ets line is covered");
  // `c` ran; the `{` that opens the never-run block does not make the condition line uncovered.
  assert.equal(cov[3], 1);
  assert.equal(cov[4], 0);
});

test("short-circuited sub-expressions do not make a line uncovered; skipped case bodies do", () => {
  const js = ["function f(a) {", "  const x = a?.foo();", "  const y = a && g();", "  switch (a) {", "    case 1: return 1;", "  }", "}"].join("\n");
  const fns = [{ ranges: [
    { startOffset: 0, endOffset: js.length, count: 1 },
    { startOffset: at(js, 2, 13), endOffset: at(js, 2, 19), count: 0 }, // `?.foo()`
    { startOffset: at(js, 3, 14), endOffset: at(js, 3, 20), count: 0 }, // `&& g()`
    { startOffset: at(js, 5, 4), endOffset: at(js, 5, 21), count: 0 }, // `case 1: return 1;`
  ] }];
  const cov = v8LineCoverage(js, fns);
  assert.equal(cov[2], 1);
  assert.equal(cov[3], 1);
  assert.equal(cov[5], 0);
});

test("stripArkUI blanks structs and builders but keeps line numbers and surrounding code", () => {
  const src = [
    "import { x } from './x';",
    "export function helper(n: number): number {",
    "  return n * 2;",
    "}",
    "@Entry",
    "@Component({ freezeWhenInactive: true })",
    "struct Index {",
    "  @State msg: string = '}';",
    "  build() {",
    "    Column() { Text(this.msg) }",
    "  }",
    "}",
    "@Builder",
    "export function Card(t: string) {",
    "  Text(t)",
    "}",
    "export const K: number = 1;",
  ].join("\n");
  const r = stripArkUI(src);
  assert.deepEqual(r.names, ["Index", "Card"]);
  assert.equal(r.text.split("\n").length, src.split("\n").length);
  assert.match(r.text, /export function helper/);
  assert.match(r.text, /class Index \{\}/);
  assert.match(r.text, /export function Card\(\) \{\}/);
  assert.match(r.text.split("\n")[16], /export const K/);
  assert.doesNotMatch(r.text, /build\(\)|Column/);
});

test("arkts lint allows string-literal indexing on Record-typed names only", () => {
  const ctx = "export class Msg {\n  data: Record<string, string> = {};\n}";
  const text = [
    "const root: Record<string, Object> = parse(s);",
    "expect(root['comm']).assertEqual(1);",
    "expect(msg.data['entity_id']).assertEqual('a');",
    "const svc = root['x'] as Record<string, Object>;",
    "expect(svc['y']).assertEqual(2);",
    "expect(obj['field']).assertEqual(3);",
  ].join("\n");
  const out = arktsLint(text, ctx);
  assert.deepEqual(out.map((x) => x.split(":")[0]), ["6"]);
});

test("arkts lint rejects expect() on a call declared to return void", () => {
  const ctx = "export class S {\n  catch(e: Error): void {\n  }\n  size(): number { return 1; }\n}";
  const out = arktsLint("expect(sm.catch(err)).assertUndefined();\nexpect(sm.size()).assertEqual(1);", ctx);
  assert.deepEqual(out.map((x) => x.split(":")[0]), ["1"]);
});

test("importLint reports names the imported module does not export", () => {
  const prod = "class NumberItem {}\nexport class Board {}\nexport { helper as h };\nexport default function main() {}";
  assert.deepEqual([...exportedNames(prod)!].sort(), ["Board", "h", "main"]);
  const out = importLint("", [{ spec: "../main/ets/Index", text: prod, line: 2, names: ["Board", "NumberItem"] }]);
  assert.equal(out.length, 1);
  assert.match(out[0], /^2: 'NumberItem' is not exported/);
  assert.equal(exportedNames("export * from './a';"), undefined);
});

test("usedPlatformImports ignores logging/error types and unused imports", () => {
  const text = [
    "import { hilog } from '@kit.PerformanceAnalysisKit';",
    "import { BusinessError } from '@kit.BasicServicesKit';",
    "import { util, xml } from '@kit.ArkTS';",
    "import router from '@ohos.router';",
    "export function f(e: BusinessError): string { hilog.info(0, 't', 'x'); return util.format('%s', 'a'); }",
  ].join("\n");
  assert.deepEqual(usedPlatformImports(text), ["util"]);
});

test("project logging wrappers are not mutated, look-alike names are", () => {
  const src = ["  LogUtils.e(err)", "  this.logger.info('x')", "  AppLogger.d('y')", "  catalog.add(x)", "  Dialog.show(x)"].join("\n");
  const lines = mutantsFor(src, [1, 2, 3, 4, 5]).map((m) => m.line);
  assert.deepEqual([...new Set(lines)], [4, 5]);
});

test("mutants get per-line ids and logging statements are not mutated", () => {
  const src = ["if (a < b && c) {", "  console.info('x = ' + x);", "  hilog.info(0x0, 'tag', 'n=%d', n + 1);", "  y = a + 1;", "}"].join("\n");
  const ms = mutantsFor(src, [1, 2, 3, 4]);
  assert.deepEqual(ms.filter((m) => m.line === 1).map((m) => m.id), ["1.1", "1.2"]);
  assert.equal(ms.filter((m) => m.line === 2 || m.line === 3).length, 0);
  assert.deepEqual(ms.filter((m) => m.line === 4).map((m) => m.id), ["4.1", "4.2"]);
});

test("hypium test_result.txt: assertion failures vs errors, multi-line messages", async () => {
  const { parseHypiumResults } = await import("../src/adapters/harmony.ts");
  const txt = ["class=Suite", "test=ok", "result=Success", "test=bad", "Error in bad, expect 3 equals 4", "    at x (a.ets:1:1)", "result=Failure",
    "test=boom", "Error in boom, execute timeout 15000ms", "result=Error", "Tests run: 3, Failure: 1, Error: 1, Pass: 1, Ignore: 0"].join("\n");
  const r = parseHypiumResults(txt);
  assert.deepEqual(r.map((t) => [t.name, t.status]), [["Suite > ok", "passed"], ["Suite > bad", "failed"], ["Suite > boom", "failed"]]);
  assert.match(r[1].message!, /^AssertionError: Error in bad, expect 3 equals 4\n/);
  assert.match(r[2].message!, /^Error: .*timeout/);
});

test("hvigor coverage drops lines only function-type annotations touch", async () => {
  const { parseHvigorCoverage } = await import("../src/adapters/harmony.ts");
  const src = ["", "export const f: (a: number) => number =", "  (a: number): number => {", "    return a;", "  };", "export const g = (): number => 1;"].join("\n");
  const report = JSON.stringify({ files: [{ path: "/p/src/main/ets/A.ets",
    functions: [
      { count: 0, regions: [{ startLoc: { line: 2, col: 17 }, endLoc: { line: 2, col: 40 }, count: 0 }] }, // the annotation
      { count: 2, regions: [{ startLoc: { line: 3, col: 3 }, endLoc: { line: 5, col: 4 }, count: 2 }] },
      { count: 0, regions: [{ startLoc: { line: 6, col: 17 }, endLoc: { line: 6, col: 33 }, count: 0 }] }, // a real, never-called arrow
    ],
    summary: { lines: { executedLineCount: [-1, -1, 0, 2, 2, -1, 0] } } }] });
  const cov = parseHvigorCoverage(report, ["/p/src/main/ets"], () => src);
  assert.deepEqual(cov["/p/src/main/ets/A.ets"], { 3: 2, 4: 2, 6: 0 });
});

test("ArkTS compiler errors are parsed with their files (paths with spaces)", async () => {
  const { parseArkTsErrors } = await import("../src/adapters/harmony.ts");
  const out = "Error Message: Property 'uri' is missing. At File: /a b/entry/src/test/X.test.ets:20:3\nCOMPILE RESULT:FAIL";
  assert.deepEqual(parseArkTsErrors(out), [{ message: "Property 'uri' is missing.", file: "/a b/entry/src/test/X.test.ets", line: 20, col: 3 }]);
});

test("platformLines marks lines that call imported system APIs, not logging or local code", async () => {
  const { HarmonyAdapter } = await import("../src/adapters/harmony.ts");
  const a = new HarmonyAdapter("/nonexistent-project", "/nonexistent-project/.unitgen");
  const text = [
    "import { url } from '@kit.ArkTS';",
    "import { hilog } from '@kit.PerformanceAnalysisKit';",
    "export function host(s: string): string {",
    "  hilog.info(0, 't', s);",
    "  const u = url.URL.parseURL(s);",
    "  return u.host.toLowerCase();",
    "}",
  ].join("\n");
  assert.deepEqual([...a.platformLines(text)], [5]);
});
