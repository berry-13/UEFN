import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { loadConfig } from "@uefn-devtools/core";
import { formatReport, runDoctor, scanVerse } from "@uefn-devtools/doctor";

const ROUND_MANAGER = `using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }

round_manager := class(creative_device):
    @editable
    Spawner : player_spawner_device = player_spawner_device{}

    @editable
    UnusedTimer : timer_device = timer_device{}

    var RoundsPlayed : int = 0
    var Score : int = 0

    OnBegin<override>()<suspends>:void =
        Initialize()
        Spawner.SpawnedEvent.Subscribe(OnPlayerSpawned)

    Initialize():void =
        Spawner.SpawnedEvent.Subscribe(OnPlayerSpawned)
        set RoundsPlayed += 1

    OnRoundStarted():void =
        Spawner.SpawnedEvent.Subscribe(OnPlayerSpawned)

    OnPlayerSpawned(Agent:agent):void =
        set Score += 10
        Print("Score: {Score}")

    Tick()<suspends>:void =
        loop:
            Players := GetPlayspace().GetPlayers()
            Sleep(0.0)

    Busy()<suspends>:void =
        loop:
            Compute()
            spawn{ Worker() }

    Compute():void = {}
    Worker()<suspends>:void = {}
`;

const CLEAN = `# A file that must produce no findings, full of traps.
<# block comment mentioning loop: and Subscribe(X) #>
clean_device := class(creative_device):
    @editable
    Button : button_device = button_device{}

    var Presses : int = 0

    OnBegin<override>()<suspends>:void =
        Button.InteractedWithEvent.Subscribe(OnPressed)  # "loop:" in a comment
        Print("# not a comment, and not loop:")
        loop:
            Sleep(1.0)
            if (Presses > 10):
                break

    OnPressed(Agent:agent):void =
        set Presses += 1
        Print("Pressed {Presses} times")

    Kept():void =
        # The cancelable is kept, so this is not UEFN-V105.
        Cancel := Button.InteractedWithEvent.Subscribe(OnKept)
        # devtools-ignore UEFN-V105
        Button.InteractedWithEvent.Subscribe(OnOther)

    OnKept(Agent:agent):void = {}
    OnOther(Agent:agent):void = {}
`;

async function project(files: Record<string, string>, config = "") {
  const dir = await mkdtemp(join(tmpdir(), "uefn-doctor-"));
  await writeFile(join(dir, "uefn-devtools.config.yaml"), config);
  await mkdir(join(dir, "Verse"));
  await mkdir(join(dir, "Tests"));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return dir;
}

test("scanner strips comments and strings but keeps interpolation", () => {
  const f = scanVerse("x.verse", CLEAN);
  const code = f.lines.map((l) => l.code).join("\n");
  assert.ok(!code.includes("block comment"));
  assert.ok(!code.includes("not a comment"));
  assert.match(code, /\(Presses\)/);
  assert.deepEqual(f.blocks.map((b) => b.kind), ["loop"]);
  assert.deepEqual(f.functions.map((fn) => fn.name), ["OnBegin", "OnPressed", "Kept", "OnKept", "OnOther"]);
});

test("finds the spec's duplicate subscription and the other issues", async () => {
  const dir = await project({ "Verse/round_manager.verse": ROUND_MANAGER });
  const report = await runDoctor(await loadConfig(dir));
  const ids = report.findings.map((f) => `${f.ruleId}@${f.line ?? ""}`);
  assert.ok(ids.includes("UEFN-V104@23"), ids.join(" "));
  const dup = report.findings.find((f) => f.ruleId === "UEFN-V104")!;
  assert.match(dup.detail!.join("\n"), /Subscribed from: OnBegin\(\) \(line 16\), Initialize\(\) \(line 19\), OnRoundStarted\(\) \(line 23\)/);
  for (const id of ["UEFN-V105@19", "UEFN-V105@23", "UEFN-D201@9", "UEFN-P301@31", "UEFN-P302@32", "UEFN-V102@35", "UEFN-V106@37", "UEFN-V103@11", "UEFN-T401@", "UEFN-S501@"]) {
    assert.ok(ids.includes(id), `missing ${id} in ${ids.join(" ")}`);
  }
  // Score is read through interpolation; the editable spawner is used.
  assert.ok(!ids.some((i) => i.startsWith("UEFN-V103@12")));
  assert.ok(!ids.includes("UEFN-D201@6"));
  // Loop with Sleep(0.0) yields, so it is not a "no suspension" loop.
  assert.ok(!ids.includes("UEFN-V102@30"));
  assert.equal(report.failed, false, "warnings do not fail at the default fail_on: error");
  const text = formatReport(report);
  assert.match(text, /UEFN PROJECT HEALTH/);
  assert.match(text, /Assets\s+n\/a/);
});

test("a clean file stays clean; suppressions and config overrides apply", async () => {
  const dir = await project(
    { "Verse/clean.verse": CLEAN, "Tests/a.test.yaml": "name: A\nassert:\n  - team: { id: 1, score: 0 }\n" },
    "doctor:\n  rules:\n    UEFN-S501: off\n",
  );
  const report = await runDoctor(await loadConfig(dir));
  assert.deepEqual(report.findings.map((f) => `${f.ruleId}@${f.line}`), []);
  assert.equal(report.scores.find((s) => s.category === "verse")?.score, 100);
});

test("broken tests and incomplete mcp setup are errors and fail the run", async () => {
  const dir = await project(
    { "Tests/bad.test.yaml": "name: Bad\nsteps:\n  - fly: {}\n" },
    "adapter: mcp\ndoctor:\n  severity:\n    fail_on: error\n",
  );
  const report = await runDoctor(await loadConfig(dir));
  const ids = new Set(report.findings.map((f) => f.ruleId));
  assert.ok(ids.has("UEFN-T402") && ids.has("UEFN-S503") && ids.has("UEFN-S501"));
  assert.equal(report.findings.find((f) => f.ruleId === "UEFN-S501")?.severity, "warning", "runtime matters for the mcp adapter");
  assert.equal(report.failed, true);
  assert.ok(report.counts.error >= 3);
});

test("using the runtime without installing it is an error", async () => {
  const dir = await project({
    "Verse/uses.verse": "d := class(creative_device):\n    DevTools:devtools_emitter = devtools_emitter{}\n",
  });
  const f = (await runDoctor(await loadConfig(dir))).findings.find((x) => x.ruleId === "UEFN-S501")!;
  assert.equal(f.severity, "error");
  assert.equal(f.line, 2);
});

test("the example project ships an unmodified copy of the runtime", async () => {
  const root = new URL("../../../", import.meta.url);
  const [canonical, example] = await Promise.all([
    readFile(new URL("runtime/verse/devtools.verse", root), "utf8"),
    readFile(new URL("examples/capture-point/Verse/devtools.verse", root), "utf8"),
  ]);
  assert.equal(example, canonical, "re-copy runtime/verse/devtools.verse into examples/capture-point/Verse/");
});

test("the example project is healthy", async () => {
  const report = await runDoctor(await loadConfig(new URL("../../../examples/capture-point/", import.meta.url).pathname));
  assert.deepEqual(report.findings.map((f) => f.ruleId), []);
});
