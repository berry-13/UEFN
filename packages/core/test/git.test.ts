import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureGitInfo, changedFiles, parsePorcelainZ } from "@uefn-devtools/core";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });

test("parsePorcelainZ keeps leading characters and both sides of a rename", () => {
  assert.deepEqual(parsePorcelainZ(" M Verse/game.verse\0R  new.verse\0old.verse\0?? a b.verse\0"), [
    "Verse/game.verse",
    "new.verse",
    "old.verse",
    "a b.verse",
  ]);
  assert.deepEqual(parsePorcelainZ(""), []);
});

test("git status paths survive modified, untracked, spaced, renamed and deleted files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-devtools-git-"));
  try {
    sh(dir, "init", "-q");
    await mkdir(join(dir, "Verse"));
    for (const f of ["Verse/game.verse", "Verse/old name.verse", "Verse/gone.verse"]) await writeFile(join(dir, f), "x\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-q", "-m", "init");
    await writeFile(join(dir, "Verse/game.verse"), "changed\n");
    await mkdir(join(dir, "NewDir/Sub"), { recursive: true });
    await writeFile(join(dir, "NewDir/Sub/fresh.verse"), "y\n");
    await rename(join(dir, "Verse/old name.verse"), join(dir, "Verse/renamed name.verse"));
    sh(dir, "add", "Verse/renamed name.verse", "Verse/old name.verse");
    await rm(join(dir, "Verse/gone.verse"));

    const info = await captureGitInfo(dir);
    assert.equal(info?.dirty, true);
    assert.deepEqual([...info!.changedFiles].sort(), [
      "NewDir/Sub/fresh.verse",
      "Verse/game.verse",
      "Verse/gone.verse",
      "Verse/old name.verse",
      "Verse/renamed name.verse",
    ]);
    assert.deepEqual([...(await changedFiles(dir))].sort(), [...info!.changedFiles].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
