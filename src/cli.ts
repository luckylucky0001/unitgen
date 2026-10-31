// Keep supervision responsive even while a platform's metadata discovery uses spawnSync.
import { fork, spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { acquireProjectLock } from "./lock.ts";
import { type ProcInfo, processTree, signalAll } from "./util.ts";
import { detectAdapter } from "./adapters/index.ts";
import { State } from "./state.ts";
import { recover } from "./mutate.ts";
import { CLI_OPTIONS } from "./cli-main.ts";
import { recoverGeneration } from "./generate.ts";

async function supervise(): Promise<number> {
  const argv = process.argv.slice(2);
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: CLI_OPTIONS });
  const help = !positionals.length || positionals[0] === "help" || values.help;
  const adapter = help ? undefined : detectAdapter(path.resolve(values.project ?? process.cwd()), values.adapter);
  const root = adapter?.root;
  const lock = root ? acquireProjectLock(root) : undefined;
  const release = lock ? lock.release : () => {};
  try {
    return await new Promise<number>((resolve, reject) => {
      const worker = fork(fileURLToPath(new URL("./cli-worker.ts", import.meta.url)), argv, {
        detached: process.platform !== "win32", stdio: ["inherit", "pipe", "pipe", "ipc"],
      });
      const builds = new Set<number>();
      lock?.update({ worker: worker.pid });
      let cancelled = false;
      let force: ReturnType<typeof setTimeout> | undefined;
      // Every process below the worker and its builds, remembered across snapshots: after a build exits,
      // helpers in their own process groups (swiftpm-testing-helper, xctest) are re-parented away.
      const tracked = new Map<number, ProcInfo>();
      const snapshot = () => {
        if (process.platform === "win32") return;
        for (const p of processTree([...(worker.pid ? [worker.pid] : []), ...builds])) tracked.set(p.pid, p);
        lock?.update({ procs: [...tracked.values()].map((p) => ({ pid: p.pid, start: p.start })) });
      };
      const kill = (pid: number, hard: boolean) => {
        try {
          if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
          else process.kill(-pid, hard ? "SIGKILL" : "SIGTERM");
        } catch (e) {
          // EPERM: the group exists only as a zombie leader (macOS); its members are handled by killTracked.
          const code = (e as NodeJS.ErrnoException).code;
          if (code !== "ESRCH" && code !== "EPERM") console.error(`unitgen: could not stop PID ${pid}: ${e}`);
        }
      };
      const killTracked = (hard: boolean) => {
        snapshot();
        signalAll([...tracked.values()], hard);
      };
      const watch = setInterval(snapshot, 3000);
      const stop = () => {
        cancelled = true;
        snapshot();
        for (const pid of builds) kill(pid, false);
        if (worker.pid) kill(worker.pid, false);
        if (!force) force = setTimeout(() => {
          for (const pid of builds) kill(pid, true);
          if (worker.pid) kill(worker.pid, true);
          killTracked(true);
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
          lock?.update({ builds: [...builds] });
          if (cancelled) kill(m.pid!, false);
        } else if (m.type === "unitgen-build-end") {
          builds.delete(m.pid!);
          lock?.update({ builds: [...builds] });
        }
      });
      worker.on("error", reject);
      worker.on("close", (code) => {
        if (force) clearTimeout(force);
        clearInterval(watch);
        process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
        process.stdout.removeListener("error", stop); process.stderr.removeListener("error", stop);
        // A cancelled run, or a worker that died while builds were still registered: nothing it started may
        // outlive it (helpers in their own process groups included). Normal exits keep build daemons.
        const abnormal = cancelled || builds.size > 0;
        for (const pid of builds) kill(pid, true);
        if (abnormal) killTracked(true);
        try {
          if (root) {
            const state = new State(root);
            recover(state);
            recoverGeneration(state);
            adapter?.recover?.();
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
