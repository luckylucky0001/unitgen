// Pluggable model backends for `unitgen generate`. The skill path does not use these: there,
// the coding agent itself writes the test and calls `unitgen verify`.
import { run, which } from "./util.ts";

export interface LlmBackend {
  name: string;
  complete(prompt: string): Promise<string>;
}

export function pickBackend(spec: string | undefined, model?: string): LlmBackend {
  const s = spec ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : which("claude") ? "claude" : "");
  if (s === "anthropic") return anthropic(model ?? process.env.UNITGEN_MODEL ?? "claude-sonnet-5-5");
  if (s === "claude") return claudeCli(model ?? process.env.UNITGEN_MODEL);
  if (s.startsWith("cmd:")) return command(s.slice(4));
  throw new Error("No model backend. Use --llm anthropic (needs ANTHROPIC_API_KEY), --llm claude (Claude Code CLI on PATH) or --llm 'cmd:<shell command reading the prompt on stdin>'. Or use the unitgen skill so the agent writes tests itself.");
}

function anthropic(model: string): LlmBackend {
  return {
    name: `anthropic:${model}`,
    async complete(prompt) {
      const res = await fetch(`${process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model, max_tokens: 16000, messages: [{ role: "user", content: prompt }] }),
      });
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const j: any = await res.json();
      return (j.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    },
  };
}

function claudeCli(model?: string): LlmBackend {
  return {
    name: `claude-cli${model ? ":" + model : ""}`,
    async complete(prompt) {
      const args = ["claude", "-p", "--output-format", "text"];
      if (model) args.push("--model", model);
      const r = run(args, { input: prompt, timeoutSec: 900 });
      if (!r.ok) throw new Error(`claude -p failed: ${r.out.slice(0, 500)}`);
      return r.out;
    },
  };
}

function command(cmd: string): LlmBackend {
  return {
    name: `cmd:${cmd}`,
    async complete(prompt) {
      const r = run(["sh", "-c", cmd], { input: prompt, timeoutSec: 900 });
      if (!r.ok) throw new Error(`model command failed: ${r.out.slice(0, 500)}`);
      return r.out;
    },
  };
}

/** Take the largest fenced code block, or the whole reply if there is none. */
export function extractCode(reply: string): string {
  const blocks = [...reply.matchAll(/```[\w+-]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (!blocks.length) return reply.trim() + "\n";
  return blocks.sort((a, b) => b.length - a.length)[0].trimEnd() + "\n";
}
