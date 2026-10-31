# unitgen

[中文](README.md) · English

Backfills unit tests for **iOS (Swift), Android (Kotlin/Java) and HarmonyOS (ArkTS)** projects: a
command-line tool plus a Skill for AI coding agents (Claude Code, TRAE).

The AI writes the tests. unitgen decides **what to test**: it ranks files by uncovered logic and
gives the context needed to write a test. It also decides **which tests to keep**: a test file is
accepted only if it compiles, passes, passes again on a re-run, contains assertions and raises
line coverage. Mutation testing then checks that its assertions actually catch broken code.

```
doctor    detect the project type, check the toolchain
baseline  run the project's own tests, record coverage before
targets   rank source files by uncovered logic lines
brief     context for one source file (source with uncovered lines marked, conventions, test doubles, similar tests)
(the AI writes the test)
verify    gate: compiles -> all pass -> re-run not flaky -> has assertions -> new coverage > 0
mutate    mutation testing: change the code under test, see whether the test notices
report    .unitgen/REPORT.md
```

The approach follows Meta's TestGen-LLM / ACH and Qodo Cover-Agent: generating tests is easy,
filtering them is the hard part. Design notes and a comparison with existing tools:
[docs/DESIGN.md](docs/DESIGN.md) (Chinese).

## Validation

Run end to end (write tests → verify → mutate → report) on 20 open-source projects with the real
toolchains: DevEco Studio 26, Xcode 16.4 and the Android SDK (Gradle). Nine of them were done from
scratch by an AI that had read only this README and the Skill. Some results:

| Project | Platform | Target file | Coverage | Mutation score |
|---|---|---|---|---|
| [SwiftyJSON](https://github.com/SwiftyJSON/SwiftyJSON) 22.9k★ | iOS · SwiftPM | `SwiftyJSON.swift` | 88% → 98% | 97% |
| [Kingfisher](https://github.com/onevcat/Kingfisher) 24.4k★ | iOS · Xcode + Simulator | `ImageFormat.swift` | 44% → 98% | 100% |
| [SwiftDate](https://github.com/malcommac/SwiftDate) 7.7k★ | iOS · SwiftPM | `DateComponents+Extras.swift` | 61% → 100% | 100% |
| [harmony-utils](https://github.com/787107497/harmony-utils) 122★ | HarmonyOS · hvigor | `DateHelper.ets` | 0% → 98% | 100% |
| [LinysBrowser_NEXT](https://github.com/awaLiny2333/LinysBrowser_NEXT) 292★ | HarmonyOS · hvigor | `url-ext.ets` | 0% → 100% | 97% |
| [DSBridge-HarmonyOS](https://github.com/751496032/DSBridge-HarmonyOS) 182★ | HarmonyOS · hvigor | `BaseBridge.ts` | 0% → 94% | 88% |
| [architecture-samples](https://github.com/android/architecture-samples) 45.9k★ | Android · Gradle | `TaskNetworkDataSource.kt` | 0% → 100% | 100% |
| [Pokedex](https://github.com/skydoves/Pokedex) 8.4k★ | Android · Gradle (multi-module) | `DetailRepositoryImpl.kt` | 89% → 100% | 100% |
| [ObjectMapper](https://github.com/tristanhimmelman/ObjectMapper) 9.1k★ | iOS · Xcode + Simulator | `Map.swift` | 75% → 98% | 100% |

All 35 target files, the method, suspected bugs found in these projects, and the unitgen issues
found and fixed along the way: [docs/VALIDATION.md](docs/VALIDATION.md) (Chinese).

## Install

**Prerequisites**, only for the platforms you use:

| Platform | Needs |
|---|---|
| all | Node.js ≥ 22.18 (`node -v`). Without one on PATH, the Node bundled with DevEco Studio is used |
| HarmonyOS | Recommended: [DevEco Studio](https://developer.huawei.com/consumer/cn/deveco-studio/), found automatically. unitgen then runs local unit tests with the real hvigor, ArkTS compiler and Previewer runtime; no emulator or device needed. The project must declare `@ohos/hypium` in devDependencies (≥ 1.0.19 for coverage) and have run `ohpm install`. Without DevEco, a built-in Node shim runs pure-logic code only |
| iOS | Xcode. SwiftPM packages run with `swift test`; `.xcodeproj` projects on an iOS Simulator. With only the Command Line Tools, only Swift Testing tests in Swift packages run |
| Android | JDK 17+ (`JAVA_HOME`) and the Android SDK (`ANDROID_HOME`, or the project's `local.properties`). On Apple silicon use an arm64 JDK (e.g. `brew install openjdk@17`): an x86_64 JDK under Rosetta builds slowly |

**Install unitgen**:

```bash
git clone https://github.com/luckylucky0001/unitgen.git ~/unitgen
cd ~/unitgen && npm ci
mkdir -p ~/.local/bin && ln -sfn ~/unitgen/bin/unitgen ~/.local/bin/unitgen
export PATH="$HOME/.local/bin:$PATH"     # add to ~/.zshrc or ~/.bashrc to keep it
unitgen --help
```

Or call `~/unitgen/bin/unitgen` directly. unitgen runs its TypeScript sources directly (no build
step): keep the checkout in place.

Windows (cmd or PowerShell): after `git clone`, run `npm ci` in the checkout and use `bin\unitgen.cmd`
(or add `bin` to PATH and call `unitgen`). On Windows `UNITGEN_ENV` is a `.cmd` file that sets the
toolchain paths with `set JAVA_HOME=...` and the like.

**Check**: run `unitgen doctor` in your project. It names the project type, which runner it uses
and why, and how to fix what is missing (for HarmonyOS, for example, the full path of DevEco's
bundled ohpm).

## Use

### 1. In Claude Code (recommended)

Install the Skill:

```bash
mkdir -p ~/.claude/skills && ln -sfn ~/unitgen/skills/unitgen ~/.claude/skills/unitgen
```

Then ask Claude Code in your project: "use unitgen to add unit tests to this project", or name
files: "use unitgen to add tests for `src/utils/url.ets`". The [Skill](skills/unitgen/SKILL.md)
defines the workflow, what to do for each verdict, and hard rules: never change production code
or build files, never weaken assertions, take expected values from reading the code. It ends with
coverage before and after, mutation scores, suspected bugs and what could not be covered.

### 2. In TRAE / TRAE CN

TRAE writes the tests and calls unitgen to check them; no Claude CLI or API key is needed. The
installer (macOS/Linux) installs the Skill with the files it references and links the CLI into
`~/.local/bin`:

```bash
cd ~/unitgen && npm ci
sh scripts/install-trae.sh --project /absolute/path/to/your-project   # into <project>/.trae/skills/unitgen/
sh scripts/install-trae.sh --global                                   # or as a TRAE CN global skill (~/.trae-cn/skills/unitgen/)
```

Make sure TRAE's terminal PATH contains `~/.local/bin` (`UNITGEN_BIN_DIR` picks another
directory), or give the CLI's absolute path. Toolchain paths can live in an environment file
outside the repository, passed with every command:

```bash
cp scripts/unitgen-env.example.sh ~/unitgen-env.sh    # fill in Node, JAVA_HOME, ANDROID_HOME; do not commit it
UNITGEN_ENV=~/unitgen-env.sh unitgen doctor -C /absolute/path/to/your-project
```

Each TRAE tool call is a separate process, so an `export` from an earlier command does not carry
over: pass `UNITGEN_ENV` every time. On Windows, copy the whole `skills/unitgen/` directory by
hand; the installer has not been tested there.

### 3. From the command line

```bash
cd <your project>                  # any subdirectory works too: unitgen finds the project root
unitgen doctor
unitgen baseline                   # once; again after big code changes
unitgen targets                    # files most worth testing first
unitgen brief <source>             # give this to your model, or follow it yourself
# ... write the test at the path the brief names ...
unitgen verify <test-file>         # --target <source> is inferred from the file name
unitgen mutate <test-file>         # lists mutants the test did not notice (survivors)
unitgen report                     # writes .unitgen/REPORT.md
```

`verify` output:

```
verdict: ACCEPTED  (library/src/test/countdown.unitgen.test.ets, 4s)
tests: 2 run, 0 failed
target coverage now: 10/10 lines (100%)
lines covered only by this file: 10 (in the target: 10)
```

`mutate` output (excerpt):

```
  mutant 3 (budget 20, 8 still to decide of 11) [4.1] line 4 (- -> +): killed (no result within 20s: the mutant hangs)
  mutant 4 (budget 20, 7 still to decide of 11) [5.1] line 5 (+ -> -): killed
mutation score: 100%  (killed 11, of which 2 only by a crash, not an assertion, survived 0, did not compile 0)
all 11 candidate mutants evaluated with the current test file (11 run now)
gate: PASSED (minimum 80%)
```

### 4. Unattended

Without an agent: unitgen calls a model itself and runs the same brief → write → verify → mutate →
feedback loop.

```bash
unitgen generate --llm claude --limit 5       # needs the claude CLI on PATH
unitgen generate --llm anthropic --limit 5    # needs ANTHROPIC_API_KEY
unitgen generate --llm 'cmd:<command that reads the prompt on stdin and prints code>'
```

Files still failing after the last attempt are moved to `.unitgen/rejected/`, and the command
exits with 2.

## Verify verdicts

| Verdict | Meaning | Next |
|---|---|---|
| `ACCEPTED` | passed every check; counts toward coverage | run `mutate` |
| `COMPILE_ERROR` | the test does not compile; compiler output attached | fix the test |
| `TEST_FAILURES` | tests failed; assertion diffs attached, and mocked system APIs named when involved | re-read the code and fix the expectation; if the code is wrong, assert current behaviour and add `// UNITGEN-SUSPECT: why` |
| `FLAKY` | passed once, failed on the re-run | remove time, ordering, shared state |
| `NO_GAIN` | everything passes but no new line is covered | target the lines marked `!` in the brief |
| `NO_ASSERTIONS` / `NO_TESTS` | no assertions / no test ran | add assertions; check the class name against the brief |
| `INFRA_ERROR` | an environment problem, not the test (missing SDK, packages not installed, production code that does not compile, coverage that never arrives, ...); not counted as an attempt, accepted files are unaffected | fix what it names, or pick another target |

When an accepted file fails a later verify, it stops counting (coverage, report, mutate) until it
passes again; its history is kept.

## Mutation testing

`mutate` changes one covered line of the code under test at a time (negated conditions, flipped
comparisons, changed constants, emptied returned strings, deleted calls or assignments, ...) and
runs the test file:

- **killed**: a test failed, so the assertions notice the change. Kills only by an exception, an
  out-of-range access or a hang are counted separately as "only by a crash".
- **survived**: the code changed and the tests still pass. The output gives the mutant's id (such
  as `[12.2]`) and the changed line. Add an assertion that fails for it, `verify`, `mutate` again.
- **equivalent**: the change cannot affect behaviour (for example an initial value that is always
  overwritten). Exclude it with `unitgen mutate <test-file> --equivalent 12.2` and explain why with
  `unitgen note "..."`. A change visible only through a mocked API is not equivalent.
- **score** = killed / (killed + survived). Mutants that do not compile are discarded and not
  scored. The gate requires 80% by default (`--min-score`).
- Each run evaluates at most `--max` mutants (default 15). Mutants already decided are not run
  again until the test file changes, so repeated runs work through all candidates. Until all are
  evaluated, the gate says so ("on 19 of 71 candidates"): the score is a sample; with
  `--require-all` a sample does not pass. The report also shows the last complete result.

Time per mutant: about 1–3 s with hvigor, 3–10 s with SwiftPM/Gradle, 20–40 s with Xcode (use
`--max 10`). A mutant that loops forever counts as killed only when its timeout expires (adapted to
how long the finished mutants took, at least 20 s), so loop-heavy code makes a run slower.

## Platforms

**HarmonyOS**
- The default runner is hvigor: DevEco's local unit-test flow in the Previewer runtime, with the
  real ArkTS compiler and hvigor's `coverageReport.json`.
- When hvigor cannot run, `doctor` says why and the Node shim is used instead
  (`UNITGEN_HARMONY_MODE=shim` forces it). Usual reasons: `ohpm install` not run, `@ohos/hypium`
  not declared, `compileSdkVersion` not matching the installed SDK, a pinned hvigor plugin without
  `~/.npmrc`.
- The shim transpiles `.ets` with TypeScript and stubs every `@kit.*`/`@ohos.*` API. It does not
  run the ArkTS compiler and is reliable for pure logic only.
- Most system APIs are mocks in the Previewer too. The brief marks uncovered lines that call them
  with `!~`: test the logic around them, never their return values.
- The runner is recorded at baseline; verify and mutate must use the same one.
- A test or mutant that never returns no longer wedges anything: unitgen stops this project's
  hvigor daemon and its Previewer (other projects' daemons are untouched).

**iOS**
- `Package.swift` alone → SwiftPM; `.xcodeproj`/`.xcworkspace` alone → Xcode on an iOS Simulator.
  When both exist, SwiftPM is the default; pass `--adapter xcode` on every command to use the
  Simulator (for UIKit code, for example).
- The brief names the test framework. Packages with `swift-tools-version` < 6.0 need XCTest: a
  plain `swift test` in their CI never runs Swift Testing. The same applies to Xcode targets older
  than iOS 13 / macOS 10.15. Otherwise Swift Testing is used.
- Xcode builds go to `.unitgen/DerivedData`, so an open Xcode is not disturbed. unitgen's own
  xcodebuild runs turn on `ENABLE_TESTABILITY` (needed for `@testable import`) and turn off legacy
  gcov coverage settings (they zero llvm coverage). This applies to those runs only; the project is
  not changed.

**Android**
- Discovers each module's unit-test task (flavors included) and injects a JaCoCo init script with
  `-I`; no build file is changed.
- Code of one module exercised by another module's tests counts as covered. When a module does not
  build (for example a dependency needs a newer compileSdk), the baseline still measures the
  others, names that module with Gradle's reason, and `targets` lists its files last.
- JVM local unit tests (`src/test`) only. The first build downloads Gradle dependencies. For a
  module that declares no test framework (no JUnit / kotlin-test), the brief says to pick another.

## What unitgen changes in your project

| | Adds | Modifies |
|---|---|---|
| all | `.unitgen/` (state, logs, REPORT.md; it has its own `.gitignore`); add it to the project's `.gitignore` | — |
| HarmonyOS | `<module>/src/test/<File>.unitgen.test.ets`; hvigor's own `<module>/.test/` output (most projects already ignore `**/.test`) | `<module>/src/test/List.test.ets`, which registers generated tests so DevEco runs them too |
| iOS SwiftPM | `Tests/<Target>UnitGenTests/` | a marked block `// unitgen:begin … // unitgen:end` at the end of `Package.swift` (a separate test target) |
| iOS Xcode | `<Class>UnitGenTests.swift` in the existing test target | registration in `project.pbxproj` when needed (original kept in `.unitgen/`) |
| Android | `src/test/<kotlin\|java>/<package>/<Class>UnitGenTest.kt` | — |

Production code, existing tests and build configuration are never changed. During `mutate` the
source under test is changed temporarily and always restored, also after a forced kill (by the
next command).

**Undo**: `unitgen reject <test-file> "why"` moves a generated test to `.unitgen/rejected/` and
unregisters it. A generated test deleted by hand is removed from `List.test.ets` on the next run.
Removing the SwiftPM block and `.unitgen/` restores the original state.

## Troubleshooting

**`doctor` says HarmonyOS uses the shim, not hvigor.** Fix what the `runner:` line names. Most
often `ohpm install` has not run in the project root; doctor prints the full path of DevEco's
bundled ohpm.

**The baseline fails because existing tests fail.** They are listed. If they are unrelated,
`unitgen baseline --allow-failing` keeps a baseline from the passing ones.

**verify keeps returning `INFRA_ERROR`.** Read the reason. Common ones: production code that does
not compile, uninstalled ohpm packages, hypium older than 1.0.19 (coverage never arrives), or
hvigor's coverage data corrupted by an interrupted build (unitgen removes the module's `.test/` so
it is rebuilt; verify again). None of these is the test's fault; do not change the test to dodge
them.

**`project locked by a running unitgen command`.** One unitgen command per project at a time: wait
for it or stop it as the message says. If the previous command was killed, the next one checks
that, takes over and restores changed files; only builds that are still running produce a message,
with the exact kill command. Never delete `.unitgen/run.lock` by hand.

**`mutate` is slow.** Limit each run with `--max` and run it several times; `--max 10` on Xcode.

**A compile error shows only warnings.** Fixed: when hvigor's output is cut off, unitgen reads
hvigor's own `.hvigor/outputs/build-logs/build.log`. The full build output is always in
`.unitgen/logs/`; every command ends with the log path.

**The project directory was moved or renamed.** No effect: `.unitgen` stores paths relative to the
project root.

## Command reference

```
unitgen <command> [options]

doctor                     detect the project type, check the toolchain
modules                    list modules/targets and where generated tests go
baseline                   existing tests + coverage        --allow-failing
targets                    rank files by uncovered logic    --limit <n> (20) --all-kinds
brief <source>             context for writing the test     --out <file> --feedback <file>
verify <test-file>         the gate                         --target <source> --reruns <n> (1) --allow-no-gain --quarantine
mutate <test-file>         mutation testing                 --target <source> --max <n> (15) --min-score <percent> (80) --require-all
                                                            --equivalent <id|line>[,...] (repeatable)
generate                   unattended loop                  --llm anthropic|claude|cmd:<sh> --model <id> --limit <n> (5)
                                                            --attempts <n> (3) --max <n> --min-score <percent>
reject <test-file> [why]   quarantine a generated test
note <text>                attach a note to the report
report                     write .unitgen/REPORT.md
status                     baseline, accepted and rejected counts

Common: -C <dir> (project root; default: found upwards from the current directory)
        --adapter harmony|gradle|swiftpm|xcode  --module <name>  --json (results on stdout, progress on stderr)
```

**Exit codes**: 0 passed (or mutation not applicable); 1 command, argument or environment error;
2 quality gate failed; 130 cancelled.

**Environment variables**:

| Variable | Effect |
|---|---|
| `UNITGEN_HARMONY_MODE=hvigor\|shim` | force the HarmonyOS runner |
| `UNITGEN_HVIGOR_DAEMON=0` | cold hvigor builds instead of the daemon (about 3x slower) |
| `DEVECO_STUDIO_HOME` / `DEVECO_SDK_HOME` | where DevEco is, when not in `/Applications/DevEco-Studio.app` |
| `UNITGEN_QUIET=1` | no build progress in the terminal (logs are still written) |
| `UNITGEN_VERBOSE=1` | print the commands run |
| `UNITGEN_ENV=<env.sh>` | toolchain environment file applied to the unitgen process only (default: `unitgen-env/env.sh` next to the unitgen checkout, if it exists) |

Build progress and diagnostics go to stderr, `--json` results to stdout: do not merge them before
parsing. When piping output, use a shell with `pipefail` to keep unitgen's exit code.

## Known limits

- **HarmonyOS**: local unit tests in the Previewer runtime, where most system APIs are mocks.
  Device-dependent logic, `ohosTest` (instrument tests) and UI tests are out of scope. The shim is
  reliable for pure logic only. Private methods of structs and code a module does not export
  cannot be tested; the brief warns about them.
- **iOS**: UI tests and devices are out of scope. Each xcodebuild run takes tens of seconds. With
  only the Command Line Tools, a project's existing XCTest tests cannot run (0% baseline).
- **Android**: JVM local unit tests only; without Robolectric or `isReturnDefaultValues`,
  `android.util.Log` and similar calls throw. APK installation, device APIs and Compose UI tests are
  out of scope.
- **Windows**: CI runs all unit tests on windows-latest and, through `bin\unitgen.cmd`, doctor,
  baseline, verify, mutate and report end to end on a Gradle/Java project. The HarmonyOS Node shim is
  also run end to end on Windows; the hvigor path (DevEco for Windows) was not tested, and iOS needs
  macOS anyway. The TRAE installer is a shell script: on Windows copy
  the Skill directory by hand.

## Development

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # node --test
```

`UNITGEN_VERBOSE=1` prints the commands run; `UNITGEN_KEEP_COV=1` keeps SwiftPM's coverage JSON
and the HarmonyOS shim's transpiled output and raw V8 data. Implementation notes:
[docs/DESIGN.md](docs/DESIGN.md).
