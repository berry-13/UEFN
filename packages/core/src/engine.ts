import { resolve } from "node:path";
import type {
  CompileResult,
  DevToolsConfig,
  GameState,
  Project,
  RuntimeCommand,
  RuntimeEvent,
  Session,
} from "@uefn-devtools/protocol";
import { EventTypes, emptyGameState, parseDuration } from "@uefn-devtools/protocol";
import { McpUefnAdapter, SimulatedAdapter, type CapabilityReport, type UEFNAdapter } from "@uefn-devtools/uefn";
import { loadConfig, type LoadedConfig } from "./config.ts";
import { EventStore, eventMatches, type EventQuery } from "./event-store.ts";
import { captureGitInfo } from "./git.ts";
import { discoverProject } from "./project.ts";
import { applyEvent } from "./state.ts";

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly unsupported: boolean,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

/** Something that happened in the engine that clients may want to mirror (runner progress, etc.). */
export interface ActivityEvent {
  source: string;
  runId?: string;
  data: unknown;
}

export interface EngineOptions {
  cwd?: string;
  configPath?: string;
  /** Overrides `adapter` from the config. */
  adapter?: DevToolsConfig["adapter"];
  /** Injects an adapter directly (tests, embedding). */
  adapterInstance?: UEFNAdapter;
}

export function createAdapter(loaded: LoadedConfig, kind: DevToolsConfig["adapter"]): UEFNAdapter {
  const { config, root } = loaded;
  if (kind === "simulated") {
    return new SimulatedAdapter({ config: config.simulated, verseDir: resolve(root, config.paths.verse) });
  }
  return new McpUefnAdapter({
    mcp: config.mcp,
    ...(config.runtime.log_path ? { logPath: resolve(root, config.runtime.log_path) } : {}),
  });
}

/**
 * The one state model and execution engine every client (CLI, MCP, desktop)
 * talks to (spec §82, §89). Owns the adapter, the session, the event log
 * and the derived GameState.
 */
export class DevToolsEngine {
  readonly events = new EventStore();
  private liveState: GameState = emptyGameState();
  private currentSession?: Session;
  private pump?: Promise<void>;
  private ready = false;
  private connected = false;
  private lockTail: Promise<unknown> = Promise.resolve();
  private readonly activityListeners = new Set<(event: ActivityEvent) => void>();
  lastCompile?: CompileResult;

  private constructor(
    readonly loaded: LoadedConfig,
    readonly adapter: UEFNAdapter,
  ) {
    this.events.subscribe((event) => {
      applyEvent(this.liveState, event);
      if (event.type === EventTypes.SessionReady) this.ready = true;
      if (event.type === EventTypes.GameStarted && this.currentSession) this.currentSession.status = "playing";
      if (event.type === EventTypes.GameEnded && this.currentSession) this.currentSession.status = "connected";
    });
  }

  static async open(options: EngineOptions = {}): Promise<DevToolsEngine> {
    const loaded = await loadConfig(options.cwd ?? process.cwd(), options.configPath);
    const adapter = options.adapterInstance ?? createAdapter(loaded, options.adapter ?? loaded.config.adapter);
    return new DevToolsEngine(loaded, adapter);
  }

  /**
   * Runs `fn` with exclusive use of the session. Every client (CLI, MCP,
   * daemon RPC) goes through this so concurrent callers cannot interleave
   * test runs or session changes.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lockTail.then(fn, fn);
    this.lockTail = next.catch(() => {});
    return next;
  }

  publishActivity(event: ActivityEvent): void {
    for (const listener of this.activityListeners) listener(event);
  }

  onActivity(listener: (event: ActivityEvent) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  get config(): DevToolsConfig {
    return this.loaded.config;
  }

  get root(): string {
    return this.loaded.root;
  }

  get state(): GameState {
    return this.liveState;
  }

  get session(): Session | undefined {
    return this.currentSession;
  }

  get runtimeReady(): boolean {
    return this.ready;
  }

  now(): number {
    return this.adapter.clock.now();
  }

  sleep(ms: number): Promise<void> {
    return this.adapter.clock.sleep(ms);
  }

  /** Runs `fn` after `ms` on the session clock; returns a canceller. */
  schedule(ms: number, fn: () => void): () => void {
    const handle = setTimeout(fn, Math.max(0, this.adapter.clock.toWallMs(ms)));
    return () => clearTimeout(handle);
  }

  async project(): Promise<Project> {
    return discoverProject(this.loaded);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.adapter.connect();
    this.connected = true;
  }

  async capabilities(): Promise<CapabilityReport> {
    await this.connect();
    return this.adapter.describeCapabilities();
  }

  async compile(): Promise<CompileResult> {
    await this.connect();
    this.lastCompile = await this.adapter.compile();
    return this.lastCompile;
  }

  /** Launches a session, or reuses the one already running. */
  async startSession(): Promise<Session> {
    await this.connect();
    if (this.currentSession && this.currentSession.status !== "stopped" && this.currentSession.status !== "failed") {
      return this.currentSession;
    }
    const [handle, git] = await Promise.all([this.adapter.startSession(), captureGitInfo(this.root)]);
    const project = await this.project();
    this.currentSession = {
      id: handle.id,
      projectId: project.name,
      status: "starting",
      startedAt: Date.now(),
      adapter: this.adapter.name,
      ...(git?.commit ? { gitCommit: git.commit } : {}),
      ...(git ? { git } : {}),
    };
    this.ready = false;
    const transport = this.adapter.transport();
    await transport.start();
    this.pump = (async () => {
      for await (const event of transport.receive()) this.events.append(event);
    })();
    this.currentSession.status = "connected";
    return this.currentSession;
  }

  /** Blocks until the in-game runtime announces itself (`session.ready`). */
  async waitForRuntime(timeoutMs = parseDuration(this.config.runtime.ready_timeout)): Promise<void> {
    if (this.ready) return;
    await this.waitForEvent({ type: EventTypes.SessionReady }, { timeoutMs, fromIndex: 0 });
  }

  async stopSession(): Promise<void> {
    if (!this.currentSession) return;
    await this.adapter.stopSession();
    await this.pump;
    this.pump = undefined;
    this.currentSession.status = "stopped";
    this.currentSession.endedAt = Date.now();
    this.ready = false;
  }

  async close(): Promise<void> {
    await this.stopSession();
    if (this.connected) await this.adapter.disconnect();
    this.connected = false;
  }

  /** Sends a command to the runtime; throws {@link CommandError} on failure. */
  async command(command: RuntimeCommand): Promise<void> {
    if (!this.currentSession) throw new CommandError("no active session", false);
    const result = await this.adapter.transport().command(command);
    if (!result.ok) throw new CommandError(result.error ?? `${command.type} failed`, result.unsupported === true);
  }

  supportsCommand(type: RuntimeCommand["type"]): boolean {
    return this.currentSession !== undefined && this.adapter.transport().supportedCommands().includes(type);
  }

  /** Resolves with the first matching event at or after `fromIndex` (default: now). */
  waitForEvent(
    query: EventQuery,
    options: { timeoutMs: number; fromIndex?: number },
  ): Promise<RuntimeEvent> {
    const fromIndex = options.fromIndex ?? this.events.mark();
    const types = query.type === undefined ? undefined : new Set(Array.isArray(query.type) ? query.type : [query.type]);
    const existing = this.events.query({ ...query, fromIndex, limit: 1 })[0];
    if (existing) return Promise.resolve(existing);
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      const unsubscribe = this.events.subscribe((event) => {
        if (settled || !eventMatches(event, query, types)) return;
        settled = true;
        unsubscribe();
        cancel();
        resolvePromise(event);
      });
      const cancel = this.schedule(options.timeoutMs, () => {
        if (settled) return;
        settled = true;
        unsubscribe();
        reject(new TimeoutError(`timed out after ${options.timeoutMs}ms waiting for ${describeQuery(query)}`));
      });
    });
  }

  /** Forgets derived state (not the event log) before a test starts. */
  resetObservedState(): void {
    this.liveState = emptyGameState();
  }

  /**
   * Re-evaluates `check` after every event until it returns true or the
   * timeout (session clock) elapses. Returns the final verdict.
   */
  waitUntil(check: (state: GameState) => boolean, timeoutMs: number): Promise<boolean> {
    if (check(this.liveState)) return Promise.resolve(true);
    return new Promise((resolvePromise) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        cancel();
        resolvePromise(value);
      };
      const unsubscribe = this.events.subscribe(() => {
        if (check(this.liveState)) finish(true);
      });
      const cancel = this.schedule(timeoutMs, () => finish(check(this.liveState)));
    });
  }

  /**
   * Like {@link waitUntil}, but the condition must stay true for `settleMs`.
   * This is what catches a score that briefly reads 50 and then 100 because
   * a second scoring path fired.
   */
  waitUntilStable(check: (state: GameState) => boolean, timeoutMs: number, settleMs: number): Promise<boolean> {
    if (settleMs <= 0) return this.waitUntil(check, timeoutMs);
    return new Promise((resolvePromise) => {
      let settled = false;
      let cancelSettle: () => void = () => {};
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        cancelSettle();
        cancelDeadline();
        resolvePromise(value);
      };
      // Each time the condition becomes true, it must survive a full settle
      // window without any event turning it false again.
      const arm = () => {
        cancelSettle();
        cancelSettle = this.schedule(settleMs, () => {
          if (check(this.liveState)) finish(true);
        });
      };
      let holding = check(this.liveState);
      if (holding) arm();
      const unsubscribe = this.events.subscribe(() => {
        const now = check(this.liveState);
        if (now && !holding) arm();
        if (!now) cancelSettle();
        holding = now;
      });
      // A condition that first matches at the deadline still gets its window.
      const cancelDeadline = this.schedule(timeoutMs + settleMs + 1, () => finish(false));
    });
  }
}

function describeQuery(q: EventQuery): string {
  const parts = [q.type ? `event '${Array.isArray(q.type) ? q.type.join("|") : q.type}'` : "event"];
  if (q.payload) parts.push(`matching ${JSON.stringify(q.payload)}`);
  if (q.sourceId) parts.push(`from ${q.sourceId}`);
  return parts.join(" ");
}
