import type { Command } from "../shared.ts";
import { capabilities } from "./capabilities.ts";
import { compile } from "./compile.ts";
import { init } from "./init.ts";
import { mcp } from "./mcp.ts";
import { status } from "./status.ts";
import { test } from "./test.ts";
import { trace } from "./trace.ts";

/** Help order. Add new commands here. */
export const commands: Command[] = [status, capabilities, compile, test, trace, mcp, init];
