import { open, stat } from "node:fs/promises";
import type { CommandResult, RuntimeCommand, RuntimeEvent } from "@uefn-devtools/protocol";
import { EventTypes, WIRE_MARKER, parseWireLine, wireRecordToEvent } from "@uefn-devtools/protocol";
import type { RuntimeTransport } from "./adapter.ts";
import type { Clock } from "./clock.ts";
import { AsyncQueue } from "./util.ts";

/** `[2026.10.04-13.24.11:123][456]LogVerse: Warning: message` */
const UE_LOG_LINE = /^\[[^\]]*\]\[\s*\d+\]([A-Za-z0-9_]+):\s(?:(Error|Warning|Display|Verbose|VeryVerbose|Log):\s)?(.*)$/;

export interface LogTransportOptions {
  path: string;
  clock: Clock;
  /** Log categories forwarded as `log` events. */
  categories?: string[];
  pollMs?: number;
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
  private readonly categories: Set<string>;

  constructor(private readonly options: LogTransportOptions) {
    this.categories = new Set(options.categories ?? ["LogVerse"]);
  }

  async start(): Promise<void> {
    // Only lines written after the session starts are relevant.
    this.offset = await stat(this.options.path).then((s) => s.size, () => 0);
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

  private async poll(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const size = await stat(this.options.path).then((s) => s.size, () => 0);
      if (size < this.offset) {
        // Log was truncated or rotated by a new editor session.
        this.offset = 0;
        this.remainder = "";
      }
      if (size === this.offset) return;
      const handle = await open(this.options.path, "r");
      try {
        const buffer = Buffer.alloc(size - this.offset);
        await handle.read(buffer, 0, buffer.length, this.offset);
        this.offset = size;
        const text = this.remainder + buffer.toString("utf8");
        const lines = text.split(/\r?\n/);
        this.remainder = lines.pop() ?? "";
        for (const line of lines) this.ingest(line);
      } finally {
        await handle.close();
      }
    } finally {
      this.reading = false;
    }
  }

  /** Exposed for tests. */
  ingest(line: string): void {
    const timestamp = this.options.clock.now();
    if (line.includes(WIRE_MARKER)) {
      try {
        const record = parseWireLine(line);
        if (record) this.queue.push(wireRecordToEvent(record, timestamp));
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
    if (!match || !this.categories.has(match[1]!)) return;
    this.queue.push({
      id: `log_${++this.counter}`,
      timestamp,
      type: EventTypes.Log,
      source: { type: "system", id: match[1]! },
      payload: { category: match[1], level: (match[2] ?? "Log").toLowerCase(), message: match[3] },
    });
  }
}
