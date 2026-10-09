import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { readSseStream, type SseMessage } from "./sse.ts";
import type {
  CompileResult,
  DaemonInfo,
  GameState,
  RunSummary,
  StatusResponse,
  TraceResponse,
} from "./types.ts";

export function daemonInfoPath(root: string): string {
  return path.join(root, ".devtools", "daemon.json");
}

/** True when a process with `pid` exists (EPERM means it exists but belongs to someone else). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Reads `<root>/.devtools/daemon.json` and returns it only when it is well
 * formed and its pid is alive. A stale file (crashed daemon) yields undefined.
 */
export async function readLiveDaemon(
  root: string,
  alive: (pid: number) => boolean = isProcessAlive,
): Promise<DaemonInfo | undefined> {
  let info: DaemonInfo;
  try {
    info = JSON.parse(await readFile(daemonInfoPath(root), "utf8")) as DaemonInfo;
  } catch {
    return undefined;
  }
  if (typeof info.pid !== "number" || typeof info.port !== "number" || typeof info.token !== "string") return undefined;
  return alive(info.pid) ? info : undefined;
}

export class DaemonHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Minimal client for the daemon HTTP API (docs/daemon.md); only needs global fetch. */
export class DaemonHttp {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(info: Pick<DaemonInfo, "port" | "token">) {
    this.baseUrl = `http://127.0.0.1:${info.port}`;
    this.token = info.token;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, "x-devtools-client": "vscode", ...extra };
  }

  private async request<T>(method: "GET" | "POST", route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers: this.headers(body !== undefined ? { "content-type": "application/json" } : undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const message = (json as { error?: string } | undefined)?.error ?? `HTTP ${response.status}`;
      throw new DaemonHttpError(response.status, message);
    }
    return json as T;
  }

  status(signal?: AbortSignal): Promise<StatusResponse> {
    return this.request("GET", "/api/status", undefined, signal);
  }

  state(signal?: AbortSignal): Promise<GameState> {
    return this.request("GET", "/api/state", undefined, signal);
  }

  trace(eventId: string, signal?: AbortSignal): Promise<TraceResponse> {
    return this.request("GET", `/api/events/${encodeURIComponent(eventId)}/trace`, undefined, signal);
  }

  compile(signal?: AbortSignal): Promise<CompileResult> {
    return this.request("POST", "/api/compile", {}, signal);
  }

  runTests(body: { filter?: string; repeat?: number }, signal?: AbortSignal): Promise<RunSummary> {
    return this.request("POST", "/api/tests/run", body, signal);
  }

  /**
   * Opens `GET /api/stream` and calls `onMessage` for each SSE message until
   * the server closes the stream or `signal` aborts. Resolves on a clean
   * close, rejects on connection errors (aborts reject with AbortError).
   */
  async stream(onMessage: (message: SseMessage) => void, options: { signal?: AbortSignal; fromIndex?: number } = {}): Promise<void> {
    const query = new URLSearchParams({ token: this.token });
    if (options.fromIndex !== undefined) query.set("fromIndex", String(options.fromIndex));
    const response = await fetch(`${this.baseUrl}/api/stream?${query.toString()}`, {
      headers: { accept: "text/event-stream", "x-devtools-client": "vscode" },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok || !response.body) throw new DaemonHttpError(response.status, `stream failed: HTTP ${response.status}`);
    await readSseStream(response.body as unknown as AsyncIterable<Uint8Array>, onMessage);
  }
}
