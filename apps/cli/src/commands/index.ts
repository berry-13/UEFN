import type { Command } from "../shared.ts";
import { deps } from "./deps.ts";
import { doctor } from "./doctor.ts";

/** Help order. Add new commands here. */
export const commands: Command[] = [doctor, deps];
