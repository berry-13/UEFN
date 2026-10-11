import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { deepEqual } from "@uefn-devtools/core";
import type { GameState } from "@uefn-devtools/protocol";
import { parseDuration } from "@uefn-devtools/protocol";
import type { TestContext } from "./context.ts";

export type SnapshotSection = "devices" | "teams" | "players" | "probes" | "positions";

export interface SnapshotOptions {
  /**
   * Which parts of the state to capture. Defaults to devices, teams, players
   * and probes. Add `positions` to keep player positions (dropped otherwise,
   * since they move with every teleport and are rarely the point).
   */
  include?: SnapshotSection[];
  /** Dotted paths to drop, e.g. `players.player1.health`. `*` matches any key. */
  ignore?: string[];
}

export type SnapshotValue = null | boolean | number | string | SnapshotValue[] | { [key: string]: SnapshotValue };
export type Snapshot = { [key: string]: SnapshotValue };

export interface SnapshotDiff {
  path: string;
  /** `undefined` when the path is absent from the stored snapshot. */
  expected: SnapshotValue | undefined;
  /** `undefined` when the path is absent from the received snapshot. */
  received: SnapshotValue | undefined;
}

const DEFAULT_SECTIONS: SnapshotSection[] = ["devices", "teams", "players", "probes"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON-safe deep copy with sorted keys and no `undefined` members. */
function normalize(value: unknown): SnapshotValue {
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (isPlainObject(value)) {
    const out: { [key: string]: SnapshotValue } = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = normalize(value[key]);
    }
    return out;
  }
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) return null;
  return value as SnapshotValue;
}

function dropPath(target: SnapshotValue, segments: string[]): void {
  if (!isPlainObject(target) || segments.length === 0) return;
  const [head, ...rest] = segments as [string, ...string[]];
  const keys = head === "*" ? Object.keys(target) : [head];
  for (const key of keys) {
    if (!(key in target)) continue;
    if (rest.length === 0) delete target[key];
    else dropPath(target[key] as SnapshotValue, rest);
  }
}

/** Removes `ignore` paths from an already normalized snapshot (in place). */
export function applyIgnore<T extends SnapshotValue>(snapshot: T, ignore: readonly string[] = []): T {
  for (const path of ignore) dropPath(snapshot, path.split("."));
  return snapshot;
}

/**
 * Turns a derived GameState into a stable, comparable snapshot: volatile
 * fields (`startedAt`, `endedAt`, positions unless included) are dropped, keys
 * are sorted and area lists are ordered. Independent of any engine.
 */
export function snapshotState(state: GameState, options: SnapshotOptions = {}): Snapshot {
  const sections = new Set<SnapshotSection>(options.include ?? DEFAULT_SECTIONS);
  // Positions live on player entries, so asking for them implies players.
  if (sections.has("positions")) sections.add("players");
  const out: Record<string, unknown> = { phase: state.phase, round: state.round };
  if (state.winner !== undefined) out["winner"] = state.winner;
  if (sections.has("devices")) out["devices"] = state.devices;
  if (sections.has("teams")) out["teams"] = state.teams;
  if (sections.has("players")) {
    out["players"] = Object.fromEntries(
      Object.entries(state.players).map(([id, p]) => {
        const { position, areas, ...rest } = p;
        return [id, { ...rest, areas: [...areas].sort(), ...(sections.has("positions") && position ? { position } : {}) }];
      }),
    );
  }
  if (sections.has("probes")) out["probes"] = state.probes;
  return applyIgnore(normalize(out) as Snapshot, options.ignore);
}

function walk(path: string, a: SnapshotValue | undefined, b: SnapshotValue | undefined, out: SnapshotDiff[]): void {
  if (a === undefined || b === undefined) {
    if (a !== b) out.push({ path, expected: a, received: b });
  } else if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) walk(`${path}[${i}]`, a[i], b[i], out);
  } else if (isPlainObject(a) && isPlainObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) walk(path ? `${path}.${key}` : key, a[key] as SnapshotValue | undefined, b[key] as SnapshotValue | undefined, out);
  } else if (!deepEqual(a, b)) {
    out.push({ path, expected: a, received: b });
  }
}

/** Structural differences between a stored snapshot (`a`) and a received one (`b`). */
export function diffSnapshots(a: Snapshot, b: Snapshot): SnapshotDiff[] {
  const out: SnapshotDiff[] = [];
  walk("", a, b, out);
  return out;
}

function show(value: SnapshotValue | undefined): string {
  return value === undefined ? "(missing)" : JSON.stringify(value);
}

/** One `path: expected X, received Y` line per difference, capped at `limit`. */
export function formatSnapshotDiff(diffs: readonly SnapshotDiff[], limit = 20): string {
  const lines = diffs.slice(0, limit).map((d) => `  ${d.path || "(root)"}: expected ${show(d.expected)}, received ${show(d.received)}`);
  if (diffs.length > limit) lines.push(`  ... and ${diffs.length - limit} more`);
  return lines.join("\n");
}

// Storage

export interface SnapshotFile {
  version: 1;
  snapshots: Record<string, Snapshot>;
}

/** `<dir of the test file>/__snapshots__/<test file name>.snap.json`. */
export function snapshotFilePath(testFile: string): string {
  return join(dirname(testFile), "__snapshots__", `${basename(testFile)}.snap.json`);
}

export async function readSnapshotFile(path: string): Promise<SnapshotFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, snapshots: {} };
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<SnapshotFile>;
  if (parsed.version !== 1 || !isPlainObject(parsed.snapshots)) throw new Error(`${path} is not a snapshot file (expected version 1)`);
  return { version: 1, snapshots: parsed.snapshots };
}

export async function writeSnapshotFile(path: string, file: SnapshotFile): Promise<void> {
  const sorted: SnapshotFile = {
    version: 1,
    snapshots: Object.fromEntries(Object.entries(file.snapshots).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(sorted, null, 2) + "\n");
}

// Matching

/** What the runner tells a test about snapshots. */
export interface SnapshotEnv {
  testId: string;
  /** Absolute path of the test file. */
  file: string;
  /** Overwrite stored snapshots instead of comparing (`--update-snapshots`). */
  update: boolean;
}

export interface SnapshotMatchOptions extends SnapshotOptions {
  name?: string;
  timeout?: number | string;
  settle?: number | string;
}

export interface SnapshotOutcome {
  pass: boolean;
  description: string;
  message?: string;
  expected?: Snapshot;
  received?: Snapshot;
}

export function isCi(): boolean {
  const ci = process.env["CI"];
  return ci !== undefined && ci !== "" && ci !== "0" && ci.toLowerCase() !== "false";
}

/** Waits until the state stops changing for the settle window, then snapshots it. */
async function settledSnapshot(ctx: TestContext, options: SnapshotOptions, timeout: number, settle: number): Promise<Snapshot> {
  const { engine } = ctx;
  const deadline = engine.now() + timeout;
  let current = snapshotState(engine.state, options);
  for (;;) {
    const candidate = current;
    if (await engine.waitUntilStable((s) => deepEqual(snapshotState(s, options), candidate), 0, settle)) return candidate;
    current = snapshotState(engine.state, options);
    if (engine.now() >= deadline) return current;
  }
}

export async function matchSnapshot(ctx: TestContext, name: string, options: SnapshotMatchOptions = {}): Promise<SnapshotOutcome> {
  const env = ctx.snapshotEnv;
  if (!env) throw new Error("snapshots are only available when tests run through the runner");
  const timeout = options.timeout !== undefined ? parseDuration(options.timeout) : ctx.expectTimeout;
  const settle = options.settle !== undefined ? parseDuration(options.settle) : ctx.expectSettle;
  const key = `${env.testId}::${name}`;
  const path = snapshotFilePath(env.file);
  const file = await readSnapshotFile(path);
  const raw = file.snapshots[key];
  const stored = raw ? applyIgnore(structuredClone(raw), options.ignore) : undefined;

  if (stored !== undefined && !env.update) {
    const stable = await ctx.engine.waitUntilStable((s) => deepEqual(snapshotState(s, options), stored), timeout, settle);
    if (stable) return { pass: true, description: `snapshot '${name}' matches` };
    const received = snapshotState(ctx.engine.state, options);
    const diffs = diffSnapshots(stored, received);
    return {
      pass: false,
      description: `snapshot '${name}' matches`,
      message: `snapshot '${name}' does not match (${diffs.length} difference${diffs.length === 1 ? "" : "s"}):\n${formatSnapshotDiff(diffs)}\nRun with --update-snapshots to accept the new state.`,
      expected: stored,
      received,
    };
  }

  if (stored === undefined && !env.update && isCi()) {
    return {
      pass: false,
      description: `snapshot '${name}' exists`,
      message: `snapshot '${name}' is missing from ${basename(path)} and CI is set, so it was not written. Run 'uefn test --update-snapshots' locally and commit the result.`,
    };
  }

  const received = await settledSnapshot(ctx, options, timeout, settle);
  ctx.ensureActive();
  if (stored !== undefined && deepEqual(stored, received)) return { pass: true, description: `snapshot '${name}' matches` };
  ctx.ensureActive();
  file.snapshots[key] = received;
  await writeSnapshotFile(path, file);
  return { pass: true, description: `snapshot '${name}' ${stored === undefined ? "written" : "updated"}`, received };
}
