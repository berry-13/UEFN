import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Recording, type Anomaly, type RecordingKind, type RecordingSummary, type RuntimeEvent } from "@uefn-devtools/protocol";

/** Two same-typed events on the same entity closer than this are suspicious. */
const RAPID_REPEAT_MS = 50;
/** Event types that legitimately repeat quickly. */
const NOISY = new Set(["player.moved", "probe.updated", "log", "device.state_changed", "player.state_changed"]);

export function recordingsDir(root: string): string {
  return join(root, ".devtools", "recordings");
}

export function newRecordingId(): string {
  return `rec_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

function entityKey(e: RuntimeEvent): string {
  const t = e.target ? `${e.target.type}:${e.target.id}` : "";
  const s = e.source ? `${e.source.type}:${e.source.id}` : "";
  return `${s}>${t}`;
}

/**
 * Deterministic anomaly rules for bug recordings (spec §23). Each finding
 * names the events and traces involved so a human or agent can follow up
 * with `trace`.
 */
export function detectAnomalies(events: readonly RuntimeEvent[]): Anomaly[] {
  const out: Anomaly[] = [];
  const traces = (list: RuntimeEvent[]) => [...new Set(list.map((e) => e.traceId).filter((t): t is string => !!t))];

  // 1. One cause, the same effect twice: siblings of one parent sharing a type.
  const byParent = new Map<string, RuntimeEvent[]>();
  for (const e of events) {
    if (!e.parentEventId || NOISY.has(e.type)) continue;
    const key = `${e.parentEventId}|${e.type}|${entityKey(e)}`;
    const list = byParent.get(key) ?? [];
    list.push(e);
    byParent.set(key, list);
  }
  const reported = new Set<string>();
  for (const list of byParent.values()) {
    if (list.length < 2) continue;
    const parent = events.find((e) => e.id === list[0]!.parentEventId);
    for (const e of list) reported.add(e.id);
    out.push({
      rule: "duplicate-effect",
      severity: "error",
      message: `${list[0]!.type} fired ${list.length}× from the same ${parent?.type ?? "event"} (${list[0]!.parentEventId})`,
      eventIds: [...(parent ? [parent.id] : []), ...list.map((e) => e.id)],
      traceIds: traces(list),
    });
  }

  // 2. The same event on the same entity in quick succession.
  const last = new Map<string, RuntimeEvent>();
  for (const e of events) {
    if (NOISY.has(e.type) || e.type.startsWith("session.")) continue;
    const key = `${e.type}|${entityKey(e)}`;
    const prev = last.get(key);
    last.set(key, e);
    if (!prev || reported.has(e.id)) continue;
    const gap = e.timestamp - prev.timestamp;
    if (gap <= RAPID_REPEAT_MS) {
      out.push({
        rule: "rapid-repeat",
        severity: "warning",
        message: `${e.type} fired twice within ${Math.round(gap)} ms on ${entityKey(e).replace(">", " → ") || "the same entity"}`,
        eventIds: [prev.id, e.id],
        traceIds: traces([prev, e]),
      });
    }
  }

  // 3. Errors reported by the runtime or the transport.
  const errors = events.filter((e) => e.type === "log" && (e.payload["level"] === "error" || e.payload["level"] === "warning"));
  if (errors.length > 0) {
    const errorCount = errors.filter((e) => e.payload["level"] === "error").length;
    out.push({
      rule: "runtime-log",
      severity: errorCount > 0 ? "error" : "warning",
      message: `${errorCount} error(s) and ${errors.length - errorCount} warning(s) in the runtime log, first: ${String(errors[0]!.payload["message"] ?? "")}`,
      eventIds: errors.slice(0, 20).map((e) => e.id),
      traceIds: [],
    });
  }
  return out;
}

export function summarizeRecording(rec: Recording): RecordingSummary {
  const eventTypes: Record<string, number> = {};
  const devices = new Set<string>();
  const players = new Set<string>();
  const traces = new Set<string>();
  for (const e of rec.events) {
    eventTypes[e.type] = (eventTypes[e.type] ?? 0) + 1;
    for (const ref of [e.source, e.target]) {
      if (ref?.type === "device") devices.add(ref.id);
      if (ref?.type === "player") players.add(ref.id);
    }
    if (typeof e.payload["device"] === "string") devices.add(e.payload["device"]);
    if (typeof e.payload["player"] === "string") players.add(e.payload["player"]);
    if (e.traceId) traces.add(e.traceId);
  }
  return {
    id: rec.id,
    name: rec.name,
    kind: rec.kind,
    startedAt: rec.startedAt,
    durationMs: rec.durationMs,
    events: rec.events.length,
    eventTypes,
    devices: [...devices].sort(),
    players: [...players].sort(),
    traces: [...traces].sort(),
    anomalies: detectAnomalies(rec.events),
  };
}

export function formatRecordingSummary(s: RecordingSummary): string {
  const lines = [
    `${s.kind === "bug" ? "Bug Recording" : "Recording"} ${s.id} — ${s.name}`,
    "",
    `Duration          ${(s.durationMs / 1000).toFixed(1)} seconds`,
    `Events            ${s.events}`,
    `Relevant devices  ${s.devices.length}${s.devices.length ? `  (${s.devices.join(", ")})` : ""}`,
    `Players           ${s.players.length}${s.players.length ? `  (${s.players.join(", ")})` : ""}`,
  ];
  if (s.anomalies.length === 0) lines.push("", "No anomalies detected.");
  else {
    lines.push("", "Potential anomalies");
    for (const a of s.anomalies) {
      lines.push(`  [${a.severity}] ${a.message}`);
      if (a.traceIds.length) lines.push(`          traces: ${a.traceIds.join(", ")}`);
    }
  }
  return lines.join("\n");
}

export async function saveRecording(root: string, rec: Recording): Promise<string> {
  const dir = recordingsDir(root);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${rec.id}.json`);
  await writeFile(path, JSON.stringify(rec, null, 2) + "\n");
  return path;
}

/** Loads by id (from the project's recordings) or by path. */
export async function loadRecording(root: string, idOrPath: string): Promise<Recording> {
  const path = /^rec_[a-z0-9]+$/.test(idOrPath) ? join(recordingsDir(root), `${idOrPath}.json`) : idOrPath;
  const parsed = Recording.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is not a valid recording: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

export async function listRecordings(root: string): Promise<RecordingSummary[]> {
  const files = (await readdir(recordingsDir(root)).catch(() => [] as string[])).filter((f) => /^rec_[a-z0-9]+\.json$/.test(f));
  const out: RecordingSummary[] = [];
  for (const f of files) {
    try {
      out.push(summarizeRecording(await loadRecording(root, join(recordingsDir(root), f))));
    } catch {
      // Skip unreadable files rather than failing the whole listing.
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

export interface ActiveRecording {
  id: string;
  name: string;
  kind: RecordingKind;
  fromIndex: number;
  sessionStart: number;
  startedAt: number;
}
