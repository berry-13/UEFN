import type { TraceResponse } from "@uefn-devtools/daemon";
import type { RuntimeEvent } from "@uefn-devtools/protocol";
import { api, type IndexedEvent } from "./api.ts";
import { byId, h, json, replace, seconds, throttle } from "./dom.ts";

type CausalNode = TraceResponse["tree"];

/** Events kept in memory; older ones are still reachable through time travel and traces. */
export const EVENT_CAP = 2000;
/** Rows rendered at once, newest first. */
const ROWS_SHOWN = 250;

/** The event stream panel: a capped, filterable list plus payload and causal trace of the selection. */
export class EventsView {
  readonly events: IndexedEvent[] = [];
  private readonly types = new Set<string>();
  private paused = false;
  private missed = 0;
  private selectedId?: string;
  private size = 0;

  private readonly list = byId("event-list");
  private readonly detail = byId("event-detail");
  private readonly typeSelect = byId<HTMLSelectElement>("ev-type");
  private readonly search = byId<HTMLInputElement>("ev-search");
  private readonly pause = byId<HTMLButtonElement>("ev-pause");
  private readonly count = byId("ev-count");
  private readonly scheduleRender = throttle(() => this.render(), 200);

  constructor() {
    this.typeSelect.addEventListener("change", () => this.render());
    let searchTimer: number | undefined;
    this.search.addEventListener("input", () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => this.render(), 150);
    });
    this.pause.addEventListener("click", () => {
      this.paused = !this.paused;
      this.pause.setAttribute("aria-pressed", String(this.paused));
      this.pause.textContent = this.paused ? "Resume" : "Pause";
      if (!this.paused) {
        this.missed = 0;
        this.render();
      } else this.renderCount();
    });
    // One delegated handler for every "select event" button in the list and the trace tree.
    const onSelect = (e: Event) => {
      const button = (e.target as Element).closest<HTMLButtonElement>("button[data-event-index], button[data-node-id]");
      if (!button) return;
      const event = button.dataset.eventIndex !== undefined ? this.byIndex(Number(button.dataset.eventIndex)) : this.nodes.get(button.dataset.nodeId!);
      if (event) void this.select(event);
    };
    this.list.addEventListener("click", onSelect);
    this.detail.addEventListener("click", onSelect);
    this.render();
  }

  /** Events from the causal tree currently shown, by id (they may be older than the buffer). */
  private nodes = new Map<string, RuntimeEvent>();

  add(event: IndexedEvent): void {
    this.events.push(event);
    if (this.events.length > EVENT_CAP) this.events.splice(0, this.events.length - EVENT_CAP);
    this.size = Math.max(this.size, event.index + 1);
    if (!this.types.has(event.type)) {
      this.types.add(event.type);
      const options = [...this.types].sort();
      const at = options.indexOf(event.type);
      const option = h("option", { value: event.type }, event.type);
      // +1 skips "All types".
      this.typeSelect.insertBefore(option, this.typeSelect.options[at + 1] ?? null);
    }
    if (this.paused) {
      this.missed++;
      this.renderCount();
    } else this.scheduleRender();
  }

  byIndex(index: number): IndexedEvent | undefined {
    const first = this.events[0];
    if (!first) return undefined;
    const candidate = this.events[index - first.index];
    return candidate?.index === index ? candidate : this.events.find((e) => e.index === index);
  }

  private filtered(): IndexedEvent[] {
    const type = this.typeSelect.value;
    const needle = this.search.value.trim().toLowerCase();
    return this.events.filter((e) => {
      if (type && e.type !== type) return false;
      if (!needle) return true;
      const hay = [e.id, e.type, e.source?.id, e.target?.id, e.traceId, JSON.stringify(e.payload)].join(" ").toLowerCase();
      return hay.includes(needle);
    });
  }

  private renderCount(matching?: number, shown?: number): void {
    const parts = [];
    if (matching !== undefined && shown !== undefined) {
      parts.push(shown < matching ? `Showing newest ${shown} of ${matching} matching events.` : `${matching} matching events.`);
    }
    parts.push(`${this.events.length} buffered, ${this.size} in the log.`);
    if (this.paused) parts.push(`Paused, ${this.missed} new since.`);
    this.count.textContent = parts.join(" ");
  }

  render(): void {
    const matching = this.filtered();
    const rows = matching.slice(-ROWS_SHOWN).reverse();
    this.renderCount(matching.length, rows.length);
    const active = document.activeElement as HTMLElement | null;
    const focusedIndex = this.list.contains(active) ? active?.dataset.eventIndex : undefined;
    if (rows.length === 0) {
      replace(this.list, h("p", { class: "empty" }, this.events.length ? "No events match the filter." : "No events yet."));
      return;
    }
    replace(
      this.list,
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "events" },
          h("caption", { class: "visually-hidden" }, "Runtime events, newest first"),
          h(
            "thead",
            {},
            h("tr", {}, ["Index", "Time", "Type", "Source", "Target", "Trace"].map((c) => h("th", { scope: "col" }, c))),
          ),
          h(
            "tbody",
            {},
            rows.map((e) => {
              const selected = e.id === this.selectedId;
              return h(
                "tr",
                { class: selected ? "selected" : "" },
                h("td", { class: "num" }, e.index),
                h("td", { class: "num" }, seconds(e.timestamp)),
                h(
                  "th",
                  { scope: "row" },
                  h(
                    "button",
                    { type: "button", class: "link", "data-event-index": e.index, "aria-current": selected ? "true" : undefined },
                    e.type,
                    h("span", { class: "visually-hidden" }, `, event ${e.index}`),
                  ),
                ),
                h("td", {}, entity(e.source)),
                h("td", {}, entity(e.target)),
                h("td", {}, e.traceId ?? ""),
              );
            }),
          ),
        ),
      ),
    );
    if (focusedIndex !== undefined) {
      this.list.querySelector<HTMLButtonElement>(`button[data-event-index="${focusedIndex}"]`)?.focus();
    }
  }

  async select(event: RuntimeEvent): Promise<void> {
    this.selectedId = event.id;
    for (const row of this.list.querySelectorAll("tr.selected")) row.classList.remove("selected");
    for (const b of this.list.querySelectorAll("button[aria-current]")) b.removeAttribute("aria-current");
    const button = [...this.list.querySelectorAll<HTMLButtonElement>("button[data-event-index]")].find(
      (b) => this.byIndex(Number(b.dataset.eventIndex))?.id === event.id,
    );
    button?.setAttribute("aria-current", "true");
    button?.closest("tr")?.classList.add("selected");

    const focusInTree = this.detail.contains(document.activeElement) ? event.id : undefined;
    const traceBox = h("div", { class: "trace" }, h("p", { class: "muted" }, "Loading causal trace."));
    replace(
      this.detail,
      h(
        "dl",
        { class: "facts" },
        fact("Id", event.id),
        fact("Type", event.type),
        fact("Time", seconds(event.timestamp)),
        fact("Source", entity(event.source) || "none"),
        fact("Target", entity(event.target) || "none"),
        fact("Trace", event.traceId ?? "none"),
        fact("Parent", event.parentEventId ?? "none"),
      ),
      h("h4", {}, "Payload"),
      h("pre", { class: "code", tabindex: 0, "aria-label": "Payload JSON" }, json(event.payload)),
      h("h4", {}, "Causal trace"),
      traceBox,
    );
    try {
      const trace = await api.trace(event.id);
      if (this.selectedId !== event.id) return;
      this.nodes.clear();
      replace(
        traceBox,
        h("ul", { class: "tree" }, this.treeNode(trace.tree, event.id)),
        h("details", {}, h("summary", {}, "As text"), h("pre", { class: "code" }, trace.text)),
      );
      if (focusInTree) traceBox.querySelector<HTMLButtonElement>(`button[data-node-id="${CSS.escape(focusInTree)}"]`)?.focus();
    } catch (error) {
      if (this.selectedId !== event.id) return;
      replace(traceBox, h("p", { class: "error" }, `Could not load the trace: ${(error as Error).message}`));
    }
  }

  private treeNode(node: CausalNode, selectedId: string): HTMLElement {
    this.nodes.set(node.event.id, node.event);
    const current = node.event.id === selectedId;
    return h(
      "li",
      {},
      h(
        "button",
        { type: "button", class: "link", "data-node-id": node.event.id, "aria-current": current ? "true" : undefined },
        `${node.event.type} `,
        h("span", { class: "muted" }, `${node.event.id} at ${seconds(node.event.timestamp)}`),
      ),
      node.children.length ? h("ul", {}, node.children.map((c) => this.treeNode(c, selectedId))) : null,
    );
  }
}

function entity(ref: RuntimeEvent["source"]): string {
  return ref ? `${ref.type} ${ref.id}` : "";
}

function fact(term: string, value: string): HTMLElement[] {
  return [h("dt", {}, term), h("dd", {}, value)];
}
