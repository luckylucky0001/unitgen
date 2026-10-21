# HarmonyOS / ArkTS

## How unitgen runs it

- Project = `build-profile.json5` + `oh-package.json5`; modules from `build-profile.json5`
  (`modules[].srcPath`) that have `src/main/ets`.
- Test files: `<module>/src/test/<File>.unitgen.test.ets` (local unit tests, hypium).
  unitgen also registers each file in `src/test/List.test.ets` so hvigor runs it.
- Runner:
  - **hvigor** when `hvigorw` is on PATH or in the project (DevEco toolchain). Override the
    arguments with `UNITGEN_HVIGOR_TEST_ARGS` if your toolchain differs.
  - **shim** otherwise: TypeScript transpiles `.ets` on the fly, `@ohos/hypium` is replaced
    by a compatible implementation, every other `@kit.*`/`@ohos.*` import becomes an inert
    stub, and c8 measures coverage against the original `.ets` lines. Faithful for pure
    logic only. Files importing platform kits are ranked as `platform` (low priority).
- The shim does not run the ArkTS compiler, so generated tests are linted against the most
  common ArkTS restrictions; violations come back as `COMPILE_ERROR`. Before shipping,
  run the tests once in DevEco / hvigor.

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
        expect(parseQuery(c.input).get('a')).message(c.input).assertEqual(c.expected);
      }
    });
  });
}
```

- `export default function <camelName>()` wrapping one `describe('<SuiteName>', …)`.
- `it(name, 0, fn)` — the middle argument is the test attribute; always `0`.
- Matchers: `assertEqual` (strict ===), `assertDeepEquals`, `assertTrue/False`, `assertNull`,
  `assertUndefined`, `assertContain`, `assertClose(v, eps)`, `assertLarger/Less[OrEqual]`,
  `assertThrowError('exact message')` on a *function*, `.not()`, `.message('ctx')`,
  `await expect(promise).assertPromiseIsResolvedWith(v)` / `assertPromiseIsRejected()`.
- ArkTS restrictions: no `any`/`unknown`, object literals need a declared interface/class
  type, no destructuring, no `var`, no function expressions, no `for…in`, no `obj['key']`
  on non-arrays, no `delete`, no object spread, typed empty arrays (`const xs: number[] = []`).
- Only test what doesn't depend on platform API results under the shim (they return stubs).
