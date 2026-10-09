import { readFile } from "node:fs/promises";
import { EventStore, formatCausalTree } from "@uefn-devtools/core";
import { RuntimeEvent } from "@uefn-devtools/protocol";
import { openEngine, print, str, UsageError, type Command } from "../shared.ts";

export const trace: Command = {
  name: "trace",
  usage: "trace <event-id>",
  summary: "Causal tree of an event from a recorded events.jsonl or stored session",
  options: { file: { type: "string" }, session: { type: "string" } },
  optionHelp: [
    "--file <events.jsonl>  Recorded events (from .devtools/results/...)",
    "--session <id>         Session id from the SQLite store (see 'uefn history --sessions')",
  ],
  async run(values, positionals) {
    const id = positionals[0];
    const file = str(values, "file");
    const sessionId = str(values, "session");
    if (!id || (!file && !sessionId)) {
      throw new UsageError("usage: uefn trace <event-id> (--file <events.jsonl> | --session <id>)");
    }
    let store = new EventStore();
    let source = file ?? "";
    if (file) {
      const lines = (await readFile(file, "utf8")).split("\n").filter((l) => l.trim());
      for (const line of lines) store.append(RuntimeEvent.parse(JSON.parse(line)));
    } else {
      const engine = await openEngine(values);
      try {
        if (!engine.db) throw new UsageError("persistence is disabled (persistence.enabled: false)");
        if (!engine.db.getSession(sessionId!)) throw new UsageError(`session '${sessionId}' not found`);
        store = engine.db.loadEventStore(sessionId!);
        source = `session ${sessionId}`;
      } finally {
        await engine.close();
      }
    }
    const tree = store.causalTree(id);
    if (!tree) {
      console.error(`event '${id}' not found in ${source}`);
      return 2;
    }
    print(values, tree, () => console.log(formatCausalTree(tree)));
    return 0;
  },
};
