import type { GameState } from "@uefn-devtools/protocol";
import { api } from "./api.ts";
import { byId, seconds } from "./dom.ts";
import type { EventsView } from "./events.ts";
import { renderState } from "./state-view.ts";

/** Slider over event indices; shows the state replayed up to the chosen event, or the live state. */
export class TimeTravelView {
  private live = true;
  private size = 0;
  private liveState?: GameState;
  private seq = 0;
  private timer?: number;

  private readonly slider = byId<HTMLInputElement>("tt-slider");
  private readonly liveBox = byId<HTMLInputElement>("tt-live");
  private readonly prev = byId<HTMLButtonElement>("tt-prev");
  private readonly next = byId<HTMLButtonElement>("tt-next");
  private readonly position = byId("tt-position");
  private readonly stateBox = byId("tt-state");

  constructor(private readonly events: EventsView) {
    this.slider.addEventListener("input", () => this.goTo(Number(this.slider.value)));
    this.prev.addEventListener("click", () => enabled(this.prev) && this.step(-1));
    this.next.addEventListener("click", () => enabled(this.next) && this.step(1));
    this.liveBox.addEventListener("change", () => {
      this.live = this.liveBox.checked;
      if (this.live) this.showLive();
      else this.goTo(Number(this.slider.value));
    });
    this.updateControls();
  }

  setSize(size: number): void {
    if (size <= this.size) return;
    this.size = size;
    this.slider.max = String(Math.max(0, size - 1));
    if (this.live) this.slider.value = this.slider.max;
    this.updateControls();
  }

  setLiveState(state: GameState): void {
    this.liveState = state;
    if (this.live) this.showLive();
  }

  private step(delta: number): void {
    if (this.size === 0) return;
    const current = this.live ? this.size - 1 : Number(this.slider.value);
    this.goTo(Math.max(0, Math.min(this.size - 1, current + delta)));
  }

  private goTo(index: number): void {
    if (this.size === 0) return;
    this.live = false;
    this.liveBox.checked = false;
    this.slider.value = String(index);
    this.updateControls();
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.load(index), 80);
  }

  private async load(index: number): Promise<void> {
    const seq = ++this.seq;
    try {
      const [at, event] = await Promise.all([
        api.stateAt(index),
        this.events.byIndex(index) ?? api.events(index, 1).then((r) => r.events[0]),
      ]);
      if (seq !== this.seq || this.live) return;
      const label = `Event ${index + 1} of ${this.size}${event ? `: ${event.type}` : ""} at ${seconds(at.timestamp)}`;
      this.position.textContent = label;
      this.slider.setAttribute("aria-valuetext", label);
      renderState(this.stateBox, at.state);
    } catch (error) {
      if (seq !== this.seq) return;
      this.position.textContent = `Could not load event ${index + 1}: ${(error as Error).message}`;
    }
  }

  private showLive(): void {
    this.seq++;
    if (this.size > 0) this.slider.value = String(this.size - 1);
    this.updateControls();
    this.position.textContent = `Live state (${this.size} events in the log).`;
    this.slider.setAttribute("aria-valuetext", `Live, ${this.size} events`);
    if (this.liveState) renderState(this.stateBox, this.liveState);
  }

  private updateControls(): void {
    const empty = this.size === 0;
    this.slider.disabled = empty;
    const index = Number(this.slider.value);
    this.prev.setAttribute("aria-disabled", String(empty || (!this.live && index <= 0)));
    this.next.setAttribute("aria-disabled", String(empty || this.live || index >= this.size - 1));
    if (empty) this.position.textContent = "The event log is empty. Start a session or run tests.";
  }
}

function enabled(button: HTMLButtonElement): boolean {
  return button.getAttribute("aria-disabled") !== "true";
}
