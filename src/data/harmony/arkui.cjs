// ArkUI-only syntax helpers shared by the Node shim runner and the unitgen harmony adapter.
"use strict";

/** Index just past the `)` matching the `(` at `open`; skips strings and comments. */
function matchParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") { i = text.indexOf("\n", i); if (i < 0) return text.length; continue; }
    if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i + 2); if (i < 0) return text.length; i++; continue; }
    if (c === "'" || c === '"' || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return text.length;
}

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
  const re = new RegExp(String.raw`^([ \t]*)(${decos})(export\s+(?:default\s+)?)?(struct\s+(\w+)|function\s+(\w+))`, "gm");
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const isStruct = !!m[5];
    // Only decorated functions are ArkUI builders/styles; plain functions are ordinary code.
    if (!isStruct && !/@(Builder|LocalBuilder|Styles|Extend|AnimatableExtend)\b/.test(m[2])) continue;
    // The body's `{`: for a function, after its parameter list, which may itself contain braces
    // (`@Builder function f($$: { label: string }) {`).
    let at = m.index + m[0].length;
    if (!isStruct) {
      const open = text.indexOf("(", at);
      if (open < 0) continue;
      at = matchParen(text, open);
    }
    const bodyOpen = text.indexOf("{", at);
    if (bodyOpen < 0) continue;
    const end = matchBrace(text, bodyOpen);
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

/** Decode source-map VLQ mappings into [generated line, generated column, original line] (lines 1-based). */
function decodeMappings(mappings) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out = [];
  let srcLine = 0;
  mappings.split(";").forEach((lineStr, genLine) => {
    let genCol = 0;
    for (const seg of lineStr.split(",")) {
      if (!seg) continue;
      const vals = [];
      let shift = 0, value = 0;
      for (const ch of seg) {
        const digit = chars.indexOf(ch);
        value += (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else { vals.push(value & 1 ? -(value >> 1) : value >> 1); value = 0; shift = 0; }
      }
      genCol += vals[0];
      if (vals.length >= 4) {
        srcLine += vals[2];
        out.push([genLine + 1, genCol, srcLine + 1]);
      }
    }
  });
  return out;
}

/**
 * Original lines that produce JavaScript (TypeScript transpile + source map): type annotations,
 * interfaces and declarations-only lines are erased and never executable.
 */
function codeLines(ts, text, fileName) {
  const out = ts.transpileModule(stripArkUI(text).text.replace(/^(\s*import\s+)lazy\s+/gm, "$1"), {
    fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, experimentalDecorators: true, sourceMap: true, useDefineForClassFields: false },
  });
  return new Set(decodeMappings(JSON.parse(out.sourceMapText).mappings).map((s) => s[2]));
}

module.exports = { matchBrace, stripArkUI, decodeMappings, codeLines };
