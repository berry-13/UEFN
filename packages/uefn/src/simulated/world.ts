import type { CommandResult, RuntimeCommand, RuntimeEvent, SimulatedConfig, Vector3 } from "@uefn-devtools/protocol";
import { EventTypes } from "@uefn-devtools/protocol";
import { createRng } from "../util.ts";

type DeviceConfig = SimulatedConfig["devices"][number];

interface SimPlayer {
  id: string;
  team: number;
  alive: boolean;
  health: number;
  shield: number;
  position: Vector3;
  areas: Set<string>;
  /** Event id of the area entry, used as causal parent for captures. */
  entryEvents: Map<string, string>;
}

interface SimDevice {
  config: DeviceConfig;
  enabled: boolean;
  owner?: number;
  capturingTeam?: number;
  progress: number;
  state: "Neutral" | "Capturing" | "Contested" | "Captured";
  traceId?: string;
  captureStartedEvent?: string;
}

export type EmitFn = (event: Omit<RuntimeEvent, "id" | "timestamp"> & { id?: string }) => string;

/**
 * Deterministic reference model of a capture-point game. It exists to
 * develop and test the DevTools engine without Fortnite; it is not an
 * emulator of Fortnite behaviour. Behaviour that matters for a real island
 * must be verified against a real session.
 */
export class SimulatedWorld {
  private players = new Map<string, SimPlayer>();
  private devices = new Map<string, SimDevice>();
  private teamScores = new Map<number, number>();
  private playing = false;
  private rng: () => number;
  /** Separate stream for synthetic perf values, so profiling never shifts fault injection. */
  private perfRng: () => number;
  private ticks = 0;
  private traceCounter = 0;

  constructor(
    private readonly config: SimulatedConfig,
    private readonly emit: EmitFn,
  ) {
    this.rng = createRng(config.seed);
    this.perfRng = createRng(perfSeed(config.seed));
    this.reset();
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  reset(): void {
    this.players.clear();
    this.devices.clear();
    this.teamScores.clear();
    this.playing = false;
    this.ticks = 0;
    for (const config of this.config.devices) {
      this.devices.set(config.id, { config, enabled: config.enabled, progress: 0, state: "Neutral" });
    }
    for (let t = 1; t <= this.config.teams; t++) this.teamScores.set(t, 0);
  }

  seed(seed: number): void {
    this.rng = createRng(seed);
    this.perfRng = createRng(perfSeed(seed));
  }

  handle(command: RuntimeCommand): CommandResult {
    switch (command.type) {
      case "reset":
        this.reset();
        return { ok: true };
      case "seed":
        this.seed(command.seed);
        return { ok: true };
      case "start_game":
        return this.startGame();
      case "end_game":
        return this.endGame();
      case "spawn_player":
        return this.spawn(command.player, command.team);
      case "teleport":
        return this.teleport(command.player, command.location);
      case "leave_area":
        return this.leaveArea(command.player, command.area);
      case "eliminate_player":
        return this.eliminate(command.player, command.by);
      case "damage_player":
        return this.damage(command.player, command.amount);
      case "set_device_enabled":
        return this.setDeviceEnabled(command.device, command.enabled);
    }
  }

  private startGame(): CommandResult {
    if (this.playing) return { ok: false, error: "game already started" };
    this.playing = true;
    for (const t of this.teamScores.keys()) this.teamScores.set(t, 0);
    this.emit({ type: EventTypes.GameStarted, source: { type: "system", id: "game" }, payload: { teams: this.config.teams } });
    for (const device of this.devices.values()) {
      this.emitDeviceState(device);
    }
    return { ok: true };
  }

  private endGame(): CommandResult {
    if (!this.playing) return { ok: false, error: "game not started" };
    this.playing = false;
    let winner: number | undefined;
    let best = -Infinity;
    let tie = false;
    for (const [team, score] of this.teamScores) {
      if (score > best) {
        best = score;
        winner = team;
        tie = false;
      } else if (score === best) tie = true;
    }
    this.emit({
      type: EventTypes.GameEnded,
      source: { type: "system", id: "game" },
      payload: tie ? {} : { winner },
    });
    return { ok: true };
  }

  private spawn(id: string, team?: number): CommandResult {
    if (this.players.get(id)?.alive) return { ok: false, error: `player '${id}' already spawned` };
    const assigned = team ?? ((this.players.size % this.config.teams) + 1);
    if (assigned < 1 || assigned > this.config.teams) return { ok: false, error: `invalid team ${assigned}` };
    const existing = this.players.get(id);
    const player: SimPlayer = {
      id,
      team: assigned,
      alive: true,
      health: 100,
      shield: 0,
      position: [0, 0, 0],
      areas: new Set(),
      entryEvents: new Map(),
    };
    this.players.set(id, player);
    this.emit({
      type: EventTypes.PlayerSpawned,
      source: { type: "player", id },
      payload: { player: id, team: assigned, health: 100, shield: 0, position: player.position, respawn: existing !== undefined },
    });
    return { ok: true };
  }

  private requireAlive(id: string): SimPlayer | CommandResult {
    const player = this.players.get(id);
    if (!player) return { ok: false, error: `unknown player '${id}'` };
    if (!player.alive) return { ok: false, error: `player '${id}' is not alive` };
    return player;
  }

  private teleport(id: string, location: string): CommandResult {
    const player = this.requireAlive(id);
    if ("ok" in player) return player;
    const device = this.devices.get(location);
    if (!device) return { ok: false, error: `unknown location '${location}'` };
    for (const area of [...player.areas]) if (area !== location) this.exitArea(player, area);
    player.position = device.config.location ?? [0, 0, 0];
    this.emit({
      type: EventTypes.PlayerMoved,
      source: { type: "player", id },
      payload: { player: id, position: player.position, location },
    });
    if (!player.areas.has(location)) {
      player.areas.add(location);
      const entry = this.emit({
        type: EventTypes.PlayerEnteredArea,
        source: { type: "player", id },
        target: { type: "device", id: location },
        traceId: this.newTrace(),
        payload: { player: id, device: location, team: player.team },
      });
      player.entryEvents.set(location, entry);
    }
    return { ok: true };
  }

  private leaveArea(id: string, area: string): CommandResult {
    const player = this.requireAlive(id);
    if ("ok" in player) return player;
    if (!player.areas.has(area)) return { ok: false, error: `player '${id}' is not in '${area}'` };
    this.exitArea(player, area);
    return { ok: true };
  }

  private exitArea(player: SimPlayer, area: string): void {
    player.areas.delete(area);
    player.entryEvents.delete(area);
    this.emit({
      type: EventTypes.PlayerExitedArea,
      source: { type: "player", id: player.id },
      target: { type: "device", id: area },
      payload: { player: player.id, device: area },
    });
  }

  private eliminate(id: string, by?: string): CommandResult {
    const player = this.requireAlive(id);
    if ("ok" in player) return player;
    for (const area of [...player.areas]) this.exitArea(player, area);
    player.alive = false;
    player.health = 0;
    this.emit({
      type: EventTypes.PlayerEliminated,
      source: by ? { type: "player", id: by } : { type: "system", id: "game" },
      target: { type: "player", id },
      payload: by ? { player: id, by } : { player: id },
    });
    return { ok: true };
  }

  private damage(id: string, amount: number): CommandResult {
    const player = this.requireAlive(id);
    if ("ok" in player) return player;
    const absorbed = Math.min(player.shield, amount);
    const before = { health: player.health, shield: player.shield };
    player.shield -= absorbed;
    player.health = Math.max(0, player.health - (amount - absorbed));
    this.emit({
      type: EventTypes.PlayerStateChanged,
      source: { type: "player", id },
      payload: { player: id, previous: before, health: player.health, shield: player.shield },
    });
    if (player.health === 0) return this.eliminate(id);
    return { ok: true };
  }

  private setDeviceEnabled(id: string, enabled: boolean): CommandResult {
    const device = this.devices.get(id);
    if (!device) return { ok: false, error: `unknown device '${id}'` };
    device.enabled = enabled;
    this.emitDeviceState(device);
    return { ok: true };
  }

  /** Advances the simulation by `dt` game milliseconds. */
  tick(dt: number): void {
    this.ticks += 1;
    if (this.playing) {
      for (const device of this.devices.values()) {
        if (device.enabled) this.tickDevice(device, dt);
      }
    }
    const profiling = this.config.profiling;
    if (profiling.enabled && this.ticks % profiling.sample_every_ticks === 0) this.emitPerfSample();
  }

  /**
   * Synthetic metrics: a cost model over world size plus seeded jitter.
   * They exercise the profiler pipeline; they are not measurements.
   */
  private emitPerfSample(): void {
    const alive = [...this.players.values()].filter((p) => p.alive);
    const occupancy = alive.reduce((n, p) => n + p.areas.size, 0);
    const entities = this.players.size + this.devices.size;
    const tickMs = 0.05 + 0.012 * entities + 0.02 * occupancy + this.perfRng() * 0.03;
    this.emit({
      type: EventTypes.PerfSample,
      source: { type: "system", id: "profiler" },
      payload: {
        scope: "world",
        frame_ms: round3(16 + tickMs * 4 + this.perfRng() * 2),
        tick_ms: round3(tickMs),
        entities,
        players: alive.length,
        devices: this.devices.size,
        memory_mb: round3(256 + entities * 1.5 + occupancy * 0.25 + this.perfRng() * 0.5),
      },
    });
  }

  /** Scoped timing of a handler, emitted after the work it measures (timestamp = end). */
  private emitSpan(name: string, parent: string, durationMs: number, extra: Record<string, unknown>, traceId?: string): void {
    if (!this.config.profiling.enabled) return;
    this.emit({
      type: EventTypes.PerfSpan,
      source: { type: "system", id: "profiler" },
      parentEventId: parent,
      ...(traceId ? { traceId } : {}),
      payload: { name, duration_ms: round3(durationMs), ...extra },
    });
  }

  private occupants(deviceId: string): SimPlayer[] {
    return [...this.players.values()].filter((p) => p.alive && p.areas.has(deviceId));
  }

  private tickDevice(device: SimDevice, dt: number): void {
    const id = device.config.id;
    const inside = this.occupants(id);
    const teams = new Set(inside.map((p) => p.team));

    if (teams.size === 0) {
      if (device.state === "Capturing" || device.state === "Contested") {
        device.capturingTeam = undefined;
        device.progress = 0;
        device.traceId = undefined;
        this.setState(device, device.owner !== undefined ? "Captured" : "Neutral");
      }
      return;
    }
    if (teams.size > 1) {
      if (device.state !== "Contested") this.setState(device, "Contested");
      return;
    }

    const team = [...teams][0];
    if (team === undefined || team === device.owner) {
      if (device.state === "Contested") this.setState(device, "Captured");
      return;
    }
    if (device.capturingTeam !== team) {
      device.capturingTeam = team;
      device.progress = 0;
      const first = inside.find((p) => p.team === team)!;
      const parent = first.entryEvents.get(id);
      device.traceId = this.newTrace();
      device.captureStartedEvent = this.emit({
        type: EventTypes.CaptureStarted,
        source: { type: "device", id },
        ...(parent ? { parentEventId: parent } : {}),
        traceId: device.traceId,
        payload: { device: id, team, players: inside.map((p) => p.id) },
      });
      this.setState(device, "Capturing");
    } else if (device.state === "Contested") {
      this.setState(device, "Capturing");
    }

    device.progress = Math.min(100, device.progress + (dt / device.config.capture_time_ms) * 100);
    if (device.progress < 100) return;

    const previousOwner = device.owner;
    device.owner = team;
    device.capturingTeam = undefined;
    const completed = this.emit({
      type: EventTypes.CaptureCompleted,
      source: { type: "device", id },
      ...(device.captureStartedEvent ? { parentEventId: device.captureStartedEvent } : {}),
      ...(device.traceId ? { traceId: device.traceId } : {}),
      payload: { device: id, team, previousOwner: previousOwner ?? null, players: inside.map((p) => p.id) },
    });
    this.setState(device, "Captured");
    this.award(team, device.config.score, id, completed, device.traceId);
    if (this.rng() < this.config.faults.double_award_probability) {
      // Injected fault: a second scoring path fires for the same capture.
      this.award(team, device.config.score, id, completed, device.traceId);
    }
    this.emitSpan("capture_handler", completed, 0.08 + 0.04 * inside.length + this.perfRng() * 0.05, { device: id }, device.traceId);
  }

  private award(team: number, amount: number, device: string, parent: string, traceId?: string): void {
    const previous = this.teamScores.get(team) ?? 0;
    const current = previous + amount;
    this.teamScores.set(team, current);
    const changed = this.emit({
      type: EventTypes.ScoreChanged,
      source: { type: "device", id: device },
      target: { type: "team", id: String(team) },
      parentEventId: parent,
      ...(traceId ? { traceId } : {}),
      payload: { team, previous, current, delta: amount },
    });
    this.emitSpan("score_handler", changed, 0.02 + this.perfRng() * 0.02, { team }, traceId);
  }

  private setState(device: SimDevice, state: SimDevice["state"]): void {
    if (device.state === state) return;
    device.state = state;
    this.emitDeviceState(device);
  }

  private emitDeviceState(device: SimDevice): void {
    this.emit({
      type: EventTypes.DeviceStateChanged,
      source: { type: "device", id: device.config.id },
      ...(device.traceId ? { traceId: device.traceId } : {}),
      payload: {
        device: device.config.id,
        deviceType: device.config.type,
        state: device.state,
        enabled: device.enabled,
        owner: device.owner ?? null,
        progress: Math.round(device.progress),
      },
    });
  }

  private newTrace(): string {
    this.traceCounter += 1;
    return `tr_${this.traceCounter.toString(16).padStart(4, "0")}`;
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function perfSeed(seed: number): number {
  return (seed ^ 0x5bd1e995) >>> 0;
}
