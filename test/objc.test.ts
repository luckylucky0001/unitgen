import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { classifyObjC, definedTypes, headerFor, objcDeclarationLines, pbxFileType, quotedImports, stem, testExt } from "../src/adapters/objc.ts";
import { parseXccovArchiveJson } from "../src/coverage.ts";
import { declarationLines } from "../src/context.ts";
import { mutantsFor } from "../src/mutate.ts";
import { estimateExecutable } from "../src/targets.ts";

const IMPL = `#import "Grade.h"
#define LIMIT 10

static NSString * const kKey = @"grade";

@implementation Grade

- (NSString *)gradeFor:(NSInteger)score {
    if (score >= 90) {
        return @"A";
    }
    if ([self isCurved]) {
        score = score + 5;
    }
    self.last = [NSString stringWithFormat:@"%ld", (long)score];
    [self.history addObject:@(score)];
    [self.delegate grade:self
             didScore:score];
    BOOL ok = YES;
    NSString * name = nil;
    NSLog(@"score %ld", (long)score);
    NSParameterAssert(name);
    FMDBRelease(name);
    [name release];
    return score * 2 > LIMIT ? @"B" : @"C";
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _count = 0;
    }
    return self;
}

- (void)dealloc {
    _count = 0;
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}
@end
`;

const lineOf = (text: string, needle: string) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

test("objc: file naming, header lookup and quoted imports", () => {
  assert.equal(stem("/p/NSString+Foo.m"), "NSString+Foo");
  assert.equal(testExt("/p/A.m"), ".m");
  assert.equal(testExt("/p/A.mm"), ".mm");
  assert.equal(testExt("/p/A.swift"), ".swift");
  assert.equal(pbxFileType("/p/A.m"), "sourcecode.c.objc");
  assert.equal(pbxFileType("/p/A.mm"), "sourcecode.cpp.objcpp");
  assert.equal(pbxFileType("/p/A.swift"), "sourcecode.swift");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unitgen-objc-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "include"));
  fs.writeFileSync(path.join(dir, "src", "A.m"), "");
  fs.writeFileSync(path.join(dir, "src", "A.h"), "");
  fs.writeFileSync(path.join(dir, "src", "B.m"), "");
  fs.writeFileSync(path.join(dir, "include", "B.h"), "");
  fs.writeFileSync(path.join(dir, "include", "XB.h"), "");
  assert.equal(headerFor(path.join(dir, "src", "A.m"), [dir]), path.join(dir, "src", "A.h"));
  assert.equal(headerFor(path.join(dir, "src", "B.m"), [dir]), path.join(dir, "include", "B.h"));
  assert.equal(headerFor(path.join(dir, "src", "C.m"), [dir]), undefined);
  assert.equal(headerFor(path.join(dir, "src", "A.swift"), [dir]), undefined);
  assert.deepEqual(quotedImports(`#import "A.h"\n#import <Foundation/Foundation.h>\n  #include "sub/B.h"\n@import UIKit;`), ["A.h", "sub/B.h"]);
});

test("objc: declarations of headers and implementations (multi-line methods, enums, C functions; no ivars, comments, bodies)", () => {
  const header = `#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
typedef NS_ENUM(NSInteger, GradeKind) {
    GradeKindA = 0,
    GradeKindB,
};
/** Doc */
@protocol GradeDelegate <NSObject>
- (void)grade:(Grade *)g didScore:(NSInteger)s;
@end
@interface Grade : NSObject {
  int _ivar;
}
@property (nonatomic, weak, nullable) id<GradeDelegate> delegate;
- (NSString *)gradeFor:(NSInteger)score; // trailing comment
+ (instancetype)gradeWithName:(NSString *)name
                        scale:(CGFloat)scale;
@end
FOUNDATION_EXPORT NSString *GradeName(GradeKind k);
CGFloat GradeClamp(CGFloat v);
NS_ASSUME_NONNULL_END`;
  assert.deepEqual(objcDeclarationLines(header), [
    "typedef NS_ENUM(NSInteger, GradeKind)",
    "    GradeKindA = 0,",
    "    GradeKindB,",
    "};",
    "@protocol GradeDelegate <NSObject>",
    "- (void)grade:(Grade *)g didScore:(NSInteger)s;",
    "@end",
    "@interface Grade : NSObject",
    "@property (nonatomic, weak, nullable) id<GradeDelegate> delegate;",
    "- (NSString *)gradeFor:(NSInteger)score;",
    "+ (instancetype)gradeWithName:(NSString *)name scale:(CGFloat)scale;",
    "@end",
    "FOUNDATION_EXPORT NSString *GradeName(GradeKind k);",
    "CGFloat GradeClamp(CGFloat v);",
  ]);
  const impl = objcDeclarationLines(IMPL);
  assert.deepEqual(impl, ["@implementation Grade", "- (NSString *)gradeFor:(NSInteger)score", "- (instancetype)init", "- (void)dealloc", "@end"]);
  // The brief's generic entry point routes .m/.h to the Objective-C reader.
  assert.deepEqual(declarationLines(IMPL, "/p/Grade.m"), impl);
  assert.deepEqual(definedTypes(header).sort(), ["Grade", "GradeDelegate", "GradeKind"]);
});

test("objc: classify entry, ui (superclass from the header), logic and model files", () => {
  assert.equal(classifyObjC("/p/main.m", "int main(int argc, char *argv[]) {\n  return UIApplicationMain(argc, argv, nil, nil);\n}"), "entry");
  assert.equal(classifyObjC("/p/AppDelegate.m", "@implementation AppDelegate\n@end", "@interface AppDelegate : UIResponder <UIApplicationDelegate>"), "entry");
  assert.equal(classifyObjC("/p/VC.m", "@implementation VC\n- (void)viewDidLoad {}\n@end", "@interface VC : UIViewController"), "ui");
  assert.equal(classifyObjC("/p/Grade.m", IMPL, "@interface Grade : NSObject"), "logic");
  assert.equal(classifyObjC("/p/Model.m", "@implementation Model\n@end", "@interface Model : NSObject\n@property NSString *name;\n@end"), "model");
  assert.equal(classifyObjC("/p/Msg.pbobjc.m", "// Generated by the protocol buffer compiler.  DO NOT EDIT!\n@implementation Msg\n- (void)a {}\n@end"), "generated");
  assert.equal(classifyObjC("/p/util.m", "static inline CGFloat clamp(CGFloat v) {\n  return v;\n}"), "logic");
});

test("objc mutants: YES/NO, message sends (one and several lines), @\"\" strings, negated sends; no pointer, super-init, refcount or dealloc mutants", () => {
  const all = mutantsFor(IMPL, IMPL.split("\n").map((_, i) => i + 1), { objc: true });
  const at = (needle: string) => all.filter((m) => m.line === lineOf(IMPL, needle)).map((m) => `${m.op} | ${m.mutated.trim()}`);
  assert.deepEqual(at("BOOL ok = YES;"), ["YES -> NO | BOOL ok = NO;"]);
  assert.deepEqual(at("return @\"A\";"), ["string -> empty | return @\"\";"]);
  assert.deepEqual(at("if ([self isCurved])"), ["negate condition | if (![self isCurved]) {"]);
  assert.deepEqual(at("[self.history addObject"), ["delete statement | /* unitgen: statement deleted */"]);
  const multi = all.find((m) => m.line === lineOf(IMPL, "[self.delegate grade:self"));
  assert.equal(multi?.op, "delete statement");
  assert.equal(multi?.endLine, lineOf(IMPL, "didScore:score];"));
  // `NSString * name` is a declaration; `score * 2` is a multiplication.
  assert.deepEqual(at("NSString * name = nil;"), []);
  assert.ok(at("return score * 2").includes("* -> / | return score / 2 > LIMIT ? @\"B\" : @\"C\";"));
  assert.deepEqual(at("self = [super init];"), []);
  assert.deepEqual(at("FMDBRelease(name);"), []);
  assert.deepEqual(at("NSParameterAssert(name);"), []);
  assert.deepEqual(at("[name release];"), []);
  assert.deepEqual(at("NSLog("), []);
  assert.deepEqual(at("#define LIMIT"), []);
  assert.deepEqual(at("static NSString * const kKey"), []);
  // Nothing in -dealloc is observable by a test.
  const dealloc = lineOf(IMPL, "- (void)dealloc");
  assert.deepEqual(all.filter((m) => m.line > dealloc && m.line < dealloc + 4), []);
  // The method signature holds types, not code.
  assert.deepEqual(at("- (NSString *)gradeFor:(NSInteger)score {"), []);
  // Without the flag (Swift/Kotlin/TS), YES is just an identifier.
  assert.ok(!mutantsFor("let ok = YES", [1]).some((m) => m.op.startsWith("YES")));
});

test("swift deinit bodies get no mutants", () => {
  const src = "final class A {\n    var n = 0\n    deinit {\n        n = n + 1\n        cleanup()\n    }\n    func f() {\n        cleanup()\n    }\n}";
  const ms = mutantsFor(src, [4, 5, 8]);
  assert.deepEqual([...new Set(ms.map((m) => m.line))], [8]);
});

test("xccov and llvm-cov: preprocessor and block-comment lines inside a region are not executable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unitgen-cov-"));
  const file = path.join(dir, "A.m");
  fs.writeFileSync(file, ["- (void)f {", "#if DEBUG", "    g();", "#endif", "    /* a", "       b */", "    h(); /* c */", "    *error = nil;", "#pragma mark - x", "}"].join("\n"));
  const lines = Array.from({ length: 10 }, (_, i) => ({ line: i + 1, isExecutable: true, executionCount: 1 }));
  const cov = parseXccovArchiveJson({ [file]: lines });
  assert.deepEqual(Object.keys(cov[fs.realpathSync(file)] ?? cov[file]).map(Number), [1, 3, 7, 8, 10]);
});

test("estimateExecutable: Objective-C directives and preprocessor lines, @try and NSError out-parameters", () => {
  const src = ["#import \"A.h\"", "@implementation A", "- (BOOL)f:(NSError **)error {", "    @try {", "        *error = nil;", "    } @catch (NSException *e) {}", "#if DEBUG", "    g();", "#endif", "    return YES;", "}", "@end"].join("\n");
  assert.deepEqual(estimateExecutable(src), [3, 4, 5, 6, 8, 10]);
});

test("xcode schemes: test targets from testables and from test plans", async () => {
  const { schemeTestTargets } = await import("../src/adapters/xcode.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unitgen-scheme-"));
  fs.writeFileSync(path.join(dir, "App.xctestplan"), JSON.stringify({ testTargets: [{ target: { name: "PlanTests" } }] }));
  const xml = `<Scheme><BuildAction><BuildActionEntries><BuildActionEntry><BuildableReference BlueprintName = "App"/></BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration = "Debug">
  <TestPlans><TestPlanReference reference = "container:App.xctestplan" default = "YES"></TestPlanReference></TestPlans>
  <Testables><TestableReference skipped = "NO"><BuildableReference BuildableIdentifier = "primary" BlueprintName = "AppTests"></BuildableReference></TestableReference></Testables>
</TestAction>
<LaunchAction><BuildableReference BlueprintName = "Other"/></LaunchAction></Scheme>`;
  assert.deepEqual(schemeTestTargets(xml, dir), ["AppTests", "PlanTests"]);
  assert.deepEqual(schemeTestTargets("<Scheme><TestAction></TestAction></Scheme>"), []);
});

test("pbxproj: an Objective-C test file is registered with its file type", async () => {
  const { Pbxproj } = await import("../src/adapters/pbxproj.ts");
  const txt = [
    "// !$*UTF8*$!", "{", "\tobjects = {", "",
    "/* Begin PBXBuildFile section */",
    "/* End PBXBuildFile section */", "",
    "/* Begin PBXFileReference section */",
    "\t\tEE0000000000000000000001 /* ATests.m */ = {isa = PBXFileReference; path = ATests.m; sourceTree = \"<group>\"; };",
    "/* End PBXFileReference section */", "",
    "\t\tAA0000000000000000000001 /* Unit Tests */ = {", "\t\t\tisa = PBXGroup;", "\t\t\tchildren = (", "\t\t\t\tEE0000000000000000000001 /* ATests.m */,", "\t\t\t);", "\t\t\tpath = \"Unit Tests\";", "\t\t\tsourceTree = \"<group>\";", "\t\t};",
    "\t\tBB0000000000000000000001 /* Sources */ = {", "\t\t\tisa = PBXSourcesBuildPhase;", "\t\t\tfiles = (", "\t\t\t);", "\t\t};",
    "\t\tCC0000000000000000000001 /* Unit Tests */ = {", "\t\t\tisa = PBXNativeTarget;", "\t\t\tbuildPhases = (", "\t\t\t\tBB0000000000000000000001 /* Sources */,", "\t\t\t);", "\t\t\tname = \"Unit Tests\";", "\t\t\tproductType = \"com.apple.product-type.bundle.unit-test\";", "\t\t};",
    "\t};", "}",
  ].join("\n");
  const p = new Pbxproj(txt, path.resolve("/proj"));
  p.addSourceFile(p.targets()[0], path.resolve("/proj/Unit Tests/NSString_FooUnitGenTests.m"));
  assert.match(p.text, /lastKnownFileType = sourcecode\.c\.objc; path = NSString_FooUnitGenTests\.m;/);
  assert.deepEqual(p.targets()[0].files, [path.resolve("/proj/Unit Tests/NSString_FooUnitGenTests.m")]);
});

test("xcode modules: Objective-C sources, a tool sharing a framework's files keeps only its own, the variant the tests depend on wins", async () => {
  const { XcodeAdapter } = await import("../src/adapters/xcode.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unitgen-xcmods-"));
  for (const f of ["Lib/A.m", "Lib/A.h", "Lib/B.m", "Tool/main.m", "Tool/Extra.m", "Tests/ATests.m"]) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), f === "Tests/ATests.m" ? "#import \"A.h\"\n" : "");
  }
  const id = (n: number) => `B000000000000000000000${String(n).padStart(2, "0")}`;
  const ref = (n: number, p: string) => `\t\t${id(n)} /* ${p} */ = {isa = PBXFileReference; path = ${p}; sourceTree = "<group>"; };`;
  const build = (n: number, r: number) => `\t\t${id(n)} = {isa = PBXBuildFile; fileRef = ${id(r)}; };`;
  const group = (n: number, p: string, kids: number[]) => `\t\t${id(n)} /* ${p} */ = {isa = PBXGroup; children = (${kids.map(id).join(", ")}); path = ${p}; sourceTree = "<group>"; };`;
  const phase = (n: number, files: number[]) => `\t\t${id(n)} = {isa = PBXSourcesBuildPhase; files = (${files.map(id).join(", ")}); };`;
  const target = (n: number, name: string, type: string, phaseId: number, deps: number[] = []) =>
    `\t\t${id(n)} /* ${name} */ = {isa = PBXNativeTarget; buildPhases = (${id(phaseId)}); dependencies = (${deps.map(id).join(", ")}); name = ${name}; productType = "com.apple.product-type.${type}"; };`;
  const pbx = ["// !$*UTF8*$!", "{", "\tobjects = {",
    ref(1, "A.m"), ref(2, "B.m"), ref(3, "main.m"), ref(4, "Extra.m"), ref(5, "ATests.m"),
    build(11, 1), build(12, 2), build(13, 1), build(14, 3), build(15, 4), build(16, 5),
    group(20, "Lib", [1, 2]), group(21, "Tool", [3, 4]), group(22, "Tests", [5]),
    `\t\t${id(23)} = {isa = PBXGroup; children = (${[20, 21, 22].map(id).join(", ")}); sourceTree = "<group>"; };`,
    phase(30, [11, 12]), phase(31, [13, 14, 15]), phase(32, [16]),
    `\t\t${id(35)} = {isa = PBXTargetDependency; target = ${id(40)}; };`,
    target(40, "Lib", "framework", 30), target(41, "LibTool", "tool", 31), target(42, "LibTests", "bundle.unit-test", 32, [35]),
    "\t};", "}"].join("\n");
  fs.mkdirSync(path.join(dir, "Lib.xcodeproj"));
  fs.writeFileSync(path.join(dir, "Lib.xcodeproj", "project.pbxproj"), pbx);
  const a = new XcodeAdapter(dir, path.join(dir, ".unitgen"));
  const mods = a.modules();
  const byName = Object.fromEntries(mods.map((m) => [m.name, m]));
  assert.deepEqual(Object.keys(byName).sort(), ["Lib", "LibTool"]);
  assert.equal(byName.Lib.meta?.testTarget, "LibTests");
  assert.deepEqual(a.sourceFiles(byName.Lib).map((f) => path.relative(dir, f)).sort(), ["Lib/A.m", "Lib/B.m"]);
  assert.deepEqual(a.sourceFiles(byName.LibTool).map((f) => path.relative(dir, f)).sort(), ["Tool/Extra.m", "Tool/main.m"]);
  // The generated test of an Objective-C source: name, language, header import.
  const place = a.placement(path.join(dir, "Lib", "A.m"), byName.Lib);
  assert.equal(path.relative(dir, place.path), path.join("Tests", "AUnitGenTests.m"));
  assert.equal(place.suiteName, "AUnitGenTests");
  assert.equal(place.importHint, "#import \"A.h\"");
  assert.equal(a.moduleFor(place.path)?.name, "Lib");
});
