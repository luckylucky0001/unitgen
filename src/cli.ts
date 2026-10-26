// Keep supervision responsive even while a platform's metadata discovery uses spawnSync.
import { fork, spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { acquireProjectLock } from "./lock.ts";
import { detectAdapter } from "./adapters/index.ts";
import { State } from "./state.ts";
import { recover } from "./mutate.ts";
import { CLI_OPTIONS } from "./cli-main.ts";
import { recoverGeneration } from "./generate.ts";

async function supervise(): Promise<number> {
  const argv = process.argv.slice(2);
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: CLI_OPTIONS });
  const help = !positionals.length || positionals[0] === "help" || values.help;
  const root = help ? undefined : detectAdapter(path.resolve(values.project ?? process.cwd()), values.adapter).root;
  const release = root ? acquireProjectLock(root) : () => {};
  try {
    return await new Promise<number>((resolve, reject) => {
      const worker = fork(fileURLToPath(new URL("./cli-worker.ts", import.meta.url)), argv, {
        detached: process.platform !== "win32", stdio: ["inherit", "pipe", "pipe", "ipc"],
      });
      const builds = new Set<number>();
      let cancelled = false;
      let force: ReturnType<typeof setTimeout> | undefined;
      const kill = (pid: number, hard: boolean) => {
        try {
          if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
          else process.kill(-pid, hard ? "SIGKILL" : "SIGTERM");
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") console.error(`unitgen: could not stop PID ${pid}: ${e}`); }
      };
      const stop = () => {
        cancelled = true;
        for (const pid of builds) kill(pid, false);
        if (worker.pid) kill(worker.pid, false);
        if (!force) force = setTimeout(() => {
          for (const pid of builds) kill(pid, true);
          if (worker.pid) kill(worker.pid, true);
        }, 2000);
      };
      process.on("SIGINT", stop); process.on("SIGTERM", stop);
      // A log consumer can close a pipe early (for example `unitgen ... | head`).
      // Stop normally so restoration/lock release still happen instead of an uncaught EPIPE.
      process.stdout.on("error", stop); process.stderr.on("error", stop);
      worker.stdout!.pipe(process.stdout);
      worker.stderr!.pipe(process.stderr);
      worker.on("message", (message: unknown) => {
        const m = message as { type?: string; pid?: number };
        if (!Number.isSafeInteger(m?.pid) || m.pid! <= 0) return;
        if (m.type === "unitgen-build-start") {
          builds.add(m.pid!);
          if (cancelled) kill(m.pid!, false);
        } else if (m.type === "unitgen-build-end") builds.delete(m.pid!);
      });
      worker.on("error", reject);
      worker.on("close", (code) => {
        if (force) clearTimeout(force);
        process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
        process.stdout.removeListener("error", stop); process.stderr.removeListener("error", stop);
        for (const pid of builds) kill(pid, true);
        try {
          if (root) {
            const state = new State(root);
            recover(state);
            recoverGeneration(state);
          }
          resolve(cancelled ? 130 : code ?? 1);
        } catch (e) { reject(e); }
      });
    });
  } finally { release(); }
}

supervise().then((code) => process.exit(code), (e) => {
  console.error(`[unitgen] error: ${(e as Error).message}`);
  process.exit(1);
});
