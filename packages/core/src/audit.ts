import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface AuditEntry {
  actor: string;
  action: string;
  detail?: Record<string, unknown>;
  outcome?: "ok" | "denied" | "error";
}

/** Append-only JSONL audit trail of agent actions (spec §61). */
export class AuditLog {
  constructor(private readonly path: string) {}

  async record(entry: AuditEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  }
}
