import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DaemonHttp, DaemonHttpError, readLiveDaemon } from "../dist/daemon.js";
import type { SseMessage } from "../dist/sse.js";

test("readLiveDaemon returns live info and ignores missing, malformed or stale files", async () => {
  const root = await mkdtemp(join(tmpdir(), "uefn-vscode-daemon-"));
  assert.equal(await readLiveDaemon(root), undefined);
  await mkdir(join(root, ".devtools"));
  await writeFile(join(root, ".devtools", "daemon.json"), "{not json");
  assert.equal(await readLiveDaemon(root), undefined);
  const info = { pid: process.pid, port: 1234, token: "t", root, startedAt: 1, version: "0.1.0" };
  await writeFile(join(root, ".devtools", "daemon.json"), JSON.stringify(info));
  assert.deepEqual(await readLiveDaemon(root), info);
  assert.equal(await readLiveDaemon(root, () => false), undefined);
});

test("DaemonHttp sends the bearer token, parses errors and streams SSE with the query token", async () => {
  const seen: { url: string; auth?: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url!, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
    if (req.url === "/api/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ phase: "playing", round: 1, players: {}, devices: {}, teams: {}, probes: {} }));
    } else if (req.url === "/api/events/missing/trace") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown event 'missing'" }));
    } else if (req.url?.startsWith("/api/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": heartbeat\n\n");
      res.write('event: session\ndata: {"session":null,"runtimeReady":false,"phase":"idle"}\n\n');
      res.write('event: runtime\nid: 5\ndata: {"id":"e5","index":5,"type":"score.changed","timestamp":1,"payload":{}}\n\n');
      res.end();
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new DaemonHttp({ port, token: "secret" });
    assert.equal((await client.state()).phase, "playing");
    assert.equal(seen[0]!.auth, "Bearer secret");
    await assert.rejects(client.trace("missing"), (e: unknown) => e instanceof DaemonHttpError && e.status === 404 && e.message === "unknown event 'missing'");
    const messages: SseMessage[] = [];
    await client.stream((m) => messages.push(m), { fromIndex: 3 });
    assert.deepEqual(messages.map((m) => m.event), ["session", "runtime"]);
    assert.equal(JSON.parse(messages[1]!.data).index, 5);
    assert.equal(seen.at(-1)!.url, "/api/stream?token=secret&fromIndex=3");
  } finally {
    server.close();
  }
});
