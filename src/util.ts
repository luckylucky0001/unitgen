// Shared helpers: subprocess, logging, JSON5, file walking.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const VERBOSE = process.env.UNITGEN_VERBOSE === "1";

export function log(msg: string): void {
  process.stderr.write(`[unitgen] ${msg}\n`);
}

export function debug(msg: string): void {
  if (VERBOSE) log(msg);
}

export interface CmdResult {
  cmd: string[];
  code: number;
  out: string;
  seconds: number;
  timedOut: boolean;
  ok: boolean;
}

export interface RunOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
  logFile?: string;
  input?: string;
  signal?: AbortSignal;
  /** Stream build output to stderr; stdout remains reserved for CLI results / JSON. */
  stream?: boolean;
}

const cancellation = new AbortController();
export const runSignal = cancellation.signal;
export function cancelRuns(): void { cancellation.abort(); }
export class RunCancelled extends Error {
  constructor() { super("command cancelled"); }
}

/** Long-running builds stay observable and cancellable without changing synchronous discovery. */
export async function runAsync(cmd: string[], opts: RunOpts = {}): Promise<CmdResult> {
  const signal = opts.signal ?? cancellation.signal;
  if (signal.aborted || cancellation.signal.aborted) throw new RunCancelled();
  const start = Date.now();
  const stream = opts.stream ?? (!!opts.logFile && process.env.UNITGEN_QUIET !== "1");
  if (opts.logFile) writeFile(opts.logFile, `$ ${cmd.map(shq).join(" ")}\n\n`);
  if (stream) log(`running ${cmd[0]}; log: ${opts.logFile ?? "stderr"}`);
  return await new Promise<CmdResult>((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd: opts.cwd, env: { ...process.env, ...opts.env },
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid && process.send) process.send({ type: "unitgen-build-start", pid: child.pid });
    let out = "", size = 0, timedOut = false, cancelled = false, overflow = false;
    let spawnError: Error | undefined;
    let logError: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const kill = (hard: boolean) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        else process.kill(-child.pid, hard ? "SIGKILL" : "SIGTERM");
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") child.kill(hard ? "SIGKILL" : "SIGTERM"); }
    };
    const stop = () => {
      kill(false);
      if (!force) force = setTimeout(() => kill(true), 1500);
    };
    const abort = () => { cancelled = true; stop(); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal !== cancellation.signal) cancellation.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; stop(); }, (opts.timeoutSec ?? 1800) * 1000);
    const heartbeat = setInterval(() => {
      if (stream) log(`still running (${Math.floor((Date.now() - start) / 1000)}s); log: ${opts.logFile ?? "stderr"}`);
    }, 30000);
    const capture = (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > 256 * 1024 * 1024) { overflow = true; stop(); return; }
      out += chunk;
      if (opts.logFile && !logError) {
        try { fs.appendFileSync(opts.logFile, chunk); }
        catch (e) { logError = e as Error; stop(); }
      }
      if (stream) process.stderr.write(chunk);
    };
    child.stdout.setEncoding("utf8").on("data", capture);
    child.stderr.setEncoding("utf8").on("data", capture);
    child.on("error", (e) => { spawnError = e; });
    child.stdin.on("error", () => { /* Child may exit without reading the entire prompt. */ });
    child.stdin.end(opts.input);
    child.on("close", (status) => {
      if (child.pid && process.send) process.send({ type: "unitgen-build-end", pid: child.pid });
      clearTimeout(timer); clearInterval(heartbeat);
      // A descendant may survive the parent and close its pipes: finish group termination too.
      if (cancelled || timedOut || overflow || logError) kill(true);
      if (force) clearTimeout(force);
      signal.removeEventListener("abort", abort);
      cancellation.signal.removeEventListener("abort", abort);
      if (timedOut) out += `\n[unitgen] TIMEOUT after ${opts.timeoutSec ?? 1800}s`;
      if (overflow) out += "\n[unitgen] output exceeded 256 MiB";
      if (spawnError) out += `\n${spawnError.message}`;
      const code = cancelled ? 130 : timedOut || overflow ? -1 : spawnError ? ((spawnError as NodeJS.ErrnoException).code === "ENOENT" ? 127 : -1) : status ?? -1;
      const result = { cmd, code, out, seconds: (Date.now() - start) / 1000, timedOut, ok: code === 0 };
      if (opts.logFile && !logError) {
        try { fs.appendFileSync(opts.logFile, `\n# exit=${code} ${result.seconds.toFixed(1)}s\n`); }
        catch (e) { logError = e as Error; }
      }
      if (cancelled) reject(new RunCancelled()); else if (logError) reject(logError); else resolve(result);
    });
    if (signal.aborted || cancellation.signal.aborted) abort();
  });
}

/** Run a command with stdout+stderr merged. Never throws on a non-zero exit. */
export function run(cmd: string[], opts: RunOpts = {}): CmdResult {
  const start = Date.now();
  debug(`$ (cd ${opts.cwd ?? "."}) ${cmd.map(shq).join(" ")}`);
  const p = spawnSync(cmd[0], cmd.slice(1), {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    input: opts.input,
    timeout: (opts.timeoutSec ?? 1800) * 1000,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const timedOut = (p.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  let out = (p.stdout?.toString("utf8") ?? "") + (p.stderr?.toString("utf8") ?? "");
  let code = p.status ?? -1;
  if (p.error && !timedOut) {
    out += `\n${p.error.message}`;
    code = (p.error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : -1;
  }
  if (timedOut) out += `\n[unitgen] TIMEOUT after ${opts.timeoutSec ?? 1800}s`;
  const res: CmdResult = {
    cmd, code, out, seconds: (Date.now() - start) / 1000, timedOut, ok: code === 0 && !timedOut,
  };
  if (opts.logFile) writeFile(opts.logFile, `$ ${cmd.map(shq).join(" ")}\n# exit=${code} ${res.seconds.toFixed(1)}s\n\n${out}`);
  return res;
}

export function shq(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function which(name: string): string | undefined {
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch { /* not here */ }
  }
  return undefined;
}

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

export function readFile(p: string): string {
  return fs.readFileSync(p, "utf8");
}

export function writeFile(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

export function readJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(readFile(p)) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(p: string, v: unknown): void {
  writeFile(p, JSON.stringify(v, null, 2) + "\n");
}

export const SKIP_DIRS = new Set([
  ".git", ".build", "build", ".gradle", "node_modules", "oh_modules", ".hvigor", "Pods", "Carthage",
  "DerivedData", ".unitgen", ".idea", ".swiftpm", ".cxx", "out",
]);

export function walkFiles(root: string, exts: string[], skip: Set<string> = SKIP_DIRS): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name) && !e.name.startsWith(".")) visit(p);
      } else if (exts.some((x) => e.name.endsWith(x))) {
        found.push(p);
      }
    }
  };
  visit(root);
  return found.sort();
}

/** Good-enough JSON5: comments, trailing commas, unquoted keys, single-quoted strings. */
export function json5Parse(text: string): any {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      let buf = "";
      while (j < n && text[j] !== c) {
        if (text[j] === "\\" && j + 1 < n) {
          buf += text[j + 1] === "'" ? "'" : text.slice(j, j + 2);
          j += 2;
          continue;
        }
        buf += text[j] === '"' ? '\\"' : text[j];
        j++;
      }
      out += `"${buf}"`;
      i = j + 1;
    } else if (text.startsWith("//", i)) {
      const j = text.indexOf("\n", i);
      i = j < 0 ? n : j;
    } else if (text.startsWith("/*", i)) {
      const j = text.indexOf("*/", i + 2);
      i = j < 0 ? n : j + 2;
    } else {
      out += c;
      i++;
    }
  }
  out = out.replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, '$1"$2":').replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(out);
}

export function tailLines(text: string, n = 60): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(-n).join("\n");
}

export function relPath(p: string, root: string): string {
  return path.relative(root, p) || ".";
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** Pull lines that look like compiler/test errors, with a little context. */
export function errorExcerpt(out: string, maxLines = 80): string {
  const lines = stripAnsi(out).split("\n");
  const pick = new Set<number>();
  const re = /(error[:\s]|e: |FAILED|failed|Exception|AssertionError|Expectation failed|✘|expected|Caused by|Unresolved reference|cannot find|No such module)/i;
  lines.forEach((l, i) => {
    // Compiler warnings about production code are noise for a failing generated test.
    if (/\bwarning:/.test(l) && !/\berror\b/.test(l)) return;
    if (re.test(l)) for (let k = Math.max(0, i - 1); k <= Math.min(lines.length - 1, i + 3); k++) pick.add(k);
  });
  const sel = [...pick].sort((a, b) => a - b).map((i) => lines[i]);
  const uniq: string[] = [];
  for (const l of sel) if (uniq[uniq.length - 1] !== l) uniq.push(l);
  if (uniq.length === 0) return tailLines(out, Math.min(maxLines, 40));
  return uniq.slice(0, maxLines).join("\n");
}

/** Put the existing test of `source` (FooTest, FooTests, Foo.test) first, then the given fallbacks. */
export function preferOwnTest(all: string[], source: string | undefined, fallback: string[], limit = 2): string[] {
  if (!source) return fallback.slice(0, limit);
  const base = path.basename(source).replace(/\.[^.]+$/, "");
  const own = all.filter((f) => new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(Test|Tests|Spec)?(\.test)?\.[^.]+$`).test(path.basename(f)) && !/UnitGen|\.unitgen\./.test(path.basename(f)));
  return [...new Set([...own, ...fallback])].slice(0, limit);
}
