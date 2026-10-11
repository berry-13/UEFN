import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CommandResult, CompileResult, DeviceInfo, Diagnostic, RuntimeCommand, RuntimeEvent, SessionStatus } from "@uefn-devtools/protocol";
import { DevToolsConfig } from "@uefn-devtools/protocol";
import type {
  AdapterSession,
  Capability,
  CapabilityReport,
  RuntimeTransport,
  StartSessionOptions,
  UEFNAdapter,
} from "./adapter.ts";
import { stat } from "node:fs/promises";
import { RealClock, type Clock } from "./clock.ts";
import { LogFileTransport } from "./log-transport.ts";
import { ScenarioTransport } from "./scenario-transport.ts";

type McpConfig = DevToolsConfig["mcp"];
type ToolKey = keyof McpConfig["tools"];

export interface McpAdapterOptions {
  mcp: McpConfig;
  logPath?: string;
  /** Player actions are performed by a generated in-game scenario device (docs/scenarios.md). */
  scenario?: { stepTimeoutMs: number };
  /** How often a session that is still starting is polled before deciding whether to launch one. */
  sessionPollMs?: number;
}

/** Log bytes searched for the hello of a session that was already running. */
const BACKFILL_BYTES = 4 * 1024 * 1024;

interface ToolOutput {
  isError: boolean;
  text: string;
  json?: unknown;
}

/** What `describe_toolset` said about one toolset. */
interface DescribedToolset {
  exists: boolean;
  /** Tool names found in a structured answer; absent when the shape was not recognised. */
  names?: Set<string>;
  text: string;
}

/**
 * Adapter that drives UEFN through its MCP server (Prototype A, spec §88).
 *
 * The mapping from DevTools operations to UEFN tool names is configuration,
 * not code, until the official tool surface has been catalogued with
 * `uefn capabilities`. Unmapped operations fail loudly rather than guess.
 */
export class McpUefnAdapter implements UEFNAdapter {
  readonly name = "mcp";
  readonly clock: Clock = new RealClock();
  private client?: Client;
  private mcpTransport?: Transport;
  private connected = false;
  private connecting?: Promise<void>;
  private tools: { name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } }[] = [];
  private toolsets = new Map<string, DescribedToolset>();
  private session?: { id: string; transport: RuntimeTransport };

  constructor(private readonly options: McpAdapterOptions) {}

  /** Concurrent callers share one connection attempt instead of each opening a transport. */
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async open(): Promise<void> {
    const { command, args, url } = this.options.mcp;
    const transport = url
      ? new StreamableHTTPClientTransport(new URL(url))
      : command
        ? new StdioClientTransport({ command, args })
        : undefined;
    if (!transport) throw new Error("mcp adapter requires `mcp.command` or `mcp.url` in uefn-devtools.config.yaml");
    const client = new Client({ name: "uefn-devtools", version: "0.1.0" });
    // Kept before awaiting so disconnect() can stop a spawned server even if the handshake never completes.
    this.client = client;
    this.mcpTransport = transport;
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      this.tools = listed.tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        ...(t.inputSchema ? { inputSchema: t.inputSchema as { properties?: Record<string, unknown> } } : {}),
      }));
      await this.describeMappedToolsets(client);
      this.connected = true;
    } catch (error) {
      await this.disconnect().catch(() => {});
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.session?.transport.stop();
    this.session = undefined;
    const client = this.client;
    const transport = this.mcpTransport;
    this.client = undefined;
    this.mcpTransport = undefined;
    this.connected = false;
    this.toolsets.clear();
    try {
      await client?.close();
    } finally {
      // Client.close() only reaches the transport once the handshake began; close it directly as well.
      await transport?.close().catch(() => {});
    }
  }

  /** Runtime commands this server can execute through mapped tools. */
  gameCommands(): ("start_game" | "end_game")[] {
    return (["start_game", "end_game"] as const).filter((key) => {
      const name = this.options.mcp.tools[key];
      return name !== undefined && this.hasTool(name);
    });
  }

  /**
   * Runs a mapped game command; used by {@link McpCommandTransport}, which
   * turns a no-op into the lifecycle event the log would have shown.
   */
  async gameCommand(key: "start_game" | "end_game"): Promise<CommandResult> {
    // UEFN auto-starts the match on launch by default, and refuses StartGame
    // while one runs ("not in a startable state"); seen live on 42.30. With
    // game_state mapped, a match already in the wanted state is success.
    const running = await this.gameRunning();
    if ((key === "start_game" && running === true) || (key === "end_game" && running === false)) return { ok: true, noop: true };
    const out = await this.call(key);
    return out.isError ? { ok: false, error: out.text || `${key} failed` } : { ok: true };
  }

  /**
   * True when `mapping` can be called: a tool listed by name, or
   * `<toolset>/<tool>` on a server in meta-tool mode. UEFN 42.30 lists only
   * `list_toolsets`, `describe_toolset` and `call_tool` and reaches its
   * toolsets through `call_tool` (seen in a live editor log). The pair is
   * checked against the `describe_toolset` answer fetched at connect, so a
   * typo is not advertised as callable.
   */
  hasTool(mapping: string): boolean {
    if (this.tools.some((t) => t.name === mapping)) return true;
    if (!mapping.includes("/") || !this.tools.some((t) => t.name === "call_tool")) return false;
    const slash = mapping.lastIndexOf("/");
    const described = this.toolsets.get(mapping.slice(0, slash));
    // Not described (no describe_toolset, or it timed out): nothing to check against.
    if (!described) return true;
    if (!described.exists) return false;
    const toolset = mapping.slice(0, slash);
    const tool = mapping.slice(slash + 1);
    // UEFN 42.30 names each tool `<toolset>.<tool>` in describe_toolset.
    if (described.names) return described.names.has(tool) || described.names.has(`${toolset}.${tool}`);
    // An answer whose shape is not recognised: accept a whole-word mention of the tool.
    const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(described.text);
  }

  /** Calls `describe_toolset` once for each toolset named in the tool mappings. */
  private async describeMappedToolsets(client: Client): Promise<void> {
    this.toolsets.clear();
    const describe = this.tools.find((t) => t.name === "describe_toolset");
    if (!describe || !this.tools.some((t) => t.name === "call_tool")) return;
    const toolsets = new Set(
      Object.values(this.options.mcp.tools)
        .filter((m): m is string => typeof m === "string" && m.includes("/") && !this.tools.some((t) => t.name === m))
        .map((m) => m.slice(0, m.lastIndexOf("/"))),
    );
    const keys = Object.keys(describe.inputSchema?.properties ?? {});
    const key = keys.find((k) => /toolset/i.test(k)) ?? keys[0] ?? "toolset_name";
    for (const toolset of toolsets) {
      const result = await client
        .callTool({ name: "describe_toolset", arguments: { [key]: toolset } }, undefined, { timeout: this.options.mcp.timeout_ms })
        // A protocol error is an answer (no such toolset); a timeout or a broken connection is not.
        .catch((error: unknown) =>
          error instanceof McpError && error.code !== ErrorCode.RequestTimeout && error.code !== ErrorCode.ConnectionClosed
            ? { isError: true, content: [{ type: "text", text: error.message }] }
            : undefined,
        );
      if (!result) continue;
      const text = textOf(result.content);
      if (result.isError === true) {
        this.toolsets.set(toolset, { exists: false, text });
        continue;
      }
      const names = toolNames(("structuredContent" in result ? result.structuredContent : undefined) ?? parseJson(text));
      this.toolsets.set(toolset, { exists: true, text, ...(names.size ? { names } : {}) });
    }
  }

  /** `call_tool` arguments, named after the properties its input schema publishes. */
  private metaCall(mapping: string, args: Record<string, unknown>): { name: string; arguments: Record<string, unknown> } {
    const slash = mapping.lastIndexOf("/");
    const toolset = mapping.slice(0, slash);
    const tool = mapping.slice(slash + 1);
    const keys = Object.keys(this.tools.find((t) => t.name === "call_tool")?.inputSchema?.properties ?? {});
    const toolsetKey = keys.find((k) => /toolset/i.test(k)) ?? "toolset_name";
    const toolKey = keys.find((k) => /tool/i.test(k) && !/toolset/i.test(k)) ?? keys.find((k) => /^name$/i.test(k)) ?? "tool_name";
    const argsKey = keys.find((k) => /arg|param|input/i.test(k)) ?? "arguments";
    return { name: "call_tool", arguments: { [toolsetKey]: toolset, [toolKey]: tool, [argsKey]: args } };
  }

  /** True / false from the mapped game_state tool; undefined when unmapped or unknown. */
  /**
   * Ends the running match and starts a new one, waiting (up to
   * mcp.timeout_ms) for UEFN to leave the running state in between, since
   * StartGame is refused while a match runs.
   */
  async restartGame(): Promise<CommandResult> {
    const ended = await this.gameCommand("end_game");
    if (!ended.ok) return ended;
    const deadline = Date.now() + this.options.mcp.timeout_ms;
    while ((await this.gameRunning()) === true) {
      if (Date.now() > deadline) return { ok: false, error: "UEFN still reports the match running after StopGame; cannot restart it for the scenario device" };
      await new Promise((r) => setTimeout(r, 250));
    }
    return this.gameCommand("start_game");
  }

  private async gameRunning(): Promise<boolean | undefined> {
    const name = this.options.mcp.tools.game_state;
    if (!name || !this.hasTool(name)) return undefined;
    const out = await this.call("game_state").catch(() => undefined);
    if (!out || out.isError) return undefined;
    const value = isRecord(out.json) ? out.json["returnValue"] : out.json;
    const raw = String(typeof value === "string" ? value : out.text).toLowerCase();
    if (raw.includes("running")) return true;
    if (raw.includes("canstart") || raw.includes("unconnected")) return false;
    return undefined;
  }

  private async call(key: ToolKey, args: Record<string, unknown> = {}): Promise<ToolOutput> {
    const name = this.options.mcp.tools[key];
    if (!name) throw new Error(`no UEFN MCP tool mapped for '${key}' (set mcp.tools.${key} in the config)`);
    if (!this.client || !this.connected) throw new Error("mcp adapter is not connected");
    if (!this.hasTool(name)) {
      throw new Error(`UEFN MCP server does not expose tool '${name}' (mapped from '${key}')`);
    }
    const request = this.tools.some((t) => t.name === name) ? { name, arguments: args } : this.metaCall(name, args);
    const result = await this.client.callTool(request, undefined, {
      timeout: this.options.mcp.timeout_ms,
    });
    const text = textOf(result.content);
    const json: unknown = result.structuredContent ?? parseJson(text);
    return { isError: result.isError === true, text, json };
  }

  async getProjectInfo(): Promise<Record<string, unknown>> {
    if (!this.options.mcp.tools.project_info) return { adapter: this.name };
    const out = await this.call("project_info");
    return { adapter: this.name, ...(isRecord(out.json) ? out.json : { raw: out.text }) };
  }

  async compile(): Promise<CompileResult> {
    const started = performance.now();
    const out = await this.call("compile");
    const diagnostics = extractDiagnostics(out);
    const success = !out.isError && !diagnostics.some((d) => d.severity === "error");
    return { success, durationMs: performance.now() - started, diagnostics, raw: out.text };
  }

  async startSession(options: StartSessionOptions = {}): Promise<AdapterSession> {
    if (this.session) return { id: this.session.id, reused: true };
    const status = await this.settledSessionStatus();
    const reused = status === "connected" || status === "playing";
    // StartSession returns once the client is in the match, by which time
    // the runtime may have logged its hello; read the log from before launch.
    const launchOffset = !reused && this.options.logPath ? await stat(this.options.logPath).then((s) => s.size, () => 0) : undefined;
    if (!reused) {
      // No `headed` argument: every UEFN play session launches the Fortnite
      // client (seen in real editor logs), and an unknown argument could make
      // a strictly validated tool reject the call.
      const out = await this.call("start_session").catch((error: unknown) => {
        // StartSession blocks until the client is in the match; when UEFN's own
        // launch pipeline stalls (seen live: Versioning failed with "Failed to
        // resolve validation session"), only a timeout reaches us. Any other
        // error is not a stalled launch and is passed on unchanged.
        if (!(error instanceof McpError && error.code === ErrorCode.RequestTimeout)) throw error;
        throw new Error(
          `UEFN did not finish launching the session (${error.message}). Check UEFN's Session Inspector ` +
            "for the failed stage and close any 'Unable to Play' dialog before retrying.",
        );
      });
      if (out.isError) throw new Error(`UEFN refused to start a session: ${out.text}`);
    }
    if (!this.options.logPath) {
      throw new Error("runtime.log_path must point at the UEFN output log so runtime events can be observed");
    }
    // A reused session logged its one-shot hello (and match start) before this
    // process attached; the log transport replays them from the end of the log.
    const log = new LogFileTransport({
      path: this.options.logPath,
      clock: this.clock,
      ...(reused ? { backfillBytes: BACKFILL_BYTES } : {}),
      ...(launchOffset !== undefined ? { fromOffset: launchOffset } : {}),
    });
    // A scenario device runs once per match, at its start. In a reused session
    // whose match already runs, it ran before this process attached (and its
    // reports are not backfilled), so the first start_game restarts the match.
    const commands = new McpCommandTransport(log, this, { restartRunningMatch: reused && this.options.scenario !== undefined });
    const transport = this.options.scenario
      ? new ScenarioTransport(commands, { clock: this.clock, stepTimeoutMs: this.options.scenario.stepTimeoutMs })
      : commands;
    this.session = { id: `uefn-${Date.now().toString(36)}`, transport };
    return { id: this.session.id, reused };
  }

  /**
   * The session status once UEFN is no longer in the middle of launching
   * one, so a session that is still connecting is joined rather than started
   * a second time. Polls for at most `mcp.timeout_ms`.
   */
  private async settledSessionStatus(): Promise<SessionStatus | "none"> {
    const deadline = this.clock.now() + this.options.mcp.timeout_ms;
    for (;;) {
      const status = await this.getSessionStatus().catch(() => "none" as const);
      if (status !== "starting") return status;
      if (this.clock.now() >= deadline) {
        throw new Error(
          `UEFN's session was still starting after ${Math.round(this.options.mcp.timeout_ms / 1000)}s; ` +
            "let it finish connecting (or stop it in UEFN) and retry",
        );
      }
      await this.clock.sleep(this.options.sessionPollMs ?? 1000);
    }
  }

  async stopSession(): Promise<void> {
    if (this.options.mcp.tools.stop_session) await this.call("stop_session");
    await this.session?.transport.stop();
    this.session = undefined;
  }

  async getSessionStatus(): Promise<SessionStatus | "none"> {
    if (!this.options.mcp.tools.session_state) return this.session ? "connected" : "none";
    const out = await this.call("session_state");
    return sessionStatusFrom(out);
  }

  async getDevices(): Promise<DeviceInfo[]> {
    return [];
  }

  transport(): RuntimeTransport {
    if (!this.session) throw new Error("no active session");
    return this.session.transport;
  }

  async describeCapabilities(): Promise<CapabilityReport> {
    const mapped = (key: ToolKey, feature: string): Capability => {
      const name = this.options.mcp.tools[key];
      if (!name) return { feature, status: "UNKNOWN", notes: `map mcp.tools.${key} to a UEFN tool` };
      const exists = this.hasTool(name);
      return exists
        ? { feature, status: "DIRECT", via: `mcp:${name}`, ...(this.tools.some((t) => t.name === name) ? {} : { notes: "through call_tool" }) }
        : { feature, status: "UNKNOWN", via: `mcp:${name}`, notes: "mapped tool not exposed by server" };
    };
    // Meta-tool servers hide their toolsets behind list_toolsets; include its
    // answer so one capability dump shows the real toolset and tool names.
    let toolsets: string | undefined;
    if (this.client && this.tools.some((t) => t.name === "list_toolsets")) {
      const out = await this.client
        .callTool({ name: "list_toolsets", arguments: {} }, undefined, { timeout: this.options.mcp.timeout_ms })
        .catch(() => undefined);
      toolsets = textOf(out?.content);
    }
    return {
      adapter: this.name,
      tools: this.tools.map(({ name, description }) => ({ name, ...(description ? { description } : {}) })),
      ...(toolsets !== undefined ? { toolsets } : {}),
      capabilities: [
        mapped("project_info", "project info"),
        mapped("compile", "compile"),
        mapped("start_session", "launch session"),
        mapped("stop_session", "stop session"),
        mapped("session_state", "session status"),
        this.options.logPath
          ? { feature: "runtime events", status: "INSTRUMENTED", via: "Verse Print → output log" }
          : { feature: "runtime events", status: "UNKNOWN", notes: "set runtime.log_path" },
        mapped("start_game", "start game"),
        mapped("end_game", "end game"),
        {
          feature: "player actions",
          status: "UNKNOWN",
          notes: "no inbound channel identified; steps run from an in-game scenario device",
        },
      ],
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(content: unknown): string {
  return (Array.isArray(content) ? content : [])
    .filter((c): c is { type: "text"; text: string } => c?.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Tool names in a `describe_toolset` answer: any `name` / `tool_name` / `toolName` string, at any depth. */
function toolNames(json: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(json)) {
    for (const item of json) toolNames(item, into);
  } else if (isRecord(json)) {
    for (const [key, value] of Object.entries(json)) {
      if (/^(name|tool_?name)$/i.test(key) && typeof value === "string") into.add(value);
      else toolNames(value, into);
    }
  }
  return into;
}

/**
 * A Verse compiler diagnostic. Real UEFN 41.10 lines look like
 * `[...]VerseBuild: Error: C:/.../GameManager.verse(1111,55, 1111,83): Script error 3512: msg`
 * (each printed twice, the second time with `) :`); the bare
 * `file.verse(l,c): error X: msg` form is accepted too.
 */
const DIAGNOSTIC_LINE =
  /^(?:\[[^\]]*\]\[\s*\d+\]VerseBuild:\s(?:Error|Warning):\s)?(?<file>[^\s(][^(]*?\.verse)\((?<line>\d+)(?:,\s*(?<col>\d+))?(?:,\s*\d+,\s*\d+)?\)\s*:\s*(?:Script\s+)?(?<sev>error|warning)\s*(?<code>\w+)?\s*:?\s*(?<msg>.*)$/i;

/** Accepts structured diagnostics when offered, else parses `file.verse(l,c): error X: msg` lines. */
export function extractDiagnostics(out: ToolOutput): Diagnostic[] {
  const structured = structuredDiagnostics(out.json);
  if (structured) return structured;
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const line of out.text.split(/\r?\n/)) {
    const m = DIAGNOSTIC_LINE.exec(line.trim());
    if (!m?.groups) continue;
    const message = m.groups["msg"]!.trim();
    // Two different errors can share a position and code; only exact repeats are dropped.
    const key = [m.groups["file"], m.groups["line"], m.groups["col"], m.groups["code"], m.groups["sev"]!.toLowerCase(), message].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push({
      severity: m.groups["sev"]!.toLowerCase() === "warning" ? "warning" : "error",
      message,
      file: m.groups["file"]!,
      line: Number(m.groups["line"]),
      ...(m.groups["col"] ? { column: Number(m.groups["col"]) } : {}),
      ...(m.groups["code"] ? { code: m.groups["code"] } : {}),
    });
  }
  if (out.isError && diagnostics.length === 0) diagnostics.push({ severity: "error", message: out.text || "compile failed" });
  return diagnostics;
}

/**
 * The session's runtime transport: events come from the log, and the match
 * start / end commands go through mapped MCP tools when the server has them.
 */
class McpCommandTransport implements RuntimeTransport {
  readonly name: string;

  private restartRunningMatch: boolean;

  constructor(
    private readonly inner: LogFileTransport,
    private readonly adapter: McpUefnAdapter,
    options: { restartRunningMatch?: boolean } = {},
  ) {
    this.name = `${inner.name}+mcp`;
    this.restartRunningMatch = options.restartRunningMatch === true;
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  stop(): Promise<void> {
    return this.inner.stop();
  }

  receive(): AsyncIterable<RuntimeEvent> {
    return this.inner.receive();
  }

  async command(command: RuntimeCommand): Promise<CommandResult> {
    if ((command.type === "start_game" || command.type === "end_game") && this.adapter.gameCommands().includes(command.type)) {
      let result = await this.adapter.gameCommand(command.type);
      if (command.type === "start_game" && this.restartRunningMatch) {
        this.restartRunningMatch = false;
        if (result.noop) result = await this.adapter.restartGame();
      }
      // UEFN already had the match in the wanted state (it auto-starts one on
      // launch), so no lifecycle line may follow; emit the event so the
      // derived phase, and with it the runner's end_game cleanup, see it.
      if (result.noop) this.inner.assumeGameState(command.type === "start_game");
      return result;
    }
    return this.inner.command(command);
  }

  supportedCommands(): readonly RuntimeCommand["type"][] {
    return [...this.adapter.gameCommands(), ...this.inner.supportedCommands()];
  }

  resetObservedState(): void {
    this.inner.resetObservedState();
  }
}

/**
 * The virtual module root UEFN 42.30 prefixes to BuildAll paths
 * (`/7dd9d4e3-.../DevTools/x.verse`). It stands for the project's Verse
 * root, so stripping it leaves a path relative to `paths.verse`.
 */
const MODULE_ROOT = /^\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\//;

/**
 * Structured diagnostics. Live UEFN 42.30 `VerseToolset.BuildAll` returns
 * `{"returnValue":[{severity:"Error", code:3588, message, filePath,
 * span:{startLine, startCharacter, ...}}]}` with 0-indexed positions; a plain
 * array or a `diagnostics` key is accepted too. Positions become 1-indexed,
 * and module-rooted paths become relative to the Verse root (`paths.verse`).
 */
function structuredDiagnostics(json: unknown): Diagnostic[] | undefined {
  const list = Array.isArray(json)
    ? json
    : isRecord(json) && Array.isArray(json["returnValue"])
      ? json["returnValue"]
      : isRecord(json) && Array.isArray(json["diagnostics"])
        ? json["diagnostics"]
        : undefined;
  if (!list) return undefined;
  return (list as unknown[]).filter(isRecord).map((d) => {
    const sev = String(d["severity"] ?? d["Severity"] ?? "error").toLowerCase();
    const raw = d["filePath"] ?? d["file"] ?? d["FilePath"] ?? d["File"];
    const file = typeof raw === "string" ? raw.replace(MODULE_ROOT, "") : undefined;
    const span = isRecord(d["span"]) ? d["span"] : undefined;
    const line = typeof span?.["startLine"] === "number" ? span["startLine"] + 1 : typeof d["line"] === "number" ? d["line"] : undefined;
    const column = typeof span?.["startCharacter"] === "number" ? span["startCharacter"] + 1 : typeof d["column"] === "number" ? d["column"] : undefined;
    const code = d["code"] ?? d["Code"];
    return {
      severity: sev === "warning" ? "warning" : sev === "info" || sev === "information" || sev === "hint" ? "info" : "error",
      message: String(d["message"] ?? d["Message"] ?? ""),
      ...(file !== undefined ? { file } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(column !== undefined ? { column } : {}),
      ...(code !== undefined && code !== null ? { code: String(code) } : {}),
    } satisfies Diagnostic;
  });
}

/**
 * Maps a session-status tool result. Live UEFN 42.30 `GetSessionStatus`
 * answers Disconnected / Connecting / Connected / Reconnecting /
 * UpdatingContent (wrapped as `{"returnValue": ...}`); order matters, since
 * "disconnected" and "reconnecting" both contain "connect".
 */
export function sessionStatusFrom(out: { text: string; json?: unknown }): SessionStatus | "none" {
  const json = out.json;
  const value = isRecord(json) ? (json["returnValue"] ?? json["status"] ?? json["state"]) : json;
  const raw = (typeof value === "string" ? value : isRecord(value) ? JSON.stringify(value) : out.text).toLowerCase();
  if (/disconnect|unconnected|not.?connected|none/.test(raw)) return "none";
  if (/fail|error/.test(raw)) return "failed";
  if (/connecting|reconnecting|updating|start|launch|load/.test(raw)) return "starting";
  if (/play|running|in.?game/.test(raw)) return "playing";
  if (/connected|ready/.test(raw)) return "connected";
  return "none";
}
