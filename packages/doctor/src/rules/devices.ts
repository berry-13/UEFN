import type { Finding, Rule } from "../types.ts";
import { blocksContaining, enclosingFunction } from "../verse.ts";

export const unusedEditable: Rule = {
  id: "UEFN-D201",
  category: "devices",
  severity: "warning",
  heuristic: true,
  title: "Editable device reference is never used",
  description: "An @editable field nothing reads is either dead wiring or a reference the code forgot to use.",
  evaluate(ctx) {
    const counts = new Map<string, number>();
    for (const f of ctx.verse) {
      for (const l of f.lines) {
        for (const m of l.code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
      }
    }
    const out: Finding[] = [];
    for (const f of ctx.verse) {
      for (let i = 0; i < f.lines.length; i++) {
        const l = f.lines[i]!;
        if (!/@editable\b/.test(l.code)) continue;
        // The field is on the same line or the next non-empty line.
        let decl = l.code.replace(/@editable(\s*\{[^}]*\})?/, "").trim();
        let declLine = l.number;
        if (!decl) {
          const next = f.lines.slice(i + 1).find((n) => n.code.trim() !== "");
          if (!next) continue;
          decl = next.code.trim();
          declLine = next.number;
        }
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)*\s*:\s*([A-Za-z_][A-Za-z0-9_.]*)/.exec(decl);
        if (!m) continue;
        const [, name, type] = m;
        if ((counts.get(name!) ?? 0) > 1) continue;
        out.push({
          ruleId: this.id,
          category: this.category,
          severity: this.severity,
          heuristic: true,
          message: `@editable ${name}: ${type} is never referenced`,
          file: f.path,
          line: declLine,
          detail: [type!.endsWith("_device") ? "Device reference is wired in the editor but unused by Verse." : "Editable value is unused."],
        });
      }
    }
    return out;
  },
};

export const getPlayersInLoop: Rule = {
  id: "UEFN-P301",
  category: "performance",
  severity: "info",
  heuristic: true,
  title: "GetPlayers called inside a loop",
  description: "Re-querying the player list on every iteration costs time on large islands; cache it or react to join/leave events.",
  evaluate(ctx) {
    const out: Finding[] = [];
    for (const f of ctx.verse) {
      for (const l of f.lines) {
        if (!/\bGetPlayers\s*\(/.test(l.code)) continue;
        const loop = blocksContaining(f, l.number).find((b) => b.kind === "loop");
        if (!loop) continue;
        const fn = enclosingFunction(f, l.number);
        out.push({
          ruleId: this.id,
          category: this.category,
          severity: this.severity,
          heuristic: true,
          message: `GetPlayers() called on every iteration of the loop in ${fn ? `${fn.name}()` : "this file"}`,
          file: f.path,
          line: l.number,
        });
      }
    }
    return out;
  },
};

export const highFrequencyPolling: Rule = {
  id: "UEFN-P302",
  category: "performance",
  severity: "warning",
  heuristic: true,
  title: "High-frequency polling loop",
  description: "A loop that sleeps less than 0.1s polls ten or more times per second; an event subscription is usually cheaper.",
  evaluate(ctx) {
    const out: Finding[] = [];
    for (const f of ctx.verse) {
      for (const l of f.lines) {
        const m = /\bSleep\s*\(\s*([0-9]*\.?[0-9]+)\s*\)/.exec(l.code);
        if (!m || Number(m[1]) >= 0.1) continue;
        if (!blocksContaining(f, l.number).some((b) => b.kind === "loop")) continue;
        out.push({
          ruleId: this.id,
          category: this.category,
          severity: this.severity,
          heuristic: true,
          message: `Loop polls every ${m[1]}s${Number(m[1]) === 0 ? " (every frame)" : ""}`,
          file: f.path,
          line: l.number,
          detail: ["If this waits for a state change, subscribe to the corresponding event instead."],
        });
      }
    }
    return out;
  },
};
