# iOS / Swift and Objective-C (SwiftPM and Xcode)

## How unitgen runs it

- Generated tests go into a dedicated test target `<Target>UnitGenTests`, registered by a
  marked block at the end of `Package.swift` (`// unitgen:begin` … `// unitgen:end`).
  Keep that block when committing; delete it to remove the generated target.
- Directory: `Tests/<Target>UnitGenTests/`, or `UnitGenTests/<Target>/` when the existing
  test target owns all of `Tests/` (sources may not overlap).
- `verify` runs `swift test --enable-swift-testing --enable-code-coverage` with a temporary
  manifest that keeps only the generated targets (`--enable-swift-testing` matters: packages with
  `swift-tools-version` < 6.0 otherwise run 0 `@Test` functions). `Package.swift` is restored
  afterwards; after a crash or forced kill the next unitgen command restores it.
- Version-specific manifests (`Package@swift-6.1.swift`): SwiftPM loads the one matching the
  toolchain, so unitgen writes its block and its temporary patches into every manifest; `doctor`
  names the one in use. `Package.resolved` is restored after each run.
- The baseline runs the package's own tests only; generated targets are excluded.
- A `.target` that contains `main.swift` builds as an executable: unitgen does not offer it
  (tests cannot import it).
- Command Line Tools without Xcode: XCTest is unavailable, so the existing XCTest suites
  cannot run and the baseline is 0%. Only Swift Testing works there; unitgen adds the
  framework search paths it needs.
- Packages that `import UIKit` unconditionally cannot build on macOS; `doctor` warns. Use the
  Xcode adapter for those.

## Xcode projects (`--adapter xcode`)

- Used automatically for `.xcodeproj`/`.xcworkspace` without a `Package.swift`; pass
  `--adapter xcode` on every command when both exist.
- Runs `xcodebuild test` on an iOS Simulator (or macOS for macOS targets) with
  `-only-testing:<TestTarget>/<Class>`; coverage from the `.xcresult` (`xccov`).
- Generated files go into the existing test target that tests the module (the brief names the
  file); classic targets get the file registered in `project.pbxproj`, synchronized folders need
  nothing. Commit that pbxproj change together with the test file.
- xcodebuild runs are slow (20–40 s each): keep `mutate --max` small (10). unitgen's runs set
  `ENABLE_TESTABILITY=YES` and switch off legacy gcov coverage flags, so `@testable import` works
  even where the project's Debug configuration turned testability off. The build goes to
  `.unitgen/DerivedData` (the first run builds from scratch; an open Xcode is not disturbed).
- The brief's `@testable import` uses the target's PRODUCT_MODULE_NAME (target `Foo iOS` usually
  builds module `Foo`), and says XCTest only when the test target's deployment target is older
  than Swift Testing supports (iOS 13 / macOS 10.15).

## Writing the test

The brief decides the framework: **XCTest** for packages with `swift-tools-version` < 6.0 (a plain
`swift test` in their CI never runs Swift Testing) and for Xcode test targets older than iOS 13 /
macOS 10.15; Swift Testing otherwise. When the brief says XCTest, it wins over the examples below:

```swift
import XCTest
@testable import MyModule

final class ParserUnitGenTests: XCTestCase {
    func testEvaluatesTableOfInputs() throws {
        for (input, expected) in [("1+2", 3.0), ("2*3", 6.0)] {
            XCTAssertEqual(try Parser(input).evaluate(), expected, accuracy: 1e-9, input)
        }
    }

    func testEmptyInputThrows() {
        XCTAssertThrowsError(try Parser("").evaluate()) { XCTAssertEqual($0 as? ParserError, .empty) }
    }
}
```

Swift Testing:

```swift
import Testing
@testable import MyModule

@Suite struct ParserUnitGenTests {
    @Test(arguments: [("1+2", 3.0), ("2*3", 6.0)])
    func evaluates(input: String, expected: Double) throws {
        #expect(try Parser(input).evaluate() == expected)
    }

    @Test func emptyInputThrows() {
        #expect(throws: ParserError.empty) { try Parser("").evaluate() }
    }
}
```

- Name the suite exactly as the brief says; one suite per file.
- `#expect(throws: SomeError.self)` when the error type isn't `Equatable`;
  `#expect(throws: SomeError.case)` when it is.
- `try #require(optional)` to unwrap; never force-unwrap in tests.
- Name clashes: Foundation (macOS 15+) has `Expression`, `Predicate`, … Value contexts
  (`Expression("1+2")`, `Expression.parse(...)`) compile fine; only *type* positions
  (`let x: Expression.Symbol`, `[Expression.Symbol: …]`) fail with "is ambiguous for type
  lookup". Avoid the annotation or use a nested type reached through a value.
- Multi-statement closures in dictionary literals need explicit types.
- Internal symbols are visible through `@testable import`; `private`/`fileprivate` are not.
  Test them through the internal/public API that calls them.
- Static caches and singletons persist across tests in the same process: use unique keys
  or reset them (`clearCache()`-style APIs) inside the test.

## Objective-C

A `.m` / `.mm` source gets an Objective-C test (XCTest), whatever else the target contains: the brief
names the file (`Foo.m` -> `FooUnitGenTests.m`, `NSString+Foo.m` -> `NSString_FooUnitGenTests.m`,
`.mm` -> `.mm`), the class and the header to import, and shows that header in full under
"Interface". Only what the header declares is callable; a method missing there is private.

```objc
#import <XCTest/XCTest.h>
#import "Parser.h"

@interface ParserUnitGenTests : XCTestCase
@end

@implementation ParserUnitGenTests

- (void)testEvaluatesTableOfInputs {
    NSDictionary<NSString *, NSNumber *> *cases = @{@"1+2": @3, @"2*3": @6};
    for (NSString *input in cases) {
        NSError *error = nil;
        XCTAssertEqualWithAccuracy([[Parser parserWithString:input] evaluate:&error], cases[input].doubleValue, 1e-9, @"%@", input);
        XCTAssertNil(error, @"%@", input);
    }
}

- (void)testEmptyInputFails {
    NSError *error = nil;
    XCTAssertEqual([[Parser parserWithString:@""] evaluate:&error], 0.0);
    XCTAssertEqualObjects(error.domain, ParserErrorDomain);
    XCTAssertEqual(error.code, ParserErrorEmpty);
}

@end
```

- `XCTAssertEqualObjects` for objects, `XCTAssertEqual` for scalars, `XCTAssertEqualWithAccuracy` for
  floating point. Wrap literals that contain commas in parentheses inside an assertion
  (`XCTAssertEqualObjects(list, (@[@1, @2]))`): XCTAssert* are macros.
- `NSError **` APIs: pass `&error`, assert on the return value and on `error.domain` / `error.code`.
  `XCTAssertThrowsSpecificNamed` for APIs that raise NSException.
- Messages to nil return nil/0/NO, so a test that "does not crash" proves nothing: assert values.
- Test doubles: subclass the class (override the method you observe) or implement the delegate
  protocol in the test file; FMDatabaseQueue-style `+databaseClass` hooks are public API. No OCMock
  unless the existing tests already import it.
- The brief says whether the test target uses ARC; without ARC, balance alloc/copy with release.
- Xcode: the file goes into the existing unit-test target and is registered in `project.pbxproj`
  (`sourcecode.c.objc`); headers of the same project are found by name (`#import "Foo.h"`), or import
  them the way the existing tests do (`#import <Foo/Foo.h>`, `@import Foo;`).
- SwiftPM: Objective-C targets get their own Objective-C test target `<Target>UnitGenTests`; every
  header directory of the target is on its header search path. Needs Xcode (XCTest), not just the
  Command Line Tools. Tests run on macOS: no UIKit.
- Mutation testing also flips `YES`/`NO`, deletes message sends (`[self.items addObject:x];`, also
  over several lines) and negates conditions such as `if ([s hasPrefix:@"x"])`. It leaves `-dealloc`,
  `[super init]` chains and retain/release (or `FooRetain(x)`-style macros that are empty under ARC)
  alone, because no test can observe them.
- Projects whose old deployment target links `libarclite` (removed in Xcode 14.3) do not build on
  current Xcode; unitgen reports it as an environment problem. Raise the deployment target first.
