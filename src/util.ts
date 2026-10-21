// Shared helpers: subprocess, logging, JSON5, file walking.
import { spawnSync } from "node:child_process";
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
    if (re.test(l)) for (let k = Math.max(0, i - 1); k <= Math.min(lines.length - 1, i + 3); k++) pick.add(k);
  });
  const sel = [...pick].sort((a, b) => a - b).map((i) => lines[i]);
  const uniq: string[] = [];
  for (const l of sel) if (uniq[uniq.length - 1] !== l) uniq.push(l);
  if (uniq.length === 0) return tailLines(out, Math.min(maxLines, 40));
  return uniq.slice(0, maxLines).join("\n");
}
