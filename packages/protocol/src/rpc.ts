import { z } from "zod";

/**
 * Internal protocol between DevTools clients (CLI, dashboard, desktop) and
 * the daemon (spec §82). JSON-RPC 2.0 over `POST /rpc`; progress and runtime
 * events stream over server-sent events at `GET /stream`.
 */
export const RpcParams = {
  "project.get": z.object({}).default({}),
  "capabilities.get": z.object({}).default({}),
  compile: z.object({}).default({}),
  "session.start": z.object({}).default({}),
  "session.stop": z.object({}).default({}),
  "state.get": z.object({}).default({}),
  "tests.list": z.object({}).default({}),
  "tests.run": z
    .object({
      filter: z.string().optional(),
      repeat: z.number().int().positive().max(1000).optional(),
      seed: z.number().int().optional(),
      compile: z.boolean().default(true),
    })
    .default({ compile: true }),
  "runs.list": z.object({ limit: z.number().int().positive().max(200).default(20) }).default({ limit: 20 }),
  "runs.get": z.object({ runId: z.string() }),
  "events.query": z
    .object({
      type: z.string().optional(),
      fromIndex: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(1000).default(200),
    })
    .default({ limit: 200 }),
  "events.trace": z.object({ eventId: z.string() }),
} as const;

export type RpcMethod = keyof typeof RpcParams;
export type RpcParamsOf<M extends RpcMethod> = z.input<(typeof RpcParams)[M]>;

export interface RpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
} as const;

/** One message on `GET /stream`. */
export type StreamMessage =
  | { channel: "runtime"; index: number; event: unknown }
  | { channel: "activity"; source: string; runId?: string; data: unknown }
  | { channel: "hello"; daemon: { version: string; project: string; adapter: string } };

/** Written to `.devtools/daemon.json` (mode 0600) so local clients can find the daemon. */
export interface DaemonInfo {
  pid: number;
  url: string;
  port: number;
  token: string;
  startedAt: string;
}
