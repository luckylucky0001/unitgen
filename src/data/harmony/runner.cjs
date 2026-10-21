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

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "@ohos/hypium") return require.resolve("./hypium.cjs");
  if (/^@(kit|ohos|system|arkts|hms)[./]/.test(request) && request !== "@ohos/hypium") {
    if (ohModules !== "-" && !request.startsWith("@kit") ) {
      const local = path.join(ohModules, request);
      if (fs.existsSync(local)) return origResolve.call(this, local, parent, ...rest);
    }
    return stubPath;
  }
  if ((request.startsWith(".") || path.isAbsolute(request)) && parent && parent.filename) {
    const base = path.resolve(path.dirname(parent.filename), request);
    for (const cand of [base, base + ".ets", base + ".ts", path.join(base, "Index.ets"), path.join(base, "index.ets"), path.join(base, "index.ts")]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
    }
  }
  if (ohModules !== "-" && !request.startsWith(".") && !path.isAbsolute(request)) {
    const pkgDir = path.join(ohModules, request);
    if (fs.existsSync(pkgDir)) {
      for (const idx of ["Index.ets", "index.ets", "index.ts", "Index.ts"]) if (fs.existsSync(path.join(pkgDir, idx))) return path.join(pkgDir, idx);
    }
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
  for (const r of results) process.stdout.write(`${r.status === "passed" ? "PASS" : "FAIL"} ${r.name}${r.message ? "\n    " + r.message.replace(/\n/g, "\n    ") : ""}\n`);
  process.exitCode = results.some((r) => r.status === "failed") ? 1 : 0;
})();
