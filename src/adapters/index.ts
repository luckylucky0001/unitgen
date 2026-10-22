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

export function detectAdapter(root: string, forced?: string): Adapter {
  const abs = path.resolve(root);
  const stateDir = path.join(abs, ".unitgen");
  const pick = forced ? ADAPTERS.find((a) => a.id === forced) : ADAPTERS.find((a) => a.detect(abs));
  if (!pick) {
    throw new Error(`No supported project at ${abs}. Supported: SwiftPM (Package.swift), Xcode (.xcodeproj/.xcworkspace), Gradle Android/JVM (settings.gradle[.kts]), HarmonyOS (build-profile.json5).`);
  }
  return pick.make(abs, stateDir);
}

export const ADAPTER_IDS = ADAPTERS.map((a) => a.id);
