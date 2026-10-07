import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

const canonical = (p: string) => realpath(resolve(p)).catch(() => resolve(p));
import type { DaemonInfo, RpcMethod, RpcParamsOf, RpcResponse, StreamMessage } from "@uefn-devtools/protocol";
import { daemonInfoPath } from "./server.ts";

export class DaemonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "DaemonRpcError";
  }
}

/** Typed client for the daemon's JSON-RPC and event stream. */
export class DaemonClient {
  private nextId = 1;

  constructor(readonly info: Pick<DaemonInfo, "url" | "token">) {}

  /** Finds a running daemon for the project at `root`, if any. */
  static async discover(root: string): Promise<DaemonClient | undefined> {
    let info: DaemonInfo;
    try {
      info = JSON.parse(await readFile(daemonInfoPath(root), "utf8")) as DaemonInfo;
    } catch {
      return undefined;
    }
    const client = new DaemonClient(info);
    try {
      // A stale file can point at a port now used by another project's
      // daemon (which may even accept the same token). Only accept ours.
      const project = (await client.call("project.get", {})) as { root?: string };
      if (!project.root || (await canonical(project.root)) !== (await canonical(root))) return undefined;
      return client;
    } catch {
      return undefined; // stale file from a daemon that died
    }
  }

  async call<M extends RpcMethod>(method: M, params: RpcParamsOf<M>): Promise<any> {
    const res = await fetch(`${this.info.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.info.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
    });
    const body = (await res.json()) as RpcResponse;
    if (body.error) throw new DaemonRpcError(body.error.code, body.error.message);
    return body.result;
  }

  /** Server-sent event stream; ends when `signal` aborts or the daemon closes. */
  async *stream(signal?: AbortSignal): AsyncGenerator<StreamMessage> {
    const res = await fetch(`${this.info.url}/stream`, {
      headers: { authorization: `Bearer ${this.info.token}`, accept: "text/event-stream" },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok || !res.body) throw new Error(`stream failed: HTTP ${res.status}`);
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let split: number;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          if (data) yield JSON.parse(data) as StreamMessage;
        }
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") throw error;
    }
  }
}
