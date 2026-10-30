// Minimal @ohos/hypium-compatible test API for running ArkTS logic tests on Node.
// Mirrors the documented surface: describe/it/beforeAll/beforeEach/afterEach/afterAll/expect,
// TestType/Size/Level, and the assert* matchers (including .not() and promise matchers).
"use strict";
const util = require("node:util");

const root = { name: "", suites: [], tests: [], hooks: { beforeAll: [], beforeEach: [], afterEach: [], afterAll: [] }, parent: null };
let current = root;
// Test file whose suites are being registered (set by the runner), reported with each result.
let currentFile;
function setFile(f) { currentFile = f; }

function describe(name, fn) {
  const s = { name, suites: [], tests: [], hooks: { beforeAll: [], beforeEach: [], afterEach: [], afterAll: [] }, parent: current };
  current.suites.push(s);
  const prev = current;
  current = s;
  try { fn(); } finally { current = prev; }
}
function it(name, attrOrFn, maybeFn) {
  const fn = typeof attrOrFn === "function" ? attrOrFn : maybeFn;
  current.tests.push({ name, fn, file: currentFile });
}
// Like hypium's default, an async test (or hook) that never settles fails after this long instead of
// letting Node exit silently with an empty event loop.
const TIMEOUT_MS = Number(process.env.UNITGEN_HYPIUM_TIMEOUT_MS || 5000);
// Keeps the event loop alive while a test awaits a promise nothing else references.
function withTimeout(promise, what) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} did not finish within ${TIMEOUT_MS}ms (a promise that never settles?)`)), TIMEOUT_MS); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}
// Stubbed system modules hit while the current test ran (set by the runner through stub.cjs).
const stubHits = { current: new Set() };
const xit = () => {};
function beforeAll(fn) { current.hooks.beforeAll.push(fn); }
function beforeEach(fn) { current.hooks.beforeEach.push(fn); }
function afterEach(fn) { current.hooks.afterEach.push(fn); }
function afterAll(fn) { current.hooks.afterAll.push(fn); }

class AssertionError extends Error {
  constructor(msg) { super(msg); this.name = "AssertionError"; }
}
const fmt = (v) => util.inspect(v, { depth: 4, breakLength: 120 });

function deepEq(a, b) {
  return util.isDeepStrictEqual(a, b);
}

function expect(actual) {
  let negate = false;
  let custom = "";
  const check = (ok, msg) => {
    if (negate ? ok : !ok) throw new AssertionError((custom ? custom + ": " : "") + (negate ? "NOT " : "") + msg);
  };
  const typeName = (v) => (v === null ? "null" : Array.isArray(v) ? "Array" : typeof v === "object" ? (v.constructor && v.constructor.name) || "Object" : (typeof v)[0].toUpperCase() + (typeof v).slice(1));
  const m = {
    not() { negate = !negate; return m; },
    message(msg) { custom = msg; return m; },
    assertEqual(e) { check(actual === e || (Number.isNaN(actual) && Number.isNaN(e)), `expected ${fmt(actual)} to equal ${fmt(e)}`); },
    assertDeepEquals(e) { check(deepEq(actual, e), `expected ${fmt(actual)} to deep-equal ${fmt(e)}`); },
    assertTrue() { check(actual === true, `expected ${fmt(actual)} to be true`); },
    assertFalse() { check(actual === false, `expected ${fmt(actual)} to be false`); },
    assertNull() { check(actual === null, `expected ${fmt(actual)} to be null`); },
    assertUndefined() { check(actual === undefined, `expected ${fmt(actual)} to be undefined`); },
    assertNaN() { check(Number.isNaN(actual), `expected ${fmt(actual)} to be NaN`); },
    assertPosUnlimited() { check(actual === Infinity, `expected ${fmt(actual)} to be +Infinity`); },
    assertNegUnlimited() { check(actual === -Infinity, `expected ${fmt(actual)} to be -Infinity`); },
    assertClose(e, precision) { check(Math.abs(actual - e) <= (precision === undefined ? 1e-6 : precision), `expected ${fmt(actual)} to be within ${precision} of ${fmt(e)}`); },
    assertContain(e) {
      const ok = typeof actual === "string" ? actual.includes(e) : Array.isArray(actual) ? actual.some((x) => x === e || deepEq(x, e)) : false;
      check(ok, `expected ${fmt(actual)} to contain ${fmt(e)}`);
    },
    assertLarger(e) { check(actual > e, `expected ${fmt(actual)} > ${fmt(e)}`); },
    assertLargerOrEqual(e) { check(actual >= e, `expected ${fmt(actual)} >= ${fmt(e)}`); },
    assertLess(e) { check(actual < e, `expected ${fmt(actual)} < ${fmt(e)}`); },
    assertLessOrEqual(e) { check(actual <= e, `expected ${fmt(actual)} <= ${fmt(e)}`); },
    assertInstanceOf(name) { check(typeName(actual) === name || (actual && actual.constructor && actual.constructor.name === name), `expected ${fmt(actual)} to be instance of ${name} (got ${typeName(actual)})`); },
    assertFail() { check(false, "assertFail called"); },
    assertThrowError(e) {
      let thrown;
      try { actual(); } catch (err) { thrown = err; }
      const ok = thrown !== undefined && (e === undefined || (typeof e === "string" ? String(thrown && thrown.message !== undefined ? thrown.message : thrown) === e : thrown instanceof e));
      check(ok, thrown === undefined ? "expected function to throw" : `expected error ${fmt(e)}, got ${fmt(thrown && thrown.message !== undefined ? thrown.message : thrown)}`);
    },
    async assertPromiseIsResolved() { let ok = true; try { await actual; } catch { ok = false; } check(ok, "expected promise to resolve"); },
    async assertPromiseIsResolvedWith(e) { let v, ok = true; try { v = await actual; } catch { ok = false; } check(ok && deepEq(v, e), `expected promise to resolve with ${fmt(e)}, got ${fmt(v)}`); },
    async assertPromiseIsRejected() { let ok = false; try { await actual; } catch { ok = true; } check(ok, "expected promise to reject"); },
    async assertPromiseIsRejectedWith(e) { let r, ok = false; try { await actual; } catch (err) { ok = true; r = err; } check(ok && deepEq(r, e), `expected rejection with ${fmt(e)}, got ${fmt(r)}`); },
    async assertPromiseIsRejectedWithError(type, msg) { let r, ok = false; try { await actual; } catch (err) { ok = true; r = err; } check(ok && (!type || r instanceof type || (r && r.name === (type && type.name))) && (msg === undefined || (r && r.message === msg)), `expected rejection with ${type && type.name}(${msg}), got ${fmt(r)}`); },
    async assertPromiseIsPending() { const tag = {}; const v = await Promise.race([actual, Promise.resolve(tag)]); check(v === tag, "expected promise to be pending"); },
  };
  return m;
}

const TestType = { FUNCTION: 1, PERFORMANCE: 2, POWER: 4, RELIABILITY: 8, SECURITY: 16, GLOBAL: 32, COMPATIBILITY: 64, USER: 128, STANDARD: 256, SAFETY: 512, RESILIENCE: 1024 };
const Size = { SMALLTEST: 16384, MEDIUMTEST: 32768, LARGETEST: 65536 };
const Level = { LEVEL0: 0, LEVEL1: 1, LEVEL2: 2, LEVEL3: 3, LEVEL4: 4 };

async function callHook(fn) {
  if (fn.length > 0) await withTimeout(new Promise((res, rej) => { try { const r = fn(res); if (r && r.then) r.then(() => {}, rej); } catch (e) { rej(e); } }), "hook");
  else await withTimeout(Promise.resolve().then(() => fn()), "hook");
}

async function runSuite(s, path, results, inheritedEach) {
  const name = s.name ? [...path, s.name] : path;
  const each = { before: [...inheritedEach.before, ...s.hooks.beforeEach], after: [...s.hooks.afterEach, ...inheritedEach.after] };
  let setupError;
  try { for (const h of s.hooks.beforeAll) await callHook(h); } catch (e) { setupError = e; }
  for (const t of s.tests) {
    const full = [...name, t.name].join(" > ");
    if (setupError) { results.push({ name: full, status: "failed", file: t.file, message: "beforeAll failed: " + (setupError && setupError.stack || setupError) }); continue; }
    stubHits.current = new Set();
    try {
      for (const h of each.before) await callHook(h);
      if (t.fn.length > 0) {
        await new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`done() not called within ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
          try { const r = t.fn(() => { clearTimeout(timer); res(); }); if (r && r.then) r.then(() => {}, (e) => { clearTimeout(timer); rej(e); }); } catch (e) { clearTimeout(timer); rej(e); }
        });
      } else {
        await withTimeout(Promise.resolve().then(() => t.fn()), "test");
      }
      for (const h of each.after) await callHook(h);
      results.push({ name: full, status: "passed", file: t.file });
    } catch (e) {
      const stubs = [...stubHits.current];
      results.push({ name: full, status: "failed", file: t.file, message: String(e && e.stack ? e.stack.split("\n").slice(0, 6).join("\n") : e), ...(stubs.length ? { stubs } : {}) });
    }
  }
  for (const c of s.suites) await runSuite(c, name, results, each);
  try { for (const h of s.hooks.afterAll) await callHook(h); } catch (e) { results.push({ name: [...name, "afterAll"].join(" > "), status: "failed", message: String(e) }); }
}

async function runAll() {
  const results = [];
  await runSuite(root, [], results, { before: [], after: [] });
  return results;
}

module.exports = { stubHits, setFile, describe, it, xit, beforeAll, beforeEach, afterEach, afterAll, expect, TestType, Size, Level, runAll, Hypium: { setData() {}, hypiumTest() {} } };
