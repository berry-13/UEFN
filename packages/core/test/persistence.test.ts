import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DevToolsDatabase, DevToolsEngine, EventStore, SCHEMA_VERSION } from "@uefn-devtools/core";
import type { RunSummary, RuntimeEvent, Session, TestResult } from "@uefn-devtools/protocol";

const session: Session = {
  id: "s1",
  projectId: "Demo",
  status: "connected",
  startedAt: 1000,
  adapter: "simulated",
  gitCommit: "abc1234",
  git: { commit: "abc1234", branch: "main", dirty: false, changedFiles: [] },
};

const events: RuntimeEvent[] = [
  { id: "e1", timestamp: 0, type: "game.started", payload: {} },
  { id: "e2", timestamp: 10, type: "player.entered_area", source: { type: "player", id: "p1" }, target: { type: "device", id: "A" }, traceId: "t1", payload: { player: "p1", device: "A" } },
  { id: "e3", timestamp: 20, type: "capture.started", parentEventId: "e2", traceId: "t1", payload: { device: "A", team: 1 } },
  { id: "e4", timestamp: 30, type: "capture.completed", parentEventId: "e3", traceId: "t1", payload: { device: "A", team: 1 } },
  { id: "e5", timestamp: 31, type: "score.changed", parentEventId: "e4", traceId: "t1", payload: { team: 1, current: 50 } },
];

function testResult(id: string, status: TestResult["status"], passed: number, failed: number): TestResult {
  return { id, name: id, file: "t.ts", status, attempts: [], passed, failed, reliability: passed / Math.max(1, passed + failed), correlations: [] };
}

function run(runId: string, startedAt: number, tests: TestResult[]): RunSummary {
  const ok = tests.every((t) => t.status === "passed");
  return { runId, status: ok ? "passed" : "failed", startedAt, durationMs: 1234, tests, sessionId: "s1" };
}

async function withDb(fn: (db: DevToolsDatabase, path: string) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "uefn-db-"));
  const path = join(dir, "nested", "devtools.db");
  const db = new DevToolsDatabase(path);
  try {
    await fn(db, path);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("a fresh database migrates to the latest schema and reopens idempotently", async () => {
  await withDb((db, path) => {
    assert.equal(db.schemaVersion(), SCHEMA_VERSION);
    db.close();
    const again = new DevToolsDatabase(path);
    assert.equal(again.schemaVersion(), SCHEMA_VERSION);
    again.close();
  });
});

test("events persist across a simulated session and reload into an EventStore", async () => {
  await withDb((db, path) => {
    db.upsertSession(session);
    for (const e of events) db.queueEvent("s1", e);
    db.upsertSession({ ...session, status: "stopped", endedAt: 5000 });
    db.close();

    const reopened = new DevToolsDatabase(path);
    const s = reopened.getSession("s1");
    assert.equal(s?.status, "stopped");
    assert.equal(s?.endedAt, 5000);
    assert.equal(s?.git?.branch, "main");
    assert.equal(reopened.listSessions().length, 1);

    assert.deepEqual(reopened.eventsForSession("s1"), events);
    assert.deepEqual(reopened.eventsForSession("s1", { type: "capture.started" }).map((e) => e.id), ["e3"]);
    assert.deepEqual(reopened.eventsForSession("s1", { fromIndex: 3, limit: 1 }).map((e) => e.id), ["e4"]);

    const live = new EventStore();
    for (const e of events) live.append(e);
    const loaded = reopened.loadEventStore("s1");
    assert.equal(loaded.size, events.length);
    assert.deepEqual(loaded.causalTree("e5"), live.causalTree("e5"));
    reopened.close();
  });
});

test("run history and per-test history report flakiness", async () => {
  await withDb((db) => {
    db.recordRun(run("r1", 1, [testResult("a", "passed", 1, 0), testResult("b", "passed", 3, 0)]), { gitCommit: "c1" });
    db.recordRun(run("r2", 2, [testResult("a", "failed", 0, 1), testResult("b", "failed", 2, 1)]), { gitCommit: "c2" });
    db.recordRun(run("r3", 3, [testResult("a", "passed", 1, 0), testResult("b", "passed", 3, 0)]), { gitCommit: "c3" });

    const runs = db.listRuns();
    assert.deepEqual(runs.map((r) => r.runId), ["r3", "r2", "r1"]);
    assert.equal(runs[1]?.testsFailed, 2);
    assert.equal(runs[1]?.gitCommit, "c2");
    assert.equal(db.getRun("r2")?.tests.length, 2);
    assert.equal(db.getRun("missing"), undefined);

    const a = db.testHistory("a");
    assert.equal(a.runs, 3);
    assert.equal(a.flips, 2);
    assert.equal(a.flakinessRate, 0);
    assert.ok(Math.abs(a.failRate - 1 / 3) < 1e-9);
    const b = db.testHistory("b");
    assert.ok(Math.abs(b.flakinessRate - 1 / 3) < 1e-9);
    assert.deepEqual(b.entries.map((e) => e.gitCommit), ["c3", "c2", "c1"]);

    // Re-recording a run replaces it rather than duplicating.
    db.recordRun(run("r3", 3, [testResult("a", "passed", 1, 0)]));
    assert.equal(db.testHistory("a").runs, 3);
    assert.equal(db.testHistory("b").runs, 2);
  });
});

test("prune removes old sessions, events and runs", async () => {
  await withDb((db) => {
    db.upsertSession(session);
    db.queueEvent("s1", events[0]!);
    db.recordRun(run("r1", 1, [testResult("a", "passed", 1, 0)]));
    assert.deepEqual(db.prune(2000), { sessions: 1, runs: 1 });
    assert.equal(db.listSessions().length, 0);
    assert.equal(db.eventsForSession("s1").length, 0);
    assert.equal(db.testHistory("a").runs, 0);
  });
});

test("concurrent first opens of one fresh database all succeed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-db-concurrent-"));
  try {
    const path = join(dir, "devtools.db");
    const entry = new URL("../dist/index.js", import.meta.url).href;
    const script = `const { DevToolsDatabase } = await import(${JSON.stringify(entry)}); const db = new DevToolsDatabase(${JSON.stringify(path)}); const v = db.schemaVersion(); db.close(); if (v < 1) process.exit(2);`;
    const children = Array.from(
      { length: 8 },
      () =>
        new Promise<void>((resolve, reject) => {
          execFile(process.execPath, ["--input-type=module", "-e", script], (error, _out, stderr) =>
            error ? reject(new Error(stderr || error.message)) : resolve(),
          );
        }),
    );
    await Promise.all(children);
    const db = new DevToolsDatabase(path);
    assert.equal(db.schemaVersion(), SCHEMA_VERSION);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a locked database does not crash the flush timer and events persist once the lock clears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-db-locked-"));
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  const path = join(dir, "devtools.db");
  const writer = new DevToolsDatabase(path, { busyTimeoutMs: 1 });
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const locker = new DatabaseSync(path);
  const reader = new DatabaseSync(path);
  const count = () => Number((reader.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n);
  try {
    writer.upsertSession(session);
    locker.exec("BEGIN IMMEDIATE");
    for (const e of events) writer.queueEvent(session.id, e);
    await new Promise((r) => setTimeout(r, 450)); // several failed timer ticks
    assert.deepEqual(uncaught, []);
    assert.equal(count(), 0);
    locker.exec("COMMIT");
    const deadline = Date.now() + 3000;
    while (count() < events.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(count(), events.length);
    assert.deepEqual(uncaught, []);
    assert.deepEqual(writer.eventsForSession(session.id).map((e) => e.id), events.map((e) => e.id));
  } finally {
    process.off("uncaughtException", onUncaught);
    reader.close();
    locker.close();
    writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a throwing adapter.stopSession still finalises the session and closes the database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-engine-stop-"));
  try {
    await writeFile(join(dir, "uefn-devtools.config.yaml"), "simulated:\n  time_scale: 100\n  boot_ms: 100\n");
    const engine = await DevToolsEngine.open({ cwd: dir });
    await engine.startSession();
    const id = engine.session!.id;
    const realStop = engine.adapter.stopSession.bind(engine.adapter);
    engine.adapter.stopSession = async () => {
      throw new Error("adapter exploded");
    };
    try {
      await assert.rejects(engine.close(), /adapter exploded/);
    } finally {
      await realStop(); // release the simulated session so the process can exit
    }
    const db = new DevToolsDatabase(join(dir, ".devtools", "devtools.db"));
    try {
      const stored = db.getSession(id);
      assert.equal(stored?.status, "stopped");
      assert.ok(stored?.endedAt !== undefined);
    } finally {
      db.close();
    }
    assert.throws(() => engine.db?.getSession(id)); // database was closed
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
