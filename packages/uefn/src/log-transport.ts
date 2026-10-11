import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { CommandResult, RuntimeCommand, RuntimeEvent } from "@uefn-devtools/protocol";
import { EventTypes, WIRE_MARKER, parseWireLine, wireRecordToEvent } from "@uefn-devtools/protocol";
import type { RuntimeTransport } from "./adapter.ts";
import type { Clock } from "./clock.ts";
import { AsyncQueue } from "./util.ts";

/**
 * A UE log line, as seen in real UEFN 41.10 editor logs:
 * `[2026.07.05-20.03.53:924][514]LogVerse: : CarUpgradeManager: Ready.` (Print, empty channel),
 * `[...][ 25]LogVerse: Marketplace: Purchase successful` (log_channel),
 * `[...]LogVerse: Warning: Devices_move_to_debug_log: MoveTo error: ...`.
 * Groups: timestamp, category, verbosity, message.
 */
const UE_LOG_LINE =
  /^\[([^\]]*)\]\[\s*\d+\]([A-Za-z0-9_ ]+?):\s(?:(Error|Warning|Display|Verbose|VeryVerbose|Log):\s)?(.*)$/;

/**
 * The Verse log channel that prefixes a LogVerse message; module-prefixed in
 * UEFN 42.30 (`DevTools-devtools_log: ...`) and empty for a bare Print.
 * Other categories have no channel, so their messages are kept whole.
 */
const VERSE_CHANNEL = /^([A-Za-z0-9_-]*):\s(.*)$/;

/** `2026.07.05-20.03.53:924`, the UE log timestamp prefix. */
const UE_TIMESTAMP = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})$/;

/**
 * Match lifecycle markers the editor logs for a play-in-client session
 * (verified in UEFN 41.10 and 42.30 logs, category LogValkyrieBeacon). They
 * give game start and end without any Verse instrumentation.
 */
const MINIGAME_CATEGORY = "LogValkyrieBeacon";
const MINIGAME_STATE = /MinigameStateChanged: EFortMinigameState::(\w+)\s*$/;
/**
 * Logged when UEFN launches a play session (42.30). The editor log spans
 * every session of the editor process, so a backfill never looks past it.
 */
const SESSION_LAUNCH = /LogValkyrieActivityTracker: Session -> Start Activity: Matchmaking\b/;

export interface LogTransportOptions {
  path: string;
  clock: Clock;
  /** Log categories forwarded as `log` events. */
  categories?: string[];
  pollMs?: number;
  /**
   * When attaching to a session that is already running, read up to this
   * many bytes before the end of the log and replay its most recent DevTools
   * hello and match state, which were logged before the tail started.
   */
  backfillBytes?: number;
  /**
   * Log size before the session was launched: lines from there on are read,
   * since the runtime can say hello before the launch call returns.
   */
  fromOffset?: number;
}

/**
 * Receive-only transport that tails the UEFN output log. The Verse runtime
 * (runtime/verse/devtools.verse) writes DevTools wire lines with `Print`;
 * everything else in the configured categories becomes a structured `log`
 * event. Commands cannot travel this way: see docs/capabilities.md.
 */
export class LogFileTransport implements RuntimeTransport {
  readonly name = "log-file";
  private queue = new AsyncQueue<RuntimeEvent>();
  private offset = 0;
  private remainder = "";
  private timer?: NodeJS.Timeout;
  private reading = false;
  private counter = 0;
  private decoder = new StringDecoder("utf8");
  private minigameState?: string;
  /** Wire sequence numbers seen in the current runtime epoch. */
  private seqs = new Set<number>();
  private epoch = 1;
  /** Session clock minus log time, the smallest seen (the least delayed line). */
  private logOffset?: number;
  private lastTimestamp = 0;
  private readonly categories: Set<string>;

  constructor(private readonly options: LogTransportOptions) {
    this.categories = new Set(options.categories ?? ["LogVerse"]);
  }

  async start(): Promise<void> {
    // Only lines written after the session starts are relevant.
    const size = await stat(this.options.path).then((s) => s.size, () => 0);
    const from = this.options.fromOffset;
    // A smaller log than at launch was rotated meanwhile: read it all.
    this.offset = from === undefined ? size : from <= size ? from : 0;
    if (this.options.backfillBytes && this.offset > 0) await this.backfill(this.options.backfillBytes);
    this.timer = setInterval(() => void this.poll(), this.options.pollMs ?? 200);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.poll();
    this.queue.close();
  }

  receive(): AsyncIterable<RuntimeEvent> {
    return this.queue;
  }

  async command(command: RuntimeCommand): Promise<CommandResult> {
    return {
      ok: false,
      unsupported: true,
      error: `'${command.type}' cannot be sent over the log transport; drive this step from an in-game DevTools scenario device`,
    };
  }

  supportedCommands(): readonly RuntimeCommand["type"][] {
    return [];
  }

  /**
   * Records a match state learned from UEFN itself (GetGameState) rather than
   * from the log, e.g. a match UEFN auto-started before the tail began.
   * Emits the lifecycle event the log would have, unless the log already did.
   */
  assumeGameState(running: boolean): void {
    if (running && this.minigameState !== "InProgress") {
      this.minigame("InProgress", this.options.clock.now(), { alreadyRunning: true });
    } else if (!running && this.minigameState === "InProgress") {
      this.minigame("PostGameEnd", this.options.clock.now(), { alreadyEnded: true });
    }
  }

  /**
   * The engine forgot the match state, so the next lifecycle line or
   * assumeGameState call must be reported again rather than deduplicated.
   */
  resetObservedState(): void {
    this.minigameState = undefined;
  }

  private async poll(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const size = await stat(this.options.path).then((s) => s.size, () => 0);
      if (size < this.offset) {
        // Log was truncated or rotated by a new editor session.
        this.offset = 0;
        this.remainder = "";
        this.decoder = new StringDecoder("utf8");
        this.minigameState = undefined;
      }
      if (size === this.offset) return;
      const handle = await open(this.options.path, "r");
      try {
        const buffer = Buffer.alloc(size - this.offset);
        await handle.read(buffer, 0, buffer.length, this.offset);
        this.offset = size;
        // The decoder holds back a multi-byte character split across reads.
        const text = this.remainder + this.decoder.write(buffer);
        const lines = text.split(/\r?\n/);
        this.remainder = lines.pop() ?? "";
        // The newest line of the batch anchors log time to the session clock,
        // so lines read together keep their real spacing.
        for (let i = lines.length - 1; i >= 0; i--) {
          const time = lineTime(lines[i]!);
          if (time !== undefined) {
            this.anchor(time);
            break;
          }
        }
        for (const line of lines) this.ingest(line);
      } finally {
        await handle.close();
      }
    } finally {
      this.reading = false;
    }
  }

  /**
   * Replays the latest hello and match state found in the last `bytes` of
   * the log, from the current play session only: lines before the latest
   * session launch belong to an earlier session (whose runtime may since
   * have been removed).
   */
  private async backfill(bytes: number): Promise<void> {
    const start = Math.max(0, this.offset - bytes);
    const handle = await open(this.options.path, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(this.offset - start);
      await handle.read(buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally {
      await handle.close();
    }
    const lines = text.split(/\r?\n/);
    if (start > 0) lines.shift(); // partial first line
    lines.pop(); // unterminated last line (or the empty string after the final newline)
    let hello: number | undefined;
    let state: number | undefined;
    for (let i = lines.length - 1; i >= 0 && (hello === undefined || state === undefined); i--) {
      const line = lines[i]!;
      if (SESSION_LAUNCH.test(line)) break;
      if (line.includes(WIRE_MARKER)) {
        if (hello === undefined && /\|H\|/.test(line)) hello = i;
      } else if (state === undefined && minigameStateOf(line) !== undefined) {
        state = i;
      }
    }
    // Replayed in log order and stamped now: they describe the current state.
    for (const i of [hello, state].filter((n): n is number => n !== undefined).sort((a, b) => a - b)) {
      this.ingest(lines[i]!, false);
    }
  }

  private anchor(logTime: number): void {
    const offset = this.options.clock.now() - logTime;
    if (this.logOffset === undefined || offset < this.logOffset) this.logOffset = offset;
  }

  /** The line's own UE timestamp on the session clock, else the ingest time. */
  private timestampOf(line: string, useLineTime: boolean): number {
    const now = this.options.clock.now();
    const time = useLineTime ? lineTime(line) : undefined;
    if (time === undefined) return Math.max(this.lastTimestamp, now);
    this.anchor(time);
    const stamped = Math.min(now, Math.max(this.lastTimestamp, time + this.logOffset!));
    this.lastTimestamp = stamped;
    return stamped;
  }

  /** Exposed for tests. `useLineTime: false` stamps the event with the ingest time. */
  ingest(rawLine: string, useLineTime = true): void {
    const line = rawLine.replace(/^﻿/, "");
    if (line.includes(WIRE_MARKER)) {
      const timestamp = this.timestampOf(line, useLineTime);
      try {
        const record = parseWireLine(line);
        if (record) this.queue.push(wireRecordToEvent(record, timestamp, this.idPrefix(record.seq)));
      } catch (error) {
        this.queue.push({
          id: `log_${++this.counter}`,
          timestamp,
          type: EventTypes.Log,
          source: { type: "system", id: "devtools" },
          payload: { level: "error", message: `malformed DevTools line: ${(error as Error).message}`, line },
        });
      }
      return;
    }
    const match = UE_LOG_LINE.exec(line);
    if (!match) return;
    const category = match[2]!;
    if (category === MINIGAME_CATEGORY) {
      const state = MINIGAME_STATE.exec(match[4]!)?.[1];
      if (state) this.minigame(state, this.timestampOf(line, useLineTime));
      return;
    }
    if (!this.categories.has(category)) return;
    const channel = category === "LogVerse" ? VERSE_CHANNEL.exec(match[4]!) : null;
    this.queue.push({
      id: `log_${++this.counter}`,
      timestamp: this.timestampOf(line, useLineTime),
      type: EventTypes.Log,
      source: { type: "system", id: category },
      payload: {
        category,
        level: (match[3] ?? "Log").toLowerCase(),
        ...(channel?.[1] ? { channel: channel[1] } : {}),
        message: channel ? channel[2] : match[4],
      },
    });
  }

  /**
   * Event id prefix for a wire record. The Verse emitter restarts its
   * sequence whenever its device restarts (a new match), so a sequence number
   * seen again starts a new epoch and keeps ids unique across matches.
   */
  private idPrefix(seq: number): string {
    if (this.seqs.has(seq)) {
      this.epoch += 1;
      this.seqs.clear();
    }
    this.seqs.add(seq);
    return this.epoch === 1 ? "rt" : `rt${this.epoch}`;
  }

  /** InProgress starts the game; PostGameEnd ends it. Repeats of a state are ignored. */
  private minigame(state: string, timestamp: number, extra: Record<string, unknown> = {}): void {
    if (state === this.minigameState) return;
    this.minigameState = state;
    const type = state === "InProgress" ? EventTypes.GameStarted : state === "PostGameEnd" ? EventTypes.GameEnded : undefined;
    if (!type) return;
    this.queue.push({
      id: `log_${++this.counter}`,
      timestamp,
      type,
      source: { type: "system", id: "valkyrie" },
      payload: { minigameState: state, ...extra },
    });
  }
}

function minigameStateOf(line: string): string | undefined {
  const match = UE_LOG_LINE.exec(line.replace(/^﻿/, ""));
  return match && match[2] === MINIGAME_CATEGORY ? MINIGAME_STATE.exec(match[4]!)?.[1] : undefined;
}

/** Milliseconds of the line's UE timestamp prefix; only differences between lines are meaningful. */
function lineTime(line: string): number | undefined {
  const raw = /^﻿?\[([^\]]*)\]/.exec(line)?.[1];
  const m = raw ? UE_TIMESTAMP.exec(raw) : null;
  if (!m) return undefined;
  const [y, mo, d, h, mi, s, ms] = m.slice(1).map(Number) as [number, number, number, number, number, number, number];
  return Date.UTC(y, mo - 1, d, h, mi, s, ms);
}
