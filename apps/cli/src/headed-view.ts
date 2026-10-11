import type { DevToolsEngine } from "@uefn-devtools/core";
import type { RuntimeEvent } from "@uefn-devtools/protocol";
import { renderFrame, renderStateLine } from "@uefn-devtools/test";

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ENTER_ALT = "\x1b[?1049h\x1b[?25l";
const LEAVE_ALT = "\x1b[?25h\x1b[?1049l";

export interface HeadedViewOptions {
  tty?: boolean;
  write?: (text: string) => void;
  /** Wall-clock milliseconds between frames (TTY) or status lines (non-TTY). */
  intervalMs?: number;
}

/**
 * Live view for `uefn test --headed` on the simulated adapter. On a TTY it
 * draws full frames on the terminal's alternate screen, with reporter output
 * in the frame's log area, and replays the whole report on exit so it stays
 * in scrollback. Without a TTY it prints a throttled one-line state summary
 * between reporter lines.
 */
export class HeadedView {
  private readonly tty: boolean;
  private readonly write: (text: string) => void;
  private readonly intervalMs: number;
  private readonly transcript: string[] = [];
  private recent: RuntimeEvent[] = [];
  private dirty = true;
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private lastLine = "";
  private readonly restore = () => process.stdout.write(LEAVE_ALT);

  constructor(
    private readonly engine: DevToolsEngine,
    options: HeadedViewOptions = {},
  ) {
    this.tty = options.tty ?? process.stdout.isTTY === true;
    this.write = options.write ?? ((t) => process.stdout.write(t));
    // Non-TTY lines are deduplicated (printed only when the state changed), so
    // the same short interval keeps fast simulated runs visible without spam.
    this.intervalMs = options.intervalMs ?? 100;
  }

  start(): void {
    this.unsubscribe = this.engine.events.subscribe((event) => {
      if (event.type.startsWith("perf.")) return;
      this.recent.push(event);
      if (this.recent.length > 20) this.recent.shift();
      this.dirty = true;
    });
    if (this.tty) {
      this.write(ENTER_ALT);
      process.once("exit", this.restore);
    }
    this.timer = setInterval(() => this.flush(), this.intervalMs);
    this.timer.unref();
  }

  /** Reporter sink. */
  log(text: string): void {
    if (!this.tty) {
      this.write(text);
      return;
    }
    this.transcript.push(text);
    this.dirty = true;
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    if (this.tty) {
      this.write(LEAVE_ALT);
      process.removeListener("exit", this.restore);
      this.write(this.transcript.join(""));
    } else {
      this.flush(true);
    }
  }

  private flush(force = false): void {
    if (!this.dirty && !force) return;
    this.dirty = false;
    const now = this.engine.now();
    if (!this.tty) {
      const line = renderStateLine(this.engine.state, now);
      // Time alone changing is not news; only print when the state moved.
      const key = line.replace(/ t=[0-9.]+s/, "");
      if (key !== this.lastLine) this.write(line + "\n");
      this.lastLine = key;
      return;
    }
    // A pseudo-TTY can report 0 columns / rows.
    const width = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const logLines = this.transcript.join("").replace(ANSI, "").split("\n");
    const frame = renderFrame({
      state: this.engine.state,
      now,
      events: this.recent,
      log: logLines,
      title: `UEFN DevTools (headed, ${this.engine.adapter.name})`,
      width,
      maxLog: Math.max(3, rows - 24),
    });
    this.write("\x1b[H\x1b[2J" + frame + "\n");
  }
}
