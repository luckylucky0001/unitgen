// Serialize even read commands: startup recovery must never undo a live mutation.
//
// The lock records the supervisor, its worker and every build process group it started. After a
// forced kill (SIGKILL, closed terminal, crashed agent session) the next command takes the lock over
// by itself when none of them is alive any more; startup recovery then restores interrupted mutations.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { processTable, signalAll } from "./util.ts";

export interface LockData {
  pid: number;
  at: string;
  worker?: number;
  /** Process groups (POSIX) / process trees (Windows) of running builds. */
  builds?: number[];
  /** Descendants seen while running, with their start time (identifies them even after re-parenting). */
  procs?: { pid: number; start: string }[];
}

/** Is `pid` a running process? With `since`, a process started after that time is a reused PID, not the owner. */
function alive(pid: number | undefined, group = false, since?: string): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(group && process.platform !== "win32" ? -pid : pid, 0);
  } catch (e) {
    // EPERM: exists but belongs to someone else.
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (since && process.platform !== "win32") {
    const started = Date.parse(spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stdout?.trim() ?? "");
    const locked = Date.parse(since);
    // lstart has 1 s resolution: allow for it.
    if (Number.isFinite(started) && Number.isFinite(locked) && started > locked + 1000) return false;
  }
  return true;
}

function readLock(file: string): LockData | undefined {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as LockData; } catch { return undefined; }
}

export function acquireProjectLock(root: string, onStale: (msg: string) => void = (m) => process.stderr.write(`[unitgen] ${m}\n`)): { release: () => void; update: (d: Partial<LockData>) => void } {
  const file = path.join(root, ".unitgen", "run.lock");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd: number | undefined;
  for (let attempt = 0; attempt < 2 && fd === undefined; attempt++) {
    try { fd = fs.openSync(file, "wx", 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const owner = readLock(file);
      // A lock without readable content may be being written right now: treat it as held.
      if (!owner) throw new Error(`project locked: ${file} (owner unknown). Wait for the active command, or remove the file if no unitgen command is running.`);
      if (alive(owner.pid, false, owner.at)) {
        throw new Error(`project locked by a running unitgen command (PID ${owner.pid}, since ${owner.at}). Wait for it to finish, or stop it with Ctrl-C / kill ${owner.pid}.`);
      }
      // Leftovers of the killed command, identified by PID *and* start time (never a reused PID):
      // test helpers stuck in an endless loop would otherwise keep running and growing. Stop them.
      if (owner.procs?.length) {
        const table = processTable();
        const ours = table.filter((p) => owner.procs!.some((q) => q.pid === p.pid && q.start === p.start));
        if (ours.length) {
          signalAll(ours, true);
          onStale(`stopped ${ours.length} process(es) the killed unitgen command left running (${ours.map((p) => p.pid).join(", ")})`);
        }
      }
      // The worker is a single process; builds are process groups (they were spawned detached).
      const live = [...new Set([...(alive(owner.worker) ? [owner.worker!] : []), ...(owner.builds ?? []).filter((p) => alive(p, true))])]
        .filter((p) => !owner.procs?.some((q) => q.pid === p));
      if (live.length) {
        const how = process.platform === "win32" ? live.map((p) => `taskkill /pid ${p} /T /F`).join(" & ") : `kill -TERM ${live.map((p) => `-${p}`).join(" ")}`;
        throw new Error(`a previous unitgen command (PID ${owner.pid}) was killed, but its build processes are still running (${live.join(", ")}). Stop them (${how}) and run the command again; unitgen then restores any interrupted mutation by itself.`);
      }
      // Another command may have taken the stale lock over meanwhile: only remove the exact lock we judged.
      const again = readLock(file);
      if (!again || again.pid !== owner.pid || again.at !== owner.at) {
        throw new Error(`project locked: another unitgen command (PID ${again?.pid ?? "unknown"}) just took over the stale lock. Wait for it to finish.`);
      }
      fs.rmSync(file, { force: true });
      onStale(`removed a stale lock: the unitgen command that held it (PID ${owner.pid}, ${owner.at}) is no longer running`);
    }
  }
  if (fd === undefined) throw new Error(`could not acquire ${file}`);
  const data: LockData = { pid: process.pid, at: new Date().toISOString() };
  try { fs.writeFileSync(fd, JSON.stringify(data) + "\n"); }
  catch (e) { fs.closeSync(fd); fs.unlinkSync(file); throw e; }
  fs.closeSync(fd);
  return {
    release: () => fs.rmSync(file, { force: true }),
    update: (d) => {
      Object.assign(data, d);
      try { fs.writeFileSync(file, JSON.stringify(data) + "\n"); } catch { /* best effort: the lock itself still exists */ }
    },
  };
}
