// End-to-end smoke test for Objective-C on macOS: a generated SwiftPM package with an Objective-C
// target, then a generated Xcode project (static library + Objective-C unit-test bundle):
// doctor -> baseline -> targets -> verify -> mutate -> report. Needs Xcode (XCTest). Used by CI on
// macOS; elsewhere it exits 0 without doing anything. Exits non-zero on failure.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("e2e objc: skipped (needs macOS with Xcode)");
  process.exit(0);
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const GRADE_H = [
  "#import <Foundation/Foundation.h>",
  "",
  "@interface Grade : NSObject",
  "+ (NSString *)gradeFor:(NSInteger)score;",
  "+ (NSInteger)add:(NSInteger)a to:(NSInteger)b;",
  "@end",
  "",
].join("\n");
const GRADE_M = [
  "#import \"Grade.h\"",
  "",
  "@implementation Grade",
  "",
  "+ (NSString *)gradeFor:(NSInteger)score {",
  "    if (score >= 90) {",
  "        return @\"A\";",
  "    }",
  "    if (score >= 50) {",
  "        return @\"B\";",
  "    }",
  "    return @\"C\";",
  "}",
  "",
  "+ (NSInteger)add:(NSInteger)a to:(NSInteger)b {",
  "    return a + b;",
  "}",
  "",
  "@end",
  "",
].join("\n");
const testFile = (cls, body) => [
  "#import <XCTest/XCTest.h>",
  "#import \"Grade.h\"",
  "",
  `@interface ${cls} : XCTestCase`,
  "@end",
  "",
  `@implementation ${cls}`,
  "",
  ...body,
  "",
  "@end",
  "",
].join("\n");
const ADD_TEST = ["- (void)testAdds {", "    XCTAssertEqual([Grade add:2 to:3], 5);", "}"];
const GRADE_TEST = [
  "- (void)testNinetyAndAboveIsA {",
  "    XCTAssertEqualObjects([Grade gradeFor:90], @\"A\");",
  "    XCTAssertEqualObjects([Grade gradeFor:100], @\"A\");",
  "}",
  "",
  "- (void)testFiftyToEightyNineIsB {",
  "    XCTAssertEqualObjects([Grade gradeFor:50], @\"B\");",
  "    XCTAssertEqualObjects([Grade gradeFor:89], @\"B\");",
  "}",
  "",
  "- (void)testBelowFiftyIsC {",
  "    XCTAssertEqualObjects([Grade gradeFor:49], @\"C\");",
  "}",
];

function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `unitgen ${name} `)); // a space in the path, on purpose
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  return { dir, write };
}

function unitgen(dir, args, expect) {
  const r = spawnSync(path.join(repo, "bin", "unitgen"), args, { cwd: dir, encoding: "utf8", env: { ...process.env, UNITGEN_QUIET: "1" } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  console.log(`$ unitgen ${args.join(" ")}  (exit ${r.status})\n${out.trim()}\n`);
  if (r.status !== expect.code || (expect.match && !expect.match.test(out))) {
    console.error(`FAILED: expected exit ${expect.code}${expect.match ? ` and ${expect.match}` : ""}`);
    process.exit(1);
  }
  return out;
}

function flow(dir, adapterArgs, test, extra = () => {}) {
  unitgen(dir, ["doctor", ...adapterArgs], { code: 0, match: /Objective-C|swiftpm-objc|status: OK/ });
  unitgen(dir, ["baseline", ...adapterArgs], { code: 0, match: /coverage: [1-9]\d*\/\d+ lines/ });
  unitgen(dir, ["targets", ...adapterArgs], { code: 0, match: /Grade\.m/ });
  const brief = unitgen(dir, ["brief", test.source, ...adapterArgs], { code: 0, match: /GradeUnitGenTests/ });
  if (!/#import "Grade\.h"/.test(brief) || !/## Interface: /.test(brief)) { console.error("FAILED: the brief lacks the header import or the interface section"); process.exit(1); }
  fs.mkdirSync(path.dirname(path.join(dir, test.rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, test.rel), testFile("GradeUnitGenTests", GRADE_TEST));
  unitgen(dir, ["verify", test.rel, ...adapterArgs], { code: 0, match: /verdict: ACCEPTED/ });
  unitgen(dir, ["mutate", test.rel, "--max", "8", ...adapterArgs], { code: 0, match: /gate: PASSED/ });
  unitgen(dir, ["report", ...adapterArgs], { code: 0 });
  const report = fs.readFileSync(path.join(dir, ".unitgen", "REPORT.md"), "utf8");
  if (!/GradeUnitGenTests\.m/.test(report)) { console.error("FAILED: report does not list the accepted test"); process.exit(1); }
  extra();
}

// 1. SwiftPM package with an Objective-C target (its public header in include/).
{
  const { dir, write } = project("objc spm");
  write("Package.swift", [
    "// swift-tools-version:5.9",
    "import PackageDescription",
    "",
    "let package = Package(",
    "    name: \"Calc\",",
    "    targets: [",
    "        .target(name: \"Calc\", path: \"Sources/Calc\"),",
    "        .testTarget(name: \"CalcTests\", dependencies: [\"Calc\"], path: \"Tests/CalcTests\"),",
    "    ]",
    ")",
    "",
  ].join("\n"));
  write("Sources/Calc/include/Grade.h", GRADE_H);
  write("Sources/Calc/Grade.m", GRADE_M);
  write("Tests/CalcTests/AddTests.m", testFile("AddTests", ADD_TEST));
  flow(dir, [], { source: "Sources/Calc/Grade.m", rel: "Tests/CalcUnitGenTests/GradeUnitGenTests.m" }, () => {
    const manifest = fs.readFileSync(path.join(dir, "Package.swift"), "utf8");
    if (!/headerSearchPath\("\.\.\/\.\.\/Sources\/Calc\/include"\)/.test(manifest)) { console.error("FAILED: the generated test target lacks the header search paths"); process.exit(1); }
  });
}

// 2. Xcode project: static library `Calc` + unit-test bundle `CalcTests` (macOS), no scheme files.
{
  const { dir, write } = project("objc xcode");
  write("Calc/Grade.h", GRADE_H);
  write("Calc/Grade.m", GRADE_M);
  write("CalcTests/AddTests.m", testFile("AddTests", ADD_TEST));
  const id = (n) => `A0000000000000000000${String(n).padStart(4, "0")}`;
  const settings = (extra) => ["SDKROOT = macosx;", "MACOSX_DEPLOYMENT_TARGET = 12.0;", "CLANG_ENABLE_OBJC_ARC = YES;", "PRODUCT_NAME = \"$(TARGET_NAME)\";", ...extra];
  const config = (n, name, s) => `\t\t${id(n)} /* ${name} */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\n${s.map((x) => `\t\t\t\t${x}`).join("\n")}\n\t\t\t};\n\t\t\tname = ${name};\n\t\t};`;
  const list = (n, a, b) => `\t\t${id(n)} = {\n\t\t\tisa = XCConfigurationList;\n\t\t\tbuildConfigurations = (\n\t\t\t\t${id(a)} /* Debug */,\n\t\t\t\t${id(b)} /* Release */,\n\t\t\t);\n\t\t\tdefaultConfigurationIsVisible = 0;\n\t\t\tdefaultConfigurationName = Debug;\n\t\t};`;
  const testSettings = ["GENERATE_INFOPLIST_FILE = YES;", "PRODUCT_BUNDLE_IDENTIFIER = dev.unitgen.CalcTests;", "CODE_SIGNING_ALLOWED = NO;"];
  const pbx = `// !$*UTF8*$!
{
\tarchiveVersion = 1;
\tclasses = {
\t};
\tobjectVersion = 56;
\tobjects = {

/* Begin PBXBuildFile section */
\t\t${id(1)} /* Grade.m in Sources */ = {isa = PBXBuildFile; fileRef = ${id(11)} /* Grade.m */; };
\t\t${id(2)} /* AddTests.m in Sources */ = {isa = PBXBuildFile; fileRef = ${id(12)} /* AddTests.m */; };
\t\t${id(3)} /* libCalc.a in Frameworks */ = {isa = PBXBuildFile; fileRef = ${id(13)} /* libCalc.a */; };
/* End PBXBuildFile section */

/* Begin PBXContainerItemProxy section */
\t\t${id(4)} /* PBXContainerItemProxy */ = {
\t\t\tisa = PBXContainerItemProxy;
\t\t\tcontainerPortal = ${id(40)} /* Project object */;
\t\t\tproxyType = 1;
\t\t\tremoteGlobalIDString = ${id(30)};
\t\t\tremoteInfo = Calc;
\t\t};
/* End PBXContainerItemProxy section */

/* Begin PBXFileReference section */
\t\t${id(10)} /* Grade.h */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.h; path = Grade.h; sourceTree = "<group>"; };
\t\t${id(11)} /* Grade.m */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.objc; path = Grade.m; sourceTree = "<group>"; };
\t\t${id(12)} /* AddTests.m */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.objc; path = AddTests.m; sourceTree = "<group>"; };
\t\t${id(13)} /* libCalc.a */ = {isa = PBXFileReference; explicitFileType = archive.ar; includeInIndex = 0; path = libCalc.a; sourceTree = BUILT_PRODUCTS_DIR; };
\t\t${id(14)} /* CalcTests.xctest */ = {isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = CalcTests.xctest; sourceTree = BUILT_PRODUCTS_DIR; };
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
\t\t${id(15)} /* Frameworks */ = {
\t\t\tisa = PBXFrameworksBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t\t${id(3)} /* libCalc.a in Frameworks */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
\t\t${id(20)} = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${id(21)} /* Calc */,
\t\t\t\t${id(22)} /* CalcTests */,
\t\t\t\t${id(23)} /* Products */,
\t\t\t);
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${id(21)} /* Calc */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${id(10)} /* Grade.h */,
\t\t\t\t${id(11)} /* Grade.m */,
\t\t\t);
\t\t\tpath = Calc;
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${id(22)} /* CalcTests */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${id(12)} /* AddTests.m */,
\t\t\t);
\t\t\tpath = CalcTests;
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${id(23)} /* Products */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${id(13)} /* libCalc.a */,
\t\t\t\t${id(14)} /* CalcTests.xctest */,
\t\t\t);
\t\t\tname = Products;
\t\t\tsourceTree = "<group>";
\t\t};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
\t\t${id(30)} /* Calc */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${id(52)};
\t\t\tbuildPhases = (
\t\t\t\t${id(33)} /* Sources */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t);
\t\t\tname = Calc;
\t\t\tproductName = Calc;
\t\t\tproductReference = ${id(13)} /* libCalc.a */;
\t\t\tproductType = "com.apple.product-type.library.static";
\t\t};
\t\t${id(31)} /* CalcTests */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${id(53)};
\t\t\tbuildPhases = (
\t\t\t\t${id(34)} /* Sources */,
\t\t\t\t${id(15)} /* Frameworks */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t\t${id(35)} /* PBXTargetDependency */,
\t\t\t);
\t\t\tname = CalcTests;
\t\t\tproductName = CalcTests;
\t\t\tproductReference = ${id(14)} /* CalcTests.xctest */;
\t\t\tproductType = "com.apple.product-type.bundle.unit-test";
\t\t};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
\t\t${id(40)} /* Project object */ = {
\t\t\tisa = PBXProject;
\t\t\tbuildConfigurationList = ${id(51)};
\t\t\tcompatibilityVersion = "Xcode 14.0";
\t\t\tdevelopmentRegion = en;
\t\t\thasScannedForEncodings = 0;
\t\t\tknownRegions = (
\t\t\t\ten,
\t\t\t\tBase,
\t\t\t);
\t\t\tmainGroup = ${id(20)};
\t\t\tproductRefGroup = ${id(23)} /* Products */;
\t\t\tprojectDirPath = "";
\t\t\tprojectRoot = "";
\t\t\ttargets = (
\t\t\t\t${id(30)} /* Calc */,
\t\t\t\t${id(31)} /* CalcTests */,
\t\t\t);
\t\t};
/* End PBXProject section */

/* Begin PBXSourcesBuildPhase section */
\t\t${id(33)} /* Sources */ = {
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t\t${id(1)} /* Grade.m in Sources */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
\t\t${id(34)} /* Sources */ = {
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t\t${id(2)} /* AddTests.m in Sources */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXSourcesBuildPhase section */

/* Begin PBXTargetDependency section */
\t\t${id(35)} /* PBXTargetDependency */ = {
\t\t\tisa = PBXTargetDependency;
\t\t\ttarget = ${id(30)} /* Calc */;
\t\t\ttargetProxy = ${id(4)} /* PBXContainerItemProxy */;
\t\t};
/* End PBXTargetDependency section */

/* Begin XCBuildConfiguration section */
${config(60, "Debug", ["ONLY_ACTIVE_ARCH = YES;", "DEBUG_INFORMATION_FORMAT = dwarf;", "GCC_OPTIMIZATION_LEVEL = 0;", "ENABLE_TESTABILITY = YES;", "SDKROOT = macosx;"])}
${config(61, "Release", ["SDKROOT = macosx;"])}
${config(62, "Debug", settings([]))}
${config(63, "Release", settings([]))}
${config(64, "Debug", settings(testSettings))}
${config(65, "Release", settings(testSettings))}
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
${list(51, 60, 61)}
${list(52, 62, 63)}
${list(53, 64, 65)}
/* End XCConfigurationList section */
\t};
\trootObject = ${id(40)} /* Project object */;
}
`;
  write("Calc.xcodeproj/project.pbxproj", pbx);
  flow(dir, ["--adapter", "xcode"], { source: "Calc/Grade.m", rel: "CalcTests/GradeUnitGenTests.m" }, () => {
    const after = fs.readFileSync(path.join(dir, "Calc.xcodeproj", "project.pbxproj"), "utf8");
    if (!/lastKnownFileType = sourcecode\.c\.objc; path = GradeUnitGenTests\.m;/.test(after)) { console.error("FAILED: the test file is not registered in project.pbxproj"); process.exit(1); }
  });
}
console.log("e2e objc OK");
