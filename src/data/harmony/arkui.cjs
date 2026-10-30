// ArkUI-only syntax helpers shared by the Node shim runner and the unitgen harmony adapter.
"use strict";

/** Index just past the `}` matching the `{` at `open`; skips strings, template literals and comments. */
function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") { i = text.indexOf("\n", i); if (i < 0) return text.length; continue; }
    if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i + 2); if (i < 0) return text.length; i++; continue; }
    if (c === "'" || c === '"' || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return text.length;
}

/**
 * Replace ArkUI-only declarations with inert stand-ins of the same name, keeping every newline so
 * line numbers (and coverage) still match the original file:
 *   [@Decorators] [export [default]] struct Foo {...}   ->  [export [default]] class Foo {}
 *   @Builder|@Styles|@Extend(X)|@AnimatableExtend(X) [export] function f(...) {...}  ->  [export] function f() {}
 */
function stripArkUI(text) {
  const names = [];
  const decos = String.raw`(?:@\w+(?:\((?:[^()]|\([^()]*\))*\))?\s*)*`;
  const re = new RegExp(String.raw`^([ \t]*)(${decos})(export\s+(?:default\s+)?)?(struct\s+(\w+)|function\s+(\w+))[^{]*\{`, "gm");
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const isStruct = !!m[5];
    // Only decorated functions are ArkUI builders/styles; plain functions are ordinary code.
    if (!isStruct && !/@(Builder|LocalBuilder|Styles|Extend|AnimatableExtend)\b/.test(m[2])) continue;
    const end = matchBrace(text, m.index + m[0].length - 1);
    const name = m[5] || m[6];
    names.push(name);
    const blank = text.slice(m.index, end).replace(/[^\n]/g, "");
    const repl = `${m[1]}${m[3] || ""}${isStruct ? `class ${name} {}` : `function ${name}() {}`}`;
    out += text.slice(last, m.index) + repl + blank;
    last = end;
    re.lastIndex = end;
  }
  return { text: out + text.slice(last), names };
}

module.exports = { matchBrace, stripArkUI };
