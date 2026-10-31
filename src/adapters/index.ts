import * as fs from "node:fs";
import * as path from "node:path";
import { GradleAdapter } from "./gradle.ts";
import { HarmonyAdapter } from "./harmony.ts";
import { SwiftPMAdapter } from "./swiftpm.ts";
import type { Adapter } from "./types.ts";
import { XcodeAdapter } from "./xcode.ts";

const ADAPTERS = [
  { id: "harmony", detect: HarmonyAdapter.detect, make: (r: string, s: string) => new HarmonyAdapter(r, s) },
  { id: "gradle", detect: GradleAdapter.detect, make: (r: string, s: string) => new GradleAdapter(r, s) },
  // A Package.swift wins over an .xcodeproj next to it (simpler, no simulator); force with --adapter xcode.
  { id: "swiftpm", detect: SwiftPMAdapter.detect, make: (r: string, s: string) => new SwiftPMAdapter(r, s) },
  { id: "xcode", detect: XcodeAdapter.detect, make: (r: string, s: string) => new XcodeAdapter(r, s) },
];

/**
 * The project a command run inside it means, like git: the nearest directory upwards that holds
 * unitgen state or that an adapter recognises. A HarmonyOS module directory has its own
 * build-profile.json5 / oh-package.json5 / hvigorfile.ts; the app root above it lists the modules.
 */
export function findProjectRoot(start: string, forced?: string): string {
  const detects = (dir: string) => (forced ? ADAPTERS.filter((a) => a.id === forced) : ADAPTERS).some((a) => a.detect(dir));
  const harmonyModule = (dir: string) => {
    if (!HarmonyAdapter.detect(dir)) return false;
    try { return !/["']?\bmodules["']?\s*:/.test(fs.readFileSync(path.join(dir, "build-profile.json5"), "utf8")); } catch { return false; }
  };
  let moduleDir: string | undefined;
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".unitgen", "state.json"))) return dir;
    if (detects(dir)) {
      if (!harmonyModule(dir)) return dir;
      moduleDir ??= dir;
    }
    if (path.dirname(dir) === dir) return moduleDir ?? path.resolve(start);
  }
}

export function detectAdapter(root: string, forced?: string): Adapter {
  const abs = path.resolve(root);
  const stateDir = path.join(abs, ".unitgen");
  const pick = forced ? ADAPTERS.find((a) => a.id === forced) : ADAPTERS.find((a) => a.detect(abs));
  if (!pick) {
    const nested = forced ? [] : findNestedProjects(abs);
    throw new Error(`No supported project at ${abs}. Supported: SwiftPM (Package.swift), Xcode (.xcodeproj/.xcworkspace), Gradle Android/JVM (settings.gradle[.kts]), HarmonyOS (build-profile.json5).`
      + (nested.length ? `\nProjects found below it (pass one with -C): ${nested.map((n) => path.relative(abs, n) || ".").join(", ")}` : ""));
  }
  return pick.make(abs, stateDir);
}

/** Up to three directory levels down, skipping dependency/build folders: roots some adapter recognises. */
function findNestedProjects(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || out.length >= 10) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || ["node_modules", "oh_modules", "build", "Pods", "DerivedData"].includes(e.name)) continue;
      const sub = path.join(dir, e.name);
      if (ADAPTERS.some((a) => a.detect(sub))) out.push(sub);
      else walk(sub, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

export const ADAPTER_IDS = ADAPTERS.map((a) => a.id);
