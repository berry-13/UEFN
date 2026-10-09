import * as vscode from "vscode";
import type { Project } from "./project.ts";
import type { CausalNode, GameState, RuntimeEvent, SessionSnapshot } from "./types.ts";

const MAX_EVENTS = 500;

function entity(ref: RuntimeEvent["source"]): string | undefined {
  return ref ? `${ref.type}:${ref.id}` : undefined;
}

function eventDescription(event: RuntimeEvent): string {
  const parts = [`t=${(event.timestamp / 1000).toFixed(2)}s`];
  const source = entity(event.source);
  const target = entity(event.target);
  if (source && target) parts.push(`${source} to ${target}`);
  else if (source ?? target) parts.push((source ?? target)!);
  return parts.join(", ");
}

function eventTooltip(event: RuntimeEvent): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${event.type}** at ${(event.timestamp / 1000).toFixed(3)}s\n\n`);
  md.appendCodeblock(JSON.stringify({ id: event.id, source: event.source, target: event.target, traceId: event.traceId, payload: event.payload }, null, 2), "json");
  return md;
}

type EventNode =
  | { kind: "event"; event: RuntimeEvent }
  | { kind: "trace"; node: CausalNode; selectedId: string }
  | { kind: "message"; label: string };

/** "Live Events": the latest runtime events, newest first, each expanding to its causal tree. */
export class EventsProvider implements vscode.TreeDataProvider<EventNode> {
  private readonly emitter = new vscode.EventEmitter<EventNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private events: RuntimeEvent[] = [];
  private connected = false;
  private pending: NodeJS.Timeout | undefined;
  private readonly project: Project;

  constructor(project: Project) {
    this.project = project;
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    this.emitter.fire(undefined);
  }

  add(event: RuntimeEvent): void {
    // Profiler samples arrive continuously and would push gameplay events out
    // of the capped list; `uefn profile` and the dashboard cover them.
    if (event.type.startsWith("perf.")) return;
    this.events.unshift(event);
    if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS;
    // Coalesce bursts into one tree refresh.
    this.pending ??= setTimeout(() => {
      this.pending = undefined;
      this.emitter.fire(undefined);
    }, 250);
  }

  clear(): void {
    this.events = [];
    this.emitter.fire(undefined);
  }

  getTreeItem(node: EventNode): vscode.TreeItem {
    if (node.kind === "message") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.accessibilityInformation = { label: node.label };
      return item;
    }
    if (node.kind === "event") {
      const item = new vscode.TreeItem(node.event.type, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `event:${node.event.id}`;
      item.description = eventDescription(node.event);
      item.tooltip = eventTooltip(node.event);
      item.iconPath = new vscode.ThemeIcon("pulse");
      item.contextValue = "uefnEvent";
      item.accessibilityInformation = { label: `Event ${node.event.type}, ${item.description}. Expand to show its causal trace.` };
      return item;
    }
    const e = node.node.event;
    const selected = e.id === node.selectedId;
    const item = new vscode.TreeItem(
      e.type,
      node.node.children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.description = `${eventDescription(e)}${selected ? " (selected)" : ""}`;
    item.tooltip = eventTooltip(e);
    item.iconPath = new vscode.ThemeIcon(selected ? "target" : "debug-stackframe-dot");
    item.accessibilityInformation = {
      label: `Trace event ${e.type}, ${eventDescription(e)}${selected ? ", the selected event" : ""}, ${node.node.children.length} caused event(s)`,
    };
    return item;
  }

  async getChildren(node?: EventNode): Promise<EventNode[]> {
    if (!node) {
      if (this.events.length > 0) return this.events.map((event) => ({ kind: "event", event }));
      // An empty array lets the contributed welcome view show when no daemon is running.
      return this.connected ? [{ kind: "message", label: "Waiting for runtime events" }] : [];
    }
    if (node.kind === "trace") return node.node.children.map((child) => ({ kind: "trace", node: child, selectedId: node.selectedId }));
    if (node.kind === "message") return [];
    const client = this.project.client();
    if (!client) return [{ kind: "message", label: "Trace unavailable: no daemon is running" }];
    try {
      const trace = await client.trace(node.event.id);
      return [{ kind: "trace", node: trace.tree, selectedId: node.event.id }];
    } catch (error) {
      return [{ kind: "message", label: `Trace unavailable: ${(error as Error).message}` }];
    }
  }
}

type StateNode =
  | { kind: "group"; group: "teams" | "devices" | "players"; label: string }
  | { kind: "leaf"; label: string; description: string; icon: string }
  | { kind: "message"; label: string };

/** "Game State": teams, devices and players from `GET /api/state`. */
export class StateProvider implements vscode.TreeDataProvider<StateNode> {
  private readonly emitter = new vscode.EventEmitter<StateNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private state: GameState | undefined;
  private error: string | undefined;
  private requestSeq = 0;
  private pending: NodeJS.Timeout | undefined;
  private readonly project: Project;

  constructor(project: Project) {
    this.project = project;
  }

  async refresh(): Promise<void> {
    const seq = ++this.requestSeq;
    const client = this.project.client();
    if (!client) {
      this.state = undefined;
      this.error = undefined;
    } else {
      try {
        const state = await client.state();
        if (seq !== this.requestSeq) return;
        this.state = state;
        this.error = undefined;
      } catch (error) {
        if (seq !== this.requestSeq) return;
        this.error = (error as Error).message;
      }
    }
    this.emitter.fire(undefined);
  }

  /** Throttled refresh for event bursts. */
  scheduleRefresh(): void {
    this.pending ??= setTimeout(() => {
      this.pending = undefined;
      void this.refresh();
    }, 1000);
  }

  getTreeItem(node: StateNode): vscode.TreeItem {
    if (node.kind === "group") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `state:${node.group}`;
      item.accessibilityInformation = { label: node.label };
      return item;
    }
    if (node.kind === "message") {
      const item = new vscode.TreeItem(node.label);
      item.accessibilityInformation = { label: node.label };
      return item;
    }
    const item = new vscode.TreeItem(node.label);
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon(node.icon);
    item.accessibilityInformation = { label: `${node.label}: ${node.description}` };
    return item;
  }

  getChildren(node?: StateNode): StateNode[] {
    const s = this.state;
    if (!node) {
      if (!this.project.daemon) return [];
      if (this.error) return [{ kind: "message", label: `Game state unavailable: ${this.error}` }];
      if (!s) return [{ kind: "message", label: "Loading game state" }];
      const teams = Object.keys(s.teams).length;
      const devices = Object.keys(s.devices).length;
      const players = Object.keys(s.players).length;
      return [
        { kind: "leaf", label: "Phase", description: `${s.phase}, round ${s.round}${s.winner !== undefined ? `, winner team ${s.winner}` : ""}`, icon: "info" },
        { kind: "group", group: "teams", label: `Teams (${teams})` },
        { kind: "group", group: "devices", label: `Devices (${devices})` },
        { kind: "group", group: "players", label: `Players (${players})` },
      ];
    }
    if (node.kind !== "group" || !s) return [];
    if (node.group === "teams") {
      return Object.values(s.teams)
        .sort((a, b) => a.id - b.id)
        .map((t) => ({ kind: "leaf", label: `Team ${t.id}`, description: `score ${t.score}`, icon: "organization" }));
    }
    if (node.group === "devices") {
      return Object.values(s.devices)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((d) => ({
          kind: "leaf",
          label: d.id,
          description: [
            d.state ?? (d.enabled ? "enabled" : "disabled"),
            d.state && !d.enabled ? "disabled" : undefined,
            d.owner !== undefined ? `owner team ${d.owner}` : undefined,
            d.progress !== undefined ? `progress ${Math.round(d.progress)}%` : undefined,
            d.triggerCount ? `triggered ${d.triggerCount}x` : undefined,
          ]
            .filter(Boolean)
            .join(", "),
          icon: "circuit-board",
        }));
    }
    return Object.values(s.players)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => ({
        kind: "leaf",
        label: p.id,
        description: [
          p.team !== undefined ? `team ${p.team}` : undefined,
          p.alive ? "alive" : "eliminated",
          p.health !== undefined ? `health ${p.health}` : undefined,
          p.shield !== undefined ? `shield ${p.shield}` : undefined,
          `score ${p.score}`,
          p.areas.length ? `in ${p.areas.join(", ")}` : undefined,
        ]
          .filter(Boolean)
          .join(", "),
        icon: p.alive ? "person" : "circle-slash",
      }));
  }
}

/**
 * Keeps one SSE connection to the live daemon and fans messages out to the
 * views. Reconnects (resuming from the last index) while the daemon's pid is
 * alive; stops when daemon.json goes away.
 */
export class LiveConnection implements vscode.Disposable {
  private abort: AbortController | undefined;
  private lastIndex = -1;
  private retry: NodeJS.Timeout | undefined;
  private readonly sessionEmitter = new vscode.EventEmitter<SessionSnapshot | undefined>();
  readonly onDidChangeSession = this.sessionEmitter.event;
  private readonly project: Project;
  private readonly events: EventsProvider;
  private readonly state: StateProvider;

  constructor(project: Project, events: EventsProvider, state: StateProvider) {
    this.project = project;
    this.events = events;
    this.state = state;
  }

  /** (Re)connects to the current daemon, or disconnects when there is none. */
  sync(): void {
    this.stop();
    if (!this.project.daemon) {
      this.events.setConnected(false);
      this.sessionEmitter.fire(undefined);
      void this.state.refresh();
      return;
    }
    this.lastIndex = -1;
    this.events.clear();
    void this.connect();
  }

  private async connect(): Promise<void> {
    const client = this.project.client();
    if (!client) return;
    const abort = new AbortController();
    this.abort = abort;
    try {
      this.events.setConnected(true);
      void this.state.refresh();
      await client.stream(
        (message) => {
          let data: unknown;
          try {
            data = JSON.parse(message.data);
          } catch {
            return;
          }
          if (message.event === "runtime") {
            const event = data as RuntimeEvent & { index: number };
            if (event.index <= this.lastIndex) return;
            this.lastIndex = event.index;
            this.events.add(event);
            this.state.scheduleRefresh();
          } else if (message.event === "session") {
            this.sessionEmitter.fire(data as SessionSnapshot);
            this.state.scheduleRefresh();
          }
        },
        { signal: abort.signal, ...(this.lastIndex >= 0 ? { fromIndex: this.lastIndex + 1 } : {}) },
      );
    } catch (error) {
      if (abort.signal.aborted) return;
      this.project.output.appendLine(`Event stream error: ${(error as Error).message}`);
    }
    if (abort.signal.aborted) return;
    // The stream ended without us asking: the daemon stopped, crashed or restarted.
    const info = await this.project.refreshDaemon();
    if (info && this.abort === abort) {
      this.retry = setTimeout(() => void this.connect(), 2000);
    } else if (!info) {
      this.events.setConnected(false);
      this.sessionEmitter.fire(undefined);
    }
  }

  private stop(): void {
    clearTimeout(this.retry);
    this.abort?.abort();
    this.abort = undefined;
  }

  dispose(): void {
    this.stop();
    this.sessionEmitter.dispose();
  }
}
