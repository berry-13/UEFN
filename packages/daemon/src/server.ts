import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { findRunSummary, formatCausalTree, listRecordings, listRunSummaries, loadRecording, summarizeRecording, type DevToolsEngine } from "@uefn-devtools/core";
import { runDoctor } from "@uefn-devtools/doctor";
import { createDevToolsMcpServer } from "@uefn-devtools/mcp";
import {
  RpcErrorCode,
  RpcParams,
  type DaemonInfo,
  type RpcMethod,
  type RpcRequest,
  type RpcResponse,
  type StreamMessage,
} from "@uefn-devtools/protocol";
import {
  filterTests,
  findTestFiles,
  generateTest,
  loadTests,
  newRunId,
  normalizeEventType,
  runTests,
  toTypeScript,
  toYaml,
  writeGeneratedTest,
} from "@uefn-devtools/test";

export const DEFAULT_PORT = 4917;
const VERSION = "0.1.0";
const MAX_BODY = 1024 * 1024;
const STATIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../static");
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface DaemonOptions {
  engine: DevToolsEngine;
  /** 0 picks a free port. */
  port?: number;
  /** Defaults to a random 32-byte token. */
  token?: string;
  /** Write `.devtools/daemon.json` so local clients can find the daemon. */
  writeInfoFile?: boolean;
}

export interface RunningDaemon {
  info: DaemonInfo;
  server: Server;
  close(): Promise<void>;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export function daemonInfoPath(root: string): string {
  return join(root, ".devtools", "daemon.json");
}

/**
 * The DevTools daemon (spec §83): one engine and session shared by every
 * client. It serves JSON-RPC (`/rpc`), a server-sent event stream
 * (`/stream`), the MCP server over Streamable HTTP (`/mcp`) and the
 * dashboard (`/`).
 *
 * Security (spec §59): binds 127.0.0.1 only, requires a bearer token for
 * every data route, and rejects foreign Host/Origin headers to block DNS
 * rebinding and cross-site requests.
 */
export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const { engine } = options;
  const token = options.token ?? randomBytes(32).toString("base64url");
  const tokenBuffer = Buffer.from(token);
  const resultsDir = resolve(engine.root, engine.config.paths.results);
  const project = await engine.project();
  const running = new Map<string, { runId: string; startedAt: number; filter?: string; repeat?: number }>();
  const streams = new Set<ServerResponse>();
  const mcpSessions = new Map<string, StreamableHTTPServerTransport>();
  let allowedHosts = new Set<string>();

  // ── fan-out to SSE clients ──────────────────────────────────────────────
  const broadcast = (message: StreamMessage) => {
    const frame = `data: ${JSON.stringify(message)}\n\n`;
    for (const res of streams) res.write(frame);
  };
  const unsubscribeEvents = engine.events.subscribe((event, index) => broadcast({ channel: "runtime", index, event }));
  const unsubscribeActivity = engine.onActivity((a) =>
    broadcast({ channel: "activity", source: a.source, ...(a.runId ? { runId: a.runId } : {}), data: a.data }),
  );
  const keepAlive = setInterval(() => {
    for (const res of streams) res.write(": keep-alive\n\n");
  }, 15_000);

  // ── RPC handlers ────────────────────────────────────────────────────────
  type Handlers = { [M in RpcMethod]: (params: import("zod").infer<(typeof RpcParams)[M]>) => Promise<unknown> };
  const handlers: Handlers = {
    "project.get": () => engine.project(),
    "capabilities.get": () => engine.capabilities(),
    compile: () => engine.exclusive(() => engine.compile()),
    "session.start": () =>
      engine.exclusive(async () => {
        const session = await engine.startSession();
        await engine.waitForRuntime();
        return session;
      }),
    "session.stop": () => engine.exclusive(() => engine.stopSession()).then(() => ({ stopped: true })),
    "state.get": async () => ({
      project: project.name,
      adapter: engine.adapter.name,
      session: engine.session ?? null,
      runtimeReady: engine.runtimeReady,
      game: engine.state,
      eventCount: engine.events.size,
      lastCompile: engine.lastCompile
        ? { success: engine.lastCompile.success, durationMs: engine.lastCompile.durationMs, diagnostics: engine.lastCompile.diagnostics }
        : null,
      running: [...running.values()],
      recording: engine.activeRecording ?? null,
      commands: engine.session && engine.session.status !== "stopped" ? engine.adapter.transport().supportedCommands() : [],
      devices: await engine.adapter.getDevices().catch(() => []),
    }),
    "tests.list": async () => {
      const { tests, errors } = await loadTests(await findTestFiles(resolve(engine.root, engine.config.paths.tests)), { root: engine.root });
      return {
        tests: filterTests(tests).map((t) => ({
          id: t.id,
          name: t.name,
          file: relative(engine.root, t.file),
          format: t.format,
          ...(t.skip ? { skip: true } : {}),
        })),
        errors: errors.map((e) => ({ file: relative(engine.root, e.file), message: e.message })),
      };
    },
    "tests.run": async (p) => {
      const runId = newRunId();
      running.set(runId, {
        runId,
        startedAt: Date.now(),
        ...(p.filter ? { filter: p.filter } : {}),
        ...(p.repeat ? { repeat: p.repeat } : {}),
      });
      // Accepted immediately; progress arrives on /stream tagged with runId.
      void engine
        .exclusive(() =>
          runTests(engine, {
            runId,
            ...(p.filter ? { filter: p.filter } : {}),
            ...(p.repeat ? { repeat: p.repeat } : {}),
            ...(p.seed !== undefined ? { seed: p.seed } : {}),
            ...(p.retries !== undefined ? { retries: p.retries } : {}),
            skipBuild: !p.compile,
            keepSession: true,
          }),
        )
        .catch(() => {})
        .finally(() => running.delete(runId));
      return { runId };
    },
    "doctor.run": () => runDoctor(engine.loaded),
    "runs.list": async (p) => ({
      running: [...running.values()],
      runs: (await listRunSummaries(resultsDir, p.limit)).map((s) => ({
        runId: s.runId,
        status: s.status,
        startedAt: s.startedAt,
        durationMs: s.durationMs,
        failedStage: s.failedStage,
        tests: s.tests.length,
        passed: s.tests.filter((t) => t.status === "passed").length,
        failed: s.tests.filter((t) => t.status === "failed" || t.status === "error").length,
      })),
    }),
    "runs.get": async (p) => {
      const live = running.get(p.runId);
      if (live) return { status: "running", ...live };
      const summary = await findRunSummary(resultsDir, p.runId);
      if (!summary) throw new RpcError(RpcErrorCode.InvalidParams, `unknown run '${p.runId}'`);
      return summary;
    },
    "events.query": async (p) => {
      const all = engine.events.query({
        ...(p.type ? { type: normalizeEventType(p.type) } : {}),
        ...(p.fromIndex !== undefined ? { fromIndex: p.fromIndex } : {}),
      });
      return { total: all.length, nextIndex: engine.events.mark(), events: all.slice(-p.limit) };
    },
    // Queues behind any test run, so a dashboard click cannot change a run's outcome.
    "runtime.command": (p) =>
      engine.exclusive(async () => {
        await engine.command(p.command);
        return { ok: true };
      }),
    "recording.start": async (p) => engine.startRecording({ kind: p.kind, ...(p.name ? { name: p.name } : {}) }),
    "recording.stop": async () => {
      const { recording, path } = await engine.stopRecording();
      return { path: relative(engine.root, path), summary: summarizeRecording(recording) };
    },
    "recordings.list": async () => ({ recordings: await listRecordings(engine.root) }),
    "recordings.get": async (p) => {
      const recording = await loadRecording(engine.root, p.id).catch(() => {
        throw new RpcError(RpcErrorCode.InvalidParams, `unknown recording '${p.id}'`);
      });
      return { summary: summarizeRecording(recording), recording };
    },
    "recordings.generate": async (p) => {
      const recording = await loadRecording(engine.root, p.id).catch(() => {
        throw new RpcError(RpcErrorCode.InvalidParams, `unknown recording '${p.id}'`);
      });
      const generated = generateTest(recording, { counts: p.counts, ...(p.name ? { name: p.name } : {}) });
      const source = { recordingId: recording.id };
      const text = p.format === "ts" ? toTypeScript(generated, source) : toYaml(generated, source);
      if (!p.write) return { source: text, notes: generated.notes };
      const path = await writeGeneratedTest(resolve(engine.root, engine.config.paths.tests), generated, p.format, source);
      return { source: text, notes: generated.notes, written: relative(engine.root, path) };
    },
    "events.trace": async (p) => {
      const tree = engine.events.causalTree(p.eventId);
      if (!tree) throw new RpcError(RpcErrorCode.InvalidParams, `unknown event '${p.eventId}'`);
      return { tree, text: formatCausalTree(tree), ancestry: engine.events.ancestry(p.eventId).map((e) => e.id) };
    },
  };

  async function dispatch(request: unknown): Promise<RpcResponse> {
    const req = request as Partial<RpcRequest>;
    const id = typeof req?.id === "string" || typeof req?.id === "number" ? req.id : null;
    try {
      if (req?.jsonrpc !== "2.0" || typeof req.method !== "string" || id === null) {
        throw new RpcError(RpcErrorCode.InvalidRequest, "expected a JSON-RPC 2.0 request with id and method");
      }
      if (!Object.hasOwn(RpcParams, req.method)) throw new RpcError(RpcErrorCode.MethodNotFound, `unknown method '${req.method}'`);
      const method = req.method as RpcMethod;
      const parsed = RpcParams[method].safeParse(req.params ?? undefined);
      if (!parsed.success) {
        throw new RpcError(RpcErrorCode.InvalidParams, parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; "));
      }
      const result = await (handlers[method] as (p: unknown) => Promise<unknown>)(parsed.data);
      return { jsonrpc: "2.0", id, result: result ?? null };
    } catch (error) {
      const code = error instanceof RpcError ? error.code : RpcErrorCode.Internal;
      return { jsonrpc: "2.0", id, error: { code, message: (error as Error).message } };
    }
  }

  // ── HTTP plumbing ───────────────────────────────────────────────────────
  const authorized = (req: IncomingMessage, url: URL, allowQueryToken: boolean): boolean => {
    const header = req.headers.authorization;
    const presented = header?.startsWith("Bearer ") ? header.slice(7) : allowQueryToken ? url.searchParams.get("token") : null;
    if (!presented) return false;
    const buf = Buffer.from(presented);
    return buf.length === tokenBuffer.length && timingSafeEqual(buf, tokenBuffer);
  };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
      "cache-control": "no-store",
      ...headers,
    });
    res.end(text);
  };

  const readJson = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolveBody, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new RpcError(RpcErrorCode.InvalidRequest, "request body too large"));
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
        } catch {
          reject(new RpcError(RpcErrorCode.ParseError, "invalid JSON"));
        }
      });
      req.on("error", reject);
    });

  const serveStatic = async (res: ServerResponse, path: string) => {
    const name = path === "/" ? "index.html" : path.slice(1);
    if (!/^[a-z0-9_-]+\.(html|js|css|svg)$/.test(name)) return send(res, 404, "not found");
    try {
      const body = await readFile(join(STATIC_DIR, name));
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(name)] ?? "application/octet-stream",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
        "x-content-type-options": "nosniff",
      });
      res.end(body);
    } catch {
      send(res, 404, "not found");
    }
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse) => {
    const sessionId = req.headers["mcp-session-id"];
    const body = req.method === "POST" ? await readJson(req) : undefined;
    let transport = typeof sessionId === "string" ? mcpSessions.get(sessionId) : undefined;
    if (!transport) {
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: RpcErrorCode.InvalidRequest, message: "missing or unknown MCP session" } });
      }
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          mcpSessions.set(id, created);
        },
      });
      created.onclose = () => {
        if (created.sessionId) mcpSessions.delete(created.sessionId);
      };
      // Each MCP session gets its own server; all of them share the engine.
      await createDevToolsMcpServer({ engine, actor: "mcp-http" }).connect(created);
      transport = created;
    }
    await transport.handleRequest(req, res, body);
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      // DNS rebinding / cross-site protection.
      if (!allowedHosts.has(req.headers.host ?? "")) return send(res, 403, "forbidden host");
      const origin = req.headers.origin;
      if (origin && !allowedHosts.has(origin.replace(/^http:\/\//, ""))) return send(res, 403, "forbidden origin");

      if (req.method === "GET" && !["/rpc", "/stream", "/mcp"].includes(url.pathname)) return serveStatic(res, url.pathname);

      if (url.pathname === "/stream" && req.method === "GET") {
        if (!authorized(req, url, true)) return send(res, 401, "unauthorized");
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ channel: "hello", daemon: { version: VERSION, project: project.name, adapter: engine.adapter.name } } satisfies StreamMessage)}\n\n`);
        streams.add(res);
        req.on("close", () => streams.delete(res));
        return;
      }

      if (url.pathname === "/rpc" && req.method === "POST") {
        if (!authorized(req, url, false)) return send(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } });
        let body: unknown;
        try {
          body = await readJson(req);
        } catch (error) {
          return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: (error as RpcError).code ?? RpcErrorCode.ParseError, message: (error as Error).message } });
        }
        const response = Array.isArray(body) ? await Promise.all(body.map(dispatch)) : await dispatch(body);
        return send(res, 200, response);
      }

      if (url.pathname === "/mcp") {
        if (!authorized(req, url, false)) return send(res, 401, "unauthorized");
        return handleMcp(req, res);
      }

      send(res, 404, "not found");
    })().catch((error: Error) => {
      if (!res.headersSent) send(res, 500, { error: error.message });
      else res.end();
    });
  });

  // Everything allocated so far (subscriptions, timer, listening socket) is
  // unwound if startup fails, since the caller gets no handle to close.
  const unwind = () => {
    clearInterval(keepAlive);
    unsubscribeEvents();
    unsubscribeActivity();
    if (server.listening) {
      server.close();
      server.closeAllConnections();
    }
  };
  let port: number;
  let info: DaemonInfo;
  const infoPath = daemonInfoPath(engine.root);
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? DEFAULT_PORT, "127.0.0.1", () => resolveListen());
    });
    port = (server.address() as AddressInfo).port;
    allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    info = { pid: process.pid, url: `http://127.0.0.1:${port}`, port, token, startedAt: new Date().toISOString() };
    if (options.writeInfoFile !== false) {
      await mkdir(dirname(infoPath), { recursive: true });
      // `mode` only applies when the file is created; an existing file keeps
      // its permissions, so tighten them explicitly before writing the token.
      await writeFile(infoPath, "", { mode: 0o600 });
      await chmod(infoPath, 0o600);
      await writeFile(infoPath, JSON.stringify(info, null, 2));
    }
  } catch (error) {
    unwind();
    throw error;
  }

  let closed = false;
  return {
    info,
    server,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      unsubscribeEvents();
      unsubscribeActivity();
      for (const res of streams) res.end();
      streams.clear();
      await Promise.all([...mcpSessions.values()].map((t) => t.close().catch(() => {})));
      const done = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      await done;
      if (options.writeInfoFile !== false) {
        // Another daemon may have taken over the file since; only remove ours.
        const current = await readFile(infoPath, "utf8").then((t) => JSON.parse(t) as DaemonInfo, () => undefined);
        if (current?.token === token && current.pid === process.pid && current.port === port) await rm(infoPath, { force: true });
      }
    },
  };
}
