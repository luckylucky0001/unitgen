// unitgen: coverage-guided unit test backfilling for iOS, Android and HarmonyOS projects.
import * as path from "node:path";
import { parseArgs } from "node:util";
import { ADAPTER_IDS, detectAdapter } from "./adapters/index.ts";
import { buildBrief } from "./context.ts";
import { summarize } from "./coverage.ts";
import { generate, recoverGeneration } from "./generate.ts";
import { pickBackend } from "./llm.ts";
import { buildReport } from "./report.ts";
import { State } from "./state.ts";
import { formatTargets, rankTargets } from "./targets.ts";
import { exists, log, relPath, walkFiles, writeFile } from "./util.ts";
import { formatVerify, quarantine, verify } from "./verify.ts";
import { formatMutation, mutate, mutationGate, recover } from "./mutate.ts";
import * as fs from "node:fs";

const HELP = `unitgen — backfill unit tests, keep only the ones that pass and add coverage

Usage: unitgen <command> [options]

Commands
  doctor                     Detect the project type and check the toolchain
  modules                    List modules/targets and where generated tests go
  baseline                   Run the existing tests with coverage (needed once; re-run after big changes)
  targets                    Rank source files by uncovered logic
  brief <source>             Print the generation brief (prompt) for one source file
  verify <test-file>         Gate a generated test file: compile, pass, re-run, assertions, new coverage
  generate                   Automatic loop with a model backend (--llm)
  mutate <test-file>         Mutation check of an accepted test: do its assertions catch changed behaviour?
  reject <test-file> [why]   Quarantine a test file without re-running it (moves it to .unitgen/rejected)
  report                     Write .unitgen/REPORT.md
  note <text>                Attach a note (e.g. a suspected bug) to the report
  status                     Show baseline / accepted / rejected counts

Common options
  -C, --project <dir>        Project root (default: cwd)
      --adapter <id>         Force adapter: ${ADAPTER_IDS.join(", ")}
      --module <name>        Restrict to one module/target
      --json                 Machine-readable output

targets:   --limit <n> (20)  --all-kinds
brief:     --out <file>      --feedback <file>
verify:    --target <source> --reruns <n> (1)  --allow-no-gain  --quarantine
mutate:    --target <source> --max <n> (15) --min-score <percent> (80) --equivalent <line,...>
generate:  --llm anthropic|claude|cmd:<sh> --model <id> --limit <n> (5) --attempts <n> (3) [files...]
           --max <n> (15 mutants/attempt) --min-score <percent> (80)

Exit codes: 0 passed (or mutation not applicable), 1 command/environment error,
            2 quality gate failed, 130 cancelled. Build progress goes to stderr.
`;

export const CLI_OPTIONS = {
  project: { type: "string", short: "C" },
  adapter: { type: "string" },
  module: { type: "string" },
  json: { type: "boolean" },
  limit: { type: "string" },
  "all-kinds": { type: "boolean" },
  out: { type: "string" },
  feedback: { type: "string" },
  target: { type: "string" },
  reruns: { type: "string" },
  "allow-no-gain": { type: "boolean" },
  "allow-failing": { type: "boolean" },
  quarantine: { type: "boolean" },
  llm: { type: "string" },
  model: { type: "string" },
  attempts: { type: "string" },
  max: { type: "string" },
  "min-score": { type: "string" },
  equivalent: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

export async function main(argv: string[]): Promise<number> {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: CLI_OPTIONS,
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (o.help) {
    // Per-command help: the command's line plus its option line.
    const own = HELP.split("\n").filter((l) => new RegExp(`^\\s+${cmd}\\b|^${cmd}:`).test(l));
    process.stdout.write(`${own.length ? own.join("\n") : `unknown command: ${cmd}`}\n\nCommon: -C <dir>  --adapter <id>  --module <name>  --json\n`);
    return 0;
  }
  const root = path.resolve(o.project ?? process.cwd());
  const adapter = detectAdapter(root, o.adapter);
  // File arguments may be given relative to the project root (as `targets` prints them) when -C is used.
  const fileArg = (p: string | undefined) => p && !path.isAbsolute(p) && !exists(p) && exists(path.resolve(adapter.root, p)) ? path.resolve(adapter.root, p) : p;
  if (["brief", "verify", "mutate", "reject"].includes(cmd) && rest[0]) rest[0] = fileArg(rest[0])!;
  if (o.target) o.target = fileArg(o.target);
  const positive = (name: string, fallback: number) => {
    const n = Number(o[name as keyof typeof o] ?? fallback);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
    return n;
  };
  const max = positive("max", 15), attempts = positive("attempts", 3), limit = positive("limit", 5);
  const minScore = Number(o["min-score"] ?? 80);
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) throw new Error("--min-score must be between 0 and 100");
  const reruns = Number(o.reruns ?? 1);
  if (!Number.isSafeInteger(reruns) || reruns < 0) throw new Error("--reruns must be a non-negative integer");
  const state = new State(adapter.root);
  recover(state); // a crashed `mutate` must never leave production code modified
  adapter.recover?.();
  recoverGeneration(state);
  const mods = o.module ? adapter.modules().filter((m) => m.name === o.module) : undefined;
  if (o.module && !mods?.length) throw new Error(`unknown module ${o.module}; see \`unitgen modules\``);
  const print = (human: string, data: unknown) => process.stdout.write((o.json ? JSON.stringify(data, null, 2) : human) + "\n");

  switch (cmd) {
    case "doctor": {
      const d = adapter.doctor();
      print([`adapter: ${adapter.id} (${adapter.platform})`, `root: ${adapter.root}`, ...d.lines, d.ok ? "status: OK" : "status: PROBLEMS FOUND"].join("\n"), { adapter: adapter.id, platform: adapter.platform, ...d });
      return d.ok ? 0 : 1;
    }
    case "modules": {
      const ms = adapter.modules();
      print(ms.map((m) => `${m.name.padEnd(32)} ${m.kind.padEnd(14)} src: ${m.sourceRoots.map((r) => relPath(r, root)).join(", ")}  ->  tests: ${relPath(m.testRoot, root)}`).join("\n"),
        ms.map(({ meta, ...m }) => ({ ...m, meta: { ...meta, buildText: undefined } })));
      return 0;
    }
    case "baseline": {
      state.data.baseline = { at: state.stamp(), ok: false, tests: 0, failed: 0, seconds: 0, note: "baseline in progress or interrupted" };
      state.save();
      log(`running existing tests with coverage (${adapter.id}) ...`);
      // Generated test files from earlier sessions must be registered so the real toolchain runs them too.
      if (adapter.platform === "harmony") for (const m of mods ?? adapter.modules()) {
        for (const f of walkFiles(m.testRoot, [adapter.testFileSuffix])) adapter.prepareTestFile(f, m);
      }
      const r = await adapter.runTests({ coverage: true, label: "baseline", modules: mods });
      const failed = r.tests.filter((t) => t.status === "failed").length;
      const cov = r.coverage ?? {};
      if (mods) {
        // Keep coverage of other modules from a previous full baseline.
        const prev = state.baselineCoverage;
        const own = new Set(mods.flatMap((m) => adapter.sourceFiles(m)));
        for (const f of Object.keys(prev)) if (!own.has(f) && !cov[f]) cov[f] = prev[f];
      }
      // Failing existing tests block the baseline unless the user accepts them (--allow-failing) or the
      // runner explains them (Node shim: they use stubbed system APIs and pass only on the real toolchain).
      const tolerated = failed > 0 && !r.infraError && r.compiled && (!!o["allow-failing"] || !!r.failuresExplained);
      const runOk = (r.ok || tolerated) && r.compiled && !r.infraError;
      const hasCoverage = r.tests.some((t) => t.status === "passed") && Object.keys(cov).length > 0;
      // A project without (useful) tests is a valid 0% baseline only where unitgen measures coverage
      // itself (HarmonyOS Node shim). Elsewhere "nothing ran / nothing covered" usually means the
      // test task or coverage agent is misconfigured, so it stays an error.
      const empty = runOk && failed === 0 && !hasCoverage && !!r.emptyCoverageOk;
      const measured = runOk && (failed === 0 || tolerated) && (hasCoverage || empty);
      const failingNames = r.tests.filter((t) => t.status === "failed").map((t) => t.name);
      const note = [r.infraError, r.note, !r.compiled ? "existing tests did not compile in this environment"
        : tolerated ? `${failed} existing tests fail here and are excluded from the gate (${r.failuresExplained ?? "--allow-failing"}): ${failingNames.slice(0, 8).join("; ")}${failingNames.length > 8 ? "; ..." : ""}`
        : failed ? `${failed} existing tests fail: ${failingNames.slice(0, 8).join("; ")}${failingNames.length > 8 ? "; ..." : ""}`
        : empty ? "no existing test covers project code: every file starts at 0%" : undefined].filter(Boolean).join("; ") || undefined;
      const baseline = { at: state.stamp(), ok: measured, tests: r.tests.length, failed, note, seconds: r.seconds };
      if (measured) {
        state.baselineCoverage = cov;
        state.data.adapter = adapter.id;
        state.data.baseline = baseline;
        state.save();
      } else {
        // Preserve old coverage as evidence, but invalidate it for future verify/generate gates.
        state.data.baseline = baseline;
        state.save();
      }
      const s = summarize(cov);
      const unloaded = rankTargets(adapter, cov, { modules: mods, minUncovered: 1 }).filter((t) => !t.measured);
      const why = !r.compiled ? "existing tests do not compile here"
        : r.infraError ? "environment problem"
        : failed ? `${failed} existing tests fail; fix them, or re-run with --allow-failing to measure the passing ones`
        : !hasCoverage ? "the existing tests ran but covered no project code (the coverage tool may not be attached)"
        : "build, tests and coverage must succeed";
      print([`tests: ${r.tests.length} (${failed} failed)  build: ${r.compiled ? "ok" : "FAILED"}  ${r.seconds.toFixed(0)}s`,
        `coverage: ${s.total.covered}/${s.total.executable} lines (${s.total.pct.toFixed(1)}%) in ${s.files.length} files loaded by tests`,
        unloaded.length ? `not loaded by any test: ${unloaded.length} logic/model files (~${unloaded.reduce((n, t) => n + t.executable, 0)} lines, 0%)` : "",
        note ? `note: ${note}` : "", !measured ? `baseline not saved: ${why}\n${r.excerpt}\nlog: ${r.logFile}` : ""].filter(Boolean).join("\n"),
        { ...baseline, coverage: s.total, unloadedFiles: unloaded.length, logFile: r.logFile });
      return measured ? 0 : r.infraError ? 1 : 2;
    }
    case "targets": {
      if (!state.hasBaseline()) log("no baseline yet: line counts are estimates. Run `unitgen baseline` first for real coverage.");
      const ts = rankTargets(adapter, state.knownCoverage(), { modules: mods, includeKinds: o["all-kinds"] ? ["logic", "model", "di", "ui", "entry", "platform"] : ["logic", "model"] });
      if (!o["all-kinds"]) log("showing logic/model files; add --all-kinds to include ui, platform, di and entry files");
      const lim = Number(o.limit ?? 20);
      if (!ts.length) log(o["all-kinds"] ? "nothing left to cover here (every file is covered or below 3 uncovered lines)" : "no logic/model file with uncovered lines here; `--all-kinds` lists ui/platform/di files too");
      print(formatTargets(ts.slice(0, lim), root), ts.slice(0, lim).map(({ uncoveredLines, ...t }) => t));
      return 0;
    }
    case "brief": {
      if (!rest[0]) throw new Error("usage: unitgen brief <source-file>");
      const fb = o.feedback && exists(o.feedback) ? fs.readFileSync(o.feedback, "utf8") : undefined;
      const b = buildBrief(adapter, state, rest[0], { feedback: fb });
      const out = o.out ?? state.file("briefs", `${path.basename(b.source)}.md`);
      writeFile(out, b.markdown);
      if (o.json) print("", { source: b.source, testPath: b.testPath, suiteName: b.suiteName, brief: out, uncovered: b.uncovered.length });
      else process.stdout.write(b.markdown + `\n\n<!-- brief saved to ${out} -->\n`);
      return 0;
    }
    case "verify": {
      if (!rest[0]) throw new Error("usage: unitgen verify <test-file> [--target <source>]");
      if (!state.data.baseline?.ok) throw new Error("a successful baseline is required; run `unitgen baseline` first");
      const r = await verify(adapter, state, rest[0], {
        target: o.target ?? inferTarget(adapter, rest[0]), reruns, allowNoGain: o["allow-no-gain"], onFail: o.quarantine ? "quarantine" : "keep",
      });
      print(formatVerify(r, root), r);
      return r.verdict === "accepted" ? 0 : 2;
    }
    case "mutate": {
      if (!rest[0]) throw new Error("usage: unitgen mutate <test-file> [--target <source>] [--max 10]");
      const relTest = relPath(path.resolve(rest[0]), root);
      const tgt = o.target ?? state.data.accepted.find((a) => a.testFile === relTest)?.target;
      if (!tgt) throw new Error("pass --target <source> (no accepted target recorded for this test file)");
      if (o.equivalent) {
        const eq = (state.data.equivalent ??= {});
        const ids = o.equivalent.split(",").map((x) => x.trim()).filter((x) => /^\d+(\.\d+)?$/.test(x));
        if (!ids.length) throw new Error("--equivalent takes line numbers (12) or mutant ids (12.2), comma-separated");
        eq[relTest] = [...new Set([...(eq[relTest] ?? []).map(String), ...ids])];
        state.save();
      }
      const r = await mutate(adapter, state, rest[0], path.resolve(root, tgt), max);
      const gate = mutationGate(r, minScore);
      print(`${formatMutation(r)}\ngate: ${gate.status} (minimum ${minScore}%)${gate.reason ? ` — ${gate.reason}` : ""}`, { ...r, gate });
      return gate.status === "FAILED" ? 2 : 0;
    }
    case "reject": {
      if (!rest[0] || !exists(rest[0])) throw new Error("usage: unitgen reject <test-file> [reason]");
      const q = quarantine(adapter, state, path.resolve(rest[0]), rest.slice(1).join(" ") || "rejected by agent", undefined, o.target ? path.resolve(o.target) : undefined);
      print(`quarantined: ${relPath(q, root)}`, { quarantinedAs: q });
      return 0;
    }
    case "generate": {
      if (!state.data.baseline?.ok) throw new Error("a successful baseline is required; run `unitgen baseline` first");
      const llm = pickBackend(o.llm, o.model);
      const res = await generate(adapter, state, llm, {
        limit, attempts, files: rest, module: o.module, reruns, mutationMax: max, minMutationScore: minScore,
      });
      writeFile(state.file("REPORT.md"), buildReport(adapter, state));
      print(res.map((r) => `${r.verdict.padEnd(14)} +${String(r.gainedLines).padStart(4)}  ${relPath(r.testFile, root)}`).join("\n") + `\n\nreport: ${state.file("REPORT.md")}`, res);
      return res.every((r) => r.verdict === "accepted") ? 0 : 2;
    }
    case "report": {
      const md = buildReport(adapter, state);
      writeFile(state.file("REPORT.md"), md);
      print(md + `\n<!-- saved to ${state.file("REPORT.md")} -->`, { reportPath: state.file("REPORT.md"), markdown: md });
      return 0;
    }
    case "note": {
      const text = rest.join(" ").trim();
      if (!text) throw new Error("usage: unitgen note <text>");
      const kind = /bug|suspect/i.test(text) ? "suspect" : "note";
      state.data.notes.push({ at: state.stamp(), kind, text });
      state.save();
      print(`noted (${kind}); it will appear in the report`, { kind, text });
      return 0;
    }
    case "status": {
      const d = state.data;
      print([`adapter: ${adapter.id}`, `baseline: ${d.baseline ? d.baseline.at : "none"}`, `accepted: ${d.accepted.length}`, `rejected: ${d.rejected.length}`, `notes: ${d.notes.length}`].join("\n"), d);
      return 0;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
      return 64;
  }
}

/** FooUnitGenTests.swift / FooUnitGenTest.kt / Foo.unitgen.test.ets -> the source the placement maps to. */
function inferTarget(adapter: ReturnType<typeof detectAdapter>, testFile: string): string | undefined {
  const abs = path.resolve(testFile);
  for (const m of adapter.modules()) {
    for (const src of adapter.sourceFiles(m)) {
      if (adapter.placement(src, m).path === abs) return src;
    }
  }
  return undefined;
}

