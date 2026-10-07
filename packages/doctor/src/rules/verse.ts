import type { Finding, Rule } from "../types.ts";
import { blocksContaining, bodyLines, enclosingFunction, type VerseFile } from "../verse.ts";

const SUSPENSION = /\b(Sleep|Await|NextTick|break|return)\b|\.Await\s*\(|^\s*(race|sync|rush)\s*:/;

function at(file: VerseFile, line: number): { file: string; line: number } {
  return { file: file.path, line };
}

export const mixedIndentation: Rule = {
  id: "UEFN-V101",
  category: "verse",
  severity: "warning",
  title: "Mixed tabs and spaces in indentation",
  description: "Verse blocks are defined by indentation; mixing tabs and spaces makes block structure depend on tab width.",
  evaluate: (ctx) =>
    ctx.verse.flatMap((f) =>
      f.mixedIndent.length
        ? [{
            ruleId: "UEFN-V101",
            category: "verse" as const,
            severity: "warning" as const,
            message: `Indentation mixes tabs and spaces on ${f.mixedIndent.length} line(s)`,
            ...at(f, f.mixedIndent[0]!),
            detail: [`Lines: ${f.mixedIndent.slice(0, 10).join(", ")}${f.mixedIndent.length > 10 ? ", …" : ""}`],
          }]
        : [],
    ),
};

export const loopWithoutSuspension: Rule = {
  id: "UEFN-V102",
  category: "verse",
  severity: "warning",
  heuristic: true,
  title: "loop without a suspension point or exit",
  description: "A `loop:` body with no Sleep/Await/break/return never yields; in a <suspends> context this stalls the island.",
  evaluate(ctx) {
    const out: Finding[] = [];
    for (const f of ctx.verse) {
      for (const b of f.blocks) {
        if (b.kind !== "loop") continue;
        const body = bodyLines(f, b.bodyStart, b.bodyEnd);
        if (body.some((l) => SUSPENSION.test(l.code))) continue;
        // Calling a function that itself suspends is invisible to a structural
        // scan; only flag loops whose body calls nothing that could suspend.
        const calls = body.flatMap((l) => [...l.code.matchAll(/\b([A-Z][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]!));
        const fn = enclosingFunction(f, b.line);
        out.push({
          ruleId: this.id,
          category: this.category,
          severity: this.severity,
          heuristic: true,
          message: `loop in ${fn ? `${fn.name}()` : "this file"} has no Sleep, Await, break or return`,
          ...at(f, b.line),
          detail: [
            calls.length ? `It calls ${[...new Set(calls)].slice(0, 5).join(", ")}; if none of them suspends, the loop never yields.` : "Nothing in the body can suspend.",
            "Potential result: infinite loop that blocks the game thread",
          ],
        });
      }
    }
    return out;
  },
};

interface Declared {
  name: string;
  file: VerseFile;
  line: number;
}

function identifierCounts(files: readonly VerseFile[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of files) {
    for (const l of f.lines) {
      for (const m of l.code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    }
  }
  return counts;
}

export const varNeverRead: Rule = {
  id: "UEFN-V103",
  category: "verse",
  severity: "info",
  heuristic: true,
  title: "Variable written but never read",
  description: "A `var` that is only declared and `set` contributes nothing; usually a leftover or a missing read.",
  evaluate(ctx) {
    const counts = identifierCounts(ctx.verse);
    const declared: Declared[] = [];
    const writes = new Map<string, number>();
    for (const f of ctx.verse) {
      for (const l of f.lines) {
        const d = /^\s*var\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(l.code);
        if (d) declared.push({ name: d[1]!, file: f, line: l.number });
        for (const m of l.code.matchAll(/\bset\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)) writes.set(m[1]!, (writes.get(m[1]!) ?? 0) + 1);
      }
    }
    const out: Finding[] = [];
    for (const d of declared) {
      // `set X += 1` reads X too, but it only feeds X itself.
      const reads = (counts.get(d.name) ?? 0) - 1 - (writes.get(d.name) ?? 0);
      if (reads > 0 || !writes.has(d.name)) continue;
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: this.severity,
        heuristic: true,
        message: `var ${d.name} is written ${writes.get(d.name)}× but never read`,
        ...at(d.file, d.line),
      });
    }
    return out;
  },
};

const SUBSCRIBE = /([A-Za-z_][A-Za-z0-9_.]*?)\.Subscribe\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)/g;

interface Subscription {
  file: VerseFile;
  line: number;
  event: string;
  handler: string;
  fn?: string;
  discarded: boolean;
  inLoop: boolean;
}

function subscriptions(files: readonly VerseFile[]): Subscription[] {
  const out: Subscription[] = [];
  for (const f of files) {
    for (const l of f.lines) {
      for (const m of l.code.matchAll(SUBSCRIBE)) {
        const before = l.code.slice(0, m.index).trim();
        out.push({
          file: f,
          line: l.number,
          event: m[1]!,
          handler: m[2]!,
          ...(enclosingFunction(f, l.number) ? { fn: enclosingFunction(f, l.number)!.name } : {}),
          // `X := E.Subscribe(H)` / `set X = …` keep the cancelable.
          discarded: before === "",
          inLoop: blocksContaining(f, l.number).some((b) => b.kind === "loop" || b.kind === "for"),
        });
      }
    }
  }
  return out;
}

export const duplicateSubscription: Rule = {
  id: "UEFN-V104",
  category: "verse",
  severity: "warning",
  heuristic: true,
  title: "Duplicate event subscription",
  description: "The same handler subscribed to the same event more than once runs once per subscription.",
  evaluate(ctx) {
    const groups = new Map<string, Subscription[]>();
    for (const s of subscriptions(ctx.verse)) {
      const key = `${s.file.path}|${s.event}|${s.handler}`;
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    const out: Finding[] = [];
    for (const list of groups.values()) {
      const inLoop = list.find((s) => s.inLoop);
      if (list.length < 2 && !inLoop) continue;
      const first = list[list.length - 1]!;
      const event = first.event.split(".").pop()!;
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: this.severity,
        heuristic: true,
        message: `Duplicate subscription detected: ${event} → ${first.handler}`,
        ...at(first.file, first.line),
        detail: [
          `Event: ${first.event}`,
          `Subscribed from: ${list.map((s) => `${s.fn ? `${s.fn}()` : "top level"} (line ${s.line})`).join(", ")}`,
          inLoop ? "One subscription is inside a loop and is added again on every iteration." : "",
          "Potential result: handler executes twice",
        ].filter(Boolean),
      });
    }
    return out;
  },
};

export const subscriptionNeverCancelled: Rule = {
  id: "UEFN-V105",
  category: "verse",
  severity: "info",
  heuristic: true,
  title: "Subscription outside OnBegin is never cancelled",
  description: "Subscribing in a function that can run repeatedly (each round, each spawn) without keeping the cancelable accumulates handlers.",
  evaluate(ctx) {
    return subscriptions(ctx.verse)
      .filter((s) => s.discarded && s.fn && s.fn !== "OnBegin")
      .map((s) => ({
        ruleId: this.id,
        category: this.category,
        severity: this.severity,
        heuristic: true,
        message: `${s.event.split(".").pop()} subscription in ${s.fn}() discards its cancelable`,
        ...at(s.file, s.line),
        detail: [`If ${s.fn}() runs more than once, ${s.handler} runs once more each time. Keep the result and call Cancel().`],
      }));
  },
};

export const spawnInLoop: Rule = {
  id: "UEFN-V106",
  category: "verse",
  severity: "warning",
  heuristic: true,
  title: "spawn inside a loop",
  description: "Spawning a task on every iteration without a bound creates an unbounded number of concurrent tasks.",
  evaluate(ctx) {
    const out: Finding[] = [];
    for (const f of ctx.verse) {
      for (const l of f.lines) {
        if (!/\bspawn\s*[:{]/.test(l.code)) continue;
        const loop = blocksContaining(f, l.number).find((b) => b.kind === "loop");
        if (!loop) continue;
        out.push({
          ruleId: this.id,
          category: this.category,
          severity: this.severity,
          heuristic: true,
          message: "spawn inside a loop starts a new task every iteration",
          ...at(f, l.number),
          detail: [`Loop at line ${loop.line}. Unless the loop is bounded, tasks accumulate (spec: unbounded spawn).`],
        });
      }
    }
    return out;
  },
};
