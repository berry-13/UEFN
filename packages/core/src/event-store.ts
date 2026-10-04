import type { RuntimeEvent } from "@uefn-devtools/protocol";
import { matches } from "./match.ts";

export interface EventQuery {
  type?: string | string[];
  /** Only events at or after this store index (see {@link EventStore.mark}). */
  fromIndex?: number;
  since?: number;
  until?: number;
  sourceId?: string;
  targetId?: string;
  traceId?: string;
  /** Deep partial match against the payload. */
  payload?: Record<string, unknown>;
  limit?: number;
}

export interface CausalNode {
  event: RuntimeEvent;
  children: CausalNode[];
}

type Listener = (event: RuntimeEvent, index: number) => void;

/** Append-only event log for a session; the source of truth for state and traces. */
export class EventStore {
  private readonly events: RuntimeEvent[] = [];
  private readonly byId = new Map<string, RuntimeEvent>();
  private readonly indexById = new Map<string, number>();
  private readonly listeners = new Set<Listener>();

  get size(): number {
    return this.events.length;
  }

  /** Index of the next event; pass as `fromIndex` to scope queries to "from now on". */
  mark(): number {
    return this.events.length;
  }

  append(event: RuntimeEvent): void {
    const index = this.events.length;
    this.events.push(event);
    this.byId.set(event.id, event);
    this.indexById.set(event.id, index);
    for (const listener of this.listeners) listener(event, index);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(id: string): RuntimeEvent | undefined {
    return this.byId.get(id);
  }

  /** Store index of an event, or -1. */
  indexOf(id: string): number {
    return this.indexById.get(id) ?? -1;
  }

  all(fromIndex = 0): readonly RuntimeEvent[] {
    return this.events.slice(fromIndex);
  }

  query(q: EventQuery = {}): RuntimeEvent[] {
    const types = q.type === undefined ? undefined : new Set(Array.isArray(q.type) ? q.type : [q.type]);
    const out: RuntimeEvent[] = [];
    for (let i = q.fromIndex ?? 0; i < this.events.length; i++) {
      const e = this.events[i]!;
      if (eventMatches(e, q, types)) {
        out.push(e);
        if (q.limit !== undefined && out.length >= q.limit) break;
      }
    }
    return out;
  }

  /** Root-to-event causal chain, following `parentEventId`. */
  ancestry(id: string): RuntimeEvent[] {
    const chain: RuntimeEvent[] = [];
    const seen = new Set<string>();
    let current = this.byId.get(id);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.unshift(current);
      current = current.parentEventId ? this.byId.get(current.parentEventId) : undefined;
    }
    return chain;
  }

  /** Causal tree rooted at the earliest ancestor of `id` (spec §18). */
  causalTree(id: string): CausalNode | undefined {
    const root = this.ancestry(id)[0];
    if (!root) return undefined;
    const children = new Map<string, RuntimeEvent[]>();
    for (const e of this.events) {
      if (!e.parentEventId) continue;
      const list = children.get(e.parentEventId) ?? [];
      list.push(e);
      children.set(e.parentEventId, list);
    }
    const build = (event: RuntimeEvent, depth: number): CausalNode => ({
      event,
      children: depth > 64 ? [] : (children.get(event.id) ?? []).map((c) => build(c, depth + 1)),
    });
    return build(root, 0);
  }

  countsByType(fromIndex = 0): Record<string, number> {
    const counts: Record<string, number> = {};
    for (let i = fromIndex; i < this.events.length; i++) {
      const type = this.events[i]!.type;
      counts[type] = (counts[type] ?? 0) + 1;
    }
    return counts;
  }

  toJSONL(fromIndex = 0): string {
    return this.events
      .slice(fromIndex)
      .map((e) => JSON.stringify(e))
      .join("\n");
  }
}

export function eventMatches(e: RuntimeEvent, q: EventQuery, types?: Set<string>): boolean {
  if (types && !types.has(e.type)) return false;
  if (q.since !== undefined && e.timestamp < q.since) return false;
  if (q.until !== undefined && e.timestamp > q.until) return false;
  if (q.sourceId !== undefined && e.source?.id !== q.sourceId) return false;
  if (q.targetId !== undefined && e.target?.id !== q.targetId) return false;
  if (q.traceId !== undefined && e.traceId !== q.traceId) return false;
  if (q.payload !== undefined && !matches(e.payload, q.payload)) return false;
  return true;
}

export function formatCausalTree(node: CausalNode, indent = ""): string {
  const label = `${node.event.type}${describePayload(node.event.payload)}`;
  const lines = [indent + label];
  node.children.forEach((child, i) => {
    const last = i === node.children.length - 1;
    const sub = formatCausalTree(child, "").split("\n");
    lines.push(`${indent}${last ? "└─ " : "├─ "}${sub[0]}`);
    for (const rest of sub.slice(1)) lines.push(`${indent}${last ? "   " : "│  "}${rest}`);
  });
  return lines.join("\n");
}

function describePayload(payload: Record<string, unknown>): string {
  const keys = ["device", "player", "team", "delta", "state"].filter((k) => payload[k] !== undefined && payload[k] !== null);
  if (keys.length === 0) return "";
  return ` (${keys.map((k) => `${k}=${String(payload[k])}`).join(", ")})`;
}
