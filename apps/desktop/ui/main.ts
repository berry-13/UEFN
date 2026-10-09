import type { SessionSnapshot, StatusResponse } from "@uefn-devtools/daemon";
import { ApiError, Stream, api, initToken, type ConnectionState } from "./api.ts";
import { byId, duration, throttle } from "./dom.ts";
import { EVENT_CAP, EventsView } from "./events.ts";
import { renderState } from "./state-view.ts";
import { TestsView } from "./tests.ts";
import { TimeTravelView } from "./timetravel.ts";

const TAB_KEY = "uefn-devtools-tab";

let status: StatusResponse | undefined;
let action: string | undefined;

const events = new EventsView();
const timeTravel = new TimeTravelView(events);
const tests = new TestsView();

const liveState = byId("live-state");
const conn = byId("conn");
const connDot = byId("conn-dot");
const actionStatus = byId("action-status");
const actionError = byId("action-error");
const buttons = {
  compile: byId<HTMLButtonElement>("btn-compile"),
  start: byId<HTMLButtonElement>("btn-start"),
  stop: byId<HTMLButtonElement>("btn-stop"),
};
const labels = { compile: "Compile", start: "Start session", stop: "Stop session" };
const busyLabels = { compile: "Compiling...", start: "Starting session...", stop: "Stopping session..." };

// ── tabs (WAI-ARIA tabs pattern, automatic activation) ─────────────────────

function setupTabs(): void {
  const tablist = byId("tablist");
  const tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const select = (tab: HTMLButtonElement, focus: boolean) => {
    for (const t of tabs) {
      const selected = t === tab;
      t.setAttribute("aria-selected", String(selected));
      t.tabIndex = selected ? 0 : -1;
      byId(t.getAttribute("aria-controls")!).hidden = !selected;
    }
    if (focus) tab.focus();
    try {
      localStorage.setItem(TAB_KEY, tab.id);
    } catch {
      // Remembering the tab is a convenience only.
    }
  };
  tablist.addEventListener("click", (e) => {
    const tab = (e.target as Element).closest<HTMLButtonElement>('[role="tab"]');
    if (tab) select(tab, false);
  });
  tablist.addEventListener("keydown", (e) => {
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    let next: number | undefined;
    if (e.key === "ArrowRight") next = (current + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next === undefined) return;
    e.preventDefault();
    select(tabs[next]!, true);
  });
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(TAB_KEY);
  } catch {
    saved = null;
  }
  const initial = tabs.find((t) => t.id === saved);
  if (initial) select(initial, false);
}

// ── session bar ─────────────────────────────────────────────────────────────

function setText(id: string, text: string): void {
  byId(id).textContent = text;
}

function renderStatus(): void {
  const s = status;
  if (!s) return;
  setText("s-project", s.project);
  setText("s-adapter", s.adapter);
  setText("s-session", s.session ? `${s.session.status} (${s.session.id})` : "none");
  setText("s-runtime", s.runtimeReady ? "ready" : "not ready");
  setText("s-phase", s.phase);
  setText("s-events", String(s.events) + (s.busy && !action ? ", daemon busy" : ""));
  const active = !!s.session && (s.session.status === "starting" || s.session.status === "connected" || s.session.status === "playing");
  setDisabled(buttons.compile, !!action);
  setDisabled(buttons.start, !!action || (active && s.runtimeReady));
  setDisabled(buttons.stop, !!action || !active);
}

/** aria-disabled keeps the button focusable, so focus is not lost while an action runs. */
function setDisabled(button: HTMLButtonElement, disabled: boolean): void {
  button.setAttribute("aria-disabled", String(disabled));
}

function applySnapshot(snapshot: SessionSnapshot): void {
  if (!status) return;
  status = { ...status, ...snapshot };
  renderStatus();
}

const refreshStatus = throttle(() => {
  api.status().then(
    (s) => {
      status = s;
      renderStatus();
    },
    () => {},
  );
}, 500);

async function runAction(name: keyof typeof buttons, fn: () => Promise<string>): Promise<void> {
  const button = buttons[name];
  if (button.getAttribute("aria-disabled") === "true") return;
  action = name;
  button.textContent = busyLabels[name];
  button.setAttribute("aria-busy", "true");
  actionError.hidden = true;
  actionStatus.textContent = "";
  renderStatus();
  try {
    actionStatus.textContent = await fn();
  } catch (error) {
    actionError.textContent = `${labels[name]} failed: ${(error as Error).message}`;
    actionError.hidden = false;
  } finally {
    action = undefined;
    button.textContent = labels[name];
    button.removeAttribute("aria-busy");
    renderStatus();
    refreshStatus();
  }
}

buttons.compile.addEventListener("click", () =>
  void runAction("compile", async () => {
    const r = await api.compile();
    const problems = r.diagnostics.length;
    return `Compile ${r.success ? "succeeded" : "failed"} in ${duration(r.durationMs)} with ${problems} diagnostic${problems === 1 ? "" : "s"}.`;
  }),
);
buttons.start.addEventListener("click", () =>
  void runAction("start", async () => {
    const s = await api.startSession();
    return `Session ${s.id} started; the runtime is ready.`;
  }),
);
buttons.stop.addEventListener("click", () =>
  void runAction("stop", async () => {
    await api.stopSession();
    return "Session stopped.";
  }),
);

// ── live state ──────────────────────────────────────────────────────────────

const refreshState = throttle(() => {
  api.state().then(
    (state) => {
      renderState(liveState, state);
      timeTravel.setLiveState(state);
    },
    () => {},
  );
}, 250);

// ── connection ──────────────────────────────────────────────────────────────

const CONNECTION_TEXT: Record<ConnectionState, string> = {
  connecting: "Connecting to the daemon",
  connected: "Connected to the daemon",
  reconnecting: "Connection lost, reconnecting",
  offline: "Daemon unreachable, retrying",
  unauthorized: "Access denied: the token is missing or no longer valid. Reopen the dashboard with 'uefn ui'.",
};

function setConnection(state: ConnectionState): void {
  if (conn.textContent !== CONNECTION_TEXT[state]) conn.textContent = CONNECTION_TEXT[state];
  connDot.dataset.state = state;
}

const stream = new Stream({
  runtime(event) {
    events.add(event);
    timeTravel.setSize(event.index + 1);
    if (status) {
      status.events = Math.max(status.events, event.index + 1);
      setText("s-events", String(status.events));
    }
    refreshState();
  },
  runner(event) {
    tests.onRunner(event);
    if (event.kind === "done" || event.kind === "discovered") refreshStatus();
  },
  session(snapshot) {
    applySnapshot(snapshot);
    refreshState();
    refreshStatus();
  },
  state(state) {
    setConnection(state);
    if (state === "connected") refreshStatus();
  },
});

async function start(): Promise<void> {
  if (!(await initToken())) {
    setConnection("unauthorized");
    return;
  }
  try {
    status = await api.status();
  } catch (error) {
    setConnection(error instanceof ApiError && (error.status === 401 || error.status === 403) ? "unauthorized" : "offline");
    if (!(error instanceof ApiError) || error.status === 0) window.setTimeout(() => void start(), 3000);
    return;
  }
  renderStatus();
  timeTravel.setSize(status.events);
  stream.open(Math.max(0, status.events - EVENT_CAP));
  refreshState();
  void tests.load();
}

setupTabs();
void start();
