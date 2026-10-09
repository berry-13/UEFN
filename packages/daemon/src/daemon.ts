import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { AuditLog, DevToolsEngine, applyEvent, eventMatches, formatCausalTree } from "@uefn-devtools/core";
import { EventTypes, emptyGameState, type RuntimeEvent } from "@uefn-devtools/protocol";
import { filterTests, findTestFiles, loadTests, normalizeEventType, runTests, type RunnerEvent } from "@uefn-devtools/test";
import { z } from "zod";
import {
  DAEMON_VERSION,
  type DaemonInfo,
  type EventsResponse,
  type RunnerStreamEvent,
  type SessionSnapshot,
  type StateAtResponse,
  type StatusResponse,
  type TestsResponse,
  type TraceResponse,
} from "./api.ts";
import { readDaemonInfo, removeDaemonInfo, writeDaemonInfo } from "./info.ts";

export interface DaemonOptions {
  engine: DevToolsEngine;
  /** TCP port on 127.0.0.1; 0 picks an ephemeral port (default). */
  port?: number;
  /** Fixed bearer token (tests); a random one is generated otherwise. */
  token?: string;
  /** Serve files from this directory under `/` (GET/HEAD only, no token needed). */
  staticDir?: string;
  /** Called on `POST /api/shutdown`; defaults to {@link DevToolsDaemon.stop}. */
  onShutdown?: () => void;
  /** SSE heartbeat interval (default 15s). */
  heartbeatMs?: number;
}

const HEARTBEAT_MS = 15_000;
const MAX_BODY = 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Serialises operations that touch the session, so concurrent clients cannot interleave runs. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  get busy(): boolean {
    return this.pending > 0;
  }
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const next = this.tail.then(fn, fn).finally(() => this.pending--);
    this.tail = next.catch(() => {});
    return next;
  }
}

const EventsQuery = z.object({
  type: z.string().optional(),
  traceId: z.string().optional(),
  fromIndex: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(1000).default(100),
});

const RunBody = z.object({
  filter: z.string().optional(),
  repeat: z.number().int().positive().max(1000).default(1),
  seed: z.number().int().optional(),
  compile: z.boolean().default(true),
});

type Handler = (req: IncomingMessage, url: URL, actor: string) => Promise<unknown>;
interface Route {
  method: "GET" | "POST";
  path: string | RegExp;
  handler: (req: IncomingMessage, url: URL, actor: string, match: RegExpExecArray | null) => Promise<unknown>;
}

/**
 * Local HTTP + SSE server that lets several clients (CLI, desktop, VS Code)
 * share one {@link DevToolsEngine} and therefore one session (spec §83).
 * Binds 127.0.0.1 only, requires a bearer token and rejects foreign Host headers.
 */
export class DevToolsDaemon {
  readonly engine: DevToolsEngine;
  readonly token: string;
  private readonly server: Server;
  private readonly lock = new Mutex();
  private readonly audit: AuditLog;
  private readonly streams = new Set<ServerResponse>();
  private readonly routes: Route[];
  private staticRoot?: string;
  private heartbeat?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private lastSnapshot = "";
  private info?: DaemonInfo;

  constructor(private readonly options: DaemonOptions) {
    this.engine = options.engine;
    this.token = options.token ?? randomBytes(32).toString("base64url");
    this.audit = new AuditLog(join(this.engine.root, ".devtools", "audit.log"));
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: Error) => sendError(res, error));
    });
    this.routes = this.buildRoutes();
  }

  get port(): number {
    return this.info?.port ?? 0;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Listens, subscribes to the engine and writes `.devtools/daemon.json`. */
  async start(): Promise<DaemonInfo> {
    const root = this.engine.root;
    const existing = await readDaemonInfo(root);
    if (existing && !existing.stale) {
      throw new Error(`a daemon is already running for ${root} (pid ${existing.pid}, port ${existing.port})`);
    }
    if (this.options.staticDir) this.staticRoot = await realpath(resolve(this.options.staticDir));
    await new Promise<void>((resolvePromise, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port ?? 0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolvePromise();
      });
    });
    const port = (this.server.address() as AddressInfo).port;
    this.unsubscribe = this.engine.events.subscribe((event, index) => this.onRuntimeEvent(event, index));
    this.heartbeat = setInterval(() => this.broadcastRaw(": heartbeat\n\n"), this.options.heartbeatMs ?? HEARTBEAT_MS);
    this.heartbeat.unref();
    this.info = { pid: process.pid, port, token: this.token, root, startedAt: Date.now(), version: DAEMON_VERSION, ui: !!this.staticRoot };
    await writeDaemonInfo(this.info);
    return this.info;
  }

  /** Closes streams and the listener and removes daemon.json. Does not close the engine. */
  async stop(): Promise<void> {
    clearInterval(this.heartbeat);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const res of this.streams) res.end();
    this.streams.clear();
    if (this.server.listening) {
      const closed = new Promise<void>((r) => this.server.close(() => r()));
      this.server.closeAllConnections();
      await closed;
    }
    if (this.info) await removeDaemonInfo(this.info.root, this.info.pid);
    this.info = undefined;
  }

  // ── request pipeline ─────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req.headers.host)) throw new HttpError(403, "host not allowed");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // Static UI assets hold no secrets, so they load without the token (the UI gets it from the URL fragment).
    if (this.staticRoot && !url.pathname.startsWith("/api/") && (req.method === "GET" || req.method === "HEAD")) {
      return this.serveStatic(req, res, url);
    }
    // EventSource cannot set headers, so the stream alone may carry the token in the query.
    const queryToken = url.pathname === "/api/stream" ? url.searchParams.get("token") : null;
    if (!this.authorized(req.headers.authorization, queryToken)) {
      res.setHeader("www-authenticate", "Bearer");
      throw new HttpError(401, "missing or invalid bearer token");
    }
    if (url.pathname === "/api/stream") {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      return this.openStream(req, res, url);
    }
    if (url.pathname.startsWith("/api/")) {
      const actor = headerString(req.headers["x-devtools-client"]) ?? "daemon-client";
      let methodMismatch = false;
      for (const route of this.routes) {
        const match = typeof route.path === "string" ? null : route.path.exec(url.pathname);
        if (typeof route.path === "string" ? route.path !== url.pathname : !match) continue;
        if (route.method !== req.method) {
          methodMismatch = true;
          continue;
        }
        return sendJson(res, 200, await route.handler(req, url, actor, match));
      }
      throw new HttpError(methodMismatch ? 405 : 404, methodMismatch ? "method not allowed" : `no route for ${url.pathname}`);
    }
    throw new HttpError(404, "not found");
  }

  private authorized(header: string | undefined, queryToken: string | null): boolean {
    const presented = header?.startsWith("Bearer ") ? header.slice(7).trim() : queryToken;
    if (!presented) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private buildRoutes(): Route[] {
    const e = this.engine;
    const mutating = (action: string, fn: Handler): Route["handler"] => async (req, url, actor) => {
      try {
        const result = await fn(req, url, actor);
        await this.audit.record({ actor, action, outcome: "ok" }).catch(() => {});
        return result;
      } catch (error) {
        await this.audit.record({ actor, action, outcome: "error", detail: { message: (error as Error).message } }).catch(() => {});
        throw error;
      }
    };
    return [
      { method: "GET", path: "/api/status", handler: async () => this.status() },
      { method: "GET", path: "/api/state", handler: async () => e.state },
      { method: "GET", path: "/api/state/at", handler: async (_req, url) => this.stateAt(url) },
      { method: "GET", path: "/api/events", handler: async (_req, url) => this.queryEvents(url) },
      {
        method: "GET",
        path: /^\/api\/events\/([^/]+)\/trace$/,
        handler: async (_req, _url, _actor, match) => this.trace(decodeURIComponent(match![1]!)),
      },
      { method: "GET", path: "/api/tests", handler: async () => this.listTests() },
      { method: "GET", path: "/api/capabilities", handler: async () => e.capabilities() },
      { method: "POST", path: "/api/compile", handler: mutating("daemon.compile", () => this.lock.run(() => e.compile())) },
      {
        method: "POST",
        path: "/api/session/start",
        handler: mutating("daemon.session.start", () =>
          this.lock.run(async () => {
            const session = await e.startSession();
            this.emitSession();
            await e.waitForRuntime();
            this.emitSession();
            return session;
          }),
        ),
      },
      {
        method: "POST",
        path: "/api/session/stop",
        handler: mutating("daemon.session.stop", () =>
          this.lock.run(async () => {
            await e.stopSession();
            this.emitSession();
            return { stopped: true };
          }),
        ),
      },
      {
        method: "POST",
        path: "/api/tests/run",
        handler: mutating("daemon.tests.run", async (req) => {
          const body = RunBody.parse(await readJson(req));
          return this.lock.run(async () => {
            try {
              return await runTests(e, {
                ...(body.filter ? { filter: body.filter } : {}),
                repeat: body.repeat,
                ...(body.seed !== undefined ? { seed: body.seed } : {}),
                skipBuild: !body.compile,
                keepSession: true,
                onEvent: (event) => {
                  this.broadcast("runner", runnerEventToJson(event));
                  if (event.kind === "session") this.emitSession();
                },
              });
            } finally {
              this.emitSession();
            }
          });
        }),
      },
      {
        method: "POST",
        path: "/api/shutdown",
        handler: mutating("daemon.shutdown", async () => {
          setImmediate(this.options.onShutdown ?? (() => void this.stop()));
          return { stopping: true };
        }),
      },
    ];
  }

  // ── endpoints ────────────────────────────────────────────────────────────

  private snapshot(): SessionSnapshot {
    return { session: this.engine.session ?? null, runtimeReady: this.engine.runtimeReady, phase: this.engine.state.phase };
  }

  private async status(): Promise<StatusResponse> {
    const e = this.engine;
    const project = await e.project();
    return {
      project: project.name,
      root: e.root,
      adapter: e.adapter.name,
      ...this.snapshot(),
      events: e.events.size,
      busy: this.lock.busy,
      daemon: {
        pid: process.pid,
        port: this.port,
        startedAt: this.info?.startedAt ?? 0,
        version: DAEMON_VERSION,
        streams: this.streams.size,
        ui: !!this.staticRoot,
      },
    };
  }

  /** Time travel: the state after replaying events[0..index] (inclusive) from an empty state. */
  private stateAt(url: URL): StateAtResponse {
    const raw = url.searchParams.get("index");
    const index = raw === null ? NaN : Number(raw);
    const size = this.engine.events.size;
    if (!Number.isInteger(index) || index < 0) throw new HttpError(400, "index must be a non-negative integer");
    if (index >= size) throw new HttpError(400, `index ${index} is out of range (log has ${size} events)`);
    const events = this.engine.events.all(0).slice(0, index + 1);
    const state = emptyGameState();
    for (const event of events) applyEvent(state, event);
    return { index, timestamp: events[index]!.timestamp, state };
  }

  private queryEvents(url: URL): EventsResponse {
    const q = EventsQuery.parse(Object.fromEntries(url.searchParams));
    const query = {
      ...(q.type ? { type: q.type.split(",").map((t) => normalizeEventType(t.trim())) } : {}),
      ...(q.traceId ? { traceId: q.traceId } : {}),
    };
    const types = query.type ? new Set(query.type) : undefined;
    const all = this.engine.events.all(0);
    const events: EventsResponse["events"] = [];
    let nextIndex = all.length;
    for (let i = q.fromIndex; i < all.length; i++) {
      const event = all[i]!;
      if (!eventMatches(event, query, types)) continue;
      events.push({ ...event, index: i });
      if (events.length >= q.limit) {
        nextIndex = i + 1;
        break;
      }
    }
    return { events, nextIndex, size: all.length };
  }

  private trace(id: string): TraceResponse {
    const tree = this.engine.events.causalTree(id);
    if (!tree) throw new HttpError(404, `unknown event '${id}'`);
    return { tree, ancestry: this.engine.events.ancestry(id).map((e) => e.id), text: formatCausalTree(tree) };
  }

  private async listTests(): Promise<TestsResponse> {
    const e = this.engine;
    const { tests, errors } = await loadTests(await findTestFiles(resolve(e.root, e.config.paths.tests)));
    return {
      tests: filterTests(tests).map((t) => ({ id: t.id, name: t.name, file: relative(e.root, t.file), format: t.format })),
      errors,
    };
  }

  // ── server-sent events ───────────────────────────────────────────────────

  private openStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    // Replay from ?fromIndex or after Last-Event-ID (EventSource reconnects) before going live.
    const lastId = headerString(req.headers["last-event-id"]);
    const fromParam = url.searchParams.get("fromIndex");
    const from = fromParam !== null ? Number(fromParam) : lastId !== undefined ? Number(lastId) + 1 : NaN;
    if (Number.isInteger(from) && from >= 0) {
      this.engine.events.all(from).forEach((event, i) => res.write(runtimeFrame(event, from + i)));
    }
    res.write(frame("session", this.snapshot()));
    this.streams.add(res);
    req.on("close", () => this.streams.delete(res));
  }

  private onRuntimeEvent(event: RuntimeEvent, index: number): void {
    this.broadcastRaw(runtimeFrame(event, index));
    if (event.type === EventTypes.SessionReady || event.type === EventTypes.GameStarted || event.type === EventTypes.GameEnded) {
      this.emitSession();
    }
  }

  /** Sends a `session` event when the session snapshot changed since the last one. */
  private emitSession(): void {
    const snapshot = this.snapshot();
    const key = JSON.stringify(snapshot);
    if (key === this.lastSnapshot) return;
    this.lastSnapshot = key;
    this.broadcast("session", snapshot);
  }

  private broadcast(name: string, data: unknown): void {
    this.broadcastRaw(frame(name, data));
  }

  private broadcastRaw(chunk: string): void {
    for (const res of this.streams) res.write(chunk);
  }

  // ── static files ─────────────────────────────────────────────────────────

  private async serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const root = this.staticRoot!;
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, "bad path");
    }
    if (pathname.includes("\0")) throw new HttpError(400, "bad path");
    let file = resolve(root, "." + pathname);
    if (!within(root, file)) throw new HttpError(404, "not found");
    let info = await stat(file).catch(() => undefined);
    if (info?.isDirectory()) {
      file = join(file, "index.html");
      info = await stat(file).catch(() => undefined);
    }
    if (!info?.isFile()) throw new HttpError(404, "not found");
    // Symlinks must not lead outside the static root either.
    if (!within(root, await realpath(file))) throw new HttpError(404, "not found");
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": info.size,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "referrer-policy": "no-referrer",
      "cache-control": "no-cache",
    });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

/** DNS rebinding guard: only loopback names may address the daemon. */
function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === "127.0.0.1" || name === "localhost";
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function frame(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function runtimeFrame(event: RuntimeEvent, index: number): string {
  return `id: ${index}\nevent: runtime\ndata: ${JSON.stringify({ ...event, index })}\n\n`;
}

/** Test definitions carry functions; stream only what a UI needs. */
function runnerEventToJson(event: RunnerEvent): RunnerStreamEvent {
  if (event.kind === "attempt") {
    const { test, ...rest } = event;
    return { ...rest, test: { id: test.id, name: test.name, file: test.file } };
  }
  return event as unknown as RunnerStreamEvent;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function sendError(res: ServerResponse, error: Error): void {
  if (res.headersSent) {
    res.destroy(error);
    return;
  }
  if (error instanceof z.ZodError) {
    return sendJson(res, 400, { error: error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
  }
  sendJson(res, error instanceof HttpError ? error.status : 500, { error: error.message });
}
