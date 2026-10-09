import { deepEqual, matches } from "@uefn-devtools/core";
import type { GameState } from "@uefn-devtools/protocol";
import { parseDuration } from "@uefn-devtools/protocol";
import { currentContext, type TestContext } from "./context.ts";
import {
  DeviceHandle,
  EventExpectation,
  EventsHandle,
  HANDLE,
  PlayerHandle,
  ProbeHandle,
  TeamHandle,
  type Duration,
} from "./fixtures.ts";
import { normalizeEventType } from "./names.ts";
import { matchSnapshot, type SnapshotMatchOptions } from "./snapshot.ts";

export class AssertionError extends Error {
  constructor(
    message: string,
    readonly expected?: unknown,
    readonly received?: unknown,
  ) {
    super(message);
    this.name = "AssertionError";
  }
}

export interface MatchOptions {
  /** How long to keep retrying (session clock). */
  timeout?: Duration;
  /** How long the condition must keep holding once true. */
  settle?: Duration;
}

export interface MatcherResult {
  pass: boolean;
  message?: string;
  expected?: unknown;
  received?: unknown;
}

export type CustomMatcher = (received: unknown, ...args: unknown[]) => MatcherResult | Promise<MatcherResult>;

/** Augment this interface to type matchers added with `expect.extend`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CustomMatchers {}

const CUSTOM = Symbol.for("uefn-devtools.custom-matchers");
const g = globalThis as unknown as Record<symbol, Map<string, CustomMatcher> | undefined>;
const customMatchers: Map<string, CustomMatcher> = (g[CUSTOM] ??= new Map());

function fmt(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function timing(ctx: TestContext, options: MatchOptions = {}): { timeout: number; settle: number } {
  return {
    timeout: options.timeout !== undefined ? parseDuration(options.timeout) : ctx.expectTimeout,
    settle: options.settle !== undefined ? parseDuration(options.settle) : ctx.expectSettle,
  };
}

/**
 * Builds assertions. Handle-based matchers retry until the condition holds
 * (and stays held for the settle window) or the timeout elapses, the same
 * way Playwright locator assertions auto-wait.
 */
export class Expectation {
  constructor(
    protected readonly received: unknown,
    protected readonly ctx: TestContext,
  ) {}

  private record(description: string, pass: boolean, expected: unknown, received: unknown, message?: string): void {
    this.ctx.recordAssertion({
      description,
      passed: pass,
      expected,
      received,
      ...(message ? { message } : {}),
    });
    if (!pass) {
      throw new AssertionError(message ?? `${description}: expected ${fmt(expected)}, received ${fmt(received)}`, expected, received);
    }
  }

  /** Polls `read` until `accept` holds (stably), then records the assertion. */
  private async poll<V>(
    description: string,
    read: (state: GameState) => V,
    accept: (value: V) => boolean,
    expected: unknown,
    options?: MatchOptions,
  ): Promise<void> {
    this.ctx.ensureActive();
    const { timeout, settle } = timing(this.ctx, options);
    const pass = await this.ctx.engine.waitUntilStable((s) => accept(read(s)), timeout, settle);
    this.record(description, pass, expected, read(this.ctx.engine.state));
  }

  private value(): unknown {
    const r = this.received;
    return typeof r === "function" ? (r as () => unknown)() : r;
  }

  private async polled(description: string, accept: (v: unknown) => boolean, expected: unknown, options?: MatchOptions): Promise<void> {
    // Plain values are checked once; thunks are re-read until they match.
    if (typeof this.received === "function") {
      await this.poll(description, () => this.value(), accept, expected, options);
    } else {
      this.ctx.ensureActive();
      const v = this.value();
      this.record(description, accept(v), expected, v);
    }
  }

  // ── generic value matchers ─────────────────────────────────────────────
  async toBe(expected: unknown, options?: MatchOptions): Promise<void> {
    await this.polled(`value is ${fmt(expected)}`, (v) => Object.is(v, expected), expected, options);
  }
  async toEqual(expected: unknown, options?: MatchOptions): Promise<void> {
    await this.polled(`value equals ${fmt(expected)}`, (v) => deepEqual(v, expected), expected, options);
  }
  async toMatchObject(expected: Record<string, unknown>, options?: MatchOptions): Promise<void> {
    await this.polled(`value matches ${fmt(expected)}`, (v) => matches(v, expected), expected, options);
  }
  async toBeGreaterThan(n: number, options?: MatchOptions): Promise<void> {
    await this.polled(`value > ${n}`, (v) => typeof v === "number" && v > n, `> ${n}`, options);
  }
  async toBeLessThan(n: number, options?: MatchOptions): Promise<void> {
    await this.polled(`value < ${n}`, (v) => typeof v === "number" && v < n, `< ${n}`, options);
  }
  async toBeTruthy(options?: MatchOptions): Promise<void> {
    await this.polled("value is truthy", (v) => Boolean(v), true, options);
  }

  // ── device matchers ───────────────────────────────────────────────────
  private device(): DeviceHandle {
    if (!isHandle(this.received, "device")) throw new TypeError("expected a device handle (game.device(id))");
    return this.received as unknown as DeviceHandle;
  }
  async toHaveState(state: string, options?: MatchOptions): Promise<void> {
    const d = this.device();
    await this.poll(`${d.id} state = ${state}`, (s) => s.devices[d.id]?.state, (v) => v === state, state, options);
  }
  async toHaveOwner(team: number | null, options?: MatchOptions): Promise<void> {
    const d = this.device();
    await this.poll(`${d.id} owner = ${team === null ? "none" : `Team ${team}`}`, (s) => s.devices[d.id]?.owner ?? null, (v) => v === team, team, options);
  }
  async toBeEnabled(options?: MatchOptions): Promise<void> {
    const d = this.device();
    await this.poll(`${d.id} enabled`, (s) => s.devices[d.id]?.enabled, (v) => v === true, true, options);
  }
  async toBeDisabled(options?: MatchOptions): Promise<void> {
    const d = this.device();
    await this.poll(`${d.id} disabled`, (s) => s.devices[d.id]?.enabled, (v) => v === false, false, options);
  }
  async toHaveTriggerCount(count: number, options?: MatchOptions): Promise<void> {
    const d = this.device();
    await this.poll(`${d.id} trigger count = ${count}`, (s) => s.devices[d.id]?.triggerCount ?? 0, (v) => v === count, count, options);
  }

  // ── team matchers ─────────────────────────────────────────────────────
  async toHaveScore(score: number, options?: MatchOptions): Promise<void> {
    if (isHandle(this.received, "team")) {
      const t = this.received as unknown as TeamHandle;
      await this.poll(`Team ${t.id} score = ${score}`, (s) => s.teams[String(t.id)]?.score ?? 0, (v) => v === score, score, options);
      return;
    }
    if (isHandle(this.received, "player")) {
      const p = this.received as unknown as PlayerHandle;
      await this.poll(`${p.id} score = ${score}`, (s) => s.players[p.id]?.score ?? 0, (v) => v === score, score, options);
      return;
    }
    throw new TypeError("toHaveScore expects game.team(n) or game.player(id)");
  }

  // ── player matchers ───────────────────────────────────────────────────
  private player(): PlayerHandle {
    if (!isHandle(this.received, "player")) throw new TypeError("expected a player handle (game.player(id))");
    return this.received as unknown as PlayerHandle;
  }
  async toHaveHealth(health: number, options?: MatchOptions): Promise<void> {
    const p = this.player();
    await this.poll(`${p.id} health = ${health}`, (s) => s.players[p.id]?.health, (v) => v === health, health, options);
  }
  async toHaveShield(shield: number, options?: MatchOptions): Promise<void> {
    const p = this.player();
    await this.poll(`${p.id} shield = ${shield}`, (s) => s.players[p.id]?.shield, (v) => v === shield, shield, options);
  }
  async toBeAlive(options?: MatchOptions): Promise<void> {
    const p = this.player();
    await this.poll(`${p.id} alive`, (s) => s.players[p.id]?.alive, (v) => v === true, true, options);
  }
  async toBeEliminated(options?: MatchOptions): Promise<void> {
    const p = this.player();
    await this.poll(`${p.id} eliminated`, (s) => s.players[p.id]?.alive, (v) => v === false, false, options);
  }
  async toBeOnTeam(team: number, options?: MatchOptions): Promise<void> {
    const p = this.player();
    await this.poll(`${p.id} on team ${team}`, (s) => s.players[p.id]?.team, (v) => v === team, team, options);
  }
  async toBeInArea(area: string, options?: MatchOptions): Promise<void> {
    const p = this.player();
    await this.poll(`${p.id} in ${area}`, (s) => s.players[p.id]?.areas ?? [], (v) => v.includes(area), area, options);
  }

  // ── probe matchers ────────────────────────────────────────────────────
  async toHaveValue(expected: unknown, options?: MatchOptions): Promise<void> {
    if (!isHandle(this.received, "probe")) throw new TypeError("toHaveValue expects game.probe(id)");
    const p = this.received as unknown as ProbeHandle;
    await this.poll(`${p.id} = ${fmt(expected)}`, (s) => s.probes[p.id], (v) => deepEqual(v, expected), expected, options);
  }

  // ── event matchers ────────────────────────────────────────────────────
  /**
   * The event occurred since the test started. With `times`, the count
   * must reach exactly that number and stay there for the settle window
   * (`times: 0` asserts absence).
   */
  async toHaveOccurred(
    type: string,
    payload?: Record<string, unknown>,
    options: MatchOptions & { times?: number } = {},
  ): Promise<void> {
    if (!isHandle(this.received, "events")) throw new TypeError("toHaveOccurred expects game.events");
    const events = this.received as unknown as EventsHandle;
    const normalized = normalizeEventType(type);
    const label = `${normalized}${payload ? ` ${fmt(payload)}` : ""}`;
    const { times } = options;
    const count = () => events.count(normalized, payload);
    if (times === undefined) {
      await this.poll(`${label} occurred`, count, (n) => n > 0, ">= 1 occurrence", { ...options, settle: 0 });
    } else {
      await this.poll(
        `${label} occurred ${times}×`,
        count,
        (n) => n === times,
        times,
        times === 0 ? { ...options, timeout: 0, settle: options.settle ?? options.timeout ?? this.ctx.expectSettle } : options,
      );
    }
  }

  // ── snapshot matcher ──────────────────────────────────────────────────
  /**
   * `expect(game).toMatchSnapshot(name?)`: compares the settled, normalized
   * GameState with the stored snapshot. A missing snapshot is written (and
   * fails when `CI` is set); `--update-snapshots` overwrites.
   */
  async toMatchSnapshot(nameOrOptions?: string | SnapshotMatchOptions, options: SnapshotMatchOptions = {}): Promise<void> {
    if (!isHandle(this.received, "game")) throw new TypeError("toMatchSnapshot expects the game fixture");
    this.ctx.ensureActive();
    const opts = typeof nameOrOptions === "object" ? nameOrOptions : options;
    const name = (typeof nameOrOptions === "string" ? nameOrOptions : opts.name) ?? `snapshot-${++this.ctx.snapshotCounter}`;
    const outcome = await matchSnapshot(this.ctx, name, opts);
    this.record(outcome.description, outcome.pass, outcome.expected ?? "stored snapshot", outcome.received ?? "current state", outcome.message);
  }

  /** `expect(game.event(type)).toOccurWithin(ms)`: measured from handle creation. */
  async toOccurWithin(duration: Duration): Promise<void> {
    if (!isHandle(this.received, "event")) throw new TypeError("toOccurWithin expects game.event(type, payload?)");
    const e = this.received as unknown as EventExpectation;
    const ms = parseDuration(duration);
    const description = `${e.type} within ${ms}ms`;
    try {
      const event = await e.ctx.engine.waitForEvent(
        { type: e.type, ...(e.payload ? { payload: e.payload } : {}) },
        { timeoutMs: ms, fromIndex: e.fromIndex },
      );
      this.record(description, true, `<= ${ms}ms`, event.type);
    } catch {
      this.record(description, false, `<= ${ms}ms`, "not observed");
    }
  }
}

export type ExpectFn = {
  (received: unknown): Expectation & CustomMatchers;
  extend(matchers: Record<string, CustomMatcher>): void;
};

function isHandle(value: unknown, kind: string): boolean {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[HANDLE] === kind;
}

export const expect: ExpectFn = Object.assign(
  (received: unknown) => {
    const ctx = currentContext();
    const expectation = new Expectation(received, ctx);
    return new Proxy(expectation, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && !(prop in target) && customMatchers.has(prop)) {
          const matcher = customMatchers.get(prop)!;
          return async (...args: unknown[]) => {
            ctx.ensureActive();
            const result = await matcher(received, ...args);
            ctx.recordAssertion({
              description: result.message ?? `${prop}(${args.map(fmt).join(", ")})`,
              passed: result.pass,
              expected: result.expected,
              received: result.received,
            });
            if (!result.pass) throw new AssertionError(result.message ?? `${prop} failed`, result.expected, result.received);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ReturnType<ExpectFn>;
  },
  {
    extend(matchers: Record<string, CustomMatcher>): void {
      for (const [name, fn] of Object.entries(matchers)) customMatchers.set(name, fn);
    },
  },
);

export { DeviceHandle, PlayerHandle, TeamHandle, ProbeHandle, EventsHandle };
