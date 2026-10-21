# iOS / Swift (SwiftPM)

## How unitgen runs it

- Generated tests go into a dedicated test target `<Target>UnitGenTests`, registered by a
  marked block at the end of `Package.swift` (`// unitgen:begin` … `// unitgen:end`).
  Keep that block when committing; delete it to remove the generated target.
- Directory: `Tests/<Target>UnitGenTests/`, or `UnitGenTests/<Target>/` when the existing
  test target owns all of `Tests/` (sources may not overlap).
- `verify` runs `swift test --enable-code-coverage` with a temporary manifest that keeps only
  the generated targets; `Package.swift` is restored afterwards (a crash leaves a backup in
  `.unitgen/Package.swift.orig`, restored on the next run).
- Command Line Tools without Xcode: XCTest is unavailable, so the existing XCTest suites
  cannot run and the baseline is 0%. Only Swift Testing works there; unitgen adds the
  framework search paths it needs.
- Packages that `import UIKit` unconditionally cannot build on macOS; `doctor` warns.
  Use an Xcode scheme with an iOS Simulator for those (not automated yet).

## Writing the test

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
