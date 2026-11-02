# iOS / Swift (SwiftPM and Xcode)

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
