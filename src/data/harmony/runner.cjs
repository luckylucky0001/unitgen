// Runs ArkTS (.ets/.ts) hypium tests on Node: transpiles on require with inline source maps
// (so c8 reports coverage against the original .ets lines), maps @ohos/hypium to the shim
// and every other @kit.* / @ohos.* / @system.* import to an inert stub.
// usage: node runner.cjs <typescript-dir> <results.json> <ohModulesDir|-> <test files...>
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const [tsDir, resultsFile, ohModules, ...testFiles] = process.argv.slice(2);
const ts = require(tsDir);
const hypium = require("./hypium.cjs");
const stubPath = path.join(__dirname, "stub.cjs");

const stubbed = new Set();
function missingPackage(request, parent) {
  const e = new Error(`UNITGEN_MISSING_PACKAGE ${request} (imported by ${parent && parent.filename}): ohpm package not installed; run \`ohpm install\` in the project`);
  e.code = "UNITGEN_MISSING_PACKAGE";
  return e;
}

// ArkUI exposes enums/functions as globals (Color, Alignment, $r, ...). Define inert stubs so
// modules that merely reference them still load; values are meaningless, so tests must not assert on them.
const stub = require("./stub.cjs");
const ARKUI_GLOBALS = ["Color", "Alignment", "FlexAlign", "HorizontalAlign", "VerticalAlign", "ItemAlign", "FlexDirection", "FlexWrap",
  "FontWeight", "FontStyle", "TextAlign", "TextOverflow", "TextDecorationType", "ButtonType", "ButtonStyleMode", "ImageFit", "ImageRepeat",
  "Curve", "BarState", "BarPosition", "Axis", "EdgeEffect", "Visibility", "HitTestMode", "BorderStyle", "LineCapStyle", "ResponseType",
  "SafeAreaType", "SafeAreaEdge", "KeyboardAvoidMode", "DialogAlignment", "PlayMode", "NavigationMode", "TitleHeight", "Placement",
  "AppStorage", "LocalStorage", "PersistentStorage", "Environment", "getContext", "animateTo", "px2vp", "vp2px", "fp2px", "px2fp", "lpx2px", "px2lpx",
  "$r", "$rawfile", "postCardAction", "focusControl"];
const usedGlobals = new Set();
for (const g of ARKUI_GLOBALS) {
  if (!(g in globalThis)) {
    Object.defineProperty(globalThis, g, { configurable: true, get() { usedGlobals.add(g); return stub; } });
  }
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "@ohos/hypium") return require.resolve("./hypium.cjs");
  // System APIs use a dot (@ohos.router, @kit.ArkUI, @system.app); ohpm packages use a slash
  // (@ohos/crypto-js) and must come from oh_modules, never from the stub.
  if (/^@(kit|ohos|system|arkts|hms)\./.test(request)) {
    stubbed.add(request);
    return stubPath;
  }
  if ((request.startsWith(".") || path.isAbsolute(request)) && parent && parent.filename) {
    const base = path.resolve(path.dirname(parent.filename), request);
    for (const cand of [base, base + ".ets", base + ".ts", path.join(base, "Index.ets"), path.join(base, "index.ets"), path.join(base, "index.ts")]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
    }
  }
  if (!request.startsWith(".") && !path.isAbsolute(request) && !request.startsWith("node:") && !Module.isBuiltin(request)) {
    if (ohModules === "-") throw missingPackage(request, parent);
    const pkgDir = path.join(ohModules, request);
    if (fs.existsSync(pkgDir)) {
      for (const idx of ["Index.ets", "index.ets", "index.ts", "Index.ts"]) if (fs.existsSync(path.join(pkgDir, idx))) return path.join(pkgDir, idx);
      try { return origResolve.call(this, pkgDir, parent, ...rest); } catch { /* fall through */ }
    }
    throw missingPackage(request, parent);
  }
  return origResolve.call(this, request, parent, ...rest);
};

function compile(module, filename) {
  const src = fs.readFileSync(filename, "utf8");
  const out = ts.transpileModule(src, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, experimentalDecorators: true,
      inlineSourceMap: true, inlineSources: true, esModuleInterop: true, useDefineForClassFields: false,
    },
  });
  const syntax = (out.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (syntax.length) {
    const d = syntax[0];
    const pos = d.file ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
    throw new SyntaxError(`${filename}:${pos.line + 1}:${pos.character + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
  }
  module._compile(out.outputText, filename);
}
require.extensions[".ets"] = compile;
require.extensions[".ts"] = compile;

(async () => {
  const loadErrors = [];
  for (const f of testFiles) {
    try {
      const mod = require(path.resolve(f));
      const fn = typeof mod.default === "function" ? mod.default : typeof mod === "function" ? mod : undefined;
      if (fn) fn();
    } catch (e) {
      loadErrors.push({ name: `load ${path.basename(f)}`, status: "failed", message: String(e && e.stack ? e.stack.split("\n").slice(0, 8).join("\n") : e), file: f, load: true });
    }
  }
  const results = [...loadErrors, ...(await hypium.runAll())];
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  fs.writeFileSync(resultsFile.replace(/\.json$/, ".stubs.json"), JSON.stringify({ modules: [...stubbed], globals: [...usedGlobals] }));
  for (const r of results) process.stdout.write(`${r.status === "passed" ? "PASS" : "FAIL"} ${r.name}${r.message ? "\n    " + r.message.replace(/\n/g, "\n    ") : ""}\n`);
  process.exitCode = results.some((r) => r.status === "failed") ? 1 : 0;
})();
