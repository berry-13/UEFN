import { readFile } from "node:fs/promises";
import { parseAllDocuments } from "yaml";
import { z } from "zod";
import type { TestBody, TestDefinition } from "./context.ts";
import { expect } from "./expect.ts";
import type { GameFixture } from "./fixtures.ts";
import { slugify } from "./names.ts";

const Duration = z.union([z.number(), z.string()]);
const Payload = z.record(z.string(), z.unknown());

const StepSchema = z.union([
  z.enum(["start_game", "end_game"]),
  z.object({ start_game: z.null() }).strict(),
  z.object({ end_game: z.null() }).strict(),
  z.object({ spawn_player: z.object({ id: z.union([z.string(), z.number()]), team: z.number().int().optional() }) }).strict(),
  z.object({ teleport: z.object({ player: z.union([z.string(), z.number()]), location: z.string() }) }).strict(),
  z.object({ enter: z.object({ player: z.union([z.string(), z.number()]), area: z.string() }) }).strict(),
  z.object({ leave: z.object({ player: z.union([z.string(), z.number()]), area: z.string() }) }).strict(),
  z.object({ eliminate: z.object({ player: z.union([z.string(), z.number()]), by: z.string().optional() }) }).strict(),
  z.object({ damage: z.object({ player: z.union([z.string(), z.number()]), amount: z.number() }) }).strict(),
  z.object({ enable_device: z.object({ id: z.string() }) }).strict(),
  z.object({ disable_device: z.object({ id: z.string() }) }).strict(),
  z.object({ wait: Duration }).strict(),
  z.object({ wait_for: z.object({ event: z.string(), match: Payload.optional(), timeout: Duration.optional() }) }).strict(),
]);
type Step = z.infer<typeof StepSchema>;

const AssertSchema = z.union([
  z.object({
    device: z.object({
      id: z.string(),
      state: z.string().optional(),
      owner: z.number().int().nullable().optional(),
      enabled: z.boolean().optional(),
      trigger_count: z.number().int().optional(),
    }),
  }).strict(),
  z.object({ team: z.object({ id: z.number().int(), score: z.number() }) }).strict(),
  z.object({
    player: z.object({
      id: z.union([z.string(), z.number()]),
      health: z.number().optional(),
      shield: z.number().optional(),
      alive: z.boolean().optional(),
      team: z.number().int().optional(),
      in_area: z.string().optional(),
    }),
  }).strict(),
  z.object({
    event: z.object({ type: z.string(), match: Payload.optional(), times: z.number().int().nonnegative().optional() }),
  }).strict(),
  z.object({ probe: z.object({ id: z.string(), value: z.unknown() }) }).strict(),
]);
type Assertion = z.infer<typeof AssertSchema>;

export const YamlTestSchema = z.object({
  name: z.string(),
  id: z.string().optional(),
  timeout: Duration.optional(),
  tags: z.array(z.string()).optional(),
  skip: z.boolean().optional(),
  setup: z.array(StepSchema).default([]),
  steps: z.array(StepSchema).default([]),
  assert: z.array(AssertSchema).default([]),
});
export type YamlTest = z.infer<typeof YamlTestSchema>;

async function runStep(game: GameFixture, step: Step): Promise<void> {
  if (step === "start_game" || (typeof step === "object" && "start_game" in step)) return game.start();
  if (step === "end_game" || (typeof step === "object" && "end_game" in step)) return game.end();
  if ("spawn_player" in step) {
    const { id, team } = step.spawn_player;
    await game.player(id, team !== undefined ? { team } : {}).spawn();
    return;
  }
  if ("teleport" in step) return game.player(step.teleport.player).teleport(step.teleport.location);
  if ("enter" in step) return game.player(step.enter.player).enter(step.enter.area);
  if ("leave" in step) return game.player(step.leave.player).leave(step.leave.area);
  if ("eliminate" in step) return game.player(step.eliminate.player).eliminate(step.eliminate.by ? { by: step.eliminate.by } : {});
  if ("damage" in step) return game.player(step.damage.player).damage(step.damage.amount);
  if ("enable_device" in step) return game.device(step.enable_device.id).enable();
  if ("disable_device" in step) return game.device(step.disable_device.id).disable();
  if ("wait" in step) return game.wait(step.wait);
  if ("wait_for" in step) {
    const { event, match, timeout } = step.wait_for;
    await game.waitForEvent(event, match, timeout !== undefined ? { timeout } : {});
    return;
  }
  const never: never = step;
  throw new Error(`unknown step ${JSON.stringify(never)}`);
}

async function runAssertion(game: GameFixture, a: Assertion): Promise<void> {
  if ("device" in a) {
    const { id, state, owner, enabled, trigger_count } = a.device;
    const d = game.device(id);
    if (state !== undefined) await expect(d).toHaveState(state);
    if (owner !== undefined) await expect(d).toHaveOwner(owner);
    if (enabled === true) await expect(d).toBeEnabled();
    if (enabled === false) await expect(d).toBeDisabled();
    if (trigger_count !== undefined) await expect(d).toHaveTriggerCount(trigger_count);
  } else if ("team" in a) {
    await expect(game.team(a.team.id)).toHaveScore(a.team.score);
  } else if ("player" in a) {
    const { id, health, shield, alive, team, in_area } = a.player;
    const p = game.player(id);
    if (health !== undefined) await expect(p).toHaveHealth(health);
    if (shield !== undefined) await expect(p).toHaveShield(shield);
    if (alive === true) await expect(p).toBeAlive();
    if (alive === false) await expect(p).toBeEliminated();
    if (team !== undefined) await expect(p).toBeOnTeam(team);
    if (in_area !== undefined) await expect(p).toBeInArea(in_area);
  } else if ("event" in a) {
    const { type, match, times } = a.event;
    await expect(game.events).toHaveOccurred(type, match, times !== undefined ? { times } : {});
  } else {
    await expect(game.probe(a.probe.id)).toHaveValue(a.probe.value);
  }
}

export function yamlToDefinition(doc: YamlTest, file: string): TestDefinition {
  const body: TestBody = async ({ game }) => {
    for (const step of doc.setup) await runStep(game, step);
    for (const step of doc.steps) await runStep(game, step);
  };
  const finalAssertions: TestBody = async ({ game }) => {
    for (const a of doc.assert) await runAssertion(game, a);
  };
  return {
    id: doc.id ?? slugify(doc.name),
    name: doc.name,
    file,
    format: "yaml",
    body,
    finalAssertions,
    options: {
      ...(doc.timeout !== undefined ? { timeout: doc.timeout } : {}),
      ...(doc.tags ? { tags: doc.tags } : {}),
    },
    ...(doc.skip ? { skip: true } : {}),
  };
}

/** Loads every YAML document in `file` as a test. Throws with all validation issues. */
export async function loadYamlTests(file: string): Promise<TestDefinition[]> {
  const docs = parseAllDocuments(await readFile(file, "utf8"));
  const out: TestDefinition[] = [];
  for (const [i, doc] of docs.entries()) {
    if (doc.errors.length > 0) throw new Error(`${file} (document ${i + 1}): ${doc.errors[0]!.message}`);
    const result = YamlTestSchema.safeParse(doc.toJS());
    if (!result.success) {
      const issues = result.error.issues.map((x) => `  ${x.path.join(".")}: ${x.message}`).join("\n");
      throw new Error(`${file} (document ${i + 1}) is not a valid test:\n${issues}`);
    }
    out.push(yamlToDefinition(result.data, file));
  }
  return out;
}
