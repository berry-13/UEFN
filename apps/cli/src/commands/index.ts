import type { Command } from "../shared.ts";
import { capabilities } from "./capabilities.ts";
import { ci } from "./ci.ts";
import { compile } from "./compile.ts";
import { history } from "./history.ts";
import { init } from "./init.ts";
import { mcp } from "./mcp.ts";
import { status } from "./status.ts";
import { test } from "./test.ts";
import { trace } from "./trace.ts";

/** Help order. Add new commands here. */
export const commands: Command[] = [status, capabilities, compile, test, trace, history, mcp, init, ci];
