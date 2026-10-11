import assert from "node:assert/strict";
import { test } from "node:test";
import { SseParser, readSseStream, type SseMessage } from "../dist/sse.js";

function parse(chunks: string[]): SseMessage[] {
  const out: SseMessage[] = [];
  const parser = new SseParser((m) => out.push(m));
  for (const c of chunks) parser.feed(c);
  parser.end();
  return out;
}

test("parses named events with ids and multi-line data", () => {
  const out = parse(["event: runtime\nid: 3\ndata: {\"a\":1}\n\n", "data: line1\ndata: line2\n\n"]);
  assert.deepEqual(out, [
    { event: "runtime", data: '{"a":1}', id: "3" },
    { event: "message", data: "line1\nline2", id: "3" },
  ]);
});

test("handles chunks split mid-line and CRLF split across chunks", () => {
  const out = parse(["event: ses", "sion\r", "\ndata: {\"x\"", ":true}\r\n\r", "\n"]);
  assert.deepEqual(out, [{ event: "session", data: '{"x":true}' }]);
});

test("ignores comments, retry and events without data; drops an unterminated event", () => {
  const out = parse([": heartbeat\n\n", "retry: 1000\nevent: x\n\n", "data:no-space\n\n", "data: pending"]);
  assert.deepEqual(out, [{ event: "message", data: "no-space" }]);
});

test("readSseStream decodes UTF-8 split across byte chunks", async () => {
  const bytes = new TextEncoder().encode("event: runtime\ndata: café\n\n");
  const split = bytes.indexOf(0xc3) + 1;
  async function* body() {
    yield bytes.slice(0, split);
    yield bytes.slice(split);
  }
  const out: SseMessage[] = [];
  await readSseStream(body(), (m) => out.push(m));
  assert.deepEqual(out, [{ event: "runtime", data: "café" }]);
});
