import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DevToolsEngine } from "@uefn-devtools/core";
import { EventTypes } from "@uefn-devtools/protocol";

async function project(extra = ""): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "uefn-devtools-engine-"));
  await writeFile(join(dir, "uefn-devtools.config.yaml"), `adapter: simulated\nsimulated:\n  time_scale: 100\n  boot_ms: 100\n${extra}`);
  return dir;
}

test("waitForRuntime after a restart waits for the new session's session.ready", async () => {
  const engine = await DevToolsEngine.open({ cwd: await project() });
  try {
    await engine.startSession();
    await engine.waitForRuntime();
    await engine.stopSession();
    assert.equal(engine.events.query({ type: EventTypes.SessionReady }).length, 1);

    const mark = engine.events.mark();
    await engine.startSession();
    assert.equal(engine.runtimeReady, false);
    await engine.waitForRuntime();
    // Resolved by a session.ready from the second session, not the first one in the log.
    assert.equal(engine.events.query({ type: EventTypes.SessionReady, fromIndex: mark }).length, 1);
  } finally {
    await engine.close();
  }
});

test("concurrent connect calls share one adapter connect", async () => {
  const engine = await DevToolsEngine.open({ cwd: await project() });
  let calls = 0;
  const original = engine.adapter.connect.bind(engine.adapter);
  engine.adapter.connect = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return original();
  };
  try {
    await Promise.all([engine.connect(), engine.connect(), engine.capabilities()]);
    await engine.connect();
    assert.equal(calls, 1);
  } finally {
    await engine.close();
  }
});

test("a failed connect can be retried", async () => {
  const engine = await DevToolsEngine.open({ cwd: await project() });
  let calls = 0;
  const original = engine.adapter.connect.bind(engine.adapter);
  engine.adapter.connect = async () => {
    if (++calls === 1) throw new Error("boom");
    return original();
  };
  try {
    await assert.rejects(engine.connect(), /boom/);
    await engine.connect();
    assert.equal(calls, 2);
  } finally {
    await engine.close();
  }
});

test("the connected session status is persisted", async () => {
  const engine = await DevToolsEngine.open({ cwd: await project() });
  try {
    const session = await engine.startSession();
    assert.equal(session.status, "connected");
    assert.equal(engine.db?.getSession(session.id)?.status, "connected");
  } finally {
    await engine.close();
  }
});

test("an unusable persistence path disables history instead of failing open", async () => {
  const dir = await project("persistence:\n  path: ./blocker/devtools.db\n");
  // A file where the database directory should be: mkdir fails as it would on a read-only project.
  await writeFile(join(dir, "blocker"), "");
  const write = process.stderr.write;
  const warnings: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    warnings.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let engine: DevToolsEngine;
  try {
    engine = await DevToolsEngine.open({ cwd: dir });
  } finally {
    process.stderr.write = write;
  }
  try {
    assert.equal(engine.db, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /persistence error/);
    await engine.startSession();
    await engine.waitForRuntime();
  } finally {
    await engine.close();
  }
});
