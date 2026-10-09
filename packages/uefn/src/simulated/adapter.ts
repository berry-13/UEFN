import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type {
  CommandResult,
  CompileResult,
  DeviceInfo,
  RuntimeCommand,
  RuntimeEvent,
  SessionStatus,
  SimulatedConfig,
} from "@uefn-devtools/protocol";
import { EventTypes } from "@uefn-devtools/protocol";
import type { AdapterSession, CapabilityReport, RuntimeTransport, UEFNAdapter } from "../adapter.ts";
import { ScaledClock, type Clock } from "../clock.ts";
import { AsyncQueue } from "../util.ts";
import { SimulatedWorld } from "./world.ts";

const SUPPORTED: readonly RuntimeCommand["type"][] = [
  "start_game",
  "end_game",
  "reset",
  "spawn_player",
  "teleport",
  "leave_area",
  "eliminate_player",
  "damage_player",
  "set_device_enabled",
  "seed",
];

class SimulatedTransport implements RuntimeTransport {
  readonly name = "simulated";
  private queue = new AsyncQueue<RuntimeEvent>();
  private running = false;
  private loop?: Promise<void>;
  private eventCounter = 0;
  private ready = false;
  readonly world: SimulatedWorld;

  constructor(
    private readonly config: SimulatedConfig,
    private readonly clock: Clock,
  ) {
    this.world = new SimulatedWorld(config, (event) => {
      const id = event.id ?? `sim_${++this.eventCounter}`;
      this.queue.push({ ...event, id, timestamp: this.clock.now() });
      return id;
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    await this.clock.sleep(this.config.boot_ms);
    if (!this.running) return;
    this.ready = true;
    this.queue.push({
      id: `sim_${++this.eventCounter}`,
      timestamp: this.clock.now(),
      type: EventTypes.SessionReady,
      source: { type: "system", id: "runtime" },
      payload: { runtimeVersion: "simulated" },
    });
    while (this.running) {
      await this.clock.sleep(this.config.tick_ms);
      if (this.running) this.world.tick(this.config.tick_ms);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    this.queue.close();
  }

  receive(): AsyncIterable<RuntimeEvent> {
    return this.queue;
  }

  async command(command: RuntimeCommand): Promise<CommandResult> {
    if (!this.ready) return { ok: false, error: "runtime not ready" };
    return this.world.handle(command);
  }

  supportedCommands(): readonly RuntimeCommand["type"][] {
    return SUPPORTED;
  }
}

export interface SimulatedAdapterOptions {
  config: SimulatedConfig;
  verseDir: string;
}

/**
 * Adapter backed by {@link SimulatedWorld}. Used for developing DevTools
 * itself, for CI of DevTools, and for trying the test API without UEFN.
 */
export class SimulatedAdapter implements UEFNAdapter {
  readonly name = "simulated";
  readonly clock: Clock;
  private current?: SimulatedTransport;
  private sessionId?: string;
  private sessionCounter = 0;

  constructor(private readonly options: SimulatedAdapterOptions) {
    this.clock = new ScaledClock(options.config.time_scale);
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    await this.stopSession();
  }

  async getProjectInfo(): Promise<Record<string, unknown>> {
    return { adapter: this.name, devices: this.options.config.devices.length, teams: this.options.config.teams };
  }

  async compile(): Promise<CompileResult> {
    const started = performance.now();
    const files = await listVerse(this.options.verseDir);
    return {
      success: true,
      durationMs: performance.now() - started,
      diagnostics: [
        {
          severity: "info",
          message: `simulated compile: ${files.length} Verse file(s) found; no real Verse compilation was performed`,
        },
      ],
    };
  }

  async startSession(): Promise<AdapterSession> {
    if (this.current && this.sessionId) return { id: this.sessionId, reused: true };
    this.current = new SimulatedTransport(this.options.config, this.clock);
    this.sessionId = `sim-session-${++this.sessionCounter}`;
    return { id: this.sessionId, reused: false };
  }

  async stopSession(): Promise<void> {
    const transport = this.current;
    this.current = undefined;
    this.sessionId = undefined;
    await transport?.stop();
  }

  async getSessionStatus(): Promise<SessionStatus | "none"> {
    if (!this.current) return "none";
    return this.current.world.isPlaying ? "playing" : "connected";
  }

  async getDevices(): Promise<DeviceInfo[]> {
    return this.options.config.devices.map((d) => ({
      id: d.id,
      type: d.type,
      ...(d.location ? { location: d.location } : {}),
    }));
  }

  transport(): RuntimeTransport {
    if (!this.current) throw new Error("no active session");
    return this.current;
  }

  async describeCapabilities(): Promise<CapabilityReport> {
    return {
      adapter: this.name,
      capabilities: [
        { feature: "compile", status: "DIRECT", via: "simulator", notes: "file discovery only; no Verse compiler" },
        { feature: "session lifecycle", status: "DIRECT", via: "simulator" },
        { feature: "runtime events", status: "DIRECT", via: "simulator" },
        { feature: "runtime commands", status: "DIRECT", via: "simulator", notes: SUPPORTED.join(", ") },
        {
          feature: "profiling",
          status: "DIRECT",
          via: "simulator",
          notes: "synthetic perf.sample / perf.span from a cost model; not real measurements",
        },
      ],
    };
  }
}

async function listVerse(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".verse")) out.push(relative(dir, full));
    }
  }
  await walk(dir);
  return out;
}
