import assert from "node:assert/strict";
import { test } from "node:test";
import { extractDiagnostics } from "@uefn-devtools/uefn";

// From a real UEFN 41.10 editor log: each error is printed twice, the second time with `) :`.
const FILE = "C:/Users/Berry/Documents/Fortnite Projects/EscapeTheTsunami_CARS/Content/GameManager.verse";
const MSG = "This invocation calls a function that has the 'no_rollback' effect";
const REAL_BUILD_OUTPUT = [
  `[2026.07.05-22.00.52:275][714]VerseBuild: Error: ${FILE}(1111,55, 1111,83): Script error 3512: ${MSG}`,
  `[2026.07.05-22.00.52:275][714]VerseBuild: Error: ${FILE}(1111,55, 1111,83) : Script error 3512: ${MSG}`,
  "[2026.07.05-19.44.56:449][236]LogSolLoadCompiler: Display: Global Verse compile (incremental, 2 packages compiled in 4553.0 ms) finished: FAILED.",
].join("\r\n");

test("parses and de-duplicates real VerseBuild errors", () => {
  const diagnostics = extractDiagnostics({ text: REAL_BUILD_OUTPUT, isError: false });
  assert.deepEqual(diagnostics, [{ severity: "error", message: MSG, file: FILE, line: 1111, column: 55, code: "3512" }]);
});

test("still parses the bare file.verse(l,c): error form", () => {
  const diagnostics = extractDiagnostics({ text: "Verse/a.verse(3,7): warning W1: unused", isError: false });
  assert.deepEqual(diagnostics, [{ severity: "warning", message: "unused", file: "Verse/a.verse", line: 3, column: 7, code: "W1" }]);
});

// Returned by VerseToolset.BuildAll on a live UEFN 42.30 editor (2026-10-09).
const LIVE_BUILD_ALL = {
  returnValue: [
    {
      severity: "Error",
      code: 3588,
      message: "Ambiguous identifier; could be (/invaliddomain/TestMCPClaude/DevTools/devtools_poc_device:)DevTools or (/invaliddomain/TestMCPClaude:)DevTools",
      filePath: "/7dd9d4e3-39d1-429a-bcaf-b001382f57f0/DevTools/devtools_poc_device.verse",
      span: { startLine: 8, startCharacter: 8, endLine: 8, endCharacter: 16 },
    },
  ],
};

test("parses live BuildAll structured diagnostics with 1-indexed positions", () => {
  const diagnostics = extractDiagnostics({ text: JSON.stringify(LIVE_BUILD_ALL), json: LIVE_BUILD_ALL, isError: false });
  assert.deepEqual(diagnostics, [
    {
      severity: "error",
      message: LIVE_BUILD_ALL.returnValue[0]!.message,
      file: "/7dd9d4e3-39d1-429a-bcaf-b001382f57f0/DevTools/devtools_poc_device.verse",
      line: 9,
      column: 9,
      code: "3588",
    },
  ]);
});

test("an empty live BuildAll result is a clean build", () => {
  assert.deepEqual(extractDiagnostics({ text: '{"returnValue":[]}', json: { returnValue: [] }, isError: false }), []);
});

test("live session status values map correctly", async () => {
  const { sessionStatusFrom } = await import("@uefn-devtools/uefn");
  const as = (v: string) => sessionStatusFrom({ text: JSON.stringify({ returnValue: v }), json: { returnValue: v } });
  assert.equal(as("Disconnected"), "none");
  assert.equal(as("Connecting"), "starting");
  assert.equal(as("Reconnecting"), "starting");
  assert.equal(as("UpdatingContent"), "starting");
  assert.equal(as("Connected"), "connected");
});
