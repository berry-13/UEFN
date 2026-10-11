import type { CompileResult, GameState, Session } from "@uefn-devtools/protocol";
import type {
  CapabilitiesResponse,
  DaemonInfo,
  EventsResponse,
  RunTestsRequest,
  RunTestsResponse,
  StateAtResponse,
  StatusResponse,
  StreamMessages,
  TestsResponse,
  TraceResponse,
} from "./api.ts";
import { readDaemonInfo } from "./info.ts";

export class DaemonClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DaemonClientError";
  }
}

export interface DaemonClientOptions {
  /** e.g. `http://127.0.0.1:43123` */
  url: string;
  token: string;
  /** Recorded as the actor in the audit log (`X-DevTools-Client`). */
  client?: string;
}

export interface EventsQuery {
  /** One type or several; PascalCase is accepted. */
  type?: string | string[];
  traceId?: string;
  fromIndex?: number;
  limit?: number;
}

export type StreamMessage = {
  [K in keyof StreamMessages]: { event: K; data: StreamMessages[K]; id?: string };
}[keyof StreamMessages];

/** Typed client for the daemon HTTP API; uses global `fetch`, so it runs in Node, Electron and VS Code. */
export class DaemonClient {
  constructor(readonly options: DaemonClientOptions) {}

  static fromInfo(info: DaemonInfo, client?: string): DaemonClient {
    return new DaemonClient({ url: `http://127.0.0.1:${info.port}`, token: info.token, ...(client ? { client } : {}) });
  }

  /** Connects to the daemon serving `root`; throws when none is running or daemon.json is stale. */
  static async fromRoot(root: string, client?: string): Promise<DaemonClient> {
    const info = await readDaemonInfo(root);
    if (!info) throw new DaemonClientError(`no daemon is running for ${root}`, 0);
    if (info.stale) throw new DaemonClientError(`stale daemon.json for ${root} (pid ${info.pid} is not running)`, 0);
    return DaemonClient.fromInfo(info, client);
  }

  status(): Promise<StatusResponse> {
    return this.request("GET", "/api/status");
  }

  state(): Promise<GameState> {
    return this.request("GET", "/api/state");
  }

  /** State after replaying events[0..index] (inclusive). */
  stateAt(index: number): Promise<StateAtResponse> {
    return this.request("GET", `/api/state/at?index=${index}`);
  }

  events(query: EventsQuery = {}): Promise<EventsResponse> {
    const params = new URLSearchParams();
    if (query.type) params.set("type", Array.isArray(query.type) ? query.type.join(",") : query.type);
    if (query.traceId) params.set("traceId", query.traceId);
    if (query.fromIndex !== undefined) params.set("fromIndex", String(query.fromIndex));
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const qs = params.toString();
    return this.request("GET", `/api/events${qs ? `?${qs}` : ""}`);
  }

  trace(eventId: string): Promise<TraceResponse> {
    return this.request("GET", `/api/events/${encodeURIComponent(eventId)}/trace`);
  }

  tests(): Promise<TestsResponse> {
    return this.request("GET", "/api/tests");
  }

  capabilities(): Promise<CapabilitiesResponse> {
    return this.request("GET", "/api/capabilities");
  }

  compile(): Promise<CompileResult> {
    return this.request("POST", "/api/compile");
  }

  startSession(): Promise<Session> {
    return this.request("POST", "/api/session/start");
  }

  stopSession(): Promise<{ stopped: true }> {
    return this.request("POST", "/api/session/stop");
  }

  runTests(body: RunTestsRequest = {}): Promise<RunTestsResponse> {
    return this.request("POST", "/api/tests/run", body);
  }

  /** Asks the daemon process to stop (it removes daemon.json on the way out). */
  /** Single-use, 60s ticket the dashboard trades for the token (`POST /api/ui/exchange`). */
  uiTicket(): Promise<{ ticket: string; expiresAt: number }> {
    return this.request("POST", "/api/ui/ticket");
  }

  shutdown(): Promise<{ stopping: true }> {
    return this.request("POST", "/api/shutdown");
  }

  /** URL for a browser `EventSource` (the token travels in the query string). */
  streamUrl(fromIndex?: number): string {
    const params = new URLSearchParams({ token: this.options.token });
    if (fromIndex !== undefined) params.set("fromIndex", String(fromIndex));
    return `${this.options.url}/api/stream?${params}`;
  }

  /**
   * Reads `GET /api/stream` with fetch and calls `onMessage` per event until
   * the stream ends or `signal` aborts. `onOpen` fires once the response headers arrive.
   */
  async stream(
    onMessage: (message: StreamMessage) => void,
    options: { signal?: AbortSignal; fromIndex?: number; onOpen?: () => void } = {},
  ): Promise<void> {
    const qs = options.fromIndex !== undefined ? `?fromIndex=${options.fromIndex}` : "";
    const res = await fetch(`${this.options.url}/api/stream${qs}`, {
      headers: this.headers(),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!res.ok || !res.body) throw new DaemonClientError(await errorText(res), res.status);
    options.onOpen?.();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const message = parseFrame(block);
          if (message) onMessage(message);
        }
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") throw error;
    }
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.token}`,
      ...(this.options.client ? { "x-devtools-client": this.options.client } : {}),
    };
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.options.url + path, {
      method,
      headers: { ...this.headers(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new DaemonClientError(await errorText(res), res.status);
    return (await res.json()) as T;
  }
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    return (JSON.parse(text) as { error?: string }).error ?? `HTTP ${res.status}`;
  } catch {
    return text || `HTTP ${res.status}`;
  }
}

function parseFrame(block: string): StreamMessage | undefined {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (!data.length) return undefined;
  return { event, data: JSON.parse(data.join("\n")), ...(id !== undefined ? { id } : {}) } as StreamMessage;
}
