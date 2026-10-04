import type { DeviceState, GameState, PlayerState, RuntimeCommand, RuntimeEvent, TeamState, Vector3 } from "@uefn-devtools/protocol";
import { CommandError, type DevToolsEngine, type EventQuery } from "@uefn-devtools/core";
import { parseDuration } from "@uefn-devtools/protocol";
import { currentContext, type TestContext } from "./context.ts";
import { normalizeEventType, playerId } from "./names.ts";

/** Marker so `expect()` can recognise handles without instanceof across package copies. */
export const HANDLE = Symbol.for("uefn-devtools.handle");

export type Duration = number | string;

async function send(ctx: TestContext, command: RuntimeCommand): Promise<void> {
  try {
    await ctx.engine.command(command);
  } catch (error) {
    if (error instanceof CommandError && error.unsupported) {
      throw new Error(
        `${error.message} — transport '${ctx.engine.adapter.transport().name}' cannot drive '${command.type}' (see docs/capabilities.md)`,
      );
    }
    throw error;
  }
}

export class PlayerHandle {
  readonly [HANDLE] = "player" as const;
  constructor(
    private readonly ctx: TestContext,
    readonly id: string,
    private readonly team?: number,
  ) {}

  /** Live state; `undefined` until the player has spawned. */
  get state(): PlayerState | undefined {
    return this.ctx.engine.state.players[this.id];
  }
  get health(): number | undefined {
    return this.state?.health;
  }
  get shield(): number | undefined {
    return this.state?.shield;
  }
  get alive(): boolean {
    return this.state?.alive === true;
  }
  get teamId(): number | undefined {
    return this.state?.team;
  }
  get position(): Vector3 | undefined {
    return this.state?.position;
  }

  /** Spawns the player if it has not spawned yet. Actions call this implicitly. */
  async spawn(options: { team?: number } = {}): Promise<this> {
    const team = options.team ?? this.team;
    await this.ctx.step(`${this.id} spawned${team !== undefined ? ` on team ${team}` : ""}`, async () => {
      await send(this.ctx, { type: "spawn_player", player: this.id, ...(team !== undefined ? { team } : {}) });
      await this.ctx.engine.waitForEvent(
        { type: "player.spawned", payload: { player: this.id } },
        { timeoutMs: this.ctx.expectTimeout, fromIndex: this.ctx.startIndex },
      );
    });
    return this;
  }

  private async ensureSpawned(): Promise<void> {
    if (!this.state || !this.state.alive) await this.spawn();
  }

  async teleport(location: string): Promise<void> {
    await this.ensureSpawned();
    await this.ctx.step(`${this.id} teleported to ${location}`, () =>
      send(this.ctx, { type: "teleport", player: this.id, location }),
    );
  }

  /** Moves into an area device; the step completes once the runtime reports the entry. */
  async enter(area: string): Promise<void> {
    await this.ensureSpawned();
    const from = this.ctx.engine.events.mark();
    await this.ctx.step(`${area} entered by ${this.id}`, async () => {
      await send(this.ctx, { type: "teleport", player: this.id, location: area });
      await this.ctx.engine.waitForEvent(
        { type: "player.entered_area", payload: { player: this.id, device: area } },
        { timeoutMs: this.ctx.expectTimeout, fromIndex: from },
      );
    });
  }

  async leave(area: string): Promise<void> {
    await this.ctx.step(`${this.id} left ${area}`, () => send(this.ctx, { type: "leave_area", player: this.id, area }));
  }

  async eliminate(options: { by?: string | PlayerHandle } = {}): Promise<void> {
    const by = typeof options.by === "string" ? options.by : options.by?.id;
    await this.ctx.step(`${this.id} eliminated${by ? ` by ${by}` : ""}`, () =>
      send(this.ctx, { type: "eliminate_player", player: this.id, ...(by ? { by } : {}) }),
    );
  }

  async damage(amount: number): Promise<void> {
    await this.ctx.step(`${this.id} took ${amount} damage`, () =>
      send(this.ctx, { type: "damage_player", player: this.id, amount }),
    );
  }
}

export class DeviceHandle {
  readonly [HANDLE] = "device" as const;
  constructor(
    private readonly ctx: TestContext,
    readonly id: string,
  ) {}

  get state(): DeviceState | undefined {
    return this.ctx.engine.state.devices[this.id];
  }
  get current(): string | undefined {
    return this.state?.state;
  }
  get owner(): number | undefined {
    return this.state?.owner;
  }
  get enabled(): boolean | undefined {
    return this.state?.enabled;
  }

  async enable(): Promise<void> {
    await this.ctx.step(`${this.id} enabled`, () => send(this.ctx, { type: "set_device_enabled", device: this.id, enabled: true }));
  }
  async disable(): Promise<void> {
    await this.ctx.step(`${this.id} disabled`, () => send(this.ctx, { type: "set_device_enabled", device: this.id, enabled: false }));
  }
}

export class TeamHandle {
  readonly [HANDLE] = "team" as const;
  constructor(
    private readonly ctx: TestContext,
    readonly id: number,
  ) {}

  get state(): TeamState | undefined {
    return this.ctx.engine.state.teams[String(this.id)];
  }
  get score(): number {
    return this.state?.score ?? 0;
  }
}

export class ProbeHandle {
  readonly [HANDLE] = "probe" as const;
  constructor(
    private readonly ctx: TestContext,
    readonly id: string,
  ) {}
  get value(): unknown {
    return this.ctx.engine.state.probes[this.id];
  }
}

/** Events observed since the test started. */
export class EventsHandle {
  readonly [HANDLE] = "events" as const;
  constructor(private readonly ctx: TestContext) {}

  list(type?: string, payload?: Record<string, unknown>): RuntimeEvent[] {
    return this.ctx.engine.events.query({
      fromIndex: this.ctx.startIndex,
      ...(type ? { type: normalizeEventType(type) } : {}),
      ...(payload ? { payload } : {}),
    });
  }

  count(type: string, payload?: Record<string, unknown>): number {
    return this.list(type, payload).length;
  }
}

/** A future event, for `expect(game.event(...)).toOccurWithin(ms)`. */
export class EventExpectation {
  readonly [HANDLE] = "event" as const;
  /** Only events after this index count; captured when the handle is created. */
  readonly fromIndex: number;
  constructor(
    readonly ctx: TestContext,
    readonly type: string,
    readonly payload?: Record<string, unknown>,
  ) {
    this.fromIndex = ctx.engine.events.mark();
  }
}

export class GameFixture {
  readonly events: EventsHandle;
  private readonly players = new Map<string, PlayerHandle>();

  constructor(private readonly ctx: TestContext) {
    this.events = new EventsHandle(ctx);
  }

  get engine(): DevToolsEngine {
    return this.ctx.engine;
  }

  get state(): GameState {
    return this.ctx.engine.state;
  }

  async start(): Promise<void> {
    await this.ctx.step("Game started", async () => {
      const from = this.ctx.engine.events.mark();
      await send(this.ctx, { type: "start_game" });
      await this.ctx.engine.waitForEvent({ type: "game.started" }, { timeoutMs: this.ctx.expectTimeout, fromIndex: from });
    });
  }

  async end(): Promise<void> {
    await this.ctx.step("Game ended", () => send(this.ctx, { type: "end_game" }));
  }

  /** Returns a player handle; the player spawns on first action (or call `.spawn()`). */
  player(id: string | number, options: { team?: number } = {}): PlayerHandle {
    const key = playerId(id);
    let handle = this.players.get(key);
    if (!handle) {
      handle = new PlayerHandle(this.ctx, key, options.team);
      this.players.set(key, handle);
    }
    return handle;
  }

  device(id: string): DeviceHandle {
    return new DeviceHandle(this.ctx, id);
  }

  team(id: number): TeamHandle {
    return new TeamHandle(this.ctx, id);
  }

  probe(id: string): ProbeHandle {
    return new ProbeHandle(this.ctx, id);
  }

  event(type: string, payload?: Record<string, unknown>): EventExpectation {
    return new EventExpectation(this.ctx, normalizeEventType(type), payload);
  }

  async wait(duration: Duration): Promise<void> {
    const ms = parseDuration(duration);
    await this.ctx.step(`Waited ${ms}ms`, () => this.ctx.engine.sleep(ms));
  }

  async waitForEvent(
    type: string,
    payload?: Record<string, unknown>,
    options: { timeout?: Duration } = {},
  ): Promise<RuntimeEvent> {
    const normalized = normalizeEventType(type);
    const query: EventQuery = { type: normalized, ...(payload ? { payload } : {}) };
    return this.ctx.step(`${normalized} observed`, () =>
      this.ctx.engine.waitForEvent(query, {
        timeoutMs: options.timeout !== undefined ? parseDuration(options.timeout) : this.ctx.expectTimeout,
        fromIndex: this.ctx.startIndex,
      }),
    );
  }
}

export function createFixtures(ctx: TestContext = currentContext()): { game: GameFixture } {
  return { game: new GameFixture(ctx) };
}
