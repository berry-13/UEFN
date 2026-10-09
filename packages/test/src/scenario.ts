import { readFile } from "node:fs/promises";
import { parseDuration, type Vector3 } from "@uefn-devtools/protocol";
import { parseAllDocuments } from "yaml";
import { findTestFiles } from "./discover.ts";
import { playerId, slugify } from "./names.ts";
import { YamlTestSchema, type Step, type YamlTest } from "./yaml.ts";

/**
 * Turns a YAML test's player actions into a Verse device that performs them
 * inside a real UEFN match (the "scenario device" of docs/capabilities.md).
 * UEFN's MCP tools start and stop matches but cannot act on players, so the
 * device does it with `fort_character` APIs and reports each step through
 * the DevTools emitter; the host waits for those reports
 * (`ScenarioTransport`). Waits run in the device too; `wait_for` does not
 * (the device cannot see DevTools events), so put a `wait` before an action
 * that must follow an outcome.
 */

export interface ScenarioOptions {
  /** Named world positions for teleport / enter / leave. */
  locations: Record<string, Vector3>;
  /** Delay after the match starts before the first step. */
  startDelayMs: number;
  /** Test id, used for the class and file names. */
  id: string;
}

/** One step the device performs and confirms with a `scenario.step` event. */
export interface ScenarioPlanStep {
  index: number;
  /** The runtime command the host sends for this step. */
  action: "spawn_player" | "teleport" | "leave_area" | "damage_player" | "eliminate_player";
  player: string;
  description: string;
}

export interface GeneratedScenario {
  className: string;
  fileName: string;
  verse: string;
  plan: ScenarioPlanStep[];
  warnings: string[];
}

export class ScenarioError extends Error {}

/** Distance a `leave` step moves the player away from the area, in Unreal units. */
const LEAVE_OFFSET = 2000;
/** Damage large enough to eliminate any default character. */
const ELIMINATE_DAMAGE = 100000;
/** Scenario events use their own sequence range (see `SeqStart` in devtools.verse). */
const SEQ_START = 1_000_000;

export function scenarioClassName(id: string): string {
  return `devtools_scenario_${id.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "test"}`;
}

/** A Verse string literal: braces interpolate in Verse, so they are escaped too. */
function verseString(value: string): string {
  return `"${value.replace(/[\\"{}]/g, (c) => `\\${c}`).replace(/\r?\n/g, " ")}"`;
}

function verseFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

function verseVector([x, y, z]: Vector3): string {
  return `vector3{X := ${verseFloat(x)}, Y := ${verseFloat(y)}, Z := ${verseFloat(z)}}`;
}

export function generateScenario(test: YamlTest, options: ScenarioOptions): GeneratedScenario {
  const className = scenarioClassName(options.id);
  const players = new Map<string, number>();
  const plan: ScenarioPlanStep[] = [];
  const warnings: string[] = [];
  const body: string[] = [];

  const slot = (id: string | number): { name: string; index: number } => {
    const name = playerId(id);
    let index = players.get(name);
    if (index === undefined) {
      index = players.size;
      players.set(name, index);
    }
    return { name, index };
  };
  const location = (name: string, step: string): Vector3 => {
    const found = options.locations[name];
    if (!found) {
      throw new ScenarioError(`${step}: no position for '${name}'; add it under scenario.locations in the config`);
    }
    return found;
  };
  const confirm = (action: ScenarioPlanStep["action"], player: string, description: string, indent: string): string[] => {
    const index = plan.length;
    plan.push({ index, action, player, description });
    return [`${indent}Step(${index}, ${verseString(action)}, ${verseString(player)})`];
  };
  const withCharacter = (index: number, step: number, lines: string[]): string[] => [
    `        if (Character := CharacterAt[${index}]):`,
    ...lines,
    `        else:`,
    `            Fail(${step}, "player ${index + 1} has no character")`,
    `            return`,
  ];
  const moveTo = (player: { name: string; index: number }, position: Vector3, action: ScenarioPlanStep["action"], description: string) => {
    const step = plan.length;
    body.push(`        # ${step}: ${description}`);
    body.push(
      ...withCharacter(player.index, step, [
        `            if (Character.TeleportTo[${verseVector(position)}, IdentityRotation()]):`,
        `                Emitter.Emit("player.moved", array{DevToolsString("player", ${verseString(player.name)}), DevToolsVector("position", Character.GetTransform().Translation)})`,
        ...confirm(action, player.name, description, "                "),
        `            else:`,
        `                Fail(${step}, "teleport refused")`,
        `                return`,
      ]),
    );
  };
  const damage = (player: { name: string; index: number }, amount: number, action: ScenarioPlanStep["action"], description: string) => {
    const step = plan.length;
    body.push(`        # ${step}: ${description}`);
    body.push(
      ...withCharacter(player.index, step, [
        `            Character.Damage(${verseFloat(amount)})`,
        `            ReportHealth(${verseString(player.name)}, Character)`,
        ...confirm(action, player.name, description, "            "),
      ]),
    );
  };

  for (const s of [...test.setup, ...test.steps] as Step[]) {
    if (s === "start_game" || s === "end_game" || (typeof s === "object" && ("start_game" in s || "end_game" in s))) {
      // The host starts and ends matches over MCP; the device runs inside the match.
      continue;
    }
    if ("spawn_player" in s) {
      const p = slot(s.spawn_player.id);
      if (s.spawn_player.team !== undefined) warnings.push(`spawn_player ${p.name}: team ${s.spawn_player.team} is not enforced; players join by island settings`);
      const step = plan.length;
      const description = `${p.name} is player ${p.index + 1}`;
      body.push(`        # ${step}: ${description}`);
      body.push(
        ...withCharacter(p.index, step, [
          `            Emitter.Emit("player.spawned", array{DevToolsString("player", ${verseString(p.name)}), DevToolsVector("position", Character.GetTransform().Translation)})`,
          ...confirm("spawn_player", p.name, description, "            "),
        ]),
      );
    } else if ("teleport" in s) {
      const p = slot(s.teleport.player);
      moveTo(p, location(s.teleport.location, "teleport"), "teleport", `teleport ${p.name} to ${s.teleport.location}`);
    } else if ("enter" in s) {
      const p = slot(s.enter.player);
      moveTo(p, location(s.enter.area, "enter"), "teleport", `${p.name} enters ${s.enter.area}`);
    } else if ("leave" in s) {
      const p = slot(s.leave.player);
      const [x, y, z] = location(s.leave.area, "leave");
      moveTo(p, [x + LEAVE_OFFSET, y, z], "leave_area", `${p.name} leaves ${s.leave.area}`);
    } else if ("damage" in s) {
      const p = slot(s.damage.player);
      damage(p, s.damage.amount, "damage_player", `damage ${p.name} by ${s.damage.amount}`);
    } else if ("eliminate" in s) {
      const p = slot(s.eliminate.player);
      if (s.eliminate.by) warnings.push(`eliminate ${p.name}: 'by ${s.eliminate.by}' is not attributed; the damage has no instigator`);
      damage(p, ELIMINATE_DAMAGE, "eliminate_player", `eliminate ${p.name}`);
    } else if ("wait" in s) {
      const seconds = parseDuration(s.wait) / 1000;
      body.push(`        Sleep(${verseFloat(seconds)})`);
    } else if ("wait_for" in s) {
      warnings.push(`wait_for ${s.wait_for.event}: the device does not wait for it; add a 'wait' if the next action depends on it`);
    } else if ("enable_device" in s || "disable_device" in s) {
      throw new ScenarioError("enable_device / disable_device are not supported in scenarios yet (no generic device API in Verse)");
    }
  }
  if (plan.length === 0) throw new ScenarioError(`test '${options.id}' has no player actions to run in a scenario`);

  const verse = [
    `# Generated by \`uefn scenario ${options.id}\` from "${test.name.replace(/\r?\n/g, " ")}". Do not edit; regenerate instead.`,
    `# Place one ${className} device in the level. It needs devtools.verse (runtime/verse).`,
    `using { /Fortnite.com/Characters }`,
    `using { /Fortnite.com/Devices }`,
    `using { /Fortnite.com/Game }`,
    `using { /UnrealEngine.com/Temporary/SpatialMath }`,
    `using { /Verse.org/Simulation }`,
    ``,
    `${className} := class(creative_device):`,
    `    Emitter:devtools_emitter = devtools_emitter{SeqStart := ${SEQ_START}}`,
    ``,
    `    OnBegin<override>()<suspends>:void =`,
    `        Emitter.Hello()`,
    `        Sleep(${verseFloat(options.startDelayMs / 1000)})`,
    `        Emitter.Emit("scenario.started", array{DevToolsInt("steps", ${plan.length})})`,
    ...body,
    `        Emitter.Emit("scenario.completed", array{DevToolsInt("steps", ${plan.length})})`,
    ``,
    `    CharacterAt(Index:int)<decides><transacts>:fort_character =`,
    `        GetPlayspace().GetPlayers()[Index].GetFortCharacter[]`,
    ``,
    `    Step(Index:int, Action:string, Player:string)<transacts>:void =`,
    `        Emitter.Emit("scenario.step", array{DevToolsInt("index", Index), DevToolsString("action", Action), DevToolsString("player", Player)})`,
    ``,
    `    Fail(Index:int, Reason:string)<transacts>:void =`,
    `        Emitter.Emit("scenario.failed", array{DevToolsInt("index", Index), DevToolsString("reason", Reason)})`,
    ``,
    `    ReportHealth(Player:string, Character:fort_character)<transacts>:void =`,
    `        Emitter.Emit("player.state_changed", array{DevToolsString("player", Player), DevToolsFloat("health", Character.GetHealth()), DevToolsFloat("shield", Character.GetShield())})`,
    ``,
  ].join("\n");

  return { className, fileName: `${className}.verse`, verse, plan, warnings };
}

/** Finds a YAML test by id. YAML files are only parsed; no project code runs. */
export async function findYamlTest(testsDir: string, id: string): Promise<{ test: YamlTest; file: string } | undefined> {
  const files = (await findTestFiles(testsDir)).filter((f) => /\.ya?ml$/.test(f));
  for (const file of files) {
    for (const doc of parseAllDocuments(await readFile(file, "utf8"))) {
      const parsed = YamlTestSchema.safeParse(doc.toJS());
      if (parsed.success && (parsed.data.id ?? slugify(parsed.data.name)) === id) return { test: parsed.data, file };
    }
  }
  return undefined;
}
