import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isDaemonProcess } from "../src/commands/daemon.ts";

test("a live pid that cannot be identified is not declared gone", () => {
  // No /proc (Windows, macOS): a running process might be the daemon.
  assert.equal(isDaemonProcess(process.pid, "/nonexistent-proc"), undefined);
  assert.equal(isDaemonProcess(2 ** 30, "/nonexistent-proc"), false);
});

test("with /proc, the command line decides", async () => {
  const proc = await mkdtemp(join(tmpdir(), "uefn-proc-"));
  await mkdir(join(proc, "100"));
  await writeFile(join(proc, "100", "cmdline"), ["node", "main.js", "daemon", "start"].join("\0"));
  await mkdir(join(proc, "200"));
  await writeFile(join(proc, "200", "cmdline"), ["node", "other.js"].join("\0"));
  assert.equal(isDaemonProcess(100, proc), true);
  assert.equal(isDaemonProcess(200, proc), false);
  assert.equal(isDaemonProcess(300, proc), false);
});
