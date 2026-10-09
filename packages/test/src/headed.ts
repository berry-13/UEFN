import type { GameState, RuntimeEvent } from "@uefn-devtools/protocol";

/**
 * Terminal views of the derived GameState for `uefn test --headed` and the
 * `--debug` pause screen (docs/debugging.md). Pure functions: the same input
 * always yields the same string, so they are unit-testable without a TTY.
 */
export interface FrameInput {
  state: GameState;
  /** Session-clock time shown in the header, in milliseconds. */
  now?: number;
  /** Most recent events, oldest first; perf.* events are skipped. */
  events?: readonly RuntimeEvent[];
  /** Reporter lines to show in the log area, oldest first. */
  log?: readonly string[];
  title?: string;
  /** Total width in columns (default 80). */
  width?: number;
  /** How many events / log lines to show (defaults 6 / 10). */
  maxEvents?: number;
  maxLog?: number;
}

const BAR = 20;

export function progressBar(percent: number, width = BAR): string {
  const p = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const filled = Math.round((p / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${String(Math.round(p)).padStart(3)}%`;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

function fit(line: string, width: number): string {
  return line.length > width ? line.slice(0, Math.max(0, width - 3)) + "..." : line;
}

/** `type (k=v, ...)` with the payload keys that identify an event. */
export function describeEvent(e: RuntimeEvent): string {
  const keys = ["device", "player", "team", "state", "delta", "current", "by"].filter(
    (k) => e.payload[k] !== undefined && e.payload[k] !== null,
  );
  const detail = keys.map((k) => `${k}=${String(e.payload[k])}`).join(", ");
  return detail ? `${e.type} (${detail})` : e.type;
}

/** Recent non-perf events, oldest first. */
export function recentEvents(events: readonly RuntimeEvent[], max: number): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < max; i--) {
    if (!events[i]!.type.startsWith("perf.")) out.unshift(events[i]!);
  }
  return out;
}

/** Multi-line frame: header, teams, devices, players, recent events, log. */
export function renderFrame(input: FrameInput): string {
  const width = input.width ?? 80;
  const { state } = input;
  const lines: string[] = [];
  const rule = (title: string) => lines.push(`-- ${title} ${"-".repeat(Math.max(0, width - title.length - 4))}`);

  const header = [input.title ?? "UEFN DevTools", input.now !== undefined ? `t=${seconds(input.now)}` : undefined]
    .filter(Boolean)
    .join("  ");
  lines.push(header);
  lines.push(`Phase: ${state.phase}   Round: ${state.round}${state.winner !== undefined ? `   Winner: team ${state.winner}` : ""}`);

  rule("Teams");
  const teams = Object.values(state.teams).sort((a, b) => a.id - b.id);
  if (teams.length === 0) lines.push("  (no scores yet)");
  for (const t of teams) lines.push(`  Team ${t.id}  ${String(t.score).padStart(6)}`);

  rule("Devices");
  const devices = Object.values(state.devices).sort((a, b) => a.id.localeCompare(b.id));
  if (devices.length === 0) lines.push("  (none observed)");
  const idWidth = Math.max(0, ...devices.map((d) => d.id.length));
  for (const d of devices) {
    const status = d.enabled ? (d.state ?? "-") : "disabled";
    const owner = d.owner !== undefined ? `owner ${d.owner}` : "owner -";
    lines.push(`  ${d.id.padEnd(idWidth)}  ${status.padEnd(10)} ${owner.padEnd(8)} ${progressBar(d.progress ?? 0)}`);
  }

  rule("Players");
  const players = Object.values(state.players).sort((a, b) => a.id.localeCompare(b.id));
  if (players.length === 0) lines.push("  (none spawned)");
  const pWidth = Math.max(0, ...players.map((p) => p.id.length));
  for (const p of players) {
    lines.push(
      `  ${p.id.padEnd(pWidth)}  team ${p.team ?? "-"}  ${(p.alive ? "alive" : "eliminated").padEnd(10)} ` +
        `hp ${String(p.health ?? "-").padStart(3)}  areas: ${p.areas.length ? p.areas.join(", ") : "-"}`,
    );
  }

  const events = recentEvents(input.events ?? [], input.maxEvents ?? 6);
  rule("Recent events");
  if (events.length === 0) lines.push("  (none)");
  for (const e of events) lines.push(`  ${seconds(e.timestamp).padStart(8)}  ${describeEvent(e)}`);

  if (input.log) {
    rule("Log");
    for (const l of input.log.slice(-(input.maxLog ?? 10))) lines.push(`  ${l}`);
  }
  return lines.map((l) => fit(l, width)).join("\n");
}

/** One-line summary for non-TTY output (CI logs). */
export function renderStateLine(state: GameState, now?: number): string {
  const parts: string[] = [`[headed${now !== undefined ? ` t=${seconds(now)}` : ""}] ${state.phase}`];
  const teams = Object.values(state.teams).sort((a, b) => a.id - b.id);
  if (teams.length) parts.push(`teams ${teams.map((t) => `${t.id}:${t.score}`).join(" ")}`);
  const devices = Object.values(state.devices).sort((a, b) => a.id.localeCompare(b.id));
  if (devices.length) {
    parts.push(
      devices
        .map((d) => `${d.id}=${d.enabled ? (d.state ?? "-") : "disabled"}(owner ${d.owner ?? "-"}, ${Math.round(d.progress ?? 0)}%)`)
        .join(" "),
    );
  }
  const players = Object.values(state.players).sort((a, b) => a.id.localeCompare(b.id));
  if (players.length) {
    parts.push(
      players
        .map((p) => `${p.id}(t${p.team ?? "-"} ${p.alive ? `hp${p.health ?? "-"}` : "out"}${p.areas.length ? ` @${p.areas.join("+")}` : ""})`)
        .join(" "),
    );
  }
  return parts.join(" | ");
}
