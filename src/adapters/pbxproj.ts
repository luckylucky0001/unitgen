// Minimal reader/editor for Xcode project.pbxproj files: enough to find native targets, the files
// they compile, their test targets, and to register a new test file in a test target.
import { randomBytes } from "node:crypto";
import * as path from "node:path";

export interface PbxObject {
  id: string;
  isa: string;
  body: string;
}

export interface PbxTarget {
  id: string;
  name: string;
  productType: string;
  sourcesPhase?: string;
  syncedDirs: string[];
  /** Ids of the targets this one depends on (PBXTargetDependency), e.g. a test bundle's host. */
  dependsOn: string[];
  /** Absolute paths of the source files in its Sources build phase. */
  files: string[];
}

export class Pbxproj {
  text: string;
  readonly objects = new Map<string, PbxObject>();
  private parent = new Map<string, string>();

  readonly projectDir: string;

  constructor(text: string, projectDir: string) {
    this.text = text;
    this.projectDir = projectDir;
    this.parse();
  }

  private parse(): void {
    this.objects.clear();
    this.parent.clear();
    // Objects are either one line (`ID /* c */ = {isa = X; ...};`) or span lines ending with "\t\t};".
    const re = /^\t\t([0-9A-Fa-f]{24})(?: \/\*.*?\*\/)? = \{(.*)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.text))) {
      let body = m[2];
      if (!/\};\s*$/.test(body)) {
        const end = this.text.indexOf("\n\t\t};", m.index);
        body = this.text.slice(m.index + m[0].length - m[2].length, end + 5);
      }
      const isa = /isa = (\w+);/.exec(body)?.[1] ?? "";
      this.objects.set(m[1], { id: m[1], isa, body });
    }
    for (const o of this.objects.values()) {
      if (o.isa === "PBXGroup" || o.isa === "PBXVariantGroup" || o.isa === "PBXFileSystemSynchronizedRootGroup") {
        for (const child of this.list(o.body, "children")) this.parent.set(child, o.id);
      }
    }
  }

  attr(body: string, key: string): string | undefined {
    const m = new RegExp(`\\b${key} = ("((?:\\\\.|[^"\\\\])*)"|[^;]+);`).exec(body);
    return m ? (m[2] ?? m[1]).trim() : undefined;
  }

  list(body: string, key: string): string[] {
    const m = new RegExp(`\\b${key} = \\(([\\s\\S]*?)\\);`).exec(body);
    return m ? [...m[1].matchAll(/([0-9A-Fa-f]{24})/g)].map((x) => x[1]) : [];
  }

  /** Absolute path of a file reference or group, following parent groups (sourceTree "<group>"). */
  fullPath(id: string): string {
    const parts: string[] = [];
    let cur: string | undefined = id;
    while (cur) {
      const o = this.objects.get(cur);
      if (!o) break;
      const p = this.attr(o.body, "path");
      const tree = this.attr(o.body, "sourceTree");
      if (p) parts.unshift(p);
      if (tree === "SOURCE_ROOT") return path.resolve(this.projectDir, ...parts);
      if (tree && tree !== "<group>") return path.resolve(this.projectDir, ...parts);
      cur = this.parent.get(cur);
    }
    return path.resolve(this.projectDir, ...parts);
  }

  targets(): PbxTarget[] {
    const out: PbxTarget[] = [];
    for (const o of this.objects.values()) {
      if (o.isa !== "PBXNativeTarget") continue;
      const phases = this.list(o.body, "buildPhases");
      const sourcesPhase = phases.find((p) => this.objects.get(p)?.isa === "PBXSourcesBuildPhase");
      const files = sourcesPhase
        ? this.list(this.objects.get(sourcesPhase)!.body, "files")
            .map((bf) => this.attr(this.objects.get(bf)?.body ?? "", "fileRef"))
            .filter((r): r is string => !!r)
            .map((r) => this.fullPath(r.split(" ")[0]))
        : [];
      const syncedDirs = this.list(o.body, "fileSystemSynchronizedGroups").map((g) => this.fullPath(g));
      out.push({
        id: o.id,
        name: (this.attr(o.body, "name") ?? "").replace(/^"|"$/g, ""),
        productType: (this.attr(o.body, "productType") ?? "").replace(/^"|"$/g, ""),
        sourcesPhase, syncedDirs, files,
        dependsOn: this.list(o.body, "dependencies").map((d) => this.attr(this.objects.get(d)?.body ?? "", "target")?.split(" ")[0]).filter((x): x is string => !!x),
      });
    }
    return out;
  }

  private newId(): string {
    let id: string;
    do id = randomBytes(12).toString("hex").toUpperCase();
    while (this.text.includes(id));
    return id;
  }

  /**
   * Add `file` to the target's Sources phase, in the group that holds the target's other files.
   * Returns the ids added (for later removal) or undefined if the file is already registered.
   */
  addSourceFile(target: PbxTarget, file: string): { fileRef: string; buildFile: string } | undefined {
    if (!target.sourcesPhase) throw new Error(`target ${target.name} has no Sources build phase`);
    const name = path.basename(file);
    if (target.files.includes(file)) return undefined;
    // Group: the one whose full path is the file's directory, preferring groups holding the target's files.
    const dir = path.dirname(file);
    let group = [...this.objects.values()].find((o) => o.isa === "PBXGroup" && this.fullPath(o.id) === dir);
    let refPath = name;
    if (!group) {
      // A group whose file references carry a subdirectory (group `Tests`, file `ObjectMapperTests/A.swift`):
      // add the new file the same way, next to its neighbours.
      for (const o of this.objects.values()) {
        if (o.isa !== "PBXGroup") continue;
        const child = this.list(o.body, "children").map((c) => c.split(" ")[0])
          .find((c) => this.objects.get(c)?.isa === "PBXFileReference" && path.dirname(this.fullPath(c)) === dir);
        if (child) { group = o; refPath = path.relative(this.fullPath(o.id), file).split(path.sep).join("/"); break; }
      }
    }
    if (!group) throw new Error(`no Xcode group maps to ${dir}; add the file in Xcode once, or put it next to an existing test file`);
    const fileRef = this.newId();
    const buildFile = this.newId();
    const quoted = /^[\w./-]+$/.test(refPath) ? refPath : `"${refPath}"`;
    const fr = `\t\t${fileRef} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${quoted}; sourceTree = "<group>"; };\n`;
    const bf = `\t\t${buildFile} /* ${name} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileRef} /* ${name} */; };\n`;
    let t = this.text;
    t = t.replace("/* End PBXFileReference section */", `${fr.trimEnd()}\n/* End PBXFileReference section */`);
    t = t.replace("/* End PBXBuildFile section */", `${bf.trimEnd()}\n/* End PBXBuildFile section */`);
    t = insertIntoList(t, group.id, "children", `${fileRef} /* ${name} */`);
    t = insertIntoList(t, target.sourcesPhase, "files", `${buildFile} /* ${name} in Sources */`);
    this.text = t;
    this.parse();
    return { fileRef, buildFile };
  }

  /** Remove every line that mentions one of the ids (object definitions and list entries). */
  removeIds(ids: string[]): void {
    this.text = this.text.split("\n").filter((l) => !ids.some((id) => l.includes(id))).join("\n");
    this.parse();
  }
}

function insertIntoList(text: string, objectId: string, key: string, entry: string): string {
  // The object's definition line (two tabs, then `ID /* c */ = {`), not a reference inside a list.
  const def = new RegExp(`^\\t\\t${objectId}(?: \\/\\*.*?\\*\\/)? = \\{`, "m").exec(text);
  if (!def) throw new Error(`pbxproj object ${objectId} not found`);
  const start = def.index;
  const listStart = text.indexOf(`${key} = (`, start);
  const listEnd = listStart < 0 ? -1 : text.indexOf(");", listStart);
  if (listStart < 0 || listEnd < 0) throw new Error(`pbxproj list ${key} not found in ${objectId}`);
  // Insert a new entry line right before the line holding the closing ");".
  const closeLineStart = text.lastIndexOf("\n", listEnd) + 1;
  return `${text.slice(0, closeLineStart)}\t\t\t\t${entry},\n${text.slice(closeLineStart)}`;
}
