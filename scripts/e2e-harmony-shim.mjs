// End-to-end smoke test on a generated HarmonyOS (ArkTS) project with the Node shim, through the
// platform's launcher (bin/unitgen.cmd on Windows, bin/unitgen elsewhere): doctor -> baseline ->
// targets -> verify -> mutate -> report. Needs no DevEco Studio. Used by CI; exits non-zero on failure.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unitgen harmony ")); // a space in the path, on purpose
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

write("build-profile.json5", JSON.stringify({
  app: { signingConfigs: [], products: [{ name: "default", runtimeOS: "HarmonyOS" }] },
  modules: [{ name: "lib", srcPath: "./lib", targets: [{ name: "default", applyToProducts: ["default"] }] }],
}, null, 2));
write("oh-package.json5", JSON.stringify({ name: "e2e", version: "1.0.0", dependencies: {}, devDependencies: { "@ohos/hypium": "1.0.25" } }, null, 2));
write("hvigorfile.ts", "export default { system: () => {}, plugins: [] };\n");
write("lib/build-profile.json5", JSON.stringify({ apiType: "stageMode", targets: [{ name: "default" }] }, null, 2));
write("lib/oh-package.json5", JSON.stringify({ name: "lib", version: "1.0.0", main: "./src/main/ets/grade.ets", dependencies: {} }, null, 2));
write("lib/hvigorfile.ts", "export default { system: () => {}, plugins: [] };\n");
write("lib/src/main/ets/grade.ets", [
  "export function grade(score: number): string {",
  "  if (score >= 90) {",
  "    return 'A';",
  "  }",
  "  if (score >= 50) {",
  "    return 'B';",
  "  }",
  "  return 'C';",
  "}",
  "",
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
].join("\n"));
write("lib/src/test/Add.test.ets", [
  "import { describe, it, expect } from '@ohos/hypium';",
  "import { add } from '../main/ets/grade';",
  "",
  "export default function addTest() {",
  "  describe('AddTest', () => {",
  "    it('adds', 0, () => {",
  "      expect(add(2, 3)).assertEqual(5);",
  "    });",
  "  });",
  "}",
  "",
].join("\n"));
write("lib/src/test/List.test.ets", [
  "import addTest from './Add.test';",
  "",
  "export default function testsuite() {",
  "  addTest();",
  "}",
  "",
].join("\n"));

function unitgen(args, expect) {
  const launcher = path.join(repo, "bin", win ? "unitgen.cmd" : "unitgen");
  const env = { ...process.env, UNITGEN_QUIET: "1", UNITGEN_HARMONY_MODE: "shim" };
  const r = win
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[launcher, ...args].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(" ")}"`], { cwd: dir, encoding: "utf8", windowsVerbatimArguments: true, env })
    : spawnSync(launcher, args, { cwd: dir, encoding: "utf8", env });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  console.log(`$ unitgen ${args.join(" ")}  (exit ${r.status})\n${out.trim()}\n`);
  if (r.status !== expect.code || (expect.match && !expect.match.test(out))) {
    console.error(`FAILED: expected exit ${expect.code}${expect.match ? ` and ${expect.match}` : ""}`);
    process.exit(1);
  }
  return out;
}

unitgen(["doctor"], { code: 0, match: /runner: shim/ });
unitgen(["baseline"], { code: 0, match: /coverage: [1-9]\d*\/\d+ lines/ });
unitgen(["targets"], { code: 0, match: /grade\.ets/ });
const testFile = path.join("lib", "src", "test", "grade.unitgen.test.ets");
write(testFile, [
  "import { describe, it, expect } from '@ohos/hypium';",
  "import { grade } from '../main/ets/grade';",
  "",
  "export default function gradeUnitGenTest() {",
  "  describe('GradeUnitGenTest', () => {",
  "    it('ninetyAndAboveIsA', 0, () => {",
  "      expect(grade(90)).assertEqual('A');",
  "      expect(grade(100)).assertEqual('A');",
  "    });",
  "    it('fiftyToEightyNineIsB', 0, () => {",
  "      expect(grade(50)).assertEqual('B');",
  "      expect(grade(89)).assertEqual('B');",
  "    });",
  "    it('belowFiftyIsC', 0, () => {",
  "      expect(grade(49)).assertEqual('C');",
  "    });",
  "  });",
  "}",
  "",
].join("\n"));
unitgen(["verify", testFile], { code: 0, match: /verdict: ACCEPTED/ });
unitgen(["mutate", testFile, "--max", "10"], { code: 0, match: /gate: PASSED/ });
unitgen(["report"], { code: 0 });
const report = fs.readFileSync(path.join(dir, ".unitgen", "REPORT.md"), "utf8");
if (!/grade\.unitgen\.test\.ets/.test(report)) { console.error("FAILED: report does not list the accepted test"); process.exit(1); }
const list = fs.readFileSync(path.join(dir, "lib", "src", "test", "List.test.ets"), "utf8");
if (!/gradeUnitGenTest\(\)/.test(list)) { console.error("FAILED: the accepted test is not registered in List.test.ets"); process.exit(1); }
console.log("e2e harmony OK");
