import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { GitInfo, RuntimeEvent } from "@uefn-devtools/protocol";
import { RuntimeEvent as RuntimeEventSchema } from "@uefn-devtools/protocol";
import type { DevToolsEngine } from "./engine.ts";

export const RECORDING_EXTENSION = ".uefnrec.json";
export const RECORDINGS_DIR = ".devtools/recordings";

/** A captured stretch of a session: metadata plus the observed events. */
export interface Recording {
  version: 1;
  name: string;
  /** Wall-clock ISO time the recording began. */
  recordedAt: string;
  /** Adapter named in the config at record time (`simulated`, `mcp`). */
  adapter: string;
  session?: { id: string; projectId: string; adapter: string; startedAt: number };
  git?: GitInfo;
  /** Session-clock milliseconds at the start and end of the recording. */
  startedAt: number;
  endedAt: number;
  events: RuntimeEvent[];
}

export interface RecorderOptions {
  name: string;
}

/**
 * Captures the engine's events from a start mark until stopped. Pure
 * observation: it never sends commands, so it works for a human playing the
 * game as well as for a script driving the simulator.
 */
export class Recorder {
  private startIndex?: number;
  private startedAt = 0;
  private recordedAt = "";

  constructor(
    private readonly engine: DevToolsEngine,
    private readonly options: RecorderOptions,
  ) {}

  get recording(): boolean {
    return this.startIndex !== undefined;
  }

  /** Events captured so far. */
  get eventCount(): number {
    return this.startIndex === undefined ? 0 : this.engine.events.size - this.startIndex;
  }

  start(): void {
    if (this.startIndex !== undefined) throw new Error("recorder already started");
    this.startIndex = this.engine.events.mark();
    this.startedAt = this.engine.now();
    this.recordedAt = new Date().toISOString();
  }

  stop(): Recording {
    if (this.startIndex === undefined) throw new Error("recorder was not started");
    const session = this.engine.session;
    const recording: Recording = {
      version: 1,
      name: this.options.name,
      recordedAt: this.recordedAt,
      adapter: this.engine.adapter.name,
      ...(session ? { session: { id: session.id, projectId: session.projectId, adapter: session.adapter, startedAt: session.startedAt } } : {}),
      ...(session?.git ? { git: session.git } : {}),
      startedAt: this.startedAt,
      endedAt: this.engine.now(),
      events: [...this.engine.events.all(this.startIndex)],
    };
    this.startIndex = undefined;
    return recording;
  }
}

export function recordingPath(root: string, name: string): string {
  return resolve(root, RECORDINGS_DIR, `${name}${RECORDING_EXTENSION}`);
}

export async function saveRecording(recording: Recording, file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(recording, null, 2) + "\n");
}

export async function loadRecording(file: string): Promise<Recording> {
  const data = JSON.parse(await readFile(file, "utf8")) as Partial<Recording>;
  if (data.version !== 1 || !Array.isArray(data.events) || typeof data.name !== "string") {
    throw new Error(`${file} is not a DevTools recording (expected version 1 with events)`);
  }
  return { ...(data as Recording), events: data.events.map((e) => RuntimeEventSchema.parse(e)) };
}
