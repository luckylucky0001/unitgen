// Fully automatic loop: rank -> brief -> model -> verify -> feedback -> retry -> keep or quarantine.
import * as path from "node:path";
import * as fs from "node:fs";
import type { Adapter } from "./adapters/types.ts";
import { buildBrief } from "./context.ts";
import { extractCode, type LlmBackend } from "./llm.ts";
import type { State } from "./state.ts";
import { rankTargets } from "./targets.ts";
import { log, readJson, relPath, writeFile } from "./util.ts";
import { formatVerify, quarantine, verify, type VerifyResult } from "./verify.ts";
import { mutate, mutationGate } from "./mutate.ts";

export interface GenerateOpts {
  limit: number;
  attempts: number;
  files?: string[];
  module?: string;
  reruns: number;
  mutationMax?: number;
  minMutationScore?: number;
}

/** A killed worker must not leave verify-only acceptance masquerading as a passed generation. */
export function recoverGeneration(state: State): void {
  const file = state.file("generation-in-progress.json");
  const pending = readJson<{ testFile: string } | null>(file, null);
  if (!pending) return;
  state.data.accepted = state.data.accepted.filter((a) => a.testFile !== pending.testFile);
  state.setTestCoverage(pending.testFile, undefined);
  state.save();
  fs.unlinkSync(file);
}

export async function generate(adapter: Adapter, state: State, llm: LlmBackend, opts: GenerateOpts): Promise<VerifyResult[]> {
  const mods = opts.module ? adapter.modules().filter((m) => m.name === opts.module) : undefined;
  const targets = opts.files?.length
    ? opts.files.map((f) => path.resolve(f))
    : rankTargets(adapter, state.knownCoverage(), { modules: mods }).slice(0, opts.limit).map((t) => t.file);
  const results: VerifyResult[] = [];
  for (const [i, src] of targets.entries()) {
    log(`[${i + 1}/${targets.length}] ${relPath(src, adapter.root)} (model: ${llm.name})`);
    let feedback: string | undefined;
    let last: VerifyResult | undefined;
    for (let attempt = 1; attempt <= opts.attempts; attempt++) {
      const brief = buildBrief(adapter, state, src, { feedback });
      const reply = await llm.complete(brief.markdown);
      writeFile(brief.testPath, extractCode(reply));
      last = await verify(adapter, state, brief.testPath, {
        target: src, reruns: opts.reruns, attempts: attempt,
        onFail: attempt === opts.attempts ? "quarantine" : "keep",
      });
      log(`  attempt ${attempt}: ${last.verdict}${last.verdict === "accepted" ? ` (+${last.gainedLines} lines)` : ""}`);
      if (last.verdict === "accepted") {
        const pending = state.file("generation-in-progress.json");
        writeFile(pending, JSON.stringify({ testFile: relPath(brief.testPath, adapter.root) }));
        let mutation;
        try { mutation = await mutate(adapter, state, brief.testPath, src, opts.mutationMax ?? 15); }
        catch (e) {
          recoverGeneration(state);
          throw e;
        }
        const gate = mutationGate(mutation, opts.minMutationScore ?? 80);
        if (gate.status !== "FAILED") { fs.unlinkSync(pending); break; }
        last = { ...last, verdict: "mutation_failures", feedback: `Mutation gate failed (${Math.round(mutation.score * 100)}%). Strengthen assertions.\n${mutation.feedback}` };
        // A model/infra error on the next attempt must not leave a failed quality gate accepted.
        recoverGeneration(state);
        if (attempt === opts.attempts) quarantine(adapter, state, brief.testPath, "mutation_failures", attempt, src);
      }
      if (last.verdict === "infra_error") break;
      feedback = last.feedback;
    }
    if (last) {
      results.push(last);
      if (last.verdict === "infra_error") {
        log(formatVerify(last, adapter.root));
        break;
      }
    }
  }
  return results;
}
