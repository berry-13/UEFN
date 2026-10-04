import { expect, test } from "@uefn-devtools/test";

test("capturing A awards 50 points", async ({ game }) => {
  const player = game.player("player1", { team: 1 });

  await game.start();
  await player.enter("CapturePointA");

  await expect(game.device("CapturePointA")).toHaveState("Captured");
  await expect(game.team(1)).toHaveScore(50);
});

test("contested point does not award score", async ({ game }) => {
  const attacker = game.player("attacker", { team: 1 });
  const defender = game.player("defender", { team: 2 });

  await game.start();
  await attacker.enter("CapturePointA");
  await defender.enter("CapturePointA");

  await expect(game.device("CapturePointA")).toHaveState("Contested");
  await game.wait("6s");
  await expect(game.team(1)).toHaveScore(0);
  await expect(game.events).toHaveOccurred("CaptureCompleted", undefined, { times: 0 });
});

test("eliminated attacker stops the capture", async ({ game }) => {
  const attacker = game.player("attacker", { team: 1 });

  await game.start();
  await attacker.enter("CapturePointB");
  await expect(game.device("CapturePointB")).toHaveState("Capturing");

  await attacker.eliminate();

  await expect(game.device("CapturePointB")).toHaveState("Neutral");
  await expect(game.team(1)).toHaveScore(0);
});

test("capture completes within the configured time", async ({ game }) => {
  await game.start();
  const completed = game.event("CaptureCompleted", { device: "CapturePointA" });
  await game.player("player1", { team: 1 }).enter("CapturePointA");

  await expect(completed).toOccurWithin("6s");
});
