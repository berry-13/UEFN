import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
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
import { RealClock, type Clock } from "./clock.ts";
import { LogFileTransport } from "./log-transport.ts";

type McpConfig = DevToolsConfig["mcp"];
type ToolKey = keyof McpConfig["tools"];

export interface McpAdapterOptions {
  mcp: McpConfig;
  logPath?: string;
}

interface ToolOutput {
  isError: boolean;
  text: string;
  json?: unknown;
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
  private tools: { name: string; description?: string }[] = [];
  private session?: { id: string; transport: RuntimeTransport };

  constructor(private readonly options: McpAdapterOptions) {}

  async connect(): Promise<void> {
    if (this.connected) return;
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
      this.tools = listed.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) }));
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
      return name !== undefined && this.tools.some((t) => t.name === name);
    });
  }

  /** Runs a mapped game command; used by {@link McpCommandTransport}. */
  async gameCommand(key: "start_game" | "end_game"): Promise<CommandResult> {
    const out = await this.call(key);
    return out.isError ? { ok: false, error: out.text || `${key} failed` } : { ok: true };
  }

  private async call(key: ToolKey, args: Record<string, unknown> = {}): Promise<ToolOutput> {
    const name = this.options.mcp.tools[key];
    if (!name) throw new Error(`no UEFN MCP tool mapped for '${key}' (set mcp.tools.${key} in the config)`);
    if (!this.client || !this.connected) throw new Error("mcp adapter is not connected");
    if (!this.tools.some((t) => t.name === name)) {
      throw new Error(`UEFN MCP server does not expose tool '${name}' (mapped from '${key}')`);
    }
    const result = await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: this.options.mcp.timeout_ms,
    });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((c): c is { type: "text"; text: string } => c?.type === "text")
      .map((c) => c.text)
      .join("\n");
    let json: unknown = result.structuredContent;
    if (json === undefined) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
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
    const status = await this.getSessionStatus().catch(() => "none" as const);
    const reused = status === "connected" || status === "playing";
    if (!reused) {
      // No `headed` argument: every UEFN play session launches the Fortnite
      // client (seen in real editor logs), and an unknown argument could make
      // a strictly validated tool reject the call.
      const out = await this.call("start_session");
      if (out.isError) throw new Error(`UEFN refused to start a session: ${out.text}`);
    }
    if (!this.options.logPath) {
      throw new Error("runtime.log_path must point at the UEFN output log so runtime events can be observed");
    }
    const transport = new McpCommandTransport(new LogFileTransport({ path: this.options.logPath, clock: this.clock }), this);
    this.session = { id: `uefn-${Date.now().toString(36)}`, transport };
    return { id: this.session.id, reused };
  }

  async stopSession(): Promise<void> {
    if (this.options.mcp.tools.stop_session) await this.call("stop_session");
    await this.session?.transport.stop();
    this.session = undefined;
  }

  async getSessionStatus(): Promise<SessionStatus | "none"> {
    if (!this.options.mcp.tools.session_state) return this.session ? "connected" : "none";
    const out = await this.call("session_state");
    const raw = (isRecord(out.json) ? String(out.json["status"] ?? out.json["state"] ?? "") : out.text).toLowerCase();
    if (/play|running|in.?game/.test(raw)) return "playing";
    if (/connect|ready|session/.test(raw)) return "connected";
    if (/start|launch|load/.test(raw)) return "starting";
    if (/fail|error/.test(raw)) return "failed";
    return "none";
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
      const exists = this.tools.some((t) => t.name === name);
      return exists
        ? { feature, status: "DIRECT", via: `mcp:${name}` }
        : { feature, status: "UNKNOWN", via: `mcp:${name}`, notes: "mapped tool not exposed by server" };
    };
    return {
      adapter: this.name,
      tools: this.tools,
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
  if (isRecord(out.json) && Array.isArray(out.json["diagnostics"])) {
    return (out.json["diagnostics"] as unknown[]).filter(isRecord).map((d) => {
      // UEFN 42.30 names severities Error / Warning / Information / Hint.
      const sev = String(d["severity"] ?? d["Severity"] ?? "error").toLowerCase();
      const file = d["file"] ?? d["File"] ?? d["filePath"] ?? d["FilePath"];
      const message = d["message"] ?? d["Message"];
      return {
        severity: sev === "warning" ? "warning" : sev === "info" || sev === "information" || sev === "hint" ? "info" : "error",
        message: String(message ?? ""),
        ...(typeof file === "string" ? { file } : {}),
        ...(typeof d["line"] === "number" ? { line: d["line"] } : {}),
      };
    });
  }
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const line of out.text.split(/\r?\n/)) {
    const m = DIAGNOSTIC_LINE.exec(line.trim());
    if (!m?.groups) continue;
    const key = [m.groups["file"], m.groups["line"], m.groups["col"], m.groups["code"], m.groups["sev"]!.toLowerCase()].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push({
      severity: m.groups["sev"]!.toLowerCase() === "warning" ? "warning" : "error",
      message: m.groups["msg"]!.trim(),
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

  constructor(
    private readonly inner: RuntimeTransport,
    private readonly adapter: McpUefnAdapter,
  ) {
    this.name = `${inner.name}+mcp`;
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
      return this.adapter.gameCommand(command.type);
    }
    return this.inner.command(command);
  }

  supportedCommands(): readonly RuntimeCommand["type"][] {
    return [...this.adapter.gameCommands(), ...this.inner.supportedCommands()];
  }
}
