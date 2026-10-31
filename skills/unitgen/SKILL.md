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
UNITGEN="${UNITGEN:-$(command -v unitgen || true)}"
[ -n "$UNITGEN" ] && [ -x "$UNITGEN" ] || { echo "Install unitgen or set UNITGEN to its absolute executable path" >&2; exit 1; }
"$UNITGEN" doctor -C <project-root>
```

Needs Node >= 22.18 (runs the TypeScript sources directly); without one on PATH, `bin/unitgen`
uses the Node bundled with DevEco Studio, or the Node/JDK in `../unitgen-env` when present.
`doctor` checks the platform toolchain: Swift (Xcode or Command Line Tools), JDK 17+ and Android
SDK, or DevEco Studio's hvigor (found automatically; otherwise a Node shim for ArkTS pure logic,
and doctor says why). Fix whatever it reports before continuing; do not work around a missing
toolchain by skipping verification.

All commands accept `-C <root>`; run them from the project root otherwise.

### TRAE / TRAE CN

Install the complete Skill with `sh scripts/install-trae.sh --project <project-root>` or
`--global` (TRAE CN). The installer also links the CLI into `~/.local/bin`; ensure TRAE's
terminal PATH contains that directory, or set `UNITGEN` explicitly. Keep the checkout in place.
For reproducible toolchains, copy `scripts/unitgen-env.example.sh` outside the repository,
fill in paths, and export `UNITGEN_ENV` for **every** command. Do not rely on an `export`
from a previous tool call surviving into the next one.

TRAE writes tests and calls the CLI directly; this workflow requires no Claude CLI/API key.
Keep stdout for `--json` results and read progress from stderr or the reported log file.
Use the tool's process/job status for long builds; do not repeatedly start builds or use
fixed multi-minute sleeps. Cancellation must stop the command, not only the agent response.

## Workflow

0. **Start clean:** `git status`. If an earlier session was interrupted, run any unitgen command
   first (`"$UNITGEN" status`): it takes over a stale lock and restores interrupted mutations and
   temporary edits (it says so). Production code must show no changes before you continue.
1. **Doctor:** read every line. iOS: Xcode or Command Line Tools, and a `note:` when an
   `.xcodeproj` exists next to `Package.swift` (pass `--adapter xcode` on every command to use the
   iOS Simulator, e.g. for UIKit code). HarmonyOS: the `runner:` line says whether the real toolchain (hvigor:
   ArkTS compiler + Previewer runtime) or the Node shim is used, and why — for example
   `ohpm install` not run, `@ohos/hypium` not declared, an old hypium, `compileSdkVersion` not
   matching the installed SDK. Tell the user what would enable the real toolchain; do not edit
   build files yourself.
2. **Baseline (once):** `"$UNITGEN" baseline` — runs the project's own tests with coverage
   (files unitgen generated are excluded). Require exit 0 before generating tests. A project
   without tests gets a valid 0% baseline. Read the `note:` line: existing tests that do not
   compile, failing tests, modules the runner cannot build (and why) — report them to the user.
   If existing tests fail, `baseline --allow-failing` keeps a baseline from the passing ones (the
   HarmonyOS shim does this by itself for tests that fail only because they call stubbed system
   APIs). Re-run the baseline after switching runners (e.g. `UNITGEN_HARMONY_MODE`); verify
   refuses a baseline measured with another runner.
3. **Pick targets:** `"$UNITGEN" targets --limit 15`. If the user named files or a module,
   use those (`--module <name>` narrows the list). Prefer `logic` kind with many uncovered
   lines. Files listed last sit in modules the runner cannot build. Skip a target that is pure
   glue around platform APIs you cannot fake. Run `targets` again after each accepted file:
   one test file often covers other files too, so their uncovered counts change.
4. **For each target, one at a time:**
   1. `"$UNITGEN" brief <source-file>` and read the whole brief. It names the exact test
      file path and suite/class name to use — keep both, the gate depends on them.
      Lines starting with ⚠️ at the top (uninstalled packages, a file that exports nothing,
      ArkUI components, a module that does not build) often mean the target cannot be verified
      here: prefer another target. In the source, `!` marks uncovered lines; `!~` marks uncovered
      lines that call a system API which is only a stub/mock here — cover the logic around them,
      never assert on what that API returns.
   2. Open any other source the brief references but does not include (constructors of
      collaborators, data classes, test-helper modules) before writing assertions.
      Read the actual network/local/domain model fields; do not infer that they share names.
      Check fakes for TODO/unimplemented methods. If needed, implement a small test-local fake
      using existing interfaces; do not change shared fakes or add dependencies.
   3. Write the test file at the given path. Follow the brief's rules; reuse listed test
      doubles; mirror the imports of the example tests. Things that cost attempts in practice:
      - Formatted output (`description`, `String(describing:)`, `toString()`, error messages):
        read how the code builds the string, character by character; do not guess.
      - Global or static state (enabled flags, singletons, caches): save and restore it in the
        test, and serialize the suite if the framework runs tests in parallel (Swift Testing).
      - Collections stored in observable/state fields may come back as proxies or copies:
        compare contents, not identity.
   4. `"$UNITGEN" verify <test-file> --target <source-file>` and act on the verdict:

      | verdict | what to do |
      |---|---|
      | `ACCEPTED` | done; move on |
      | any other verdict on a file that was `ACCEPTED` before | it stops counting (coverage, report, mutate) until it passes again; its history is kept. Fix it or put the previous version back |
      | `COMPILE_ERROR` | fix the test using the compiler output |
      | `TEST_FAILURES` | re-read the production code; fix the *expectation*. If the code is really wrong, assert current behaviour and add `// UNITGEN-SUSPECT: <why>` (collected into the report automatically). If the feedback lists stubbed APIs, check whether the failing value comes from one before calling it a bug |
      | `FLAKY` | remove the source of nondeterminism (time, ordering, shared state, real dispatchers) |
      | `NO_GAIN` | the tests only hit already-covered lines; aim at the `!` lines in a fresh brief. `--allow-no-gain` only when a file is intentionally redundant, and say why in a note |
      | `NO_ASSERTIONS` / `NO_TESTS` | add real assertions / check suite & class naming |
      | `INFRA_ERROR` | environment problem (missing SDK, uninstalled ohpm packages, production code that does not compile, coverage that never arrives, ...): follow the fix the message names or report it and pick another target; don't edit tests to dodge it. It does not count as an attempt, and an already accepted file stays accepted (exit 1, not 2) |

   5. **Check assertion strength:** `"$UNITGEN" mutate <test-file>` changes the lines your test
      covers (operators, conditions, constants, returned strings, deleted calls and assignments)
      and re-runs the test. Coverage alone does not prove the assertions check anything.
      - Each *survivor* is printed with an id (`[12.2]`) and the changed line. Add an assertion
        that would fail for it, `verify`, then `mutate` again: survivors are re-checked first,
        and mutants already decided for the current test file are not run again.
      - Only a mutant with no observable effect is *equivalent* (a value nobody reads, a bound
        that cannot be reached, a slot overwritten before use). Exclude it with
        `"$UNITGEN" mutate <test-file> --equivalent <id>[,<id>...]` and explain why with
        `"$UNITGEN" note "..."`. A bare line number excludes every mutant on that line: avoid it.
      - A survivor whose effect is only visible through a stubbed/mocked system API is *not*
        equivalent: leave it, note it, and report the score as it is.
      - The gate (default `--min-score 80`) counts every mutant evaluated with the current test
        file; exit 2 means it failed (the test stays accepted). `--max` caps one run: about
        1–2 s per mutant with hvigor, 3–10 s with SwiftPM/Gradle, 10–25 s with Xcode, so use
        `--max 10` on Xcode. `--max` counts mutants that compiled; ones that do not compile are
        replaced by the next candidates. Re-run to evaluate more candidates.
      - Kills by a crash (exception, index out of range, hang) rather than an assertion are
        reported separately; mutants that do not compile are discarded. The source is always
        restored, also after a crash or forced kill (by the next command).
      - Re-verifying after strengthening shows "+0 vs. its previously accepted version" and is
        still ACCEPTED — new assertions don't need new lines.
   6. Give up on a target after ~4 attempts: `"$UNITGEN" reject <test-file> "<why>"` moves the
      file into `.unitgen/rejected/` (and unregisters it) so the build stays green.
   **Large single files** (one 1000+ line source, e.g. a whole library in one file): build the
   test file up in passes — one feature area per pass (parsing, accessors, operators, errors…),
   `verify` after each pass. Each pass must add coverage or it is `NO_GAIN`.
   Use `"$UNITGEN" note "<text>"` only for findings that are not already a `UNITGEN-SUSPECT` comment.
5. **Finish:** `"$UNITGEN" report` writes `.unitgen/REPORT.md`. Summarise it for the user with
   the numbers, not adjectives: coverage before → after per target (lines), tests added, the
   runner, mutation score with evaluated/candidate counts (a gate PASSED "on 19 of 71 candidates"
   is a sample: say so, or run mutate again until all are evaluated), crash-only kills, discarded and
   equivalent mutants (and why), suspected bugs with their evidence, and what could not be
   covered and why (system APIs, a device, a module that does not build, ...).

## Hard rules

- Never modify production code, build files or existing tests to make a generated test pass.
  The only exception is what unitgen itself manages (it registers a SwiftPM test target and
  ArkTS `List.test.ets` entries).
- Never weaken a test to get it accepted (`assertTrue(true)`, catching and ignoring
  assertion errors, asserting on mocks you just stubbed). The gate counts assertions, but
  you are responsible for them being meaningful.
- Expected values come from reading the code (or a trustworthy oracle such as an RFC
  test vector), never from "whatever the test printed".
- Run one unitgen command at a time per project (the lock enforces it): runs share build directories.
- Never commit, push or build the project yourself while a `mutate` is running: the target
  file is temporarily mutated.
- All CLI commands acquire a project lock, including recovery. Never remove `.unitgen/run.lock`
  by hand: after a forced kill the next command checks that the old command and the processes
  it started are gone (stopping leftovers it can identify), takes the lock over and restores
  interrupted mutations. If it says builds are still running, stop them with the command it prints.
- Do not add dependencies. Use only the libraries the brief lists or the example tests import.

## Platform notes

Read the matching reference before writing the first test for a platform:

- iOS / Swift: [references/ios.md](references/ios.md)
- Android / Kotlin / Java: [references/android.md](references/android.md)
- HarmonyOS / ArkTS: [references/harmony.md](references/harmony.md)

## Non-interactive mode

`"$UNITGEN" generate --llm anthropic|claude|cmd:<shell> --limit 5` runs the same
brief → write → verify → mutate → feedback loop without an agent (ANTHROPIC_API_KEY for `anthropic`,
`claude` on PATH for `claude`). Prefer the interactive workflow above when you are the agent:
you can read more of the codebase than a single brief contains.
