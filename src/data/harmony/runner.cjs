// Runs ArkTS (.ets/.ts) hypium tests on Node: transpiles on require with inline source maps
// (so c8 reports coverage against the original .ets lines), maps @ohos/hypium to the shim
// and every other @kit.* / @ohos.* / @system.* import to an inert stub.
// usage: node runner.cjs <typescript-dir> <results.json> <ohModulesDir|-> <test files...>
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const [tsDir, resultsFile, ohModules, ...testFiles] = process.argv.slice(2);
// Transpiled JS is written here and executed from there, so V8 coverage is exact for the JS;
// unitgen maps JS lines back to .ets lines itself (c8's range remapping through source maps
// misattributes the end of uncovered blocks, e.g. whole switch statements).
const genDir = path.join(path.dirname(resultsFile), "gen");
const lineMaps = {};
const ts = require(tsDir);
const hypium = require("./hypium.cjs");
const { decodeMappings, stripArkUI } = require("./arkui.cjs");
const stubPath = path.join(__dirname, "stub.cjs");

const stubbed = new Set();
// Files whose ArkUI structs/builders were blanked out: [{ file, names }].
const stubbedUi = [];
const localDeps = JSON.parse(process.env.UNITGEN_LOCAL_DEPS || "{}");
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
  "$r", "$rawfile", "postCardAction", "focusControl", "FunctionKey", "ModifierKey", "KeyType", "KeySource", "MouseButton",
  "MouseAction", "TouchType", "SourceType", "GestureMode", "PanDirection", "SwipeDirection", "ScrollState", "TextInputStyle",
  "InputType", "EnterKeyType", "CopyOptions", "ImageRenderMode", "ObscuredReasons", "RenderFit", "BlurStyle", "ShadowStyle",
  "ThemeColorMode", "AdaptiveColor", "FocusPriority", "KeyboardAppearance", "WordBreak", "LineBreakStrategy", "uiObserver"];
const usedGlobals = new Set();
// ArkUI state-management decorators (V1 and V2). They must be real no-op decorators: a legacy TS
// class/property decorator that returns a value would replace the class or descriptor.
const DECORATORS = ["ObservedV2", "Observed", "Trace", "Track", "Local", "Param", "Once", "Event", "Provider", "Consumer", "Monitor",
  "Computed", "Type", "State", "Prop", "Link", "Provide", "Consume", "ObjectLink", "Watch", "StorageLink", "StorageProp",
  "LocalStorageLink", "LocalStorageProp", "BuilderParam", "Builder", "Styles", "Extend", "Concurrent", "Sendable", "Reusable",
  "ReusableV2", "Require", "Component", "ComponentV2", "Entry", "Preview", "CustomDialog", "AnimatableExtend", "LocalBuilder"];
const FACTORY_WITH_CLASS_ARG = new Set(["Type"]);
// State management V2: a @Trace field holds an observable proxy of an assigned Array/Map/Set/Date, so
// `obj.items === assigned` is false on the real runtime. Mirror that (behaviour otherwise unchanged).
function traceField(target, key) {
  const store = new WeakMap();
  Object.defineProperty(target, key, {
    configurable: true, enumerable: true,
    get() { return store.get(this); },
    set(v) {
      const wrap = v !== null && typeof v === "object" && (Array.isArray(v) || v instanceof Map || v instanceof Set || v instanceof Date);
      store.set(this, wrap ? new Proxy(v, {}) : v);
    },
  });
}
for (const name of DECORATORS) {
  if (name in globalThis) continue;
  if (name === "Trace") {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: (target, key) => { usedGlobals.add("@Trace"); if (typeof key === "string") traceField(target, key); } });
    continue;
  }
  const noop = () => undefined;
  const deco = function (...args) {
    usedGlobals.add("@" + name);
    // @Watch('cb'), @StorageLink('k'), @Provide('k'), @Monitor('a.b'), @Type(Foo): factory form.
    if (args.length === 1 && (typeof args[0] !== "function" || FACTORY_WITH_CLASS_ARG.has(name))) return noop;
    if (args.length === 0) return noop;
    return undefined;
  };
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: deco });
}
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
  // Generated by hvigor at build time (BUNDLE_NAME, VERSION_NAME, DEBUG, ...); not on disk without a build.
  if (request === "BuildProfile") {
    stubbed.add(request);
    return path.join(__dirname, "buildprofile.cjs");
  }
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
  if (localDeps[request]) {
    for (const idx of ["Index.ets", "index.ets", "Index.ts", "index.ts"]) {
      const f = path.join(localDeps[request], idx);
      if (fs.existsSync(f)) return f;
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
  // ArkTS-only syntax TypeScript cannot parse: `import lazy { x } from '...'` (lazy import).
  const raw = fs.readFileSync(filename, "utf8");
  // UI components (struct + @Component/@Entry) and @Builder/@Styles/@Extend functions are not
  // TypeScript. They are blanked out (line numbers kept); the rest of the file (helpers, classes,
  // constants next to the component) loads and is measured normally.
  const ui = testFiles.some((t) => path.resolve(t) === filename) ? { text: raw, names: [] } : stripArkUI(raw);
  if (ui.names.length) stubbedUi.push({ file: filename, names: ui.names });
  const src = ui.text.replace(/^(\s*import\s+)lazy\s+/gm, "$1");
  const out = ts.transpileModule(src, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, experimentalDecorators: true,
      sourceMap: true, esModuleInterop: true, useDefineForClassFields: false,
    },
  });
  const syntax = (out.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (syntax.length) {
    const d = syntax[0];
    const pos = d.file ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
    throw new SyntaxError(`${filename}:${pos.line + 1}:${pos.character + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
  }
  // Mirror relative to the project root, without dot-directories (c8's globs skip them).
  const rel = path.relative(process.env.UNITGEN_ROOT || "/", filename).split(path.sep).map((p) => (p.startsWith(".") ? "_" + p.slice(1) : p)).join(path.sep);
  const genPath = path.join(genDir, rel) + ".js";
  fs.mkdirSync(path.dirname(genPath), { recursive: true });
  const js = out.outputText.replace(/\n\/\/# sourceMappingURL=.*$/, "");
  fs.writeFileSync(genPath, js);
  const segs = decodeMappings(JSON.parse(out.sourceMapText).mappings);
  lineMaps[genPath] = { source: filename, lines: genToSourceLines(segs), segs };
  module._compile(js, genPath);
}

/** Generated line -> lowest original line (1-based), for stack traces. */
function genToSourceLines(segs) {
  const out = [];
  for (const [g, , s] of segs) if (out[g] === undefined || s < out[g]) out[g] = s;
  return out;
}

/** Rewrite "<gen>.js:L:C" in stack traces to the original "<file>.ets:L". */
function mapStack(text) {
  // Match the known generated paths literally: project paths may contain spaces or parentheses.
  let out = String(text);
  for (const [file, m] of Object.entries(lineMaps)) {
    if (!out.includes(file)) continue;
    out = out.split(file).map((part, i) => {
      if (i === 0) return part;
      const pos = /^:(\d+)(?::\d+)?/.exec(part);
      if (!pos || !m.lines[Number(pos[1])]) return file + part;
      return `${m.source}:${m.lines[Number(pos[1])]}` + part.slice(pos[0].length);
    }).join("");
  }
  return out;
}
require.extensions[".ets"] = compile;
require.extensions[".ts"] = compile;

(async () => {
  const loadErrors = [];
  for (const f of testFiles) {
    try {
      hypium.setFile(path.resolve(f));
      const mod = require(path.resolve(f));
      const fn = typeof mod.default === "function" ? mod.default : typeof mod === "function" ? mod : undefined;
      if (fn) fn();
    } catch (e) {
      loadErrors.push({ name: `load ${path.basename(f)}`, status: "failed", message: mapStack(String(e && e.stack ? e.stack.split("\n").slice(0, 8).join("\n") : e)), file: f, load: true });
    }
  }
  const results = [...loadErrors, ...(await hypium.runAll())].map((r) => (r.message ? { ...r, message: mapStack(r.message) } : r));
  fs.writeFileSync(path.join(path.dirname(resultsFile), "linemaps.json"), JSON.stringify(lineMaps));
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  fs.writeFileSync(resultsFile.replace(/\.json$/, ".stubs.json"), JSON.stringify({ modules: [...stubbed], globals: [...usedGlobals], ui: stubbedUi }));
  for (const r of results) process.stdout.write(`${r.status === "passed" ? "PASS" : "FAIL"} ${r.name}${r.message ? "\n    " + r.message.replace(/\n/g, "\n    ") : ""}\n`);
  process.exitCode = results.some((r) => r.status === "failed") ? 1 : 0;
})();
