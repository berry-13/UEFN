/**
 * Level snapshots: the open UEFN level as a sorted, rounded JSON document
 * that can live in git, and a diff between two of them.
 *
 * The scene is read through UEFN's editor toolsets (UEFN 42.30). One
 * `execute_tool_script` call batches the per-actor reads inside the editor,
 * which took about 45s for 2,836 actors live, against thousands of MCP round
 * trips otherwise.
 */

export const LEVEL_SNAPSHOT_VERSION = 1;
export const LEVEL_SNAPSHOT_FILE = "level.snapshot.json";

type Vec3 = [number, number, number];

export interface LevelActor {
  /** The actor guid, stable across editor sessions. */
  id: string;
  label: string;
  /** Class path, e.g. `/CRD_VerseDevices/VerseDevice.VerseDevice_C`. */
  class: string;
  /** Object path used to address the actor in editor tools. */
  path: string;
  folder?: string;
  tags?: string[];
  dataLayers?: unknown[];
  location?: Vec3;
  /** Pitch, yaw, roll in degrees. */
  rotation?: Vec3;
  scale?: Vec3;
  /** Event bindings wired into the device, as UEFN reports them. */
  bindings?: unknown;
  /** Editable settings of a Verse device, as UEFN reports them. */
  settings?: unknown;
}

export interface LevelSnapshot {
  version: typeof LEVEL_SNAPSHOT_VERSION;
  level: string;
  actors: LevelActor[];
}

export interface LevelCapture {
  snapshot: LevelSnapshot;
  /** Per-actor reads that failed; the snapshot leaves those fields out. */
  errors: string[];
}

/** What {@link captureLevel} needs from an adapter: McpUefnAdapter.callEditorTool. */
export interface EditorToolCaller {
  callEditorTool(
    toolset: string,
    tool: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<{ isError: boolean; text: string; json?: unknown }>;
}

export function isEditorToolCaller(value: unknown): value is EditorToolCaller {
  return typeof (value as Partial<EditorToolCaller> | undefined)?.callEditorTool === "function";
}

/** Runs inside the editor's tool-script sandbox, which only offers `execute_tool` and plain Python. */
export const SNAPSHOT_SCRIPT = `import json

def call(name, args):
    return execute_tool(name, json.dumps(args))["returnValue"]

def run():
    level = call("editor_toolset.toolsets.scene.SceneTools.get_current_level", {})
    actors = call("editor_toolset.toolsets.scene.SceneTools.find_actors", {"name": "", "tag": "", "collision_channels": []})
    out = []
    errors = []
    for a in actors:
        ref = {"refPath": a["actorPath"]}
        row = {"id": a["guid"], "label": a["label"], "class": a["class"]["refPath"], "path": a["actorPath"], "folder": a["folderPath"], "dataLayers": a["dataLayerAssets"]}
        reads = [
            ("transform", "editor_toolset.toolsets.actor.ActorTools.get_actor_transform", {"actor": ref}),
            ("tags", "editor_toolset.toolsets.actor.ActorTools.get_tags", {"actor": ref}),
            ("bindings", "ValkyrieToolset.DeviceToolset.ListEventBindings", {"devicePath": ref}),
        ]
        if "VerseDevice" in row["class"]:
            reads.append(("settings", "ValkyrieToolset.DeviceToolset.ListDeviceProperties", {"device": ref}))
        for key, name, args in reads:
            try:
                row[key] = call(name, args)
            except Exception as e:
                errors.append(a["label"] + " " + key + ": " + str(e)[:200])
        out.append(row)
    return {"level": level, "actors": out, "errors": errors}
`;

/** Reads the open level through the editor toolsets. */
export async function captureLevel(caller: EditorToolCaller, options: { timeoutMs?: number } = {}): Promise<LevelCapture> {
  const out = await caller.callEditorTool(
    "editor_toolset.toolsets.programmatic.ProgrammaticToolset",
    "execute_tool_script",
    { script: SNAPSHOT_SCRIPT },
    { timeoutMs: options.timeoutMs ?? 600_000 },
  );
  if (out.isError) throw new Error(`reading the level failed: ${out.text.slice(0, 500)}`);
  return normalizeCapture(scriptResult(out.json ?? out.text));
}

/** The script's `run()` value: UEFN wraps it in `returnValue`, as a JSON string. */
function scriptResult(raw: unknown): unknown {
  let value = isRecord(raw) && "returnValue" in raw ? raw["returnValue"] : raw;
  if (typeof value === "string") value = JSON.parse(value);
  return value;
}

/** Turns the script's raw rows into a snapshot with sorted actors and rounded numbers. */
export function normalizeCapture(raw: unknown): LevelCapture {
  if (!isRecord(raw) || !Array.isArray(raw["actors"])) throw new Error("the level script returned no actor list");
  const actors = raw["actors"].filter(isRecord).map(normalizeActor);
  actors.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const errors = Array.isArray(raw["errors"]) ? raw["errors"].map(String) : [];
  return { snapshot: { version: LEVEL_SNAPSHOT_VERSION, level: String(raw["level"] ?? ""), actors }, errors };
}

function normalizeActor(row: Record<string, unknown>): LevelActor {
  const actor: LevelActor = { id: String(row["id"]), label: String(row["label"] ?? ""), class: String(row["class"] ?? ""), path: String(row["path"] ?? "") };
  const folder = row["folder"];
  if (typeof folder === "string" && folder !== "" && folder !== "None") actor.folder = folder;
  const tags = row["tags"];
  if (Array.isArray(tags) && tags.length > 0) actor.tags = tags.map(String).sort();
  const layers = row["dataLayers"];
  if (Array.isArray(layers) && layers.length > 0) actor.dataLayers = layers;
  const xf = row["transform"];
  if (isRecord(xf)) {
    const location = vec(xf["location"], ["x", "y", "z"], 100);
    const rotation = vec(xf["rotation"], ["pitch", "yaw", "roll"], 100);
    const scale = vec(xf["scale"], ["x", "y", "z"], 10_000);
    if (location) actor.location = location;
    if (rotation) actor.rotation = rotation;
    if (scale) actor.scale = scale;
  }
  const bindings = meaningful(row["bindings"]);
  if (bindings !== undefined) actor.bindings = bindings;
  const settings = meaningful(row["settings"]);
  if (settings !== undefined) actor.settings = settings;
  return actor;
}

/** Rounded to 1/scale so float noise does not show up as a change. */
function vec(value: unknown, keys: [string, string, string], scale: number): Vec3 | undefined {
  if (!isRecord(value)) return undefined;
  const out = keys.map((k) => Number(value[k]));
  if (out.some((n) => !Number.isFinite(n))) return undefined;
  return out.map((n) => Math.round(n * scale) / scale + 0) as Vec3;
}

/** Empty answers (`""`, `[]`, `{}`, null) are left out; JSON in a string is parsed. */
function meaningful(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.trim() === "") return undefined;
    try {
      return meaningful(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.length > 0 ? value : undefined;
  if (isRecord(value)) return Object.values(value).some((v) => meaningful(v) !== undefined) ? value : undefined;
  return value;
}

/** Parses and checks a snapshot file's content. */
export function parseLevelSnapshot(text: string, source = "snapshot"): LevelSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not JSON: ${(error as Error).message}`);
  }
  if (!isRecord(raw) || raw["version"] !== LEVEL_SNAPSHOT_VERSION || !Array.isArray(raw["actors"])) {
    throw new Error(`${source} is not a version ${LEVEL_SNAPSHOT_VERSION} level snapshot`);
  }
  return raw as unknown as LevelSnapshot;
}

/** Serialised with one stable key order, so the same level always gives the same bytes. */
export function serializeLevelSnapshot(snapshot: LevelSnapshot): string {
  return JSON.stringify(snapshot, null, 2) + "\n";
}

export interface LevelChange {
  id: string;
  label: string;
  /** Field name to [before, after]. */
  fields: Record<string, [unknown, unknown]>;
}

export interface LevelDiff {
  added: LevelActor[];
  removed: LevelActor[];
  changed: LevelChange[];
  /** Set when the two snapshots are of different levels. */
  levels?: [string, string];
}

const COMPARED: (keyof LevelActor)[] = ["label", "class", "folder", "tags", "dataLayers", "location", "rotation", "scale", "bindings", "settings"];

/** Matches actors by guid, so a moved or renamed actor is a change, not a remove and an add. */
export function diffLevels(before: LevelSnapshot, after: LevelSnapshot): LevelDiff {
  const old = new Map(before.actors.map((a) => [a.id, a]));
  const now = new Map(after.actors.map((a) => [a.id, a]));
  const diff: LevelDiff = {
    added: after.actors.filter((a) => !old.has(a.id)),
    removed: before.actors.filter((a) => !now.has(a.id)),
    changed: [],
  };
  for (const a of after.actors) {
    const b = old.get(a.id);
    if (!b) continue;
    const fields: Record<string, [unknown, unknown]> = {};
    for (const key of COMPARED) if (!sameValue(b[key], a[key])) fields[key] = [b[key], a[key]];
    if (Object.keys(fields).length > 0) diff.changed.push({ id: a.id, label: a.label, fields });
  }
  if (before.level !== after.level) diff.levels = [before.level, after.level];
  return diff;
}

export function levelDiffIsEmpty(diff: LevelDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0 && !diff.levels;
}

/** Human-readable diff, one line per actor plus indented field changes. */
export function formatLevelDiff(diff: LevelDiff): string {
  const lines: string[] = [];
  if (diff.levels) lines.push(`level ${diff.levels[0]} -> ${diff.levels[1]}`);
  for (const a of diff.added) lines.push(`+ ${a.label} (${shortClass(a.class)})${a.location ? ` at ${fmt(a.location)}` : ""}`);
  for (const a of diff.removed) lines.push(`- ${a.label} (${shortClass(a.class)})${a.location ? ` at ${fmt(a.location)}` : ""}`);
  for (const c of diff.changed) {
    lines.push(`~ ${c.label}`);
    for (const [field, [b, a]] of Object.entries(c.fields)) lines.push(`    ${field}: ${fmt(b)} -> ${fmt(a)}`);
  }
  lines.push(`${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed`);
  return lines.join("\n");
}

function shortClass(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1) || path;
}

function fmt(value: unknown): string {
  if (value === undefined) return "(none)";
  if (Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number")) return `(${value.join(", ")})`;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
