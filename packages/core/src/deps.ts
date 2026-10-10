import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { parseAllDocuments } from "yaml";
import { captureGitInfo } from "./git.ts";
import type { LoadedConfig } from "./config.ts";
import { TEST_FILE, walk } from "./project.ts";

const run = promisify(execFile);

export type DepNodeKind = "file" | "module" | "class" | "device" | "event" | "test" | "import";
export type DepEdgeKind = "declares" | "imports" | "references" | "emits" | "tests" | "extends";

export interface DepNode {
  id: string;
  kind: DepNodeKind;
  label: string;
  /** Project-relative path with forward slashes. */
  file?: string;
  line?: number;
}

export interface DepEdge {
  from: string;
  to: string;
  kind: DepEdgeKind;
}

export interface DepsGraph {
  root: string;
  nodes: DepNode[];
  edges: DepEdge[];
}

export interface ImpactResult {
  target: string;
  /** Nodes the target matched; empty when nothing matched. */
  seeds: DepNode[];
  /** Everything reachable from the seeds, tests excluded. */
  affected: DepNode[];
  tests: DepNode[];
}

// ---------------------------------------------------------------------------
// Verse scanner
// ---------------------------------------------------------------------------

export interface VerseDecl {
  name: string;
  kind: "class" | "struct" | "interface" | "enum" | "module";
  /** Names listed in `class(a, b)`. */
  parents: string[];
  line: number;
  endLine: number;
  /** Enclosing module or class declaration, when nested. */
  parent?: string;
}

export interface VerseEditable {
  name: string;
  type: string;
  line: number;
  /** Declaration that contains the field. */
  owner?: string;
}

export interface VerseEmit {
  /** Event type (or probe id) string. */
  name: string;
  probe: boolean;
  line: number;
  owner?: string;
}

export interface VerseScan {
  file: string;
  decls: VerseDecl[];
  imports: { path: string; line: number }[];
  editables: VerseEditable[];
  emits: VerseEmit[];
  /** `DevToolsSource("device", "X")` style references. */
  deviceRefs: { id: string; line: number; owner?: string }[];
  /** Identifier uses per declaration, for class-to-class references; `owner` undefined means file level. */
  identifiers: { name: string; line: number; owner?: string }[];
}

/**
 * Blanks comments (`#` and nestable `<# #>`) and returns two same-length
 * views of the source: `code` also blanks string and character literal
 * contents, `text` keeps them. Offsets and line numbers match the input.
 */
export function stripVerse(src: string): { code: string; text: string } {
  const code: string[] = [];
  const text: string[] = [];
  const blank = (ch: string) => (ch === "\n" || ch === "\r" ? ch : " ");
  const n = src.length;
  let depth = 0;
  let i = 0;
  while (i < n) {
    const ch = src[i]!;
    const two = src.slice(i, i + 2);
    if (depth > 0) {
      if (two === "<#") {
        depth++;
        code.push(" ", " ");
        text.push(" ", " ");
        i += 2;
      } else if (two === "#>") {
        depth--;
        code.push(" ", " ");
        text.push(" ", " ");
        i += 2;
      } else {
        code.push(blank(ch));
        text.push(blank(ch));
        i++;
      }
      continue;
    }
    if (two === "<#") {
      depth = 1;
      code.push(" ", " ");
      text.push(" ", " ");
      i += 2;
      continue;
    }
    if (ch === "#") {
      while (i < n && src[i] !== "\n") {
        code.push(blank(src[i]!));
        text.push(blank(src[i]!));
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      code.push(ch);
      text.push(ch);
      i++;
      while (i < n && src[i] !== ch && src[i] !== "\n") {
        if (src[i] === "\\" && i + 1 < n && src[i + 1] !== "\n") {
          code.push(" ", " ");
          text.push(src[i]!, src[i + 1]!);
          i += 2;
          continue;
        }
        code.push(" ");
        text.push(src[i]!);
        i++;
      }
      if (src[i] === ch) {
        code.push(ch);
        text.push(ch);
        i++;
      }
      continue;
    }
    code.push(ch);
    text.push(ch);
    i++;
  }
  return { code: code.join(""), text: text.join("") };
}

function lineIndex(src: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const DECL =
  /^([ \t]*)([A-Za-z_]\w*)(?:<[^>\n]*>)*\s*:=\s*(class|struct|interface|enum|module)\b(?:\s*<[^>\n]*>)*\s*(?:\(([^)\n]*)\))?/;
const EDITABLE =
  /@editable\b(?:\s*\{[^}]*\}|\s*\([^)]*\))?(?:\s*@\w+(?:\([^)]*\))?)*\s*(?:var\s+)?(\w+)(?:<[^>\n]*>)*\s*:\s*([^=\n]+?)\s*(?:=|$)/gm;
const PRIMITIVES = new Set([
  "int", "float", "string", "logic", "rational", "void", "char", "char32", "message", "color",
  "vector2", "vector3", "rotation", "transform", "any", "comparable", "type", "false", "true",
]);

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

function readString(text: string, quoteAt: number): string {
  let out = "";
  for (let i = quoteAt + 1; i < text.length && text[i] !== '"' && text[i] !== "\n"; i++) {
    if (text[i] === "\\" && i + 1 < text.length) i++;
    out += text[i];
  }
  return out;
}

/** Lightweight Verse scanner: declarations, imports, @editable fields, emitter calls. No full parse. */
export function scanVerse(file: string, src: string): VerseScan {
  const { code, text } = stripVerse(src);
  const lineOf = lineIndex(src);
  const lines = code.split("\n");
  const decls: VerseDecl[] = [];
  const stack: { decl: VerseDecl; indent: number }[] = [];
  const lineOwner: (string | undefined)[] = [];
  const declLines = new Set<number>();

  for (const [idx, raw] of lines.entries()) {
    const lineNo = idx + 1;
    const blank = raw.trim() === "";
    if (!blank) {
      const indent = indentOf(raw);
      while (stack.length > 0 && indent <= stack[stack.length - 1]!.indent) {
        stack.pop();
      }
    }
    const m = blank ? null : DECL.exec(raw);
    if (m) {
      const decl: VerseDecl = {
        name: m[2]!,
        kind: m[3] as VerseDecl["kind"],
        parents: (m[4] ?? "")
          .split(",")
          .map((p) => /(\w+)\s*(?:<[^>]*>)*\s*$/.exec(p.trim())?.[1])
          .filter((p): p is string => !!p),
        line: lineNo,
        endLine: lineNo,
        ...(stack.length > 0 ? { parent: stack[stack.length - 1]!.decl.name } : {}),
      };
      decls.push(decl);
      declLines.add(lineNo);
      stack.push({ decl, indent: indentOf(raw) });
    }
    lineOwner[lineNo] = stack.length > 0 ? stack[stack.length - 1]!.decl.name : undefined;
    if (!blank) for (const s of stack) s.decl.endLine = lineNo;
  }

  const imports: VerseScan["imports"] = [];
  for (const m of code.matchAll(/\busing\s*\{\s*([^}]+?)\s*\}/g)) {
    imports.push({ path: m[1]!.replace(/\s+/g, " "), line: lineOf(m.index) });
  }

  const editables: VerseEditable[] = [];
  for (const m of code.matchAll(EDITABLE)) {
    const type = m[2]!.trim().replace(/^(\[\]|\?)+/, "").replace(/\s+/g, "");
    const line = lineOf(m.index + m[0].indexOf(m[1]!));
    const owner = lineOwner[line];
    editables.push({ name: m[1]!, type, line, ...(owner ? { owner } : {}) });
  }

  const emits: VerseEmit[] = [];
  for (const m of code.matchAll(/\b(Emit|Probe\w*)\s*\(\s*"/g)) {
    const quote = m.index + m[0].length - 1;
    const line = lineOf(quote);
    const owner = lineOwner[line];
    emits.push({ name: readString(text, quote), probe: m[1] !== "Emit", line, ...(owner ? { owner } : {}) });
  }

  const deviceRefs: VerseScan["deviceRefs"] = [];
  for (const m of text.matchAll(/\bDevTools(?:Source|Target|String)\s*\(\s*"device"\s*,\s*"([^"\n]*)"/g)) {
    if (code[m.index] !== "D") continue;
    const line = lineOf(m.index);
    const owner = lineOwner[line];
    deviceRefs.push({ id: m[1]!, line, ...(owner ? { owner } : {}) });
  }

  const identifiers: VerseScan["identifiers"] = [];
  for (const [idx, raw] of lines.entries()) {
    const lineNo = idx + 1;
    if (declLines.has(lineNo)) continue;
    const owner = lineOwner[lineNo];
    for (const m of raw.matchAll(/[A-Za-z_]\w*/g)) {
      identifiers.push({ name: m[0], line: lineNo, ...(owner ? { owner } : {}) });
    }
  }

  return { file, decls, imports, editables, emits, deviceRefs, identifiers };
}

// ---------------------------------------------------------------------------
// Test scanner
// ---------------------------------------------------------------------------

export interface TestRef {
  /** Device id, normalised event type or probe id. */
  id: string;
  /** How the test uses a device id: assertion/handle (`device`), teleport target (`location`) or area. */
  role?: "device" | "location" | "area";
  line?: number;
}

export interface TestScan {
  id: string;
  name: string;
  file: string;
  line: number;
  format: "yaml" | "ts";
  devices: TestRef[];
  events: TestRef[];
  probes: TestRef[];
}

/** `CaptureCompleted` and `capture.completed` name the same event (mirrors @uefn-devtools/test). */
export function normalizeEventName(name: string): string {
  if (name.includes(".") || !/[A-Z]/.test(name)) return name;
  const words = name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+/g);
  if (!words || words.length < 2) return name.toLowerCase();
  const [first, ...rest] = words.map((w) => w.toLowerCase());
  return `${first}.${rest.join("_")}`;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "test";
}

function stripTs(src: string): string {
  const out: string[] = [];
  const blank = (ch: string) => (ch === "\n" ? ch : " ");
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    const ch = src[i]!;
    if (two === "//") {
      while (i < src.length && src[i] !== "\n") out.push(blank(src[i++]!));
    } else if (two === "/*") {
      while (i < src.length && src.slice(i, i + 2) !== "*/") out.push(blank(src[i++]!));
      if (i < src.length) {
        out.push(" ", " ");
        i += 2;
      }
    } else if (ch === '"' || ch === "'" || ch === "`") {
      out.push(ch);
      i++;
      while (i < src.length && src[i] !== ch && (ch === "`" || src[i] !== "\n")) {
        if (src[i] === "\\" && i + 1 < src.length) out.push(src[i++]!);
        out.push(src[i++]!);
      }
      if (i < src.length) out.push(src[i++]!);
    } else {
      out.push(ch);
      i++;
    }
  }
  return out.join("");
}

const TS_TEST = /\b(?:test|it)(?:\.(?:only|skip))?\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
const TS_DEVICE = /\.(?:device|enter|leave|teleport)\(\s*["'`]([^"'`\n]+)["'`]/g;
const TS_EVENT = /\.(?:event|waitForEvent|toHaveOccurred)\(\s*["'`]([^"'`\n]+)["'`]/g;
const TS_PROBE = /\.probe\(\s*["'`]([^"'`\n]+)["'`]/g;

function tsRefs(chunk: string, lineOf: (o: number) => number, base: number): Pick<TestScan, "devices" | "events" | "probes"> {
  const devices: TestRef[] = [];
  const events: TestRef[] = [];
  const probes: TestRef[] = [];
  for (const m of chunk.matchAll(TS_DEVICE)) {
    const verb = /\.(\w+)\(/.exec(m[0])![1]!;
    const role = verb === "device" ? "device" : verb === "teleport" ? "location" : "area";
    devices.push({ id: m[1]!, role, line: lineOf(base + m.index) });
  }
  for (const m of chunk.matchAll(TS_EVENT)) events.push({ id: normalizeEventName(m[1]!), line: lineOf(base + m.index) });
  for (const m of chunk.matchAll(TS_PROBE)) probes.push({ id: m[1]!, line: lineOf(base + m.index) });
  return { devices, events, probes };
}

/** Regex pass over a TypeScript test file: attributes `device("X")` / `event("x.y")` style calls to the enclosing `test(...)`. */
export function scanTsTests(file: string, src: string): TestScan[] {
  const text = stripTs(src);
  const lineOf = lineIndex(src);
  const found = [...text.matchAll(TS_TEST)];
  if (found.length === 0) return [];
  const shared = tsRefs(text.slice(0, found[0]!.index), lineOf, 0);
  return found.map((m, i) => {
    const end = found[i + 1]?.index ?? text.length;
    const own = tsRefs(text.slice(m.index, end), lineOf, m.index);
    const name = m[2]!;
    return {
      id: slug(name),
      name,
      file,
      line: lineOf(m.index),
      format: "ts" as const,
      devices: [...shared.devices, ...own.devices],
      events: [...shared.events, ...own.events],
      probes: [...shared.probes, ...own.probes],
    };
  });
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);

/** Reads YAML tests defensively (schema problems are reported by the test loader, not here). */
export function scanYamlTests(file: string, src: string): TestScan[] {
  const lineOf = lineIndex(src);
  const out: TestScan[] = [];
  for (const doc of parseAllDocuments(src)) {
    if (doc.errors.length > 0) continue;
    const data: unknown = doc.toJS();
    if (!isObj(data) || typeof data["name"] !== "string") continue;
    const devices: TestRef[] = [];
    const events: TestRef[] = [];
    const probes: TestRef[] = [];
    const items = ["setup", "steps", "assert"].flatMap((k) => (Array.isArray(data[k]) ? (data[k] as unknown[]) : []));
    const device = (id: string | undefined, role: NonNullable<TestRef["role"]>) => id && devices.push({ id, role });
    for (const item of items) {
      if (!isObj(item)) continue;
      for (const [key, arg] of Object.entries(item)) {
        if (!isObj(arg)) continue;
        if (key === "teleport") device(str(arg["location"]), "location");
        else if (key === "enter" || key === "leave") device(str(arg["area"]), "area");
        else if (key === "enable_device" || key === "disable_device" || key === "device") device(str(arg["id"]), "device");
        else if (key === "player") device(str(arg["in_area"]), "area");
        else if (key === "wait_for") {
          const e = str(arg["event"]);
          if (e) events.push({ id: normalizeEventName(e) });
        } else if (key === "event") {
          const e = str(arg["type"]);
          if (e) events.push({ id: normalizeEventName(e) });
        } else if (key === "probe") {
          const p = str(arg["id"]);
          if (p) probes.push({ id: p });
        }
      }
    }
    const name = data["name"];
    const range = doc.contents?.range;
    out.push({
      id: str(data["id"]) ?? slug(name),
      name,
      file,
      line: range ? lineOf(range[0]) : 1,
      format: "yaml",
      devices,
      events,
      probes,
    });
  }
  return out;
}

/** Scans test files given as paths relative to `root`. Unreadable files are skipped. */
export async function scanTests(root: string, files: readonly string[]): Promise<TestScan[]> {
  const out: TestScan[] = [];
  for (const file of files) {
    const rel = file.split("\\").join("/");
    let src: string;
    try {
      src = await readFile(resolve(root, file), "utf8");
    } catch {
      continue;
    }
    out.push(...(/\.ya?ml$/.test(file) ? scanYamlTests(rel, src) : scanTsTests(rel, src)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

const toPosix = (p: string) => p.split("\\").join("/");

const CREATIVE_BASES = /(^creative_device$|_device$)/;

/** Builds the graph for a project: Verse declarations and links, then the tests that touch them. */
export async function buildDepsGraph(loaded: LoadedConfig): Promise<DepsGraph> {
  const { root, config } = loaded;
  const verseFiles = await walk(resolve(root, config.paths.verse), (n) => n.endsWith(".verse"));
  const testFiles = await walk(resolve(root, config.paths.tests), (n) => TEST_FILE.test(n));

  const nodes = new Map<string, DepNode>();
  const edges: DepEdge[] = [];
  const edgeKeys = new Set<string>();
  const node = (n: DepNode) => {
    const existing = nodes.get(n.id);
    if (!existing) nodes.set(n.id, n);
    else if (!existing.file && n.file) Object.assign(existing, n);
    return nodes.get(n.id)!;
  };
  const edge = (from: string, to: string, kind: DepEdgeKind) => {
    const key = `${from}\0${to}\0${kind}`;
    if (from === to || edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, kind });
  };

  const scans: VerseScan[] = [];
  for (const abs of verseFiles) {
    const rel = toPosix(relative(root, abs));
    scans.push(scanVerse(rel, await readFile(abs, "utf8")));
  }

  // Project-wide symbol table: first declaration wins.
  const declared = new Map<string, { scan: VerseScan; decl: VerseDecl }>();
  for (const scan of scans) for (const decl of scan.decls) if (!declared.has(decl.name)) declared.set(decl.name, { scan, decl });

  const isDeviceClass = (name: string, seen = new Set<string>()): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    const entry = declared.get(name);
    if (!entry) return CREATIVE_BASES.test(name);
    return entry.decl.parents.some((p) => isDeviceClass(p, seen));
  };
  const symbolId = (name: string): string => {
    const entry = declared.get(name);
    if (!entry) return `class:${name}`;
    return entry.decl.kind === "module" ? `module:${name}` : `class:${name}`;
  };

  for (const scan of scans) {
    const fileId = `file:${scan.file}`;
    node({ id: fileId, kind: "file", label: scan.file, file: scan.file });
    const ownerId = (owner: string | undefined) => (owner && declared.has(owner) ? symbolId(owner) : fileId);

    for (const decl of scan.decls) {
      const id = symbolId(decl.name);
      const kind: DepNodeKind = decl.kind === "module" ? "module" : isDeviceClass(decl.name) ? "device" : "class";
      node({ id, kind, label: decl.name, file: scan.file, line: decl.line });
      edge(decl.parent ? symbolId(decl.parent) : fileId, id, "declares");
      for (const parent of decl.parents) {
        const pid = symbolId(parent);
        const known = declared.get(parent);
        node({
          id: pid,
          kind: known ? (known.decl.kind === "module" ? "module" : isDeviceClass(parent) ? "device" : "class") : CREATIVE_BASES.test(parent) ? "device" : "class",
          label: parent,
          ...(known ? { file: known.scan.file, line: known.decl.line } : {}),
        });
        edge(id, pid, "extends");
      }
    }

    for (const imp of scan.imports) {
      const id = `import:${imp.path}`;
      node({ id, kind: "import", label: imp.path, file: scan.file, line: imp.line });
      edge(fileId, id, "imports");
      const last = imp.path.split("/").pop()!.trim();
      const local = declared.get(last);
      if (local?.decl.kind === "module") edge(fileId, symbolId(last), "imports");
    }

    for (const ed of scan.editables) {
      if (PRIMITIVES.has(ed.type.replace(/^\[.*?\]/, ""))) continue;
      const id = `device:${ed.name}`;
      node({ id, kind: "device", label: ed.name, file: scan.file, line: ed.line });
      edge(ownerId(ed.owner), id, "references");
      const typeName = ed.type.replace(/[^\w].*$/, "");
      if (declared.has(typeName)) edge(ownerId(ed.owner), symbolId(typeName), "references");
    }

    for (const ref of scan.deviceRefs) {
      const id = `device:${ref.id}`;
      node({ id, kind: "device", label: ref.id });
      edge(ownerId(ref.owner), id, "references");
    }

    for (const em of scan.emits) {
      const id = em.probe ? `probe:${em.name}` : `event:${normalizeEventName(em.name)}`;
      node({ id, kind: "event", label: em.probe ? `probe ${em.name}` : normalizeEventName(em.name), file: scan.file, line: em.line });
      edge(ownerId(em.owner), id, "emits");
    }

    for (const ident of scan.identifiers) {
      const target = declared.get(ident.name);
      if (!target || ident.name === ident.owner) continue;
      edge(ownerId(ident.owner), symbolId(ident.name), "references");
    }
  }

  const tests = await scanTests(root, testFiles.map((f) => relative(root, f)));
  for (const abs of testFiles) {
    const rel = toPosix(relative(root, abs));
    node({ id: `file:${rel}`, kind: "file", label: rel, file: rel });
  }
  for (const t of tests) {
    const id = `test:${t.file}#${t.id}`;
    node({ id, kind: "test", label: t.id, file: t.file, line: t.line });
    edge(`file:${t.file}`, id, "declares");
    for (const d of t.devices) {
      node({ id: `device:${d.id}`, kind: "device", label: d.id });
      edge(id, `device:${d.id}`, "tests");
    }
    for (const e of t.events) {
      node({ id: `event:${e.id}`, kind: "event", label: e.id });
      edge(id, `event:${e.id}`, "tests");
    }
    for (const p of t.probes) {
      node({ id: `probe:${p.id}`, kind: "event", label: `probe ${p.id}` });
      edge(id, `probe:${p.id}`, "tests");
    }
  }

  return { root, nodes: [...nodes.values()], edges };
}

// ---------------------------------------------------------------------------
// Impact
// ---------------------------------------------------------------------------

/**
 * Which tests are affected by changing a Verse file or symbol. Walks the
 * graph in dependency direction: what a change declares and emits, the
 * devices it wires, and the classes, files and modules that depend on it.
 * Tests are selected when they exercise any affected device or event.
 */
export function impactOf(graph: DepsGraph, target: string): ImpactResult {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, DepEdge[]>();
  const inn = new Map<string, DepEdge[]>();
  for (const e of graph.edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (inn.get(e.to) ?? inn.set(e.to, []).get(e.to)!).push(e);
  }

  let want = toPosix(target);
  if (isAbsolute(want)) want = toPosix(relative(graph.root, want));
  want = want.replace(/^\.\//, "");
  const seeds = graph.nodes.filter((n) => {
    if (n.id === want || n.label === want) return true;
    if (n.kind === "file") return n.file === want || n.file!.endsWith(`/${want}`);
    return n.id.endsWith(`:${want}`) && n.kind !== "import";
  });

  const affected = new Set<string>();
  const queue = seeds.map((s) => s.id);
  const add = (id: string) => {
    if (!affected.has(id)) {
      affected.add(id);
      queue.push(id);
    }
  };
  for (const s of queue.slice()) affected.add(s);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const e of out.get(id) ?? []) {
      if (e.kind === "declares" || e.kind === "emits") add(e.to);
      else if (e.kind === "references" && (e.to.startsWith("device:") || e.to.startsWith("event:") || e.to.startsWith("probe:"))) add(e.to);
    }
    const symbol = id.startsWith("class:") || id.startsWith("module:");
    for (const e of inn.get(id) ?? []) {
      if (e.kind === "extends") add(e.from);
      else if (symbol && (e.kind === "references" || e.kind === "imports")) add(e.from);
    }
  }

  const testIds = new Set<string>();
  for (const id of affected) if (byId.get(id)?.kind === "test") testIds.add(id);
  for (const e of graph.edges) if (e.kind === "tests" && affected.has(e.to)) testIds.add(e.from);

  return {
    target,
    seeds,
    affected: [...affected].map((id) => byId.get(id)!).filter((n) => n.kind !== "test"),
    tests: [...testIds].map((id) => byId.get(id)!),
  };
}

/** Union of {@link impactOf} over several targets (e.g. every changed file). */
export function impactOfAll(graph: DepsGraph, targets: readonly string[]): ImpactResult {
  const results = targets.map((t) => impactOf(graph, t));
  const uniq = (nodes: DepNode[]) => [...new Map(nodes.map((n) => [n.id, n])).values()];
  return {
    target: targets.join(", "),
    seeds: uniq(results.flatMap((r) => r.seeds)),
    affected: uniq(results.flatMap((r) => r.affected)),
    tests: uniq(results.flatMap((r) => r.tests)),
  };
}

/** Changed files per git, as paths relative to the project root. Empty outside a repository. */
export async function changedFiles(root: string): Promise<string[]> {
  const info = await captureGitInfo(root);
  if (!info) return [];
  let top: string;
  try {
    top = (await run("git", ["rev-parse", "--show-toplevel"], { cwd: root, timeout: 5000 })).stdout.trim();
  } catch {
    return [];
  }
  return info.changedFiles.map((f) => toPosix(relative(root, join(top, f)))).filter((f) => !f.startsWith(".."));
}

// ---------------------------------------------------------------------------
// Exporters
// ---------------------------------------------------------------------------

export function exportJson(graph: DepsGraph): string {
  return JSON.stringify({ nodes: graph.nodes, edges: graph.edges }, null, 2);
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const DOT_SHAPE: Record<DepNodeKind, string> = {
  file: "folder",
  module: "component",
  class: "box",
  device: "box3d",
  event: "ellipse",
  test: "note",
  import: "plaintext",
};

export function exportDot(graph: DepsGraph): string {
  const lines = ["digraph uefn_deps {", "  rankdir=LR;", '  node [fontname="Helvetica"];'];
  for (const n of graph.nodes) lines.push(`  "${esc(n.id)}" [label="${esc(n.label)}", shape=${DOT_SHAPE[n.kind]}];`);
  for (const e of graph.edges) lines.push(`  "${esc(e.from)}" -> "${esc(e.to)}" [label="${e.kind}"];`);
  lines.push("}");
  return lines.join("\n");
}

export function exportMermaid(graph: DepsGraph): string {
  const ids = new Map(graph.nodes.map((n, i) => [n.id, `n${i}`]));
  const q = (s: string) => s.replace(/"/g, "#quot;");
  const shape = (n: DepNode): string => {
    const label = `"${q(n.label)}"`;
    switch (n.kind) {
      case "file": return `[${label}]`;
      case "module": return `[[${label}]]`;
      case "class": return `(${label})`;
      case "device": return `{{${label}}}`;
      case "event": return `([${label}])`;
      case "test": return `[/${label}/]`;
      case "import": return `>${label}]`;
    }
  };
  const lines = ["flowchart LR"];
  for (const n of graph.nodes) lines.push(`  ${ids.get(n.id)}${shape(n)}`);
  for (const e of graph.edges) lines.push(`  ${ids.get(e.from)} -->|${e.kind}| ${ids.get(e.to)}`);
  return lines.join("\n");
}

/** Human summary grouped by file, then the test links. */
export function formatDepsText(graph: DepsGraph): string {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const outgoing = (id: string, kind: DepEdgeKind) => graph.edges.filter((e) => e.from === id && e.kind === kind).map((e) => byId.get(e.to)!);
  const lines: string[] = [];
  const describe = (id: string, indent: string) => {
    for (const child of outgoing(id, "declares")) {
      const ext = outgoing(child.id, "extends").map((n) => n.label);
      lines.push(`${indent}${child.kind} ${child.label}${ext.length ? ` (${ext.join(", ")})` : ""}${child.line ? `:${child.line}` : ""}`);
      for (const d of outgoing(child.id, "references")) if (d.id.startsWith("device:")) lines.push(`${indent}  device ${d.label}`);
      for (const d of outgoing(child.id, "references")) if (!d.id.startsWith("device:")) lines.push(`${indent}  uses ${d.label}`);
      for (const ev of outgoing(child.id, "emits")) lines.push(`${indent}  emits ${ev.label}`);
      describe(child.id, `${indent}  `);
    }
  };
  for (const file of graph.nodes.filter((n) => n.kind === "file")) {
    const declares = outgoing(file.id, "declares");
    if (declares.some((d) => d.kind === "test")) continue;
    lines.push(file.label);
    for (const imp of outgoing(file.id, "imports")) lines.push(`  imports ${imp.label}`);
    for (const ev of outgoing(file.id, "emits")) lines.push(`  emits ${ev.label}`);
    describe(file.id, "  ");
  }
  const tests = graph.nodes.filter((n) => n.kind === "test");
  if (tests.length > 0) {
    lines.push("", "Tests");
    for (const t of tests) {
      const links = graph.edges.filter((e) => e.from === t.id && e.kind === "tests").map((e) => byId.get(e.to)!.label);
      lines.push(`  ${t.label}  (${t.file}:${t.line})${links.length ? `  -> ${links.join(", ")}` : ""}`);
    }
  }
  return lines.join("\n");
}
