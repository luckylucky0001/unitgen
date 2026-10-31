// End-to-end smoke test on a generated Gradle/Java project, through the platform's launcher
// (bin/unitgen.cmd on Windows, bin/unitgen elsewhere): doctor -> baseline -> verify -> mutate.
// Needs `gradle` and a JDK on PATH (GitHub's runners have both). Used by CI; exits non-zero on failure.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unitgen e2e ")); // a space in the path, on purpose
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

// Without `gradle` on PATH, copy a Gradle wrapper from an existing project (UNITGEN_E2E_WRAPPER_FROM=<dir>).
const from = process.env.UNITGEN_E2E_WRAPPER_FROM;
if (from) {
  for (const f of ["gradlew", "gradlew.bat"]) if (fs.existsSync(path.join(from, f))) fs.copyFileSync(path.join(from, f), path.join(dir, f));
  fs.cpSync(path.join(from, "gradle", "wrapper"), path.join(dir, "gradle", "wrapper"), { recursive: true });
  if (!win) fs.chmodSync(path.join(dir, "gradlew"), 0o755);
}
write("settings.gradle", "rootProject.name = 'calc'\n");
write("build.gradle", [
  "plugins { id 'java' }",
  "repositories { mavenCentral() }",
  "dependencies { testImplementation 'junit:junit:4.13.2' }",
  "",
].join("\n"));
write("src/main/java/calc/Calc.java", [
  "package calc;",
  "",
  "public class Calc {",
  "    public static String grade(int score) {",
  "        if (score >= 90) {",
  "            return \"A\";",
  "        }",
  "        if (score >= 50) {",
  "            return \"B\";",
  "        }",
  "        return \"C\";",
  "    }",
  "",
  "    public static int add(int a, int b) {",
  "        return a + b;",
  "    }",
  "}",
  "",
].join("\n"));
write("src/test/java/calc/AddTest.java", [
  "package calc;",
  "",
  "import org.junit.Test;",
  "import static org.junit.Assert.assertEquals;",
  "",
  "public class AddTest {",
  "    @Test public void adds() { assertEquals(5, Calc.add(2, 3)); }",
  "}",
  "",
].join("\n"));

function unitgen(args, expect) {
  const launcher = path.join(repo, "bin", win ? "unitgen.cmd" : "unitgen");
  const r = win
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[launcher, ...args].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(" ")}"`], { cwd: dir, encoding: "utf8", windowsVerbatimArguments: true, env: { ...process.env, UNITGEN_QUIET: "1" } })
    : spawnSync(launcher, args, { cwd: dir, encoding: "utf8", env: { ...process.env, UNITGEN_QUIET: "1" } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  console.log(`$ unitgen ${args.join(" ")}  (exit ${r.status})\n${out.trim()}\n`);
  if (r.status !== expect.code || (expect.match && !expect.match.test(out))) {
    console.error(`FAILED: expected exit ${expect.code}${expect.match ? ` and ${expect.match}` : ""}`);
    process.exit(1);
  }
  return out;
}

unitgen(["doctor"], { code: 0, match: /status: OK/ });
unitgen(["baseline"], { code: 0, match: /coverage: [1-9]\d*\/\d+ lines/ });
unitgen(["targets"], { code: 0, match: /Calc\.java/ });
write("src/test/java/calc/CalcUnitGenTest.java", [
  "package calc;",
  "",
  "import org.junit.Test;",
  "import static org.junit.Assert.assertEquals;",
  "",
  "public class CalcUnitGenTest {",
  "    @Test public void ninetyAndAboveIsA() { assertEquals(\"A\", Calc.grade(90)); assertEquals(\"A\", Calc.grade(100)); }",
  "    @Test public void fiftyToEightyNineIsB() { assertEquals(\"B\", Calc.grade(50)); assertEquals(\"B\", Calc.grade(89)); }",
  "    @Test public void belowFiftyIsC() { assertEquals(\"C\", Calc.grade(49)); }",
  "}",
  "",
].join("\n"));
unitgen(["verify", path.join("src", "test", "java", "calc", "CalcUnitGenTest.java")], { code: 0, match: /verdict: ACCEPTED/ });
unitgen(["mutate", path.join("src", "test", "java", "calc", "CalcUnitGenTest.java"), "--max", "8"], { code: 0, match: /gate: PASSED/ });
unitgen(["report"], { code: 0 });
const report = fs.readFileSync(path.join(dir, ".unitgen", "REPORT.md"), "utf8");
if (!/CalcUnitGenTest/.test(report)) { console.error("FAILED: report does not list the accepted test"); process.exit(1); }
console.log("e2e OK");
