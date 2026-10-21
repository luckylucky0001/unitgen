// unitgen: coverage-guided unit test backfilling for iOS, Android and HarmonyOS projects.
import * as path from "node:path";
import { parseArgs } from "node:util";
import { ADAPTER_IDS, detectAdapter } from "./adapters/index.ts";
import { buildBrief } from "./context.ts";
import { summarize } from "./coverage.ts";
import { generate } from "./generate.ts";
import { pickBackend } from "./llm.ts";
import { buildReport } from "./report.ts";
import { State } from "./state.ts";
import { formatTargets, rankTargets } from "./targets.ts";
import { exists, log, relPath, writeFile } from "./util.ts";
import { formatVerify, quarantine, verify } from "./verify.ts";
import { formatMutation, mutate, recover } from "./mutate.ts";
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
mutate:    --target <source> --max <n> (10)
generate:  --llm anthropic|claude|cmd:<sh> --model <id> --limit <n> (5) --attempts <n> (3) [files...]
`;

async function main(argv: string[]): Promise<number> {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
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
      quarantine: { type: "boolean" },
      llm: { type: "string" },
      model: { type: "string" },
      attempts: { type: "string" },
      max: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || o.help || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  const root = path.resolve(o.project ?? process.cwd());
  const adapter = detectAdapter(root, o.adapter);
  const state = new State(adapter.root);
  recover(state); // a crashed `mutate` must never leave production code modified
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
      log(`running existing tests with coverage (${adapter.id}) ...`);
      const r = adapter.runTests({ coverage: true, label: "baseline", modules: mods });
      const failed = r.tests.filter((t) => t.status === "failed").length;
      const cov = r.coverage ?? {};
      if (mods) {
        // Keep coverage of other modules from a previous full baseline.
        const prev = state.baselineCoverage;
        const own = new Set(mods.flatMap((m) => adapter.sourceFiles(m)));
        for (const f of Object.keys(prev)) if (!own.has(f) && !cov[f]) cov[f] = prev[f];
      }
      state.baselineCoverage = cov;
      const note = r.infraError ?? r.note ?? (!r.compiled ? "existing tests did not compile in this environment; baseline treated as 0% for affected modules" : failed ? `${failed} existing tests fail` : undefined);
      state.data.adapter = adapter.id;
      state.data.baseline = { at: state.stamp(), ok: r.ok, tests: r.tests.length, failed, note, seconds: r.seconds };
      state.save();
      const s = summarize(cov);
      print([`tests: ${r.tests.length} (${failed} failed)  build: ${r.compiled ? "ok" : "FAILED"}  ${r.seconds.toFixed(0)}s`,
        `coverage: ${s.total.covered}/${s.total.executable} lines (${s.total.pct.toFixed(1)}%) in ${s.files.length} files`,
        note ? `note: ${note}` : "", !r.ok ? `\n${r.excerpt}\nlog: ${r.logFile}` : ""].filter(Boolean).join("\n"),
        { ...state.data.baseline, coverage: s.total, logFile: r.logFile });
      return 0;
    }
    case "targets": {
      if (!state.hasBaseline()) log("no baseline yet: line counts are estimates. Run `unitgen baseline` first for real coverage.");
      const ts = rankTargets(adapter, state.knownCoverage(), { modules: mods, includeKinds: o["all-kinds"] ? ["logic", "model", "di", "ui", "entry", "platform"] : undefined });
      const lim = Number(o.limit ?? 20);
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
      if (!state.hasBaseline()) log("warning: no baseline; every covered line counts as new. Run `unitgen baseline` first.");
      const r = verify(adapter, state, rest[0], {
        target: o.target, reruns: Number(o.reruns ?? 1), allowNoGain: o["allow-no-gain"], onFail: o.quarantine ? "quarantine" : "keep",
      });
      print(formatVerify(r, root), r);
      return r.verdict === "accepted" ? 0 : 2;
    }
    case "mutate": {
      if (!rest[0]) throw new Error("usage: unitgen mutate <test-file> [--target <source>] [--max 10]");
      const relTest = relPath(path.resolve(rest[0]), root);
      const tgt = o.target ?? state.data.accepted.find((a) => a.testFile === relTest)?.target;
      if (!tgt) throw new Error("pass --target <source> (no accepted target recorded for this test file)");
      const r = mutate(adapter, state, rest[0], path.resolve(root, tgt), Number(o.max ?? 10));
      print(formatMutation(r), r);
      return 0;
    }
    case "reject": {
      if (!rest[0] || !exists(rest[0])) throw new Error("usage: unitgen reject <test-file> [reason]");
      const q = quarantine(adapter, state, path.resolve(rest[0]), rest.slice(1).join(" ") || "rejected by agent", undefined, o.target ? path.resolve(o.target) : undefined);
      print(`quarantined: ${relPath(q, root)}`, { quarantinedAs: q });
      return 0;
    }
    case "generate": {
      const llm = pickBackend(o.llm, o.model);
      const res = await generate(adapter, state, llm, {
        limit: Number(o.limit ?? 5), attempts: Number(o.attempts ?? 3), files: rest, module: o.module, reruns: Number(o.reruns ?? 1),
      });
      writeFile(state.file("REPORT.md"), buildReport(adapter, state));
      print(res.map((r) => `${r.verdict.padEnd(14)} +${String(r.gainedLines).padStart(4)}  ${relPath(r.testFile, root)}`).join("\n") + `\n\nreport: ${state.file("REPORT.md")}`, res);
      return 0;
    }
    case "report": {
      const md = buildReport(adapter, state);
      writeFile(state.file("REPORT.md"), md);
      process.stdout.write(md + `\n<!-- saved to ${state.file("REPORT.md")} -->\n`);
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

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    log(`error: ${(e as Error).message}`);
    if (process.env.UNITGEN_VERBOSE === "1") console.error(e);
    process.exit(1);
  },
);
