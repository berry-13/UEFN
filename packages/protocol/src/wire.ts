import type { EntityKind, EntityReference, RuntimeEvent } from "./events.ts";
import { EventTypes } from "./events.ts";

/**
 * Line-oriented wire format written by the Verse runtime
 * (`runtime/verse/devtools.verse`) through `Print`, and read back from the
 * UEFN output log by the log transport.
 *
 *   [UEFN-DEVTOOLS]|1|<kind>|<seq>|<name>|<field>|<field>...
 *
 * kind   E = event, P = probe update, H = hello (runtime ready)
 * seq    per-emitter sequence number, used to build event ids
 * name   event type (E), probe id (P), runtime version (H)
 * field  key[:t]=value, t ∈ s (default) | i | f | b | v (x,y,z)
 *
 * Reserved keys: `trace`, `parent` (sequence of the parent event), `src`
 * and `tgt` (`<kind>:<id>`). For P lines the value lives in key `v`.
 *
 * `%`, `|`, `=` and newlines in keys/values are percent-encoded. JSON was
 * rejected because Verse string literals treat `{` `}` as interpolation,
 * which makes a JSON encoder in Verse fragile.
 */
export const WIRE_MARKER = "[UEFN-DEVTOOLS]";
export const WIRE_VERSION = "1";

export type WireKind = "E" | "P" | "H";

export interface WireRecord {
  kind: WireKind;
  seq: number;
  name: string;
  fields: Record<string, unknown>;
  emitter?: string;
}

export function encodeWireValue(raw: string): string {
  return raw.replace(/%/g, "%25").replace(/\|/g, "%7C").replace(/=/g, "%3D").replace(/\n/g, "%0A");
}

export function decodeWireValue(raw: string): string {
  return raw.replace(/%7C/gi, "|").replace(/%3D/gi, "=").replace(/%0A/gi, "\n").replace(/%25/g, "%");
}

function decodeTyped(type: string, raw: string): unknown {
  switch (type) {
    case "i": {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n)) throw new Error(`invalid int '${raw}'`);
      return n;
    }
    case "f": {
      const n = Number.parseFloat(raw);
      if (Number.isNaN(n)) throw new Error(`invalid float '${raw}'`);
      return n;
    }
    case "b":
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new Error(`invalid bool '${raw}'`);
    case "v": {
      const parts = raw.split(",").map((p) => Number.parseFloat(p));
      if (parts.length !== 3 || parts.some(Number.isNaN)) throw new Error(`invalid vector '${raw}'`);
      return parts;
    }
    case "s":
      return raw;
    default:
      throw new Error(`unknown field type '${type}'`);
  }
}

/**
 * Parses one log line. Returns `undefined` for lines that do not carry the
 * marker; throws for lines that carry it but are malformed, so corruption is
 * never silently ignored.
 */
export function parseWireLine(line: string): WireRecord | undefined {
  const start = line.indexOf(WIRE_MARKER);
  if (start < 0) return undefined;
  const body = line.slice(start + WIRE_MARKER.length).trimEnd();
  const parts = body.split("|");
  // parts[0] is the empty string before the first separator.
  if (parts[0] !== "" || parts.length < 5) throw new Error(`malformed DevTools line: ${line}`);
  const [, version, kind, seqRaw, nameRaw, ...fieldParts] = parts as [string, string, string, string, string, ...string[]];
  if (version !== WIRE_VERSION) throw new Error(`unsupported wire version '${version}'`);
  if (kind !== "E" && kind !== "P" && kind !== "H") throw new Error(`unknown record kind '${kind}'`);
  const seq = Number.parseInt(seqRaw, 10);
  if (!Number.isFinite(seq)) throw new Error(`invalid sequence '${seqRaw}'`);

  const fields: Record<string, unknown> = {};
  for (const part of fieldParts) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    if (eq < 0) throw new Error(`field without value: '${part}'`);
    const keySpec = part.slice(0, eq);
    const value = decodeWireValue(part.slice(eq + 1));
    const colon = keySpec.indexOf(":");
    const key = decodeWireValue(colon < 0 ? keySpec : keySpec.slice(0, colon));
    const type = colon < 0 ? "s" : keySpec.slice(colon + 1);
    fields[key] = decodeTyped(type, value);
  }
  return { kind, seq, name: decodeWireValue(nameRaw), fields };
}

const ENTITY_KINDS = new Set<EntityKind>(["player", "device", "team", "scene", "verse", "asset", "probe", "system"]);

function parseEntity(raw: unknown): EntityReference | undefined {
  if (typeof raw !== "string") return undefined;
  const colon = raw.indexOf(":");
  if (colon < 0) return undefined;
  const kind = raw.slice(0, colon) as EntityKind;
  if (!ENTITY_KINDS.has(kind)) return undefined;
  return { type: kind, id: raw.slice(colon + 1) };
}

/** Converts a wire record into the normalised RuntimeEvent shape. */
export function wireRecordToEvent(record: WireRecord, timestamp: number, idPrefix = "rt"): RuntimeEvent {
  const { trace, parent, src, tgt, ...payload } = record.fields;
  const event: RuntimeEvent = {
    id: `${idPrefix}_${record.seq}`,
    timestamp,
    type:
      record.kind === "P" ? EventTypes.ProbeUpdated : record.kind === "H" ? EventTypes.SessionReady : record.name,
    payload:
      record.kind === "P"
        ? { probe: record.name, value: payload["v"] }
        : record.kind === "H"
          ? { runtimeVersion: record.name, ...payload }
          : payload,
  };
  const source = parseEntity(src);
  const target = parseEntity(tgt);
  if (source) event.source = source;
  if (target) event.target = target;
  if (typeof trace === "string") event.traceId = trace;
  if (parent !== undefined) event.parentEventId = `${idPrefix}_${String(parent)}`;
  return event;
}
