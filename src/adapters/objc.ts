// Objective-C (.m) and Objective-C++ (.mm) sources in Xcode targets and SwiftPM C-family targets:
// what the Xcode and SwiftPM adapters need beyond Swift. Tests of an Objective-C file are written in
// Objective-C (XCTest), import the file's header, and go into the same test target as Swift tests.
import * as path from "node:path";
import { exists, walkFiles } from "../util.ts";
import type { FileKind } from "./types.ts";

export const SOURCE_EXTS = [".swift", ".m", ".mm"];

export const isObjC = (file: string): boolean => /\.mm?$/.test(file);

/** Extension of the test file for a source: .mm for Objective-C++ (its headers may use C++), .m, .swift. */
export function testExt(source: string): string {
  return source.endsWith(".mm") ? ".mm" : source.endsWith(".m") ? ".m" : ".swift";
}

/** File name without its source extension (`NSString+Foo.m` -> `NSString+Foo`). */
export function stem(file: string): string {
  return path.basename(file).replace(/\.(swift|mm?)$/, "");
}

/** Xcode's file type for a source in project.pbxproj. */
export function pbxFileType(file: string): string {
  return file.endsWith(".mm") ? "sourcecode.cpp.objcpp" : file.endsWith(".m") ? "sourcecode.c.objc" : "sourcecode.swift";
}

// Header file name -> first path, per directory (one walk per directory and command).
const headerIndex = new Map<string, Map<string, string>>();

/** The header that declares a source's interface: `Foo.h` next to `Foo.m`, else the first `Foo.h` under `dirs`. */
export function headerFor(source: string, dirs: string[]): string | undefined {
  if (!isObjC(source)) return undefined;
  const name = `${stem(source)}.h`;
  const beside = path.join(path.dirname(source), name);
  if (exists(beside)) return beside;
  for (const d of dirs) {
    let index = headerIndex.get(d);
    if (!index) {
      index = new Map();
      for (const h of walkFiles(d, [".h"])) if (!index.has(path.basename(h))) index.set(path.basename(h), h);
      headerIndex.set(d, index);
    }
    const hit = index.get(name);
    if (hit) return hit;
  }
  return undefined;
}

/** Headers a file includes with `#import "X.h"` / `#include "X.h"` (quoted: the project's own headers). */
export function quotedImports(text: string): string[] {
  return [...text.matchAll(/^\s*#\s*(?:import|include)\s+"([^"]+\.h)"/gm)].map((m) => m[1]);
}

/** `text` without comments, line structure kept (so line numbers still match). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"/g, (s) => (s.startsWith("\"") ? s : s.replace(/[^\n]/g, " ")));
}

const DIRECTIVE = /^\s*(@interface|@protocol|@implementation|@property|@end|@class|@optional|@required|typedef\b|extern\b|FOUNDATION_EXPORT\b|FOUNDATION_EXTERN\b|UIKIT_EXTERN\b|NS_SWIFT_NAME\b)/;
const METHOD = /^\s*[-+]\s*\(/;
// A C function prototype or definition at top level: `NSString *FooName(int x);`, `static inline CGFloat clamp(CGFloat v) {`.
const C_FUNCTION = /^\s*(static\s+|inline\s+|extern\s+|__attribute__\(\([^)]*\)\)\s+)*[A-Za-z_][\w]*(\s+[A-Za-z_]\w*)*[\s*]+\**[A-Za-z_]\w*\s*\([^;{]*\)?\s*(;|\{)?\s*$/;
const NOT_A_FUNCTION = /^\s*(return|if|else|for|while|switch|do|case|goto|sizeof)\b/;

/**
 * Declarations of an Objective-C header or implementation: @interface/@protocol/@implementation
 * lines, properties, method signatures (multi-line ones joined), C functions and NS_ENUM members.
 * Method bodies and private instance variables are left out; `@public` ones are kept (callers read them).
 */
export function objcDeclarationLines(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let continuing = false;
  let enumBlock = -1;
  // Instance-variable block of an @interface: its visibility section (`@public` ivars are API).
  let ivars = false;
  let afterInterface = false;
  let visibility = "";
  let publicIvars = false;
  for (const raw of stripComments(text).split("\n")) {
    const l = raw.replace(/\s+$/, "");
    const t = l.trim();
    if (ivars && depth === 1) {
      const v = /^@(public|protected|private|package)\b/.exec(t);
      if (v) {
        visibility = v[1];
        if (visibility === "public") out.push(l);
      } else if (visibility === "public" && /;$/.test(t)) { out.push(l); publicIvars = true; }
    }
    if (continuing) {
      out[out.length - 1] += ` ${t.replace(/\{$/, "").trim()}`;
      continuing = !/[;{]$/.test(t) && t !== "";
    } else if (depth === 0 && t && (DIRECTIVE.test(l) || METHOD.test(l) || (C_FUNCTION.test(l) && !NOT_A_FUNCTION.test(l) && /\(/.test(t)))) {
      out.push(l.replace(/\s*\{$/, ""));
      continuing = METHOD.test(l) && !/[;{]$/.test(t);
    } else if (enumBlock >= 0 && depth === enumBlock + 1 && /^[A-Za-z_]\w*\s*(=[^,]*)?,?$/.test(t)) {
      out.push(l);
    }
    if (depth === 0 && /\b(NS_ENUM|NS_OPTIONS|NS_CLOSED_ENUM|NS_ERROR_ENUM|enum)\b/.test(t) && t.includes("{")) enumBlock = 0;
    // `@interface Foo : NSObject {`, or the `{` alone on the next line.
    if (depth === 0 && (/^\s*@interface\b/.test(l) || (afterInterface && /^\s*\{/.test(l))) && l.includes("{")) { ivars = true; visibility = "protected"; publicIvars = false; }
    if (t) afterInterface = depth === 0 && /^\s*@interface\b/.test(l) && !l.includes("{");
    for (const c of l.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "")) {
      if (c === "{") depth++;
      else if (c === "}") {
        depth = Math.max(0, depth - 1);
        if (depth === 0 && ivars) {
          if (publicIvars) out.push(l.trim());
          ivars = false;
        }
        if (depth === 0 && enumBlock >= 0) {
          out.push(l.trim());
          enumBlock = -1;
        }
      }
    }
  }
  return out;
}

/** Type names an Objective-C or Swift text defines (classes, protocols, categories' classes, NS_ENUMs). */
export function definedTypes(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(?:class|struct|enum|protocol|interface|object|typealias)\s+([A-Z]\w*)|NS_(?:ENUM|OPTIONS|CLOSED_ENUM|ERROR_ENUM)\s*\(\s*\w+\s*,\s*([A-Z]\w*)/g)) out.push(m[1] ?? m[2]);
  return out;
}

/** classify() for Objective-C: `header` is the file's interface (where the superclass is declared). */
export function classifyObjC(file: string, text: string, header = ""): FileKind {
  const both = `${header}\n${text}`;
  if (/\.pb(objc)?\.mm?$|Generated/.test(file) || /(^|\n)\s*(\/\/|\/\*|\*).*\b(generated|DO NOT EDIT)\b/i.test(text.slice(0, 600))) return "generated";
  if (/\b(UIApplicationMain|NSApplicationMain)\s*\(|<\s*(UIApplicationDelegate|NSApplicationDelegate|UIWindowSceneDelegate)\b/.test(both) || /^\s*int\s+main\s*\(/m.test(text)) return "entry";
  if (/@interface\s+\w+\s*:\s*(UI|NS)\w*(View|ViewController|Cell|Controller|Control|Window|Button|Label)\b/.test(both)) return "ui";
  const methods = (text.match(/^\s*[-+]\s*\([^)]*\)\s*\w+/gm) ?? []).length;
  const functions = text.split("\n").filter((l) => C_FUNCTION.test(l) && /\{\s*$/.test(l) && !NOT_A_FUNCTION.test(l)).length;
  return methods + functions === 0 ? "model" : "logic";
}

/** Brief conventions for an Objective-C test file. */
export function objcConventions(o: { where: string; suite: string; header?: string; arc: boolean; examples: string[]; publicOnly?: string }): string {
  return [
    o.where,
    `Write the test in Objective-C with XCTest (the source under test is Objective-C): \`#import <XCTest/XCTest.h>\`, ${o.header ? `\`#import "${o.header}"\`` : "the header that declares the code under test"}, then \`@interface ${o.suite} : XCTestCase @end\` and \`@implementation ${o.suite}\` with \`- (void)testX\` methods (each name starts with \`test\`). One class per file, named exactly \`${o.suite}\` (it is used to run only this file).`,
    o.examples.length ? `Import headers the way the existing tests do (${o.examples.join(", ")}).` : "",
    o.publicOnly ?? "",
    "Assertions: `XCTAssertEqualObjects` for objects (NSString, NSNumber, NSArray, NSDictionary), `XCTAssertEqual` for scalars (NSInteger, BOOL, enums), `XCTAssertEqualWithAccuracy` for floating point, `XCTAssertNil`/`XCTAssertNotNil`, `XCTAssertTrue`/`XCTAssertFalse`, `XCTAssertThrowsSpecificNamed` for NSException. For `NSError **` APIs pass `&error` and assert on the return value and on `error.domain`/`error.code`.",
    "XCTAssert* are macros: an argument with a comma outside parentheses (`@[@1, @2]`, `@{@\"a\": @1, @\"b\": @2}`, `[x a:1 b:2]` is fine) must be wrapped in parentheses, e.g. `XCTAssertEqualObjects(list, (@[@1, @2]))`.",
    o.arc ? "The test target compiles with ARC: never call retain/release/autorelease." : "The test target compiles WITHOUT ARC (manual reference counting): balance alloc/new/copy with release (or autorelease), and never use __weak.",
    "Messages to nil return nil/0/NO: assert on values, not on the absence of a crash. Methods that are not in a header are private: test them through the public methods that call them, never with performSelector: or a category re-declaring them.",
    "No network, no real keychain/user defaults/file system outside NSTemporaryDirectory(), no sleeps or run-loop spinning; UI classes only through their non-UI logic.",
  ].filter(Boolean).join("\n");
}
