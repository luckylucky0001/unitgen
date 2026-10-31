// Mutation check: does an accepted test actually detect behaviour changes in the lines it covers?
// Each mutant flips one operator/literal on a covered line of the target, re-runs only that test
// file, and counts it as killed (a test failed) or survived (all passed). Mutants that do not
// compile are discarded. The source file is always restored, also after a crash (see recover()).
import * as fs from "node:fs";
import * as path from "node:path";
import type { Adapter } from "./adapters/types.ts";
import type { State } from "./state.ts";
import { exists, log, readFile, readJson, relPath, writeFile } from "./util.ts";
import { fileHash } from "./verify.ts";

export interface Mutant {
  line: number;
  /** Stable id `<line>.<n>` (n-th mutant generated for that line), for `--equivalent 12.2`. */
  id?: string;
  /** Last line replaced (multi-line statement deletion); defaults to `line`. */
  endLine?: number;
  op: string;
  original: string;
  mutated: string;
}

export interface MutantResult extends Mutant {
  outcome: "killed" | "killed-crash" | "survived" | "equivalent" | "stillborn" | "error";
  /** Content hash of the test file the outcome was measured with. */
  testHash?: string;
  /** Runner that measured it (Adapter.runnerName): the HarmonyOS shim and hvigor can disagree. */
  runner?: string;
}

export interface MutationReport {
  testFile: string;
  target: string;
  killed: number;
  /** Of `killed`: detected only because the code crashed, not by an assertion. */
  crashes: number;
  survived: number;
  stillborn: number;
  score: number;
  results: MutantResult[];
  feedback: string;
  /** Mutants that could be generated for the covered lines, minus excluded ones (a run samples up to --max). */
  candidates: number;
  /** Mutants not run because they were marked equivalent. */
  excluded?: number;
  /** Candidates evaluated in this or earlier runs. */
  triedTotal?: number;
  /** Latest outcome of every mutant evaluated so far (re-runs re-check survivors first). */
  history?: MutantResult[];
  /** Mutant runs of this invocation that produced no test results. */
  errors?: number;
}

export function mutationGate(r: MutationReport, minimum = 80): { status: "PASSED" | "FAILED" | "NOT_APPLICABLE"; minimum: number; reason?: string } {
  if (r.candidates === 0 || (r.results.length > 0 && r.results.every((x) => x.outcome === "equivalent"))) return { status: "NOT_APPLICABLE", minimum };
  const errors = r.results.filter((x) => x.outcome === "error"); // this run only
  if (errors.length) {
    return { status: "FAILED", minimum, reason: `${errors.length} mutant run(s) produced no test results (${errors.map((e) => `line ${e.line}`).join(", ")}): the test run crashed or exited early; see the mutant logs. Fix the cause (e.g. a test awaiting a promise that never settles) and re-run` };
  }
  if (r.killed + r.survived === 0) {
    // Every candidate failed to compile or is marked equivalent: there is nothing to score.
    if ((r.triedTotal ?? r.results.length) >= r.candidates) return { status: "NOT_APPLICABLE", minimum, reason: "no candidate mutant compiles (the rest are marked equivalent): nothing to score" };
    return { status: "FAILED", minimum, reason: "no mutant was evaluated yet: re-run mutate" };
  }
  if (r.score * 100 < minimum) return { status: "FAILED", minimum, reason: `score ${(r.score * 100).toFixed(0)}% is below ${minimum}%` };
  // A pass on a sample is a pass, but say so: the rest may still hold survivors.
  const tried = r.triedTotal ?? r.results.length;
  if (tried < r.candidates) return { status: "PASSED", minimum, reason: `on ${tried} of ${r.candidates} candidates; ${r.candidates - tried} not evaluated yet, which may still survive (re-run mutate to evaluate them)` };
  return { status: "PASSED", minimum };
}

// [name, pattern, replacement]. Patterns require surrounding spaces where a token is ambiguous
// (generics `<T>`, arrows `->`/`=>`, unary minus, `++`).
const OPERATORS: [string, RegExp, string][] = [
  ["== -> !=", / == /, " != "],
  ["!= -> ==", / != /, " == "],
  ["=== -> !==", / === /, " !== "],
  ["!== -> ===", / !== /, " === "],
  ["<= -> <", / <= /, " < "],
  [">= -> >", / >= /, " > "],
  ["< -> <=", / < /, " <= "],
  ["> -> >=", / > /, " >= "],
  // Also at the end of a line: multi-line conditions (`a ||` / `b`).
  ["&& -> ||", / &&(?=\s|$)/, " ||"],
  ["|| -> &&", / \|\|(?=\s|$)/, " &&"],
  ["+ -> -", / \+ /, " - "],
  ["- -> +", / - /, " + "],
  ["* -> /", / \* /, " / "],
  ["true -> false", /\btrue\b/, "false"],
  ["false -> true", /\bfalse\b/, "true"],
  // Not `$0` (Swift closure argument) and not a literal in a type union (`flag: 0 | 1`).
  ["0 -> 1", /(?<![\w.$])(?<!\|\s*)0(?![\w.x])(?!\s*\|)/, "1"],
  ["1 -> 0", /(?<![\w.$])(?<!\|\s*)1(?![\w.])(?!\s*\|)/, "0"],
];

/** Replace string/char literals with same-length placeholders so operators inside them are ignored. */
function maskStrings(line: string): string {
  return line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, (s) => "\u0000".repeat(s.length));
}

const KEYWORD_START = /^(return|val|var|let|const|if|else|for|while|do|throw|try|catch|finally|case|default|guard|defer|import|package|func|fun|class|struct|enum|interface|object|switch|when|break|continue|super|this\s*\(|init|deinit|subscript|get|set|willSet|didSet|extension|protocol|typealias|associatedtype|where|operator|precedencegroup|actor|mutating|nonmutating|convenience|required|lazy|weak|unowned|fileprivate|open|final|indirect|override|private|public|internal|protected|static|export|function|async|await|yield|@)\b|^@/;

/** A declaration line (Swift/Kotlin/TS): its operators are part of a signature, not code (`static func + (`). */
const DECLARATION = /^\s*((public|private|internal|fileprivate|open|static|class|final|override|mutating|nonmutating|convenience|required|prefix|postfix|infix|@\w+(\([^)]*\))?)\s+)*(func|fun|subscript|init|deinit|operator|precedencegroup|constructor)\b/;

/** A TS/ArkTS method header with a return type (`toString(): string {`): never a trailing-closure call. */
const TS_METHOD = /^\s*(async\s+)?[A-Za-z_$][\w$]*\s*(<[^>]*>)?\s*\([^)]*\)\s*:\s*[^=;]+\{\s*$/;

/** Is line `ln` (1-based) inside a constructor / init body? */
function inConstructor(src: string[], ln: number): boolean {
  let depth = 0;
  for (let j = ln - 2; j >= 0 && j >= ln - 400; j--) {
    const l = maskStrings(src[j].replace(/\/\/.*$/, ""));
    for (let i = l.length - 1; i >= 0; i--) {
      if (l[i] === "}") depth++;
      else if (l[i] === "{" && depth-- === 0) {
        depth = 0;
        if (/\b(constructor\s*\(|init\s*[({?!]|init\s*$)/.test(l)) return true;
        if (DECLARATION.test(l) || TS_METHOD.test(l) || /^\s*(export\s+)?(class|struct|object|interface|enum|extension)\b/.test(l)) return false;
      }
    }
  }
  return false;
}

/**
 * A local declared without a value (`let font: Font?` / `let x: number;` then `x = ...`): deleting the
 * assignment uses it before it is set, which Swift and strict TS reject. A `var` whose type admits
 * nil/undefined starts with that value, so deleting is fine there.
 */
function declaredWithoutValue(text: string, name: string): boolean {
  const n = name.replace(/\$/g, "\\$");
  const m = new RegExp(`^\\s*(let|var)\\s+${n}\\s*(?::\\s*([^=\\n;]*?))?\\s*;?\\s*$`, "m").exec(text);
  if (!m) return false;
  // TS `let x: T | undefined;` may stay unassigned; a Swift `let x: T?` may not.
  if (m[1] === "let") return !(m[2] && /\b(undefined|null)\b/.test(m[2]));
  return !(m[2] && /\?\s*$|\b(undefined|null)\b|^Optional</.test(m[2]));
}

/** Lines of the function body around line `ln` (1-based) up to that line; top-level code: the lines above it. */
function enclosingFunction(src: string[], ln: number): string {
  let depth = 0;
  for (let j = ln - 2; j >= 0; j--) {
    const l = maskStrings(src[j].replace(/\/\/.*$/, ""));
    for (let i = l.length - 1; i >= 0; i--) {
      if (l[i] === "}") depth++;
      else if (l[i] === "{" && depth-- === 0) {
        depth = 0;
        if (DECLARATION.test(l) || TS_METHOD.test(l) || /\bfunction\b|=>\s*\{\s*$|\b(get|set|willSet|didSet)\s*\{/.test(l)) return src.slice(j + 1, ln - 1).join("\n");
        if (/^\s*((export|public|private|internal|fileprivate|open|final|abstract|data)\s+)*(class|struct|enum|extension|actor|object|interface)\b/.test(l)) return "";
      }
    }
  }
  return src.slice(0, ln - 1).join("\n");
}

/** Text of the class/struct declaration around line `ln` (1-based), or "" when there is none. */
function enclosingType(src: string[], ln: number): string {
  const head = /^\s*((export|default|public|private|internal|fileprivate|open|final|abstract|data|sealed)\s+)*(class|struct|actor)\b/;
  let start = -1;
  for (let j = ln - 2; j >= 0; j--) if (head.test(src[j])) { start = j; break; }
  if (start < 0) return "";
  let depth = 0, opened = false;
  for (let j = start; j < src.length; j++) {
    for (const c of maskStrings(src[j].replace(/\/\/.*$/, ""))) {
      if (c === "{") { depth++; opened = true; }
      if (c === "}") depth--;
    }
    if (opened && depth <= 0) return j + 1 >= ln ? src.slice(start, j + 1).join("\n") : "";
  }
  return src.slice(start).join("\n");
}

/**
 * `name` is a stored field without a default (`id: number;`, `let id: Int`, `val id: Int`): the
 * compiler requires every constructor to assign it, so deleting that assignment cannot compile.
 */
function fieldWithoutDefault(text: string, name: string): boolean {
  const n = name.replace(/\$/g, "\\$");
  return new RegExp(`^\\s*((public|private|protected|internal|fileprivate|readonly|final|override|let|var|val)\\s+)*${n}\\s*:\\s*[^=?{}\\n]+?[^?]\\s*;?\\s*$`, "m").test(text)
    && !new RegExp(`^\\s*.*\\b(lateinit|optional)\\b.*\\b${n}\\s*:`, "m").test(text);
}

/**
 * `x == null || x.y`, `x != null && x.y`, and `!x || x.y` / `x && x.y` for an `x` declared optional or
 * nullable in this file: with the other operator the compiler sees a dereference of a missing value.
 * (For a plain `string`, `s && s.length` -> `||` still compiles, so truthiness alone is not enough.)
 */
function nullGuard(masked: string, op: "&&" | "||", text: string): boolean {
  const i = masked.search(new RegExp(` ${op === "&&" ? "&&" : "\\|\\|"}(?=\\s|$)`));
  if (i < 0) return false;
  const left = masked.slice(0, i), right = masked.slice(i + op.length + 2);
  const g = op === "||"
    ? /(?:!\s*([\w$.]+)|([\w$.]+)\s*===?\s*(?:null|undefined|nil))\s*\)*\s*$/.exec(left)
    : /(?:(?<![!=<>]\s*)\b([\w$.]+)|([\w$.]+)\s*!==?\s*(?:null|undefined|nil))\s*$/.exec(left);
  const name = g?.[2] ?? g?.[1];
  if (!name) return false;
  if (!g?.[2]) {
    const n = name.split(".").pop()!.replace(/\$/g, "\\$");
    if (!new RegExp(`\\b${n}\\s*\\?\\s*:|\\b${n}\\s*:[^=;,)\\n]*\\|\\s*(null|undefined)\\b|\\b${n}\\s*:\\s*(null|undefined)\\s*\\|`).test(text)) return false;
  }
  return new RegExp(`^\\(*\\s*${name.replace(/[.$]/g, "\\$&")}(\\?|!)?\\.`).test(right);
}

/** Parentheses and braces balance (strings masked) and never go negative. */
function balanced(t: string): boolean {
  let p = 0, b = 0;
  for (const c of maskStrings(t)) {
    if (c === "(") p++;
    if (c === ")") p--;
    if (c === "{") b++;
    if (c === "}") b--;
    if (p < 0 || b < 0) return false;
  }
  return p === 0 && b === 0;
}

const CALL_START = /^(try\s+|await\s+|try\s+await\s+)?[A-Za-z_$][\w$]*(\??\.[A-Za-z_$][\w$]*)*(<[^>]*>)?\s*[({]/;

/**
 * A standalone call statement, balanced on one line: `foo.bar(x)`, `save()`, `list.add(y);`, and
 * trailing-closure calls `items.forEach { $0.reset() }` / `builder.add(x) { ... }`.
 */
function isCallStatement(t: string): boolean {
  if (KEYWORD_START.test(t.replace(/^(try|await)\s+/, "")) || /^[)\]}]/.test(t) || !CALL_START.test(t)) return false;
  if (!/(\)|\})\s*;?$/.test(t)) return false;
  // Before any closure body: no assignment (`a = f()`, `let x = ...`).
  const head = maskStrings(t).split("{")[0];
  return balanced(t) && !/[^=!<>]=[^=]/.test(head);
}

/** `name = value`, `a.b.c = value`, `n += 1` on one line (not a declaration, not `this.`/`self.`). */
function isPlainAssignment(t: string): boolean {
  const m = maskStrings(t);
  return !KEYWORD_START.test(t) && /^[A-Za-z_$][\w$]*(\??\.[A-Za-z_$][\w$]*|\[[^\]]*\])*\s*([+\-*\/%]|\?\?)?=(?![=>])/.test(m)
    && !/^(this|self)\./.test(m) && balanced(t) && !/[{(\[]\s*$/.test(m);
}

/** A member assignment statement on one line: `this.total = a + b;`, `self.state = .idle`. */
function isMemberAssignment(t: string): boolean {
  const m = maskStrings(t);
  return /^(this|self)\.[A-Za-z_$][\w$.]*\s*=[^=]/.test(m) && balanced(t) && !/[{]\s*$/.test(m);
}

/** Logging statements: mutating them (or the string concatenation inside) changes nothing a test should check. */
// Includes project wrappers named like loggers (LogUtils.d, AppLogger.info, this.logger.warn, TLog.e) —
// a capital "Log" suffix, so Catalog/Dialog are not matched.
const LOG_CALL = new RegExp([
  String.raw`^(await\s+)?((this|self)\.)?(console|hilog|Log|Logger|logger|log|Timber|print|println|debugPrint|NSLog|os_log)\b\s*[.(]`,
  // Wrappers must call a logging method: `auditLog.record(x)` / `changeLog.push(x)` are domain code.
  String.raw`^(await\s+)?((this|self)\.)?(?:[A-Za-z_$][\w$]*?)?(Log|Logger|LogUtils?|Logging)\s*\.\s*(v|d|i|w|e|f|debug|info|warn|warning|error|fatal|trace|verbose|log)\s*\(`,
].join("|"));

/** `literalNarrowing`: the compiler narrows `x === 64` to the literal type (strict TS/ArkTS under hvigor). */
export interface MutantOptions { literalNarrowing?: boolean }

export function mutantsFor(text: string, lines: number[], opts: MutantOptions = {}): Mutant[] {
  const out = mutantsForLines(text, lines, opts);
  const seen = new Map<number, number>();
  for (const m of out) {
    const n = (seen.get(m.line) ?? 0) + 1;
    seen.set(m.line, n);
    m.id = `${m.line}.${n}`;
  }
  return out;
}

/**
 * `c === 0x2D || c === 0x2E` (also spread over lines): flipping the first comparison to `!==`, or the
 * `||` after it to `&&`, makes the type checker narrow `c` to that literal on the right-hand side and
 * reject the next comparison of `c` ("no overlap"). The last comparison of a chain is fine.
 * `at`: index of the mutated operator in the line; `op`: its text.
 */
function literalChain(src: string[], ln: number, at: number, op: string): boolean {
  // Literal types: numbers, strings, booleans, null/undefined, and enum members (`DateType.YmdHms`).
  const lit = String.raw`(?:0x[\da-fA-F]+|\d+(?:\.\d+)?|\u0000+|true|false|null|undefined|[A-Z][\w$]*\.[A-Za-z_$][\w$]*)`;
  const id = String.raw`[A-Za-z_$][\w$.]*`;
  const line = maskStrings(src[ln - 1].replace(/\/\/.*$/, ""));
  // The rest of the condition: following lines while each one ends in `||` / `&&`.
  let next = "";
  for (let j = ln, prev = line; j < src.length && j < ln + 20 && /(\|\||&&)\s*$/.test(prev); j++) {
    prev = maskStrings(src[j].replace(/\/\/.*$/, ""));
    next += " " + prev;
  }
  const before = line.slice(0, at), after = line.slice(at + op.length) + " " + next;
  let v: string | undefined;
  let rest = after;
  if (op.includes("=")) {
    // `v === lit` or `lit === v`.
    const left = new RegExp(String.raw`(${id})\s*$`).exec(before)?.[1], afterLit = new RegExp(String.raw`^\s*${lit}(?![\w$])`).exec(after);
    const leftLit = new RegExp(String.raw`(?:^|[^\w$.])${lit}\s*$`).test(before), right = new RegExp(String.raw`^\s*(${id})`).exec(after);
    if (left && afterLit && !new RegExp(String.raw`^${lit}$`).test(left)) { v = left; rest = after.slice(afterLit[0].length); }
    else if (leftLit && right) { v = right[1]; rest = after.slice(right[0].length); }
    if (!v) return false;
    // In `if (v != 2) ... else if (v == 3)` the else branches see v narrowed as well.
    if (/\bif\s*\(/.test(before)) rest += " " + elseIfConditions(src, ln);
  } else {
    v = new RegExp(String.raw`(${id})\s*[!=]==?\s*${lit}\s*\)*\s*$`).exec(before)?.[1]
      ?? new RegExp(String.raw`${lit}\s*[!=]==?\s*(${id})\s*\)*\s*$`).exec(before)?.[1];
    if (!v) return false;
    // A new `&&` narrows only its right operand.
    let depth = 0;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "(") depth++;
      else if (rest[i] === ")" && --depth < 0) { rest = rest.slice(0, i); break; }
      else if (depth === 0 && rest.startsWith("||", i)) { rest = rest.slice(0, i); break; }
    }
  }
  const name = v.replace(/[.$]/g, "\\$&");
  // `typeof v === 'object'` compares the typeof result, not v.
  return new RegExp(String.raw`(?<![\w$.])(?<!typeof\s+)${name}\s*[!=]==?\s*${lit}|${lit}\s*[!=]==?\s*${name}(?![\w$.])`).test(rest);
}

/** Conditions of the `else if (...)` branches that follow the `if` on line `ln` (same chain). */
function elseIfConditions(src: string[], ln: number): string {
  let depth = 0;
  const out: string[] = [];
  for (let j = ln - 1; j < src.length && j < ln + 200; j++) {
    let l = maskStrings(src[j].replace(/\/\/.*$/, ""));
    if (j > ln - 1 && depth === 1 && /^\s*\}\s*else\s+if\b/.test(l)) out.push(l);
    // The first line may itself be `} else if (...) {`: count from its `if`.
    if (j === ln - 1) l = l.slice(Math.max(0, l.search(/\bif\s*\(/)));
    for (const c of l) {
      if (c === "{") depth++;
      if (c === "}") depth--;
    }
    if (j > ln - 1 && depth <= 0) break;
  }
  return out.join(" ");
}

function mutantsForLines(text: string, lines: number[], opts: MutantOptions): Mutant[] {
  const src = text.split("\n");
  const out: Mutant[] = [];
  for (const ln of lines) {
    const original = src[ln - 1];
    if (original === undefined) continue;
    const t = original.trim();
    if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("import ") || t.startsWith("@") || /^(case|default)\b.*:$/.test(t)) continue;
    if (LOG_CALL.test(t)) continue;
    let masked = maskStrings(original.replace(/\/\/.*$/, (c) => " ".repeat(c.length)));
    // On a declaration line only the body is code: `static func + (l, r) -> T {` has none,
    // `fun answer() = 1` has `1`. Blank the signature so its operators are never mutated.
    if (DECLARATION.test(original)) {
      const open = masked.indexOf("(");
      let depth = 0, close = -1;
      for (let i = Math.max(0, open); open >= 0 && i < masked.length; i++) {
        if (masked[i] === "(") depth++;
        if (masked[i] === ")" && --depth === 0) { close = i; break; }
      }
      const rest = close >= 0 ? masked.slice(close + 1) : "";
      const body = /\{|(?<![=!<>])=(?![=>])/.exec(rest);
      const cut = body ? close + 1 + body.index + 1 : masked.length;
      masked = " ".repeat(cut) + masked.slice(cut);
    }
    for (const [op, re, rep] of OPERATORS) {
      const m = re.exec(masked);
      if (!m) continue;
      if ((op === "|| -> &&" && nullGuard(masked, "||", text)) || (op === "&& -> ||" && nullGuard(masked, "&&", text))) continue;
      if (opts.literalNarrowing && /^(=== -> !==|!== -> ===|== -> !=|!= -> ==|\|\| -> &&|&& -> \|\|)$/.test(op) && literalChain(src, ln, m.index, m[0])) continue;
      // `"0" + s` is a concatenation: `"0" - s` never compiles.
      if (op === "+ -> -" && (masked[m.index - 1] === "\u0000" || masked[m.index + m[0].length] === "\u0000")) continue;
      const mutated = original.slice(0, m.index) + rep + original.slice(m.index + m[0].length);
      out.push({ line: ln, op, original, mutated });
    }
    // `a ?? fallback` -> `fallback`: does any test see the value when it is present?
    const nc = /(?<![\w$.)\]])([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\([^()]*\)|\[[^\]]*\])*)\s*\?\?(?!=)\s*/.exec(masked);
    if (nc && !/^(return|await|throw|new|typeof|case)$/.test(nc[1])) {
      out.push({ line: ln, op: "?? -> fallback", original, mutated: original.slice(0, nc.index) + original.slice(nc.index + nc[0].length) });
    }
    // Negate a simple condition: if (flag) / if (a.b) / if (list.isEmpty()) -> if (!(...)).
    const cond = /\bif\s*\(\s*(!?[A-Za-z_$][\w$.]*(?:\(\))?)\s*\)/.exec(masked);
    if (cond) {
      const inner = original.slice(cond.index, cond.index + cond[0].length).replace(/\(\s*(!?[A-Za-z_$][\w$.]*(?:\(\))?)\s*\)/, (_, x: string) => (x.startsWith("!") ? `(${x.slice(1)})` : `(!${x})`));
      out.push({ line: ln, op: "negate condition", original, mutated: original.slice(0, cond.index) + inner + original.slice(cond.index + cond[0].length) });
    } else {
      // Swift/Kotlin-style without parentheses: `if flag {`, `guard isReady else {`, `while hasMore {`.
      const bare = /\b(if|guard|while)\s+(!?)([A-Za-z_$][\w$.]*(?:\([^()]*\))?)\s*(\{|else\b)/.exec(masked);
      if (bare && !/^(let|var|case)$/.test(bare[3])) {
        const at = bare.index + bare[0].indexOf(bare[2] + bare[3], bare[1].length);
        const mutated = original.slice(0, at) + (bare[2] ? original.slice(at + 1) : `!${original.slice(at)}`);
        out.push({ line: ln, op: "negate condition", original, mutated });
      }
    }
    // Integer constants other than 0/1 (limits, factors, sizes, error codes): n -> n + 1. In a
    // `case X: return 2001` line only the part after the label (the label itself is a pattern).
    const caseLabel = /^\s*case\b[^:]*:/.exec(masked);
    const from = caseLabel ? caseLabel[0].length : 0;
    const numRe = /(?<![\w.$#])(?<!\|\s*)([2-9]|[1-9]\d{1,5})(?![\w.])(?!\s*\|)/g;
    numRe.lastIndex = from;
    const num = /^\s*(import\b|#)/.test(original) ? null : numRe.exec(masked);
    if (num) {
      out.push({ line: ln, op: `${num[1]} -> ${Number(num[1]) + 1}`, original, mutated: original.slice(0, num.index) + String(Number(num[1]) + 1) + original.slice(num.index + num[1].length) });
    }
    // Strings appended to an accumulator (`format += "yyyy"`): is the piece checked?
    const append = /(\+=\s*)("(?:[^"\\]|\\.)+"|'(?:[^'\\]|\\.)+')\s*;?\s*$/.exec(maskStrings(original).indexOf("//") >= 0 ? original.slice(0, maskStrings(original).indexOf("//")) : original);
    if (append && !/\\\(|\$\{/.test(append[2])) {
      const at = append.index + append[1].length;
      const q = append[2][0];
      out.push({ line: ln, op: "string -> empty", original, mutated: original.slice(0, at) + q + q + original.slice(at + append[2].length) });
    }
    // Returned string literals (messages, keys, formats): does a test look at the text at all?
    // `masked` has comments blanked already; find the comment in the string-masked original.
    const comment = maskStrings(original).indexOf("//");
    const ret = /\breturn\s+("(?:[^"\\]|\\.)+"|'(?:[^'\\]|\\.)+')/.exec(comment >= 0 ? original.slice(0, comment) : original);
    if (ret && !/\\\(|\$\{/.test(ret[1])) {
      const at = ret.index + ret[0].length - ret[1].length;
      const q = ret[1][0];
      out.push({ line: ln, op: "string -> empty", original, mutated: original.slice(0, at) + q + q + original.slice(at + ret[1].length) });
    }
    // Thrown messages (`throw new Error('bad input')`): does a test look at which error it was?
    const thrown = /\bthrow\b.*?("(?:[^"\\]|\\.)+"|'(?:[^'\\]|\\.)+'|`[^`]+`)/.exec(comment >= 0 ? original.slice(0, comment) : original);
    if (thrown && !/\\\(/.test(thrown[1])) {
      const at = thrown.index + thrown[0].length - thrown[1].length;
      const q = thrown[1][0];
      out.push({ line: ln, op: "string -> empty", original, mutated: original.slice(0, at) + q + q + original.slice(at + thrown[1].length) });
    }
    // Returned template literals (`return \`${a}-${b}\``) are built strings too.
    const tpl = /\breturn\s+(`[^`]*`)/.exec(comment >= 0 ? original.slice(0, comment) : original);
    // Not a Swift escaped identifier (``return `default` ``).
    if (tpl && tpl[1].length > 2 && !/^`[A-Za-z_]\w*`$/.test(tpl[1])) {
      const at = tpl.index + tpl[0].length - tpl[1].length;
      out.push({ line: ln, op: "string -> empty", original, mutated: original.slice(0, at) + "``" + original.slice(at + tpl[1].length) });
    }
    const before = out.filter((x) => x.line === ln).length;
    // Statement deletion: does any test notice the call (or the stored value) never happens?
    // Not when the statement continues on the next line (`x = items` + `.filter(...)`) or this line
    // continues the previous one: deleting part of an expression only yields a syntax error.
    const next = src.slice(ln).find((l) => l.trim() && !/^\s*\/\//.test(l))?.trim() ?? "";
    const prev = [...src.slice(0, ln - 1)].reverse().find((l) => l.trim() && !/^\s*\/\//.test(l))?.replace(/\/\/.*$/, "").trimEnd() ?? "";
    const partOfLonger = /^(\?\.|\.|[+\-*/%]|&&|\|\||\?\?|\?|:|\)|\]|,)/.test(next) || /([=(\[,.+\-*/%&|:]|=>|\s\?)$/.test(prev);
    // A delegating initializer must call `self.init`: deleting it never compiles.
    if (partOfLonger || /^self\.init\b/.test(t)) { /* no deletion mutant */ } else if (isCallStatement(t)) {
      out.push({ line: ln, op: "delete statement", original, mutated: original.replace(t, "/* unitgen: statement deleted */") });
    } else if (isMemberAssignment(t)) {
      const field = /^(?:this|self)\.([A-Za-z_$][\w$]*)\s*=/.exec(t)?.[1];
      if (field && inConstructor(src, ln) && fieldWithoutDefault(enclosingType(src, ln), field)) continue;
      out.push({ line: ln, op: "delete assignment", original, mutated: original.replace(t, "/* unitgen: assignment deleted */") });
    } else if (before === 0 && isPlainAssignment(t)) {
      // `type = .string`, `obj.secret = undefined`, `count += 1`: otherwise nothing on such a line
      // is mutated at all. Only when no other operator applies, to keep the budget for conditions.
      const field = /^([A-Za-z_$][\w$]*)\s*=/.exec(t)?.[1];
      if (field && inConstructor(src, ln) && fieldWithoutDefault(enclosingType(src, ln), field)) continue;
      if (field && declaredWithoutValue(enclosingFunction(src, ln), field)) continue;
      out.push({ line: ln, op: "delete assignment", original, mutated: original.replace(t, "/* unitgen: assignment deleted */") });
    } else if (!DECLARATION.test(original) && !TS_METHOD.test(original) && !KEYWORD_START.test(t.replace(/^(try|await)\s+/, "")) && (/^[A-Za-z_$][\w$]*(\??\.[A-Za-z_$][\w$]*)*\($/.test(t) || (CALL_START.test(t) && /\{\s*(\w+(\s*,\s*\w+)*\s+in)?\s*$/.test(t) && !/[^=!<>]=[^=]/.test(maskStrings(t).split("{")[0])))) {
      // Multi-line call: `dao.insert(` ... `)`, or a trailing closure `builder.add(x) {` ... `}`:
      // delete the whole statement if it closes cleanly.
      let p = 0, b = 0;
      let end = -1;
      for (let j = ln - 1; j < src.length && j < ln + 60; j++) {
        for (const c of maskStrings(src[j].replace(/\/\/.*$/, ""))) {
          if (c === "(") p++;
          if (c === ")") p--;
          if (c === "{") b++;
          if (c === "}") b--;
        }
        if (p === 0 && b === 0) {
          end = j + 1;
          break;
        }
      }
      if (end > ln && /(\)|\})\s*;?\s*$/.test(src[end - 1])) {
        const indent = original.slice(0, original.length - original.trimStart().length);
        out.push({ line: ln, endLine: end, op: "delete statement", original: src.slice(ln - 1, end).join("\n"), mutated: `${indent}/* unitgen: statement deleted */` });
      }
    }
  }
  return out;
}

const PRIORITY = (op: string): number =>
  op === "delete statement" || op === "delete assignment" ? 0 : op === "negate condition" ? 1 : /[<>=!]=?|&&|\|\|/.test(op.split(" ")[0]) ? 2 : /^[+\-*]/.test(op) ? 3 : /^\d+ -> \d+$/.test(op) && !/^[01] ->/.test(op) ? 5 : 4;

/** Spread picks over distinct lines first (evenly spaced), then second operators per line, deterministically. */
export function pickMutants(all: Mutant[], max: number): Mutant[] {
  const byLine = new Map<number, Mutant[]>();
  for (const m of all) {
    if (!byLine.has(m.line)) byLine.set(m.line, []);
    byLine.get(m.line)!.push(m);
  }
  for (const list of byLine.values()) list.sort((a, b) => PRIORITY(a.op) - PRIORITY(b.op));
  const lines = [...byLine.keys()].sort((a, b) => a - b);
  const picked: Mutant[] = [];
  for (let round = 0; picked.length < max; round++) {
    const avail = lines.filter((l) => byLine.get(l)!.length > round);
    if (!avail.length) break;
    const need = Math.min(max - picked.length, avail.length);
    for (let k = 0; k < need; k++) picked.push(byLine.get(avail[Math.floor((k * avail.length) / need)])![round]);
  }
  return picked;
}

function journal(state: State): string {
  return state.file("mutation-in-progress.json");
}

/** Restore a target left mutated by an interrupted run. Safe to call on every start. */
export function recover(state: State): void {
  const j = readJson<{ target: string; backup: string } | null>(journal(state), null);
  if (!j) return;
  if (exists(j.backup)) {
    fs.copyFileSync(j.backup, j.target);
    fs.unlinkSync(j.backup);
    log(`restored ${j.target} after an interrupted mutation run`);
  }
  fs.unlinkSync(journal(state));
}

export async function mutate(adapter: Adapter, state: State, testFile: string, target: string, max = 15): Promise<MutationReport> {
  recover(state);
  const absTest = path.resolve(testFile);
  const absTarget = path.resolve(target);
  const relTest = relPath(absTest, adapter.root);
  const m = adapter.moduleFor(absTest) ?? adapter.moduleFor(absTarget);
  if (!m) throw new Error(`cannot determine module for ${testFile}`);
  const cov = state.perTestCoverage[relTest];
  if (!cov) throw new Error(`${relTest} has no recorded coverage: run \`unitgen verify\` until it is ACCEPTED first`);
  const lines = Object.entries(cov[absTarget] ?? {}).filter(([, h]) => h > 0).map(([l]) => Number(l));
  if (!lines.length) throw new Error(`${relTest} covers no line of ${relPath(absTarget, adapter.root)}`);
  const original = readFile(absTarget);
  const generated = mutantsFor(original, lines, { literalNarrowing: /^hvigor/.test(adapter.runnerName ?? "") });
  // The original text is part of the key: deletions share their `mutated` placeholder, and a changed
  // source line must not inherit an outcome measured on different code.
  const key = (mu: Mutant) => `${mu.line}|${mu.op}|${mu.original}|${mu.mutated}`;
  // Mutants the user judged equivalent are not run: `12` = every mutant on line 12, `12.2` = one
  // mutant. Ids are resolved to a stable key (line, operator, mutated text) the first time they are
  // used, so a later unitgen version that numbers mutants differently cannot exclude the wrong one.
  const eqAll = (state.data.equivalent ??= {});
  // Marks recorded before the key included the original text (`key:line|op|mutated`): upgrade in place.
  const legacy = (mu: Mutant) => `key:${mu.line}|${mu.op}|${mu.mutated}`;
  const specs = (eqAll[relTest] ?? []).map(String).map((x) => {
    const old = x.startsWith("key:") && !generated.some((g) => `key:${key(g)}` === x) ? generated.find((g) => legacy(g) === x) : undefined;
    if (old) return `key:${key(old)}`;
    if (!/^\d+\.\d+$/.test(x)) return x;
    const mu = generated.find((g) => g.id === x);
    if (!mu) { log(`warning: --equivalent ${x}: no such mutant on the covered lines (ignored)`); return x; }
    return `key:${key(mu)}`;
  });
  eqAll[relTest] = [...new Set(specs)];
  state.save();
  const isEq = (mu: Mutant) => specs.includes(String(mu.line)) || specs.includes(`key:${key(mu)}`);
  const excluded = generated.filter(isEq);
  const all = generated.filter((mu) => !isEq(mu));
  // Re-runs: re-check previous survivors first (did strengthening work?), then mutants never tried,
  // then mutants whose outcome was measured with an older version of the test file. Outcomes are keyed
  // by line, operator and mutated text (changed code yields new mutants) and count only for the test
  // content they were measured with; a mutant that does not compile stays discarded.
  const testHash = fileHash(absTest);
  const prevFile = state.file("mutation", `${path.basename(absTest)}.json`);
  const prev = readJson<{ results?: MutantResult[] } | null>(prevFile, null)?.results ?? [];
  const prevBy = new Map(prev.map((r) => [key(r), r]));
  const runner = adapter.runnerName;
  const valid = (r: MutantResult | undefined) => !!r && r.runner === runner && (r.outcome === "stillborn" || r.testHash === testHash);
  const rank = (mu: Mutant) => {
    const r = prevBy.get(key(mu));
    if (!r) return 1;
    // A survivor measured with this exact test file is decided; after strengthening it goes first.
    if (r.outcome === "error" || (r.outcome === "survived" && !valid(r))) return 0;
    return valid(r) ? 3 : 2;
  };
  const fresh = all.filter((mu) => rank(mu) < 3);
  // Pick more than needed: mutants that do not compile are replaced by the next candidates.
  const candidates = [0, 1, 2].flatMap((k) => pickMutants(fresh.filter((mu) => rank(mu) === k), max * 2));
  if (!all.length && !excluded.length) {
    const acc0 = state.data.accepted.find((a) => a.testFile === relTest);
    if (acc0) {
      acc0.mutation = { killed: 0, survived: 0, stillborn: 0, score: 1, first: acc0.mutation?.first, none: true };
      state.save();
    }
    return { testFile: relTest, target: relPath(absTarget, adapter.root), killed: 0, crashes: 0, survived: 0, stillborn: 0, score: 1, results: [], candidates: 0,
      feedback: `nothing to mutate: the ${lines.length} covered lines contain no operators, constants, simple conditions or statements unitgen can change` };
  }
  const results: MutantResult[] = [];
  if (candidates.length) {
    const backup = state.file("mutation.backup");
    fs.copyFileSync(absTarget, backup);
    writeFile(journal(state), JSON.stringify({ target: absTarget, backup }));
    const base = path.basename(absTest).replace(/\W+/g, "_");
    // Mutant runs print one result line each; their build/test output goes to the per-mutant logs only
    // (hundreds of test-output lines per mutant otherwise flood an agent's context).
    const quiet = process.env.UNITGEN_QUIET;
    process.env.UNITGEN_QUIET = "1";
    try {
      const clean = await adapter.runTests({ testFiles: [absTest], modules: [m], coverage: false, label: `mutant-${base}-0-clean` });
      if (!clean.ok || clean.tests.some((t) => t.status === "failed")) {
        throw new Error(`${relTest} does not pass on the unmodified code; fix it (unitgen verify) before mutating`);
      }
      // Mutants can loop forever (e.g. a binary search bound): cap each run and count a timeout as killed.
      // The clean run is a no-op incremental build, faster than a mutant's rebuild: start generous, then
      // follow what completed mutant runs actually took (3x the median + 10 s, never below 20 s).
      const done: number[] = [];
      const timeoutFor = () => {
        if (!done.length) return Math.max(60, Math.ceil(clean.seconds * 4) + 30);
        const median = [...done].sort((x, y) => x - y)[Math.floor(done.length / 2)];
        return Math.max(20, Math.ceil(clean.seconds * 2) + 10, Math.ceil(median * 3) + 10);
      };
      for (const [i, mu] of candidates.entries()) {
        if (results.filter((r) => r.outcome !== "stillborn").length >= max) break;
        const lines2 = original.split("\n");
        lines2.splice(mu.line - 1, (mu.endLine ?? mu.line) - mu.line + 1, mu.mutated);
        fs.writeFileSync(absTarget, lines2.join("\n"));
        const timeoutSec = timeoutFor();
        const r = await adapter.runTests({ testFiles: [absTest], modules: [m], coverage: false, label: `mutant-${base}-${mu.id}`, timeoutSec });
        const timedOut = r.infraError === "timeout" || /TIMEOUT after/.test(r.excerpt);
        if (!timedOut && r.seconds > 0) done.push(r.seconds);
        let outcome: MutantResult["outcome"];
        // A hang is detected, but not by an assertion.
        if (timedOut) outcome = "killed-crash";
        else if (r.infraError) outcome = "error";
        else if (!r.compiled) outcome = "stillborn";
        else if (!r.ok || r.tests.some((t) => t.status === "failed")) {
          // Killed by a crash (ReferenceError/TypeError, index out of range, a process that died) rather than
          // by an assertion: still a detected change, but flag it.
          const asserted = r.tests.some((t) => t.status === "failed" && /assert|expect|Expectation|AssertionError|expected|XCTAssert|#require/i.test(t.message ?? ""));
          outcome = asserted ? "killed" : "killed-crash";
        }
        else outcome = r.tests.length ? "survived" : "error";
        results.push({ ...mu, outcome, testHash, ...(runner ? { runner } : {}) });
        const shown = outcome === "stillborn" ? "did not compile (discarded)" : timedOut ? `killed (no result within ${timeoutSec}s: the mutant hangs)` : outcome;
        const left = fresh.length - results.length;
        log(`  mutant ${i + 1} (budget ${max}, ${left} still to decide of ${all.length}) [${mu.id}] line ${mu.line} (${mu.op}): ${shown}`);
      }
    } finally {
      if (quiet === undefined) delete process.env.UNITGEN_QUIET; else process.env.UNITGEN_QUIET = quiet;
      fs.writeFileSync(absTarget, original);
      fs.unlinkSync(backup);
      fs.unlinkSync(journal(state));
    }
  }
  // Cumulative over every run: the latest outcome of each current candidate mutant.
  const latest = new Map<string, MutantResult>();
  for (const r of [...prev, ...results]) latest.set(key(r), r);
  const current: MutantResult[] = all.flatMap((mu) => {
    const r = latest.get(key(mu));
    return r && (valid(r) || r.outcome === "survived") ? [{ ...r, id: mu.id }] : [];
  });
  const count = (o: MutantResult["outcome"][]) => current.filter((r) => o.includes(r.outcome)).length;
  const killed = count(["killed", "killed-crash"]), crashes = count(["killed-crash"]), survived = count(["survived"]), stillborn = count(["stillborn"]);
  const score = killed + survived ? killed / (killed + survived) : 0;
  const surv = current.filter((r) => r.outcome === "survived");
  const feedback = surv.length
    ? `These changes to ${relPath(absTarget, adapter.root)} were NOT detected by any test. Add assertions that would fail for each:\n` +
      surv.map((x) => `- [${x.id}] line ${x.line} (${x.op}):\n    ${x.original.trim()}\n  → ${x.mutated.trim()}`).join("\n") +
      `\nIf a survivor cannot change observable behaviour (equivalent mutant), exclude just that mutant by its id, e.g. unitgen mutate ${relTest} --equivalent ${surv[0].id} (a bare line number excludes every mutant on the line), and say why with unitgen note`
    : "";
  const report: MutationReport = { testFile: relTest, target: relPath(absTarget, adapter.root), killed, crashes, survived, stillborn, score, results, feedback, candidates: all.length,
    excluded: excluded.length, triedTotal: current.length, history: [...latest.values()],
    errors: results.filter((r) => r.outcome === "error").length };
  const acc = state.data.accepted.find((a) => a.testFile === relTest);
  if (acc) {
    const first = acc.mutation?.first ?? Math.round(score * 100) / 100;
    acc.mutation = { killed, survived, stillborn, score: Math.round(score * 100) / 100, first, crashes, equivalent: excluded.length, testHash: fileHash(absTest), evaluated: current.length, candidates: all.length };
    state.save();
  }
  writeFile(prevFile, JSON.stringify({ ...report, results: report.history }, null, 2));
  return report;
}

export function formatMutation(r: MutationReport): string {
  if (!r.candidates) return `mutation: NOT_APPLICABLE — ${r.feedback || "every mutant is excluded as equivalent"}`;
  const ran = r.results.length;
  const tried = r.triedTotal ?? ran;
  const head = `mutation score: ${(r.score * 100).toFixed(0)}%  (killed ${r.killed}${r.crashes ? `, of which ${r.crashes} only by a crash, not an assertion` : ""}, survived ${r.survived}, did not compile ${r.stillborn})  ${r.testFile} -> ${r.target}`;
  const scope = tried >= r.candidates
    ? `all ${r.candidates} candidate mutants evaluated with the current test file (${ran ? `${ran} run now` : "nothing new to run; result from earlier runs"})`
    : `${tried} of ${r.candidates} candidate mutants evaluated with the current test file (${ran} run now); re-run to evaluate the rest, or use --max ${r.candidates}`;
  const note = `\n${scope}` + (r.excluded ? `\n${r.excluded} mutant(s) excluded as equivalent (not run)` : "");
  return r.feedback ? `${head}${note}\n\n${r.feedback}` : `${head}${note}`;
}
