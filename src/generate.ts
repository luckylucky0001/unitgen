// Fully automatic loop: rank -> brief -> model -> verify -> feedback -> retry -> keep or quarantine.
import * as path from "node:path";
import type { Adapter } from "./adapters/types.ts";
import { buildBrief } from "./context.ts";
import { extractCode, type LlmBackend } from "./llm.ts";
import type { State } from "./state.ts";
import { rankTargets } from "./targets.ts";
import { log, relPath, writeFile } from "./util.ts";
import { formatVerify, verify, type VerifyResult } from "./verify.ts";

export interface GenerateOpts {
  limit: number;
  attempts: number;
  files?: string[];
  module?: string;
  reruns: number;
}

export async function generate(adapter: Adapter, state: State, llm: LlmBackend, opts: GenerateOpts): Promise<VerifyResult[]> {
  const mods = opts.module ? adapter.modules().filter((m) => m.name === opts.module) : undefined;
  const targets = opts.files?.length
    ? opts.files.map((f) => path.resolve(f))
    : rankTargets(adapter, state.knownCoverage, { modules: mods }).slice(0, opts.limit).map((t) => t.file);
  const results: VerifyResult[] = [];
  for (const [i, src] of targets.entries()) {
    log(`[${i + 1}/${targets.length}] ${relPath(src, adapter.root)} (model: ${llm.name})`);
    let feedback: string | undefined;
    let last: VerifyResult | undefined;
    for (let attempt = 1; attempt <= opts.attempts; attempt++) {
      const brief = buildBrief(adapter, state, src, { feedback });
      const reply = await llm.complete(brief.markdown);
      writeFile(brief.testPath, extractCode(reply));
      last = verify(adapter, state, brief.testPath, {
        target: src, reruns: opts.reruns, attempts: attempt,
        onFail: attempt === opts.attempts ? "quarantine" : "keep",
      });
      log(`  attempt ${attempt}: ${last.verdict}${last.verdict === "accepted" ? ` (+${last.gainedLines} lines)` : ""}`);
      if (last.verdict === "accepted" || last.verdict === "infra_error") break;
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
