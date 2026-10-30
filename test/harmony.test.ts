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

test("mutants get per-line ids and logging statements are not mutated", () => {
  const src = ["if (a < b && c) {", "  console.info('x = ' + x);", "  hilog.info(0x0, 'tag', 'n=%d', n + 1);", "  y = a + 1;", "}"].join("\n");
  const ms = mutantsFor(src, [1, 2, 3, 4]);
  assert.deepEqual(ms.filter((m) => m.line === 1).map((m) => m.id), ["1.1", "1.2"]);
  assert.equal(ms.filter((m) => m.line === 2 || m.line === 3).length, 0);
  assert.deepEqual(ms.filter((m) => m.line === 4).map((m) => m.id), ["4.1", "4.2"]);
});
