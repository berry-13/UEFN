import type {
  CommandResult,
  CompileResult,
  DeviceInfo,
  RuntimeCommand,
  RuntimeEvent,
  SessionStatus,
} from "@uefn-devtools/protocol";
import type { Clock } from "./clock.ts";

/**
 * Carries runtime observations from Fortnite to DevTools and, where the
 * platform allows it, commands back (spec §51). Implementations must stay
 * replaceable: this is the area most constrained by what Epic exposes.
 */
export interface RuntimeTransport {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Single-consumer stream of normalised events. */
  receive(): AsyncIterable<RuntimeEvent>;
  command(command: RuntimeCommand): Promise<CommandResult>;
  /** Command types this transport can execute. */
  supportedCommands(): readonly RuntimeCommand["type"][];
  /** The engine forgot its derived state; drop what the transport deduplicates against it. */
  resetObservedState?(): void;
  /** The scenario device (test id, plan fingerprint) the running test expects; scenario transports only. */
  expectScenario?(expected: { id: string; plan: string } | undefined): void;
}

export type CapabilityStatus = "DIRECT" | "INSTRUMENTED" | "DERIVED" | "BLOCKED" | "UNKNOWN";

export interface Capability {
  feature: string;
  status: CapabilityStatus;
  via?: string;
  notes?: string;
}

export interface CapabilityReport {
  adapter: string;
  capabilities: Capability[];
  /** Raw tool list for MCP-backed adapters, to support the capability investigation. */
  tools?: { name: string; description?: string }[];
  /** `list_toolsets` output, for servers that reach their tools through `call_tool`. */
  toolsets?: string;
}

export interface AdapterSession {
  id: string;
  reused: boolean;
}

export interface StartSessionOptions {
  /**
   * Ask for a visible game window (`uefn test --headed`). A hint: the
   * simulated adapter ignores it (the CLI renders the state instead) and the
   * mcp adapter forwards it to the start_session tool, whose support for it
   * is unverified (docs/debugging.md).
   */
  headed?: boolean;
}

/**
 * Isolates Epic-specific integration from DevTools logic (spec §50). Every
 * operation the engine needs from UEFN goes through here.
 */
export interface UEFNAdapter {
  readonly name: string;
  readonly clock: Clock;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getProjectInfo(): Promise<Record<string, unknown>>;
  compile(): Promise<CompileResult>;
  startSession(options?: StartSessionOptions): Promise<AdapterSession>;
  stopSession(): Promise<void>;
  getSessionStatus(): Promise<SessionStatus | "none">;
  getDevices(): Promise<DeviceInfo[]>;
  /** Transport for the current session. */
  transport(): RuntimeTransport;
  describeCapabilities(): Promise<CapabilityReport>;
}
