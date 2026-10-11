import { createHash } from "node:crypto";
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
 *
 * Every scenario event carries the test id (`scenario`), and
 * `scenario.started` carries a fingerprint of the plan (`plan`), so the host
 * can tell two placed devices, or a stale build of one, apart.
 */

export interface ScenarioOptions {
  /** Named world positions for teleport / enter / leave. */
  locations: Record<string, Vector3>;
  /** Delay after the match starts before the first step. */
  startDelayMs: number;
  /** Test id: names the class and file, and tags every scenario event. */
  id: string;
}

/** One step the device performs and confirms with a `scenario.step` event. */
export interface ScenarioPlanStep {
  index: number;
  /** The runtime command the host sends for this step. */
  action: "spawn_player" | "teleport" | "leave_area" | "damage_player" | "eliminate_player";
  player: string;
  /**
   * The command argument the step was generated from (teleport location,
   * left area, damage amount, eliminator), reported as `arg` so the host can
   * reject a device built from an older version of the test.
   */
  arg: string;
  description: string;
}

export interface GeneratedScenario {
  className: string;
  fileName: string;
  verse: string;
  plan: ScenarioPlanStep[];
  /** Short hash of the plan, reported in `scenario.started`. */
  fingerprint: string;
  warnings: string[];
}

export class ScenarioError extends Error {
  /** `no-actions`: the test has no player actions, so it needs no device. */
  constructor(
    message: string,
    readonly kind: "invalid" | "no-actions" = "invalid",
  ) {
    super(message);
  }
}

/**
 * Distance a `leave` step moves the player away from the area, in Unreal
 * units, when scenario.locations has no `<area>.outside` position.
 */
const LEAVE_OFFSET = 2000;
/** Damage large enough to eliminate any default character. */
const ELIMINATE_DAMAGE = 100000;
/** The `arg` of a spawn step the device adds before a teleport / enter of a player that is down. */
export const IMPLICIT_SPAWN = "implicit";
/**
 * Version of what the generator emits. Part of every fingerprint: bump it
 * when generated devices behave differently, so older placed devices are
 * reported as stale even for an unchanged test.
 */
const GENERATOR_VERSION = 2;
/** Scenario events use their own sequence range (see `SeqStart` in devtools.verse). */
const SEQ_START = 1_000_000;

/**
 * Hash of what the device does, so a stale device build is detected. `timing`
 * covers the waits between steps, the start delay and the resolved teleport
 * positions, which change the device's behaviour without changing any step.
 */
export function scenarioFingerprint(plan: readonly ScenarioPlanStep[], timing: readonly string[] = []): string {
  const text = [`generator ${GENERATOR_VERSION}`, ...plan.map((s) => [s.index, s.action, s.player, s.arg].join("\u0000")), ...timing].join("\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** Named positions for teleport / enter / leave: scenario.locations, falling back to simulator device locations. */
export function scenarioLocations(config: {
  simulated: { devices: readonly { id: string; location?: Vector3 | undefined }[] };
  scenario: { locations: Record<string, Vector3> };
}): Record<string, Vector3> {
  const locations: Record<string, Vector3> = {};
  for (const d of config.simulated.devices) if (d.location) locations[d.id] = d.location;
  return Object.assign(locations, config.scenario.locations);
}

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
  const scenarioId = verseString(options.id);
  const players = new Map<string, number>();
  /** Slots whose character the device has captured (at the slot's first step). */
  const bound = new Set<number>();
  /** Players the host considers alive: a teleport / enter of anyone else spawns them first. */
  const live = new Set<string>();
  const plan: ScenarioPlanStep[] = [];
  /** Waits (with the step they precede), the start delay and resolved positions, for the fingerprint. */
  const timing: string[] = [`start_delay ${options.startDelayMs}`];
  const warnings: string[] = [];
  const body: string[] = [];
  let lastLifecycle: "start_game" | "end_game" | undefined;
  let sawStart = false;

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
  const confirm = (action: ScenarioPlanStep["action"], player: string, arg: string, description: string, indent: string): string[] => {
    const index = plan.length;
    plan.push({ index, action, player, arg, description });
    return [`${indent}Step(${index}, ${verseString(action)}, ${verseString(player)}, ${verseString(arg)})`];
  };
  // A slot's player is captured at its first step and reused afterwards, so a
  // player joining or leaving later cannot shift who a step acts on. The
  // character is read from the player at every step, so a respawn after an
  // elimination acts on the new character. Slots are numbered by first
  // appearance, so slot N is always captured after slots 0..N-1 and lands at
  // index N of Players.
  const withCharacter = (index: number, step: number, lines: string[]): string[] => {
    if (bound.has(index)) {
      return [
        `        if (Player := Players[${index}], Character := Player.GetFortCharacter[]):`,
        ...lines,
        `        else:`,
        `            Fail(${step}, "player ${index + 1} has no character (left, or not respawned yet)")`,
        `            return`,
      ];
    }
    bound.add(index);
    return [
      `        if (Player := GetPlayspace().GetPlayers()[${index}], Character := Player.GetFortCharacter[]):`,
      `            set Players += array{Player}`,
      ...lines,
      `        else:`,
      `            Fail(${step}, "player ${index + 1} has no character")`,
      `            return`,
    ];
  };
  const spawn = (p: { name: string; index: number }, description: string, arg = "") => {
    const step = plan.length;
    body.push(`        # ${step}: ${description}`);
    body.push(
      ...withCharacter(p.index, step, [
        `            Emitter.Emit("player.spawned", array{DevToolsString("player", ${verseString(p.name)}), DevToolsVector("position", Character.GetTransform().Translation)})`,
        ...confirm("spawn_player", p.name, arg, description, "            "),
      ]),
    );
    live.add(p.name);
  };
  // The host's teleport / enter spawn a player that is not alive in its
  // observed state (PlayerHandle.ensureSpawned), so the device plans that spawn too.
  const ensureSpawned = (p: { name: string; index: number }, before: string) => {
    // Marked `implicit`: the host sends this spawn only if its observed state
    // still shows the player down, which races with the device's own report.
    if (!live.has(p.name)) spawn(p, `${p.name} is player ${p.index + 1} (implicit spawn before ${before})`, IMPLICIT_SPAWN);
  };
  const moveTo = (player: { name: string; index: number }, position: Vector3, action: ScenarioPlanStep["action"], arg: string, description: string) => {
    const step = plan.length;
    // A location can move without being renamed; the arg only names it.
    timing.push(`position ${position.join(",")} at ${step}`);
    body.push(`        # ${step}: ${description}`);
    body.push(
      ...withCharacter(player.index, step, [
        `            if (Character.TeleportTo[${verseVector(position)}, IdentityRotation()]):`,
        `                Emitter.Emit("player.moved", array{DevToolsString("player", ${verseString(player.name)}), DevToolsVector("position", Character.GetTransform().Translation)})`,
        ...confirm(action, player.name, arg, description, "                "),
        `            else:`,
        `                Fail(${step}, "teleport refused")`,
        `                return`,
      ]),
    );
  };
  const damage = (player: { name: string; index: number }, amount: number, action: ScenarioPlanStep["action"], arg: string, description: string) => {
    const step = plan.length;
    body.push(`        # ${step}: ${description}`);
    body.push(
      ...withCharacter(player.index, step, [
        `            Before := Character.GetHealth() + Character.GetShield()`,
        `            Character.Damage(${verseFloat(amount)})`,
        `            ReportHealth(${verseString(player.name)}, Character)`,
        // Only what the device observes: an elimination is reported when health
        // reads 0, whichever step caused it.
        `            if (Character.GetHealth() <= 0.0):`,
        `                Emitter.Emit("player.eliminated", array{DevToolsString("player", ${verseString(player.name)})})`,
        ...(action === "eliminate_player"
          ? [
              // Damage has no effect on an invulnerable (e.g. sky-spawning) player.
              `            else:`,
              `                Fail(${step}, "player ${player.index + 1} survived the elimination (health above 0; invulnerable or still sky-spawning?)")`,
              `                return`,
            ]
          : [
              // Damage that changed nothing (already down, or invulnerable) did not happen.
              `            if (Character.GetHealth() + Character.GetShield() >= Before):`,
              `                Fail(${step}, "player ${player.index + 1} took no damage (already eliminated, invulnerable or still sky-spawning?)")`,
              `                return`,
            ]),
        ...confirm(action, player.name, arg, description, "            "),
      ]),
    );
  };

  for (const s of [...test.setup, ...test.steps] as Step[]) {
    const lifecycle =
      s === "start_game" || (typeof s === "object" && "start_game" in s)
        ? "start_game"
        : s === "end_game" || (typeof s === "object" && "end_game" in s)
          ? "end_game"
          : undefined;
    if (lifecycle) {
      // The host starts and ends matches over MCP; the device runs inside one
      // match and replays its whole plan on every match start, so a match
      // boundary between player actions would desynchronise host and device.
      if (plan.length > 0) {
        throw new ScenarioError(
          `${lifecycle} after the first player action is not supported: the device replays its whole plan on every match start; split the test at the match boundary`,
        );
      }
      // The device runs in every match: a whole match before the one with the
      // player actions would run the plan there too.
      if (lifecycle === "start_game" && lastLifecycle === "end_game" && sawStart) {
        throw new ScenarioError(
          "a complete match (start_game ... end_game) before the player actions is not supported: the device would run its plan in that match too; split the test at the match boundary",
        );
      }
      if (lifecycle === "start_game") sawStart = true;
      lastLifecycle = lifecycle;
      continue;
    }
    if (typeof s !== "object") continue;
    const isAction = ["spawn_player", "teleport", "enter", "leave", "damage", "eliminate"].some((k) => k in s);
    if (isAction && plan.length === 0 && lastLifecycle !== "start_game") {
      // The device runs when the match begins. If the test does not start the
      // match, the device's reports can predate the test and its observed state.
      throw new ScenarioError(`test '${options.id}' must start_game before its first player action, so the device runs inside the test`);
    }
    if ("spawn_player" in s) {
      const p = slot(s.spawn_player.id);
      if (s.spawn_player.team !== undefined) warnings.push(`spawn_player ${p.name}: team ${s.spawn_player.team} is not enforced; players join by island settings`);
      spawn(p, `${p.name} is player ${p.index + 1}`);
    } else if ("teleport" in s) {
      const p = slot(s.teleport.player);
      const position = location(s.teleport.location, "teleport");
      ensureSpawned(p, "teleport");
      moveTo(p, position, "teleport", s.teleport.location, `teleport ${p.name} to ${s.teleport.location}`);
    } else if ("enter" in s) {
      const p = slot(s.enter.player);
      const position = location(s.enter.area, "enter");
      ensureSpawned(p, "enter");
      moveTo(p, position, "teleport", s.enter.area, `${p.name} enters ${s.enter.area}`);
    } else if ("leave" in s) {
      const p = slot(s.leave.player);
      const outside = options.locations[`${s.leave.area}.outside`];
      let position: Vector3;
      if (outside) {
        position = outside;
      } else {
        const [x, y, z] = location(s.leave.area, "leave");
        position = [x + LEAVE_OFFSET, y, z];
      }
      moveTo(p, position, "leave_area", s.leave.area, `${p.name} leaves ${s.leave.area}`);
    } else if ("damage" in s) {
      const p = slot(s.damage.player);
      damage(p, s.damage.amount, "damage_player", String(s.damage.amount), `damage ${p.name} by ${s.damage.amount}`);
    } else if ("eliminate" in s) {
      const p = slot(s.eliminate.player);
      if (s.eliminate.by) warnings.push(`eliminate ${p.name}: 'by ${s.eliminate.by}' is not attributed; the damage has no instigator`);
      damage(p, ELIMINATE_DAMAGE, "eliminate_player", s.eliminate.by ?? "", `eliminate ${p.name}`);
      live.delete(p.name);
    } else if ("wait" in s) {
      // The device starts with the match: a wait before start_game happens
      // on the host before the device exists, so it is not mirrored.
      if (lastLifecycle !== "start_game") continue;
      const seconds = parseDuration(s.wait) / 1000;
      timing.push(`wait ${seconds} before ${plan.length}`);
      body.push(`        Sleep(${verseFloat(seconds)})`);
    } else if ("wait_for" in s) {
      warnings.push(`wait_for ${s.wait_for.event}: the device does not wait for it; add a 'wait' if the next action depends on it`);
    } else if ("enable_device" in s || "disable_device" in s) {
      throw new ScenarioError("enable_device / disable_device are not supported in scenarios yet (no generic device API in Verse)");
    }
  }
  if (plan.length === 0) throw new ScenarioError(`test '${options.id}' has no player actions to run in a scenario`, "no-actions");
  const fingerprint = scenarioFingerprint(plan, timing);

  const verse = [
    `# Generated by \`uefn scenario ${options.id.replace(/[\r\n`]/g, " ")}\` from "${test.name.replace(/\r?\n/g, " ")}". Do not edit; regenerate instead.`,
    `# Place exactly one ${className} device in the level and no other scenario device. It needs devtools.verse (runtime/verse).`,
    `using { /Fortnite.com/Characters }`,
    `using { /Fortnite.com/Devices }`,
    `using { /Fortnite.com/Game }`,
    `using { /UnrealEngine.com/Temporary/SpatialMath }`,
    `using { /Verse.org/Simulation }`,
    ``,
    `${className} := class(creative_device):`,
    `    Emitter:devtools_emitter = devtools_emitter{SeqStart := ${SEQ_START}}`,
    `    # Players bound to player slots, captured at each slot's first step.`,
    `    var Players:[]player = array{}`,
    ``,
    `    OnBegin<override>()<suspends>:void =`,
    `        Emitter.Hello()`,
    `        Sleep(${verseFloat(options.startDelayMs / 1000)})`,
    `        Emitter.Emit("scenario.started", array{DevToolsString("scenario", ${scenarioId}), DevToolsString("plan", ${verseString(fingerprint)}), DevToolsInt("steps", ${plan.length})})`,
    ...body,
    `        Emitter.Emit("scenario.completed", array{DevToolsString("scenario", ${scenarioId}), DevToolsInt("steps", ${plan.length})})`,
    ``,
    `    Step(Index:int, Action:string, Player:string, Arg:string)<transacts>:void =`,
    `        Emitter.Emit("scenario.step", array{DevToolsString("scenario", ${scenarioId}), DevToolsInt("index", Index), DevToolsString("action", Action), DevToolsString("player", Player), DevToolsString("arg", Arg)})`,
    ``,
    `    Fail(Index:int, Reason:string)<transacts>:void =`,
    `        Emitter.Emit("scenario.failed", array{DevToolsString("scenario", ${scenarioId}), DevToolsInt("index", Index), DevToolsString("reason", Reason)})`,
    ``,
    `    ReportHealth(Player:string, Character:fort_character)<transacts>:void =`,
    `        Emitter.Emit("player.state_changed", array{DevToolsString("player", Player), DevToolsFloat("health", Character.GetHealth()), DevToolsFloat("shield", Character.GetShield())})`,
    ``,
  ].join("\n");

  return { className, fileName: `${className}.verse`, verse, plan, fingerprint, warnings };
}

function rawTestId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { id, name } = raw as { id?: unknown; name?: unknown };
  if (typeof id === "string") return id;
  return typeof name === "string" ? slugify(name) : undefined;
}

/**
 * Finds a YAML test by id. YAML files are only parsed; no project code runs.
 * A file holding the test is validated as a whole, as `loadYamlTests` does,
 * so a scenario is never generated for a test the runner cannot load.
 */
export async function findYamlTest(testsDir: string, id: string): Promise<{ test: YamlTest; file: string } | undefined> {
  const files = (await findTestFiles(testsDir)).filter((f) => /\.ya?ml$/.test(f));
  /** Documents too broken to read an id from: one of them may be the test. */
  const unreadable: string[] = [];
  for (const file of files) {
    const docs = parseAllDocuments(await readFile(file, "utf8"));
    const ids = docs.map((doc) => rawTestId(toJS(doc)));
    for (const [i, doc] of docs.entries()) if (doc.errors.length > 0 && ids[i] === undefined) unreadable.push(`${file} (document ${i + 1}): ${doc.errors[0]!.message}`);
    if (!ids.includes(id)) continue;
    let found: YamlTest | undefined;
    for (const [i, doc] of docs.entries()) {
      if (doc.errors.length > 0) throw new ScenarioError(`${file} (document ${i + 1}): ${doc.errors[0]!.message}`);
      const parsed = YamlTestSchema.safeParse(doc.toJS());
      if (!parsed.success) {
        const issues = parsed.error.issues.map((x) => `  ${x.path.join(".")}: ${x.message}`).join("\n");
        throw new ScenarioError(`${file} (document ${i + 1}) is not a valid test:\n${issues}`);
      }
      if (!found && (parsed.data.id ?? slugify(parsed.data.name)) === id) found = parsed.data;
    }
    if (found) return { test: found, file };
  }
  if (unreadable.length > 0) throw new ScenarioError(`no YAML test with id '${id}', and some YAML could not be parsed:\n  ${unreadable.join("\n  ")}`);
  return undefined;
}

function toJS(doc: { toJS(): unknown }): unknown {
  try {
    return doc.toJS();
  } catch {
    return undefined;
  }
}
