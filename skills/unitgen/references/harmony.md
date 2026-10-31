# HarmonyOS / ArkTS

## How unitgen runs it

- Project = `build-profile.json5` (or a committed `build-profile.template.json5` when the real
  one is git-ignored) + `oh-package.json5`; modules from `modules[].srcPath` that have `src/main/ets`.
- Test files: `<module>/src/test/<File>.unitgen.test.ets` (local unit tests, hypium). unitgen
  registers each accepted file in `src/test/List.test.ets` so DevEco/hvigor runs it too.
- Two runners; `unitgen doctor` says which one is used and why:
  - **hvigor** (default when it can work): DevEco Studio / Command Line Tools are found
    automatically (`/Applications/DevEco-Studio.app`, `DEVECO_STUDIO_HOME`). Local unit tests
    run in the Previewer runtime with the real ArkTS compiler and hvigor's coverage report.
    Requirements: `@ohos/hypium` in devDependencies, `ohpm install` done, no
    `compileSdkVersion` other than the installed SDK's API level. Each verify takes ~5–20 s;
    unitgen points `List.test.ets` at the file under test while it runs (restored afterwards,
    also after a crash), so a broken existing test elsewhere does not block you. hvigor writes
    local-test output to `<module>/.test/` (DevEco's own location; most projects git-ignore `**/.test`).
  - **Node shim** (`UNITGEN_HARMONY_MODE=shim`, or automatically when hvigor cannot run):
    TypeScript transpiles `.ets`, `@ohos/hypium` is replaced by a compatible implementation,
    every `@kit.*`/`@ohos.*` import is an inert stub, ArkUI `struct`/`@Builder` declarations are
    blanked out (helpers next to them still load), coverage comes from V8. Fast (< 1 s), faithful
    for pure logic only, and it does not run the ArkTS compiler: generated tests are linted
    against the common ArkTS restrictions instead.
- Baseline and verify must use the same runner; switching (`UNITGEN_HARMONY_MODE`) requires
  `unitgen baseline` again, then `verify` of the files measured with the other runner.
- Environment problems come back as `INFRA_ERROR`, never as a test problem: production code
  that does not compile, uninstalled ohpm packages, ArkTS syntax the shim cannot parse,
  missing coverage (see below). Don't edit the test to dodge them — pick another target.

### Known environment pitfalls (all reported by doctor / baseline)

- `@ohos/hypium` older than 1.0.19 delivers coverage through `printSync`, which the Previewer
  drops: tests pass, coverage is 0 → `INFRA_ERROR`. Upgrade the devDependency and `ohpm install`.
- A module that imports a package its own `oh-package.json5` does not declare (only the root
  does) does not build under hvigor: the baseline skips it and names the package; `targets`
  lists its files last.
- `hvigor-config.json5` pinning a plugin version needs `~/.npmrc` (npm download); without it
  unitgen uses the shim and says so.
- A test or mutant that never returns wedges the hvigor daemon. unitgen stops this project's
  daemon and its Previewer after a timeout or cancellation (and before a run if one is left over),
  so you never need to kill them yourself; `UNITGEN_HVIGOR_DAEMON=0` uses cold builds instead.

## Writing the test

```ts
import { describe, it, expect } from '@ohos/hypium';
import { parseQuery } from '../main/ets/utils/url';

interface Case {
  input: string;
  expected: string;
}

const CASES: Case[] = [
  { input: 'a=1', expected: '1' },
];

export default function urlUnitGenTest() {
  describe('UrlUnitGenTest', () => {
    it('parsesSingleParameter', 0, () => {
      for (const c of CASES) {
        expect(parseQuery(c.input).get('a')).assertEqual(c.expected);
      }
    });
  });
}
```

- `export default function <camelName>()` wrapping one `describe('<SuiteName>', …)`.
- `it(name, 0, fn)` — the middle argument is the test attribute; always `0`. Async tests
  time out after 15 s, like hypium's default.
- Matchers: `assertEqual` (strict ===), `assertDeepEquals`, `assertTrue/False`, `assertNull`,
  `assertUndefined`, `assertContain`, `assertClose(v, eps)`, `assertLarger/Less[OrEqual]`,
  `assertThrowError('exact message')` on a *function*, `.not()`,
  `await expect(promise).assertPromiseIsResolvedWith(v)` / `assertPromiseIsRejected()`.
  `.message('ctx')` exists only in hypium ≥ 1.0.19 — the brief says whether you may use it.
- `expect()` takes a value: never pass a call that returns `void`; call it, then assert on its effects.
- Only import what the module exports; module-private code is unreachable (the brief warns
  when a file exports nothing).
- ArkTS restrictions: no `any`/`unknown`, object literals need a declared interface/class
  type, no destructuring, no `var`, no function expressions, no `for…in`, `obj['key']` only
  on `Record` types and arrays, no `delete`, no object spread, typed empty arrays
  (`const xs: number[] = []`).
- State management: arrays/Maps/Sets/Dates assigned to `@Trace` (V2) fields are stored as
  observable proxies — compare by content (`assertDeepEquals`, length, elements), never by
  identity (`===`).
- System APIs are stubs (shim) or mostly mocks (Previewer): test the logic around them, never
  what they return. That includes objects they hand back (`const mac = cryptoFramework.createMac()`,
  then `mac.doFinal()`) and ArkUI dialogs (`AlertDialog.show`). The brief marks such uncovered
  lines `!~`, and `TEST_FAILURES` names the mocked APIs the code under test uses: a failing value
  that comes from one (an HMAC of `000000`, an empty file) is the mock, not a bug.
- The Previewer runtime iterates strings by UTF-16 code unit in `Array.from(str)`
  (`Array.from('💩').length === 2`), unlike Node. Expected values for non-BMP text must come from
  the spec/oracle; if the code under test relies on code-point iteration, that is a finding
  (`UNITGEN-SUSPECT`), not a test mistake.
