import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { GitInfo, RunSummary, RuntimeEvent, Session, TestResult } from "@uefn-devtools/protocol";
import { EventStore } from "./event-store.ts";

type Row = Record<string, unknown>;

/**
 * Loads `node:sqlite` lazily. Node 22.x prints an ExperimentalWarning on
 * first load; only that one warning is dropped, and only while loading, so
 * stderr stays clean. Every other warning passes through untouched.
 */
function loadSqlite(): typeof import("node:sqlite") {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    const type = typeof rest[0] === "string" ? rest[0] : (warning as Error).name;
    if (type === "ExperimentalWarning" && /sqlite/i.test(text)) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}

/** Forward-only migrations; append, never edit. `schema_version` holds every applied version. */
const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  build_revision TEXT,
  git_commit TEXT,
  git_json TEXT,
  adapter TEXT NOT NULL
);
CREATE INDEX sessions_started_at ON sessions (started_at);
CREATE TABLE events (
  session_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  id TEXT NOT NULL,
  timestamp REAL NOT NULL,
  type TEXT NOT NULL,
  source_type TEXT,
  source_id TEXT,
  target_type TEXT,
  target_id TEXT,
  trace_id TEXT,
  parent_event_id TEXT,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, idx)
) WITHOUT ROWID;
CREATE INDEX events_type ON events (type);
CREATE INDEX events_trace ON events (trace_id);
CREATE INDEX events_session_id ON events (session_id, id);
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  duration_ms REAL NOT NULL,
  failed_stage TEXT,
  error TEXT,
  session_id TEXT,
  git_commit TEXT,
  git_branch TEXT,
  artifact_dir TEXT,
  tests_total INTEGER NOT NULL,
  tests_failed INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX runs_started_at ON runs (started_at);
CREATE TABLE test_results (
  run_id TEXT NOT NULL,
  test_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reliability REAL NOT NULL,
  passed INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (run_id, test_id)
) WITHOUT ROWID;
CREATE INDEX test_results_test ON test_results (test_id);
`,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export interface RunRow {
  runId: string;
  status: RunSummary["status"];
  startedAt: number;
  durationMs: number;
  failedStage?: string;
  error?: string;
  sessionId?: string;
  gitCommit?: string;
  gitBranch?: string;
  artifactDir?: string;
  testsTotal: number;
  testsFailed: number;
}

export interface TestHistoryEntry {
  runId: string;
  startedAt: number;
  status: TestResult["status"];
  reliability: number;
  passed: number;
  failed: number;
  gitCommit?: string;
}

export interface TestHistory {
  testId: string;
  /** Newest first. */
  entries: TestHistoryEntry[];
  runs: number;
  /** Runs where the test failed or errored, 0..1. */
  failRate: number;
  /** Runs whose attempts both passed and failed (0 < reliability < 1), 0..1. */
  flakinessRate: number;
  /** Pass/fail status changes between consecutive runs. */
  flips: number;
}

export interface SessionEventQuery {
  type?: string | string[];
  limit?: number;
  /** Per-session event index (0 = first persisted event). */
  fromIndex?: number;
}

export interface RecordRunContext {
  gitCommit?: string;
  gitBranch?: string;
}

const FLUSH_INTERVAL_MS = 100;

/** SQLite sink and query layer for sessions, events and runs (docs/persistence.md). */
export class DevToolsDatabase {
  private readonly db: DatabaseSync;
  private buffer: { sessionId: string; event: RuntimeEvent }[] = [];
  private timer?: NodeJS.Timeout;
  private closed = false;
  private warnedFlush = false;

  /** `path` may be `:memory:`. */
  constructor(
    readonly path: string,
    options: { busyTimeoutMs?: number } = {},
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new (loadSqlite().DatabaseSync)(path);
    // busy_timeout first so the WAL switch and migrations wait for other processes instead of failing.
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))};`);
    this.enableWal(options.busyTimeoutMs ?? 5000);
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  /** The journal mode switch can fail with SQLITE_BUSY without consulting busy_timeout, so retry it here. */
  private enableWal(timeoutMs: number): void {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        this.db.exec("PRAGMA journal_mode = WAL;");
        return;
      } catch (error) {
        if (Date.now() >= deadline || !/locked|busy/i.test(error instanceof Error ? error.message : String(error))) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.floor(Math.random() * 15));
      }
    }
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at INTEGER NOT NULL)");
    for (const m of MIGRATIONS) {
      if (m.version <= this.schemaVersion()) continue;
      this.transaction(() => {
        // Another process may have applied it while we waited for the write lock.
        if (m.version <= this.schemaVersion()) return;
        this.db.exec(m.sql);
        this.db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(m.version, Date.now());
      });
    }
  }

  schemaVersion(): number {
    const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // No transaction left open (the failing statement already ended it).
      }
      throw error;
    }
  }

  // Writes

  /**
   * Adapters may reuse ids across processes (the simulator always yields
   * `sim-session-1`). Returns `id` unless a different session already owns it,
   * in which case a start-time suffix keeps sessions apart.
   */
  uniqueSessionId(id: string, startedAt: number): string {
    // Check and reserve in one write transaction so two processes cannot claim the same id.
    return this.transaction(() => {
      const find = this.db.prepare("SELECT started_at FROM sessions WHERE id = ?");
      let candidate = id;
      for (let n = 0; ; n++) {
        const row = find.get(candidate) as { started_at: number } | undefined;
        if (row && row.started_at === startedAt) return candidate;
        if (!row) {
          // Placeholder row; upsertSession fills in the real fields.
          this.db
            .prepare("INSERT INTO sessions (id, project_id, status, started_at, adapter) VALUES (?, '', 'connected', ?, '')")
            .run(candidate, startedAt);
          return candidate;
        }
        candidate = `${id}-${startedAt.toString(36)}${n === 0 ? "" : `-${n}`}`;
      }
    });
  }

  /** Inserts or updates the session row (status, endedAt). */
  upsertSession(s: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, status, started_at, ended_at, build_revision, git_commit, git_json, adapter)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id, adapter = excluded.adapter, status = excluded.status, ended_at = excluded.ended_at,
           build_revision = excluded.build_revision, git_commit = excluded.git_commit, git_json = excluded.git_json`,
      )
      .run(
        s.id,
        s.projectId,
        s.status,
        s.startedAt,
        s.endedAt ?? null,
        s.buildRevision ?? null,
        s.gitCommit ?? null,
        s.git ? JSON.stringify(s.git) : null,
        s.adapter,
      );
  }

  /** Buffers an event; written in one transaction on the next flush. */
  queueEvent(sessionId: string, event: RuntimeEvent): void {
    if (this.closed) return;
    this.buffer.push({ sessionId, event });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    this.timer ??= setTimeout(() => this.flushFromTimer(), FLUSH_INTERVAL_MS).unref();
  }

  /** Timer path: never throws. A failed batch stays buffered and is retried on the next tick. */
  private flushFromTimer(): void {
    this.timer = undefined;
    try {
      this.flush();
    } catch (error) {
      if (!this.warnedFlush) {
        this.warnedFlush = true;
        process.stderr.write(`uefn-devtools: persistence flush failed, will retry: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      if (!this.closed && this.buffer.length > 0) this.scheduleFlush();
    }
  }

  /**
   * Writes all buffered events. Called on an interval, before every query, on stopSession and on close.
   * On failure the batch goes back to the front of the buffer and the error is rethrown.
   */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    const insert = this.db.prepare(
      `INSERT INTO events (session_id, idx, id, timestamp, type, source_type, source_id, target_type, target_id, trace_id, parent_event_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      this.transaction(() => {
      // Indexes are assigned under the write lock so concurrent writers never overwrite each other.
      const next = new Map<string, number>();
      const maxIdx = this.db.prepare("SELECT COALESCE(MAX(idx), -1) AS m FROM events WHERE session_id = ?");
      for (const { sessionId, event: e } of batch) {
        let idx = next.get(sessionId);
        if (idx === undefined) idx = (maxIdx.get(sessionId) as { m: number }).m + 1;
        next.set(sessionId, idx + 1);
        insert.run(
          sessionId,
          idx,
          e.id,
          e.timestamp,
          e.type,
          e.source?.type ?? null,
          e.source?.id ?? null,
          e.target?.type ?? null,
          e.target?.id ?? null,
          e.traceId ?? null,
          e.parentEventId ?? null,
          JSON.stringify(e.payload),
        );
      }
      });
    } catch (error) {
      this.buffer = batch.concat(this.buffer);
      throw error;
    }
  }

  /** Stores a finished run and its per-test results. Re-recording a run id replaces it. */
  recordRun(summary: RunSummary, context: RecordRunContext = {}): void {
    this.flush();
    this.transaction(() => {
      this.db.prepare("DELETE FROM test_results WHERE run_id = ?").run(summary.runId);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO runs (run_id, status, started_at, duration_ms, failed_stage, error, session_id, git_commit, git_branch, artifact_dir, tests_total, tests_failed, json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          summary.runId,
          summary.status,
          summary.startedAt,
          summary.durationMs,
          summary.failedStage ?? null,
          summary.error ?? null,
          summary.sessionId ?? null,
          context.gitCommit ?? null,
          context.gitBranch ?? null,
          summary.artifactDir ?? null,
          summary.tests.length,
          summary.tests.filter((t) => t.status === "failed" || t.status === "error").length,
          JSON.stringify(summary),
        );
      const insert = this.db.prepare(
        "INSERT OR REPLACE INTO test_results (run_id, test_id, status, reliability, passed, failed, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const t of summary.tests) {
        insert.run(summary.runId, t.id, t.status, t.reliability, t.passed, t.failed, JSON.stringify(t));
      }
    });
  }

  /** Deletes sessions (with their events) and runs that started before `timestamp`. */
  prune(timestamp: number): { sessions: number; runs: number } {
    this.flush();
    return this.transaction(() => {
      this.db.prepare("DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)").run(timestamp);
      const sessions = this.db.prepare("DELETE FROM sessions WHERE started_at < ?").run(timestamp);
      this.db.prepare("DELETE FROM test_results WHERE run_id IN (SELECT run_id FROM runs WHERE started_at < ?)").run(timestamp);
      const runs = this.db.prepare("DELETE FROM runs WHERE started_at < ?").run(timestamp);
      return { sessions: Number(sessions.changes), runs: Number(runs.changes) };
    });
  }

  // Queries

  /** Newest first. */
  listSessions(options: { limit?: number } = {}): Session[] {
    this.flush();
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY started_at DESC, rowid DESC LIMIT ?").all(options.limit ?? 50);
    return (rows as Row[]).map(toSession);
  }

  getSession(id: string): Session | undefined {
    this.flush();
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return row ? toSession(row) : undefined;
  }

  eventsForSession(sessionId: string, query: SessionEventQuery = {}): RuntimeEvent[] {
    this.flush();
    const where = ["session_id = ?", "idx >= ?"];
    const args: (string | number)[] = [sessionId, query.fromIndex ?? 0];
    if (query.type !== undefined) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      where.push(`type IN (${types.map(() => "?").join(",")})`);
      args.push(...types);
    }
    let sql = `SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY idx`;
    if (query.limit !== undefined) {
      sql += " LIMIT ?";
      args.push(query.limit);
    }
    return (this.db.prepare(sql).all(...args) as Row[]).map(toEvent);
  }

  /** Newest first. */
  listRuns(options: { limit?: number } = {}): RunRow[] {
    this.flush();
    const rows = this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?").all(options.limit ?? 20);
    return (rows as Row[]).map(toRunRow);
  }

  getRun(runId: string): RunSummary | undefined {
    this.flush();
    const row = this.db.prepare("SELECT json FROM runs WHERE run_id = ?").get(runId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as RunSummary) : undefined;
  }

  /** Per-run outcomes for one test, newest first, with flakiness statistics. */
  testHistory(testId: string, options: { limit?: number } = {}): TestHistory {
    this.flush();
    const rows = this.db
      .prepare(
        `SELECT t.run_id, r.started_at, t.status, t.reliability, t.passed, t.failed, r.git_commit
         FROM test_results t JOIN runs r ON r.run_id = t.run_id
         WHERE t.test_id = ? ORDER BY r.started_at DESC, r.rowid DESC LIMIT ?`,
      )
      .all(testId, options.limit ?? 50) as Row[];
    const entries: TestHistoryEntry[] = rows.map((r) => ({
      runId: String(r["run_id"]),
      startedAt: Number(r["started_at"]),
      status: r["status"] as TestResult["status"],
      reliability: Number(r["reliability"]),
      passed: Number(r["passed"]),
      failed: Number(r["failed"]),
      ...(r["git_commit"] != null ? { gitCommit: String(r["git_commit"]) } : {}),
    }));
    let flips = 0;
    const decided = entries.filter((e) => e.status !== "skipped");
    for (let i = 1; i < decided.length; i++) {
      if ((decided[i]!.status === "passed") !== (decided[i - 1]!.status === "passed")) flips++;
    }
    const n = entries.length;
    return {
      testId,
      entries,
      runs: n,
      failRate: n === 0 ? 0 : entries.filter((e) => e.status === "failed" || e.status === "error").length / n,
      flakinessRate: n === 0 ? 0 : entries.filter((e) => e.reliability > 0 && e.reliability < 1).length / n,
      flips,
    };
  }

  /** Rebuilds an {@link EventStore} so causalTree, replay and state reducers work on a past session. */
  loadEventStore(sessionId: string): EventStore {
    const store = new EventStore();
    for (const event of this.eventsForSession(sessionId)) store.append(event);
    return store;
  }

  close(): void {
    if (this.closed) return;
    // A busy database may clear within a few attempts; only then give up and say what was lost.
    for (let attempt = 0; attempt < 3 && this.buffer.length > 0; attempt++) {
      try {
        this.flush();
      } catch (error) {
        if (attempt === 2) {
          process.stderr.write(
            `uefn-devtools: persistence close lost ${this.buffer.length} buffered event(s): ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
    }
    try {
      this.buffer = [];
    } finally {
      this.closed = true;
      clearTimeout(this.timer);
      this.timer = undefined;
      this.db.close();
    }
  }
}

function toSession(r: Row): Session {
  return {
    id: String(r["id"]),
    projectId: String(r["project_id"]),
    status: r["status"] as Session["status"],
    startedAt: Number(r["started_at"]),
    ...(r["ended_at"] != null ? { endedAt: Number(r["ended_at"]) } : {}),
    ...(r["build_revision"] != null ? { buildRevision: String(r["build_revision"]) } : {}),
    ...(r["git_commit"] != null ? { gitCommit: String(r["git_commit"]) } : {}),
    ...(r["git_json"] != null ? { git: JSON.parse(String(r["git_json"])) as GitInfo } : {}),
    adapter: String(r["adapter"]),
  };
}

function toEvent(r: Row): RuntimeEvent {
  const ref = (type: unknown, id: unknown) => (id != null ? { type: String(type), id: String(id) } : undefined);
  const source = ref(r["source_type"], r["source_id"]);
  const target = ref(r["target_type"], r["target_id"]);
  return {
    id: String(r["id"]),
    timestamp: Number(r["timestamp"]),
    type: String(r["type"]),
    ...(source ? { source: source as RuntimeEvent["source"] } : {}),
    ...(target ? { target: target as RuntimeEvent["target"] } : {}),
    ...(r["trace_id"] != null ? { traceId: String(r["trace_id"]) } : {}),
    ...(r["parent_event_id"] != null ? { parentEventId: String(r["parent_event_id"]) } : {}),
    payload: JSON.parse(String(r["payload"])) as Record<string, unknown>,
  };
}

function toRunRow(r: Row): RunRow {
  const opt = (key: string, col: string) => (r[col] != null ? { [key]: String(r[col]) } : {});
  return {
    runId: String(r["run_id"]),
    status: r["status"] as RunRow["status"],
    startedAt: Number(r["started_at"]),
    durationMs: Number(r["duration_ms"]),
    ...opt("failedStage", "failed_stage"),
    ...opt("error", "error"),
    ...opt("sessionId", "session_id"),
    ...opt("gitCommit", "git_commit"),
    ...opt("gitBranch", "git_branch"),
    ...opt("artifactDir", "artifact_dir"),
    testsTotal: Number(r["tests_total"]),
    testsFailed: Number(r["tests_failed"]),
  };
}
