import type { Command } from "../shared.ts";
import { capabilities } from "./capabilities.ts";
import { ci } from "./ci.ts";
import { compile } from "./compile.ts";
import { daemon } from "./daemon.ts";
import { deps } from "./deps.ts";
import { doctor } from "./doctor.ts";
import { history } from "./history.ts";
import { init } from "./init.ts";
import { list } from "./list.ts";
import { mcp } from "./mcp.ts";
import { record } from "./record.ts";
import { profile } from "./profile.ts";
import { status } from "./status.ts";
import { test } from "./test.ts";
import { trace } from "./trace.ts";
import { ui } from "./ui.ts";

/** Help order. Add new commands here. */
export const commands: Command[] = [status, doctor, capabilities, compile, list, test, profile, trace, deps, record, history, daemon, ui, mcp, init, ci];
