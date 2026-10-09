import { createInterface, type Interface } from "node:readline";
import { formatCausalTree, type DevToolsEngine } from "@uefn-devtools/core";
import {
  describeEvent,
  normalizeEventType,
  renderFrame,
  type DebugAction,
  type DebugFailureInfo,
  type DebugHooks,
  type DebugStepInfo,
} from "@uefn-devtools/test";

const HELP = "[Enter] step   c continue   s state   e [type] events   t <event-id> tree   q abort";

export interface TerminalDebugger extends DebugHooks {
  close(): void;
}

/**
 * Readline front end for `uefn test --debug` (docs/debugging.md). The
 * runner pauses on each hook call until this resolves.
 */
export function createTerminalDebugger(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): TerminalDebugger {
  const rl: Interface = createInterface({ input, output, terminal: false });
  const lines: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let closed = false;
  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const w of waiting.splice(0)) w(undefined);
  });
  const say = (text = "") => output.write(text + "\n");
  /** Next input line; `undefined` once input has ended. */
  const ask = (): Promise<string | undefined> => {
    output.write("debug> ");
    if (lines.length) return Promise.resolve(lines.shift());
    if (closed) return Promise.resolve(undefined);
    return new Promise((resolve) => waiting.push(resolve));
  };

  let continuing = false;

  const screen = (engine: DevToolsEngine, startIndex: number) =>
    renderFrame({
      state: engine.state,
      now: engine.now(),
      events: engine.events.all(startIndex),
      title: "Debugger",
      // A pseudo-TTY can report 0 columns.
      width: (output as NodeJS.WriteStream).columns || 80,
    });

  /** Handles inspection commands; returns an action once the user picks one. */
  const prompt = async (engine: DevToolsEngine, startIndex: number): Promise<DebugAction> => {
    for (;;) {
      const raw = await ask();
      if (raw === undefined) {
        say("(input closed, continuing)");
        continuing = true;
        return "continue";
      }
      const [cmd = "", ...args] = raw.trim().split(/\s+/);
      switch (cmd) {
        case "":
        case "n":
          return "step";
        case "c":
          continuing = true;
          return "continue";
        case "q":
          return "abort";
        case "s":
          say(JSON.stringify(engine.state, null, 2));
          break;
        case "e": {
          const type = args[0] ? normalizeEventType(args[0]) : undefined;
          const events = engine.events
            .all(startIndex)
            .filter((e) => (type ? e.type === type : !e.type.startsWith("perf.")))
            .slice(-20);
          if (events.length === 0) say("(no events)");
          for (const e of events) say(`  ${e.id.padEnd(10)} ${(e.timestamp / 1000).toFixed(2).padStart(8)}s  ${describeEvent(e)}`);
          break;
        }
        case "t": {
          const id = args[0];
          const tree = id ? engine.events.causalTree(id) : undefined;
          say(tree ? formatCausalTree(tree) : id ? `event '${id}' not found` : "usage: t <event-id>");
          break;
        }
        default:
          say(HELP);
      }
    }
  };

  return {
    async beforeStep(info: DebugStepInfo): Promise<DebugAction> {
      if (continuing) return "continue";
      say("");
      say(`Paused before step ${info.index + 1} of "${info.test.name}" (${info.test.file})`);
      say(`> ${info.description}`);
      say("");
      say(screen(info.engine, info.startIndex));
      say("");
      say(HELP);
      return prompt(info.engine, info.startIndex);
    },
    async onFailure(info: DebugFailureInfo): Promise<void> {
      say("");
      say(`Test failed during ${info.stage}: "${info.test.name}"`);
      say(`  ${info.error}`);
      if (info.expected !== undefined || info.received !== undefined) {
        say(`  expected: ${JSON.stringify(info.expected)}`);
        say(`  received: ${JSON.stringify(info.received)}`);
      }
      say("");
      say(screen(info.engine, info.startIndex));
      say("");
      say(`${HELP}   (Enter, c or q leaves the failure and runs cleanup)`);
      // The failure pause always stops, even after `c`.
      const wasContinuing = continuing;
      await prompt(info.engine, info.startIndex);
      continuing = wasContinuing || continuing;
    },
    close() {
      rl.close();
    },
  };
}
