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
      { count: 0, regions: [{ startLoc: { line: 2, col: 17 }, endLoc: { line: 2, col: 38 }, count: 0 }] }, // `(a: number) => number`
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
  // Line 6 uses what the API returned (u).
  assert.deepEqual([...a.platformLines(text)], [5, 6]);
});

test("review regressions: mutant generation edge cases", () => {
  // A chained assignment continues on the next line: deleting its first line is a syntax error.
  const chain = ["    this.visible = items", "      .filter((x) => x.ok);", "    this.count = 1;"].join("\n");
  const ops = mutantsFor(chain, [1, 2, 3]).map((m) => `${m.line}:${m.op}`);
  assert.ok(!ops.includes("1:delete assignment"));
  assert.ok(ops.includes("3:delete assignment"));
  // `if f {`: the condition is negated, not the keyword.
  const neg = mutantsFor("        if f {", [1]).find((m) => m.op === "negate condition");
  assert.equal(neg?.mutated, "        if !f {");
  const guard = mutantsFor("    guard a else { return }", [1]).find((m) => m.op === "negate condition");
  assert.equal(guard?.mutated, "    guard !a else { return }");
  // A `return "..."` inside a trailing comment is not code.
  assert.equal(mutantsFor("  x = y; // return 'old'", [1]).filter((m) => m.op === "string -> empty").length, 0);
  // Domain objects whose names end in Log are not loggers.
  const domain = ["  changeLog.push(entry)", "  auditLog.record(x)", "  AuditLog.e(err)"].join("\n");
  assert.deepEqual([...new Set(mutantsFor(domain, [1, 2, 3]).map((m) => m.line))], [1, 2]);
});

test("review regressions: hvigor coverage keeps never-called object-literal arrows", async () => {
  const { parseHvigorCoverage } = await import("../src/adapters/harmony.ts");
  const src = ["", "const ops: Ops = {", "  add: (a: number, b: number): number => {", "    return a + b;", "  },", "};"].join("\n");
  const report = JSON.stringify({ files: [{ path: "/p/src/main/ets/B.ets",
    functions: [{ count: 0, regions: [{ startLoc: { line: 3, col: 8 }, endLoc: { line: 5, col: 4 }, count: 0 }] }],
    summary: { lines: { executedLineCount: [-1, -1, 1, 0, 0, -1] } } }] });
  assert.deepEqual(parseHvigorCoverage(report, ["/p/src/main/ets"], () => src)["/p/src/main/ets/B.ets"], { 2: 1, 3: 0, 4: 0 });
});

test("review regressions: builder parameters with braces, const enum exports", () => {
  const r = stripArkUI(["@Builder", "function overBuilder($$: { paramA1: string }) {", "  Row() {", "    Text($$.paramA1)", "  }", "}", "export const K = 1;"].join("\n"));
  assert.match(r.text, /^function overBuilder\(\) \{\}\n{6}export const K = 1;$/);
  assert.ok(exportedNames("export const enum Color { Red }")!.has("Color"));
});

test("review regressions: signalAll skips a PID whose start time no longer matches", { skip: process.platform === "win32" }, async (t) => {
  const { signalAll } = await import("../src/util.ts");
  const p = (await import("node:child_process")).spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => { try { process.kill(p.pid!, "SIGKILL"); } catch { /* gone */ } });
  signalAll([{ pid: p.pid!, start: "Thu Jan  1 00:00:00 1970" }], true);
  await new Promise((r) => setTimeout(r, 200));
  assert.doesNotThrow(() => process.kill(p.pid!, 0));
});

test("Swift declarations: signatures are not mutated, bodies are; calls with arguments negate; += strings", () => {
  const src = ["    static func + (lhs: A, rhs: A) -> A {", "    subscript(index: Int) -> Int {", "fun answer() = 1", "    func f(x: Int = 2) -> Int { return x + 1 }",
    "        if contains(.withYear) {", "            format += \"yyyy\""].join("\n");
  const ms = mutantsFor(src, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ms.map((m) => `${m.line}:${m.mutated.trim()}`), [
    "3:fun answer() = 0", "4:func f(x: Int = 2) -> Int { return x - 1 }", "4:func f(x: Int = 2) -> Int { return x + 0 }",
    "5:if !contains(.withYear) {", "6:format += \"\""]);
});

test("List.test.ets loses imports of generated tests deleted by hand, keeps everything else", async (t) => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { HarmonyAdapter } = await import("../src/adapters/harmony.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unitgen-list-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const testRoot = path.join(dir, "entry", "src", "test");
  fs.mkdirSync(testRoot, { recursive: true });
  fs.writeFileSync(path.join(testRoot, "kept.unitgen.test.ets"), "export default function keptUnitGenTest() {}\n");
  const list = path.join(testRoot, "List.test.ets");
  fs.writeFileSync(list, [
    "import goneUnitGenTest from './gone.unitgen.test';",
    "import keptUnitGenTest from './kept.unitgen.test';",
    "import localUnitTest from './LocalUnit.test';",
    "export default function testsuite() {",
    "  goneUnitGenTest();",
    "  keptUnitGenTest();",
    "  localUnitTest();",
    "}",
    "",
  ].join("\n"));
  const a = new HarmonyAdapter(dir, path.join(dir, ".unitgen"));
  (a as unknown as { pruneDeletedTests(m: { testRoot: string }): void }).pruneDeletedTests({ testRoot });
  assert.equal(fs.readFileSync(list, "utf8"), [
    "import keptUnitGenTest from './kept.unitgen.test';",
    "import localUnitTest from './LocalUnit.test';",
    "export default function testsuite() {",
    "  keptUnitGenTest();",
    "  localUnitTest();",
    "}",
    "",
  ].join("\n"));
});

test("no mutants that cannot compile: required-field assignments in constructors, constructors, null guards", () => {
  const ts = [
    "export interface ItemInit {",
    "  count: number;",
    "}",
    "export class Item {",
    "  id: number;",
    "  pic?: string;",
    "  count: number = 0;",
    "  constructor(init: ItemInit) {",
    "    this.id = init.id;",
    "    this.pic = init.pic;",
    "    this.count = init.count;",
    "  }",
    "  reset(): void {",
    "    this.id = 0;",
    "  }",
    "  toString(): string {",
    "    return `${this.id}`;",
    "  }",
    "}",
    "export function size(xs?: number[]): number {",
    "  if (!xs || xs.length === 0) {",
    "    return 0;",
    "  }",
    "  return xs && xs.length > 2 ? 1 : 2;",
    "}",
  ].join("\n");
  const ops = mutantsFor(ts, ts.split("\n").map((_, i) => i + 1)).map((m) => `${m.line}:${m.op}`);
  assert.ok(!ops.includes("9:delete assignment"), "required field assigned in the constructor");
  assert.ok(ops.includes("10:delete assignment"), "optional field");
  assert.ok(ops.includes("11:delete assignment"), "field with a default");
  assert.ok(ops.includes("14:delete assignment"), "outside the constructor");
  assert.ok(!ops.some((o) => /^(8|16):delete statement/.test(o)), "constructor / method declarations are not statements");
  assert.ok(!ops.includes("21:|| -> &&") && ops.includes("21:=== -> !=="));
  assert.ok(!ops.includes("24:&& -> ||"));
  const plain = "export function nonEmpty(s: string): boolean {\n  return s && s.length > 0 ? true : false;\n}\nexport function isNull(v: Item | null): boolean {\n  return v === null || v.id === 0;\n}\n";
  const pops = mutantsFor(plain, [2, 5]).map((m) => `${m.line}:${m.op}`);
  assert.ok(pops.includes("2:&& -> ||"), "a plain string's truthiness guard still compiles when flipped");
  assert.ok(!pops.includes("5:|| -> &&"), "an explicit null comparison does not");
  const swift = [
    "struct Point {",
    "  let x: Int",
    "  var label: String?",
    "  init(x: Int, label: String?) {",
    "    self.x = x",
    "    self.label = label",
    "  }",
    "  func build(_ b: Builder) {",
    "    b.add(x) {",
    "      print(1)",
    "    }",
    "  }",
    "}",
  ].join("\n");
  const sops = mutantsFor(swift, swift.split("\n").map((_, i) => i + 1)).map((m) => `${m.line}:${m.op}`);
  assert.ok(!sops.includes("5:delete assignment") && sops.includes("6:delete assignment"));
  assert.ok(sops.includes("9:delete statement"), "Swift trailing-closure call is still deleted");
});

test("plain assignments, thrown messages and returned templates get mutants; concatenation and init delegation do not", () => {
  const ts = [
    "export function f(o: Opts, s: string): string {",
    "  o.secret = undefined;",
    "  count += step;",
    "  const p = '0' + s;",
    "  if (s === '') {",
    "    throw new Error('empty input');",
    "  }",
    "  total = total + 1;",
    "  return `${s}-${p}`;",
    "}",
  ].join("\n");
  const ops = mutantsFor(ts, ts.split("\n").map((_, i) => i + 1)).map((m) => `${m.line}:${m.op}:${m.mutated.trim()}`);
  assert.ok(ops.includes("2:delete assignment:/* unitgen: assignment deleted */"));
  assert.ok(ops.includes("3:delete assignment:/* unitgen: assignment deleted */"));
  assert.ok(!ops.some((o) => o.startsWith("4:+ -> -")), "string concatenation");
  assert.ok(ops.includes("6:string -> empty:throw new Error('');"));
  assert.ok(ops.some((o) => o.startsWith("8:+ -> -")) && !ops.some((o) => o.startsWith("8:delete")), "an assignment with other mutants is not also deleted");
  assert.ok(ops.includes("9:string -> empty:return ``;"));
  const swift = [
    "final class Box {",
    "  var kind: Kind",
    "  init(raw: Int) {",
    "    kind = .number",
    "  }",
    "  convenience init(text: String) {",
    "    self.init(raw: 0)",
    "  }",
    "  func reset() {",
    "    kind = .null",
    "  }",
    "}",
  ].join("\n");
  const sops = mutantsFor(swift, swift.split("\n").map((_, i) => i + 1)).map((m) => `${m.line}:${m.op}`);
  assert.ok(!sops.includes("4:delete assignment"), "required stored property assigned in init");
  assert.ok(!sops.some((o) => o.startsWith("7:delete")), "self.init delegation");
  assert.ok(sops.includes("10:delete assignment"));
});

test("objects returned by system APIs are marked as mocks; a page exporting only a @Builder is UI", async () => {
  const { HarmonyAdapter } = await import("../src/adapters/harmony.ts");
  const a = new HarmonyAdapter("/nonexistent-project", "/nonexistent-project/.unitgen");
  const text = [
    "import { cryptoFramework } from '@kit.CryptoArchitectureKit';",
    "export async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {",
    "  const mac = cryptoFramework.createMac('SHA1');",
    "  await mac.update({ data: data });",
    "  const out = await mac.doFinal();",
    "  const size = key.length * 2;",
    "  return out.data;",
    "}",
  ].join("\n");
  assert.deepEqual([...a.platformLines(text)], [3, 4, 5, 7]);
  const page = [
    "import { promptAction } from '@kit.ArkUI';",
    "const GAP: number = 8;",
    "const NAMES: string[] = ['a', 'b'];",
    "const MORE: string[] = ['c', 'd'];",
    "const EVEN_MORE: string[] = ['e', 'f'];",
    "const LAST: number = 3;",
    "@Builder",
    "export function EditBuilder() {",
    "  EditComponent()",
    "}",
    "@Component",
    "struct EditComponent {",
    "  build() {",
    "    Column() {}",
    "  }",
    "}",
  ].join("\n");
  assert.equal(a.classify("/p/entry/src/main/ets/pages/EditPage.ets", page), "ui");
});

test("under a narrowing type checker, flips inside a literal comparison chain are not generated", () => {
  const ts = [
    "export function safe(c: number, format: string): boolean {",
    "  return c === 0x2D ||",
    "    c === 0x2E ||",
    "    (c >= 0x30 && c <= 0x39) ||",
    "    (format === 'RFC1738' && (c === 0x28 || c === 0x29));",
    "}",
    "export function isObj(val: Object | null): boolean {",
    "  return val !== null && typeof val === 'object';",
    "}",
  ].join("\n");
  const lines = ts.split("\n").map((_, i) => i + 1);
  const ops = (narrow: boolean) => mutantsFor(ts, lines, { literalNarrowing: narrow }).map((m) => `${m.line}:${m.op}`);
  const strict = ops(true), loose = ops(false);
  // c === 0x2D -> !== narrows c to 45 for `c === 0x2E` (and the later 0x28/0x29): never compiles.
  for (const o of ["2:=== -> !==", "3:=== -> !==", "5:|| -> &&"]) {
    assert.ok(loose.includes(o) && !strict.includes(o), o);
  }
  // A `||` at the end of a line is mutated too; `c === 0x2E && (c >= 0x30 ...)` still compiles.
  assert.ok(loose.includes("2:|| -> &&") && !strict.includes("2:|| -> &&"));
  assert.ok(strict.includes("3:|| -> &&"));
  // `format !== 'RFC1738'`: format is compared only once.
  assert.ok(strict.includes("5:=== -> !=="));
  assert.ok(strict.includes("8:!== -> ==="), "typeof compares its own result");
});

test("`a ?? fallback` is mutated to the fallback; `??=` and keywords are left alone", () => {
  const ts = [
    "this.children = init.children ?? [];",
    "const n = parseInt(s) ?? 0;",
    "return opts?.name ?? 'anon';",
    "cache ??= new Map();",
  ].join("\n");
  const m = mutantsFor(ts, [1, 2, 3, 4]).filter((x) => x.op === "?? -> fallback").map((x) => `${x.line}:${x.mutated}`);
  assert.deepEqual(m, ["1:this.children = [];", "2:const n = 0;", "3:return 'anon';"]);
});

test("commands run in a subdirectory find the project root; a HarmonyOS module directory is not one", async (t) => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { findProjectRoot } = await import("../src/adapters/index.ts");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "unitgen-root-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = path.join(dir, "app"), mod = path.join(app, "entry"), deep = path.join(mod, "src", "main", "ets");
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(app, "build-profile.json5"), '{ "app": {}, "modules": [{ "name": "entry", "srcPath": "./entry" }] }');
  fs.writeFileSync(path.join(app, "oh-package.json5"), "{}");
  fs.writeFileSync(path.join(mod, "build-profile.json5"), '{ "apiType": "stageMode" }');
  fs.writeFileSync(path.join(mod, "oh-package.json5"), "{}");
  fs.writeFileSync(path.join(mod, "hvigorfile.ts"), "");
  assert.equal(findProjectRoot(deep), app);
  const pkg = path.join(dir, "pkg"), src = path.join(pkg, "Sources", "Lib");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(pkg, "Package.swift"), "// swift-tools-version:5.9\n");
  assert.equal(findProjectRoot(src), pkg);
  const none = path.join(dir, "none");
  fs.mkdirSync(none);
  assert.equal(findProjectRoot(none), none);
});

test("assignments to locals declared without a value are not deleted", () => {
  const swift = ["func load() -> Font {", "  let font: Font?", "  if a {", "    font = load(path)", "  } else {", "    font = nil", "  }", "  var count: Int?", "  count = compute()", "  return font!", "}"].join("\n");
  const ops = mutantsFor(swift, [4, 6, 9]).map((m) => `${m.line}:${m.op}`);
  assert.ok(!ops.includes("4:delete assignment") && !ops.includes("6:delete assignment"));
  assert.ok(ops.includes("9:delete assignment"), "an optional var starts as nil");
  const ts = ["let n: number;", "n = parse(s);", "let m: number | undefined;", "m = parse(s);"].join("\n");
  const tops = mutantsFor(ts, [2, 4]).map((m) => `${m.line}:${m.op}`);
  assert.deepEqual(tops.filter((o) => o.endsWith("delete assignment")), ["4:delete assignment"]);
});

test("narrowing guard: enum members, literals on the left, and if / else-if chains", () => {
  const ts = [
    "export function f(type: number, kind: DateType, a: number[] | null | undefined): number {",
    "  if (kind == DateType.YmdHms || kind == DateType.YmdHm) {",
    "    return 1;",
    "  }",
    "  if (undefined !== a && null !== a && a.length !== 0) {",
    "    return 2;",
    "  }",
    "  if (type == 1) {",
    "    return 3;",
    "  } else if (type == 2) {",
    "    return 4;",
    "  } else if (type == 3) {",
    "    return 5;",
    "  }",
    "  if (type == 9) {",
    "    return 6;",
    "  }",
    "  return 0;",
    "}",
  ].join("\n");
  const lines = ts.split("\n").map((_, i) => i + 1);
  const strict = mutantsFor(ts, lines, { literalNarrowing: true }).map((m) => `${m.line}:${m.op}`);
  for (const o of ["2:== -> !=", "2:|| -> &&", "5:!== -> ===", "8:== -> !=", "10:== -> !="]) assert.ok(!strict.includes(o), o);
  // The last branch of the chain, and an if without else-if, can be flipped.
  for (const o of ["12:== -> !=", "15:== -> !="]) assert.ok(strict.includes(o), o);
});

test("system-API detection: an import clause never spans into the next import", async () => {
  const { usedPlatformImports } = await import("../src/adapters/harmony.ts");
  const text = [
    "import util from '@ohos.util';",
    "import { Base64Util } from './Base64Util';",
    "import { DateType } from '../entity/constraint';",
    "import {",
    "  buffer",
    "} from '@kit.ArkTS';",
    "export function f(s: string, t: DateType): string { return util.format(s) + buffer.from(s) + Base64Util.encode(s) + t; }",
  ].join("\n");
  assert.deepEqual(usedPlatformImports(text), ["util", "buffer"]);
});

test("Swift: backtick identifiers are not strings; subscript assignments can be deleted", () => {
  const swift = ["func f() -> Kind {", "    result[key] = value", "    return `default`", "}"].join("\n");
  const ops = mutantsFor(swift, [2, 3]).map((m) => `${m.line}:${m.op}`);
  assert.ok(ops.includes("2:delete assignment"));
  assert.ok(!ops.some((o) => o.startsWith("3:string")));
});

test("brief declarations: top-level and member declarations only, never a function's locals", async () => {
  const { declarationLines } = await import("../src/context.ts");
  const ts = [
    "export function newNote(title: string): Note {",
    "  const now: number = nowMs();",
    "  return { title: title, at: now };",
    "}",
    "export class Store {",
    "  count: number = 0;",
    "  static readonly MAX = 3;",
    "  add(n: number): void {",
    "    let next = this.count + n;",
    "  }",
    "}",
    "export const LIMIT = 10;",
  ].join("\n");
  assert.deepEqual(declarationLines(ts, "a.ets"), ["export function newNote(title: string): Note", "export class Store", "  add(n: number): void", "export const LIMIT = 10;"]);
});
