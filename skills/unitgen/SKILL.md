---
name: unitgen
description: Backfill unit tests for iOS (Swift/SwiftPM), Android (Kotlin/Java, Gradle) and HarmonyOS (ArkTS) projects, keeping only tests that compile, pass repeatedly, assert something and raise line coverage. Use when the user asks to add/补 unit tests, raise coverage, or "write tests for" files in a mobile codebase.
---

# unitgen: coverage-guided unit test backfilling

You write the tests; the `unitgen` CLI decides what to test and whether a test is kept.
It measures coverage, ranks files by untested logic, prints a brief per file (source with
uncovered lines marked `!`, conventions, available test libraries, the project's own test
doubles and example tests), then runs a strict gate on every test file you write.

## Setup

```bash
UNITGEN="${UNITGEN:-$HOME/Documents/unitgen/bin/unitgen}"   # adjust if installed elsewhere
"$UNITGEN" doctor -C <project-root>
```

Needs Node >= 22.18 (runs the TypeScript sources directly). `doctor` checks the platform
toolchain: Swift (Xcode or Command Line Tools), JDK 17+ and Android SDK, or hvigor (falls back
to a Node shim for ArkTS pure logic). Fix whatever it reports before continuing; do not
work around a missing toolchain by skipping verification.

All commands accept `-C <root>`; run them from the project root otherwise.

## Workflow

1. **Baseline (once):** `"$UNITGEN" baseline` — runs the existing tests with coverage.
   Re-run only after large production-code changes. A few failing pre-existing tests are
   fine (they are reported); a build failure is not — read the log it prints.
2. **Pick targets:** `"$UNITGEN" targets --limit 15`. If the user named files or a module,
   use those (`--module <name>` narrows the list). Prefer `logic` kind with many uncovered
   lines. Skip a target if it is pure glue around platform APIs you cannot fake.
3. **For each target, one at a time:**
   1. `"$UNITGEN" brief <source-file>` and read the whole brief. It names the exact test
      file path and suite/class name to use — keep both, the gate depends on them.
      Lines starting with ⚠️ at the top (uninstalled packages, stubbed platform APIs) often
      mean the target cannot be verified here: prefer another target.
   2. Open any other source the brief references but does not include (constructors of
      collaborators, data classes, test-helper modules) before writing assertions.
   3. Write the test file at the given path. Follow the brief's rules; reuse listed test
      doubles; mirror the imports of the example tests.
   4. `"$UNITGEN" verify <test-file> --target <source-file>` and act on the verdict:

      | verdict | what to do |
      |---|---|
      | `ACCEPTED` | done; move on |
      | `COMPILE_ERROR` | fix the test using the compiler output |
      | `TEST_FAILURES` | re-read the production code; fix the *expectation*. If the code is really wrong, assert current behaviour and add `// UNITGEN-SUSPECT: <why>` (collected into the report automatically) |
      | `FLAKY` | remove the source of nondeterminism (time, ordering, shared state, real dispatchers) |
      | `NO_GAIN` | the tests only hit already-covered lines; aim at the `!` lines in a fresh brief |
      | `NO_ASSERTIONS` / `NO_TESTS` | add real assertions / check suite & class naming |
      | `INFRA_ERROR` | environment problem (missing SDK, uninstalled ohpm packages, ...): report it, pick another target; don't edit tests to dodge it |

   5. **Check assertion strength:** `"$UNITGEN" mutate <test-file>` flips operators / deletes
      calls on the lines your test covers and re-runs it. Coverage alone does not prove the
      assertions check anything. For each *survived* mutant, add an assertion that would fail
      (then `verify` and `mutate` again), unless the mutant is equivalent (no observable change,
      e.g. an unreachable bound) — record it with `"$UNITGEN" note "equivalent mutant: <file>:<line> <why>"`.
      Aim for ≥ 80%. A run samples up to `--max` (default 15) mutants, preferring deleted calls,
      negated conditions and comparison flips; the output says how many candidates exist.
      Mutants that don't compile are replaced and don't count; the source is always restored.
      Re-verifying after strengthening shows "+0 vs. its previously accepted version" and is
      still ACCEPTED — new assertions don't need new lines.
   6. Give up on a target after ~4 attempts: `"$UNITGEN" reject <test-file> "<why>"` moves the
      file into `.unitgen/rejected/` (and unregisters it) so the build stays green.
   **Large single files** (one 1000+ line source, e.g. a whole library in one file): build the
   test file up in passes — one feature area per pass (parsing, accessors, operators, errors…),
   `verify` after each pass. Each pass must add coverage or it is `NO_GAIN`.
   Use `"$UNITGEN" note "<text>"` only for findings that are not already a `UNITGEN-SUSPECT` comment.
4. **Finish:** `"$UNITGEN" report` writes `.unitgen/REPORT.md` (coverage before/after,
   accepted/rejected files, suspected bugs). Summarise it for the user, including what you
   could not cover and why (e.g. code paths needing a device, Robolectric, or a real network).

## Hard rules

- Never modify production code, build files or existing tests to make a generated test pass.
  The only exception is what unitgen itself manages (it registers a SwiftPM test target and
  ArkTS `List.test.ets` entries).
- Never weaken a test to get it accepted (`assertTrue(true)`, catching and ignoring
  assertion errors, asserting on mocks you just stubbed). The gate counts assertions, but
  you are responsible for them being meaningful.
- Expected values come from reading the code (or a trustworthy oracle such as an RFC
  test vector), never from "whatever the test printed".
- Run one `verify` at a time per project: runs share build directories.
- Do not add dependencies. Use only the libraries the brief lists or the example tests import.

## Platform notes

Read the matching reference before writing the first test for a platform:

- iOS / Swift: [references/ios.md](references/ios.md)
- Android / Kotlin / Java: [references/android.md](references/android.md)
- HarmonyOS / ArkTS: [references/harmony.md](references/harmony.md)

## Non-interactive mode

`"$UNITGEN" generate --llm anthropic|claude|cmd:<shell> --limit 5` runs the same
brief → write → verify → feedback loop without an agent (ANTHROPIC_API_KEY for `anthropic`,
`claude` on PATH for `claude`). Prefer the interactive workflow above when you are the agent:
you can read more of the codebase than a single brief contains.
