import type { GameState } from "@uefn-devtools/protocol";
import { h, inline, replace, seconds, yesNo, type Child } from "./dom.ts";

/** One renderer for the derived GameState, used by the live view and by time travel. */
export function renderState(container: Element, state: GameState, headingLevel: "h2" | "h3" = "h3"): void {
  const heading = (text: string) => h(headingLevel, {}, text);

  const summary = h(
    "dl",
    { class: "facts" },
    fact("Phase", state.phase),
    fact("Round", state.round),
    fact("Started", seconds(state.startedAt) || "not started"),
    fact("Ended", seconds(state.endedAt) || "running or not started"),
    fact("Winner", state.winner !== undefined ? `Team ${state.winner}` : "none"),
  );

  const teams = Object.values(state.teams).sort((a, b) => a.id - b.id);
  const devices = Object.values(state.devices).sort((a, b) => a.id.localeCompare(b.id));
  const players = Object.values(state.players).sort((a, b) => a.id.localeCompare(b.id));
  const probes = Object.entries(state.probes).sort(([a], [b]) => a.localeCompare(b));

  replace(
    container,
    h("section", { class: "card", "aria-label": "Game" }, heading("Game"), summary),
    h(
      "section",
      { class: "card" },
      heading("Teams and scores"),
      table(
        "Teams and scores",
        ["Team", "Score"],
        teams.map((t) => [`Team ${t.id}`, t.score]),
        "No team has scored yet.",
      ),
    ),
    h(
      "section",
      { class: "card wide" },
      heading("Devices"),
      table(
        "Devices",
        ["Device", "Type", "State", "Owner", "Enabled", "Progress", "Triggers"],
        devices.map((d) => [
          d.id,
          d.type ?? "",
          d.state ?? "",
          d.owner !== undefined && d.owner !== null ? `Team ${d.owner}` : "none",
          yesNo(d.enabled),
          progress(d.id, d.progress),
          d.triggerCount,
        ]),
        "No device has reported state yet.",
      ),
    ),
    h(
      "section",
      { class: "card wide" },
      heading("Players"),
      table(
        "Players",
        ["Player", "Team", "Alive", "Health", "Shield", "Score", "Eliminations", "Deaths", "In areas"],
        players.map((p) => [
          p.id,
          p.team !== undefined ? `Team ${p.team}` : "",
          yesNo(p.alive),
          p.health ?? "",
          p.shield ?? "",
          p.score,
          p.eliminations,
          p.deaths,
          p.areas.join(", ") || "none",
        ]),
        "No players have spawned yet.",
      ),
    ),
    h(
      "section",
      { class: "card wide" },
      heading("Probes"),
      table(
        "Probes",
        ["Probe", "Value"],
        probes.map(([id, value]) => [id, h("code", {}, inline(value))]),
        "No probe values yet.",
      ),
    ),
  );
}

function fact(term: string, value: Child): HTMLElement[] {
  return [h("dt", {}, term), h("dd", {}, value)];
}

function progress(device: string, value: number | undefined): Child {
  if (value === undefined) return "";
  const pct = Math.max(0, Math.min(100, value));
  return h(
    "span",
    { class: "progress-cell" },
    h("progress", { max: 100, value: pct, "aria-label": `${device} capture progress` }, `${Math.round(pct)}%`),
    h("span", { "aria-hidden": "true" }, `${Math.round(pct)}%`),
  );
}

/** A data table; the first cell of each row is its row header. */
export function table(caption: string, columns: string[], rows: Child[][], empty: string, captionVisible = false): HTMLElement {
  if (rows.length === 0) return h("p", { class: "empty" }, empty);
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      {},
      h("caption", { class: captionVisible ? "" : "visually-hidden" }, caption),
      h("thead", {}, h("tr", {}, columns.map((c) => h("th", { scope: "col" }, c)))),
      h(
        "tbody",
        {},
        rows.map((cells) => h("tr", {}, cells.map((cell, i) => (i === 0 ? h("th", { scope: "row" }, cell) : h("td", {}, cell))))),
      ),
    ),
  );
}
