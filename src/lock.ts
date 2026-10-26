// Serialize even read commands: startup recovery must never undo a live mutation.
import * as fs from "node:fs";
import * as path from "node:path";

export function acquireProjectLock(root: string): () => void {
  const file = path.join(root, ".unitgen", "run.lock");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd: number;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let owner = "unknown";
    try { owner = JSON.parse(fs.readFileSync(file, "utf8")).pid; } catch { /* Partial lock is still a lock. */ }
    throw new Error(`project locked (PID ${owner}): ${file}. Wait for the active command. After a forced kill, verify that the owner and its build processes have stopped before removing this file; the next command restores interrupted mutations.`);
  }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n"); }
  catch (e) { fs.closeSync(fd); fs.unlinkSync(file); throw e; }
  fs.closeSync(fd);
  return () => fs.unlinkSync(file);
}
