// Inert stand-in for HarmonyOS system modules (@kit.*, @ohos.*) under the Node shim.
// Any property access returns another stub; calling or constructing one returns a stub too,
// so modules that merely import platform APIs still load. Behaviour is NOT emulated.
"use strict";
// The hypium shim reads which stubbed APIs a failing test touched (to tell shim limits from real failures).
let hits;
try { hits = require("./hypium.cjs").stubHits; } catch { hits = undefined; }
function make(name) {
  const fn = function () { return make(name + "()"); };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === "__esModule") return true;
      if (prop === "default") return make(name + ".default");
      if (prop === Symbol.toPrimitive) return () => `[stub ${name}]`;
      if (prop === "then") return undefined;
      if (prop === "toString") return () => `[stub ${name}]`;
      return make(`${name}.${String(prop)}`);
    },
    construct() { if (hits) hits.current.add(name.split(".").slice(0, 2).join(".")); return make(`new ${name}`); },
    apply() { if (hits) hits.current.add(name.replace(/\(\)/g, "").split(".").slice(0, 3).join(".")); return make(`${name}()`); },
  });
}
module.exports = make("ohos");
