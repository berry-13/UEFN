import type {
  EventsResponse,
  RunTestsRequest,
  RunnerStreamEvent,
  SessionSnapshot,
  StateAtResponse,
  StatusResponse,
  TestsResponse,
  TraceResponse,
} from "@uefn-devtools/daemon";
import type { CompileResult, GameState, RunSummary, RuntimeEvent, Session } from "@uefn-devtools/protocol";

export type IndexedEvent = RuntimeEvent & { index: number };

const TOKEN_KEY = "uefn-devtools-token";
let token: string | null = null;

/**
 * The CLI opens `/#ticket=...`. Strip it from the address bar and history,
 * trade it once for the token, and keep the token in sessionStorage so a
 * reload keeps working.
 */
export async function initToken(): Promise<string | null> {
  const params = new URLSearchParams(location.hash.slice(1));
  const ticket = params.get("ticket");
  if (ticket) {
    params.delete("ticket");
    const rest = params.toString();
    history.replaceState(history.state, "", location.pathname + location.search + (rest ? `#${rest}` : ""));
    try {
      const res = await fetch("/api/ui/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket }),
      });
      if (res.ok) {
        token = ((await res.json()) as { token: string }).token;
        try {
          sessionStorage.setItem(TOKEN_KEY, token);
        } catch {
          // Storage can be unavailable (private mode, policies); the in-memory token still works.
        }
        return token;
      }
    } catch {
      // Daemon unreachable: fall back to a token from an earlier load, if any.
    }
  }
  if (token) return token;
  try {
    token = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    token = null;
  }
  return token;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token ?? ""}`, "x-devtools-client": "desktop" };
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch {
    throw new ApiError("cannot reach the daemon", 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : res.statusText;
    throw new ApiError(message || `HTTP ${res.status}`, res.status);
  }
  return data as T;
}

export const api = {
  status: () => request<StatusResponse>("GET", "/api/status"),
  state: () => request<GameState>("GET", "/api/state"),
  stateAt: (index: number) => request<StateAtResponse>("GET", `/api/state/at?index=${index}`),
  events: (fromIndex: number, limit: number) => request<EventsResponse>("GET", `/api/events?fromIndex=${fromIndex}&limit=${limit}`),
  trace: (id: string) => request<TraceResponse>("GET", `/api/events/${encodeURIComponent(id)}/trace`),
  tests: () => request<TestsResponse>("GET", "/api/tests"),
  compile: () => request<CompileResult>("POST", "/api/compile"),
  startSession: () => request<Session>("POST", "/api/session/start"),
  stopSession: () => request<{ stopped: true }>("POST", "/api/session/stop"),
  runTests: (body: RunTestsRequest) => request<RunSummary>("POST", "/api/tests/run", body),
};

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "unauthorized" | "offline";

export interface StreamHandlers {
  runtime(event: IndexedEvent): void;
  runner(event: RunnerStreamEvent): void;
  session(snapshot: SessionSnapshot): void;
  state(state: ConnectionState): void;
}

const RETRY_MS = 3000;

/**
 * Owns the SSE connection. EventSource reconnects on its own after network
 * blips (sending Last-Event-ID); when it gives up (daemon gone, token
 * rejected) this reopens it from the last seen index.
 */
export class Stream {
  private source?: EventSource;
  private lastIndex = -1;
  private retry?: number;

  constructor(private readonly handlers: StreamHandlers) {}

  open(fromIndex: number): void {
    this.close();
    this.handlers.state(this.lastIndex < 0 ? "connecting" : "reconnecting");
    const url = `/api/stream?token=${encodeURIComponent(token ?? "")}&fromIndex=${fromIndex}`;
    const source = new EventSource(url);
    this.source = source;
    source.onopen = () => this.handlers.state("connected");
    source.addEventListener("runtime", (m) => {
      const event = JSON.parse((m as MessageEvent<string>).data) as IndexedEvent;
      // A reconnect replays from fromIndex again; drop what was already seen.
      if (event.index <= this.lastIndex) return;
      this.lastIndex = event.index;
      this.handlers.runtime(event);
    });
    source.addEventListener("runner", (m) => this.handlers.runner(JSON.parse((m as MessageEvent<string>).data) as RunnerStreamEvent));
    source.addEventListener("session", (m) => this.handlers.session(JSON.parse((m as MessageEvent<string>).data) as SessionSnapshot));
    source.onerror = () => {
      if (source.readyState === EventSource.CONNECTING) {
        this.handlers.state("reconnecting");
        return;
      }
      source.close();
      void api.status().then(
        () => this.scheduleRetry(),
        (error: ApiError) => {
          if (error.status === 401 || error.status === 403) this.handlers.state("unauthorized");
          else {
            this.handlers.state("offline");
            this.scheduleRetry();
          }
        },
      );
    };
  }

  private scheduleRetry(): void {
    window.clearTimeout(this.retry);
    this.retry = window.setTimeout(() => this.open(this.lastIndex + 1), RETRY_MS);
  }

  close(): void {
    window.clearTimeout(this.retry);
    this.source?.close();
    this.source = undefined;
  }
}
