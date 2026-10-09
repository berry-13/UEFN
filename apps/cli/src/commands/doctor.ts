import { runDoctor, type CheckStatus } from "@uefn-devtools/core";
import { loadTests } from "@uefn-devtools/test";
import { str, UsageError, type Command } from "../shared.ts";

const SYMBOL: Record<CheckStatus, string> = { pass: "✓", fail: "✗", warn: "!", skip: "-" };

export const doctor: Command = {
  name: "doctor",
  usage: "doctor",
  summary: "Check the environment, config, tests and adapter setup",
  async run(values) {
    const adapter = str(values, "adapter");
    if (adapter !== undefined && adapter !== "simulated" && adapter !== "mcp") {
      throw new UsageError(`unknown adapter '${adapter}'`);
    }
    const configPath = str(values, "config");
    const report = await runDoctor(undefined, {
      loadTests,
      ...(configPath ? { configPath } : {}),
      ...(adapter ? { adapter } : {}),
    });
    if (values.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      for (const c of report.checks) {
        const [first = "", ...rest] = c.detail.split("\n");
        console.log(`${SYMBOL[c.status]} ${c.title}${first ? `: ${first}` : ""}`);
        for (const line of rest) console.log(`    ${line}`);
        if (c.fix && c.status !== "pass") console.log(`    fix: ${c.fix}`);
      }
      const s = report.summary;
      console.log(`\n${s.pass} passed, ${s.warn} warning(s), ${s.fail} failed, ${s.skip} skipped`);
    }
    return report.ok ? 0 : 1;
  },
};
