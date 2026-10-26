# Android / Kotlin / Java (Gradle)

## How unitgen runs it

- Modules come from `settings.gradle(.kts)`; the unit-test task per module is discovered
  from `gradlew tasks --all` (e.g. `testDemoDebugUnitTest` for flavored modules, `test`
  for JVM modules) and cached in `.unitgen/gradle-test-tasks.json`.
- Coverage: an init script (`-I`) applies JaCoCo to every module and adds
  `unitgenJacocoReport`; no build file is touched. Runs use `--no-configuration-cache` and
  disable isolated projects for compatibility, and force `--rerun` for generated tests.
- Test files: `<module>/src/test/kotlin/<package path>/<Class>UnitGenTest.kt` (Java modules:
  `src/test/java`). `verify` runs only that class via `--tests <fqn>`, so the package line
  must match the directory.
- Test-helper modules (`:core:testing`, `*-test`), benchmarks, Hilt modules, Room
  `@Dao`/`@Database` declarations and Compose UI files are ranked low or skipped.

## Writing the test

- Read the brief's "Existing test doubles" section first. Projects like Now in Android
  ship fakes (`TestNewsResourceDao`, `InMemoryDataStore`, `TestDispatcherRule`); using them
  beats mocking and matches the codebase style.
- Coroutines: `runTest { }`; for classes taking a `CoroutineDispatcher`, inject the
  test scheduler's dispatcher (`StandardTestDispatcher()` / `UnconfinedTestDispatcher()`)
  and use the same `TestScope`.
- Flows: `flow.first()` for a snapshot; Turbine `flow.test { awaitItem() }` when the module
  has it. `StateFlow` in ViewModels needs an active collector (backgroundScope) before
  values update when `SharingStarted.WhileSubscribed` is used.
- `android.util.Log`, `TextUtils`, etc. throw "Method … not mocked" in local tests unless
  the module sets `unitTests.isReturnDefaultValues = true` or the test uses Robolectric.
  Don't drive code paths that only log; note them as uncovered instead.
- Protobuf / DataStore: build messages with the generated DSL (`userPreferences { … }`)
  or `toBuilder()`; proto3 scalars default to `0`/`false`/`""`, not Kotlin defaults.
- `internal` classes are visible from tests in the same module.
- Use the assertion library the module's existing tests use (kotlin.test, Truth, JUnit).
- Before asserting on DTOs, read their definitions and mapping functions: a network model
  may use different property names or an enum instead of the domain model's boolean.
- Inspect existing fakes for TODO/unsupported methods. Use a test-local implementation for
  missing Flow behaviour. Assert persistence/synchronization side effects on the collaborator,
  not only that the repository's local data changed.
- This adapter validates JVM local tests, not APK installation, device APIs, or Compose UI.
