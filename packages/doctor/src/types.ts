import type { DevToolsConfig, Project, RecordingSummary, RunSummary } from "@uefn-devtools/protocol";
import type { VerseFile } from "./verse.ts";

export type Severity = "error" | "warning" | "info";

export const CATEGORIES = ["verse", "devices", "performance", "assets", "tests", "publish", "devtools"] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  verse: "Verse",
  devices: "Devices",
  performance: "Performance",
  assets: "Assets",
  tests: "Tests",
  publish: "Publish readiness",
  devtools: "DevTools setup",
};

export interface Finding {
  ruleId: string;
  category: Category;
  severity: Severity;
  message: string;
  /** Project-relative path. */
  file?: string;
  line?: number;
  /** Extra lines shown under the message (spec §27 example layout). */
  detail?: string[];
  /** True when the rule is a structural heuristic rather than a certainty. */
  heuristic?: boolean;
}

export interface ProjectContext {
  root: string;
  config: DevToolsConfig;
  project: Project;
  verse: VerseFile[];
  tests: { count: number; errors: { file: string; message: string }[] };
  lastRun?: RunSummary;
  recordings: RecordingSummary[];
}

/** Spec §27. Rules are pure functions of the context. */
export interface Rule {
  id: string;
  category: Category;
  severity: Severity;
  title: string;
  description: string;
  heuristic?: boolean;
  evaluate(context: ProjectContext): Finding[];
}

export interface CategoryScore {
  category: Category;
  label: string;
  /** 0..100, or null when DevTools cannot assess the category yet. */
  score: number | null;
  reason?: string;
}

export interface DoctorReport {
  scores: CategoryScore[];
  counts: Record<Severity, number>;
  findings: Finding[];
  rules: { id: string; title: string; category: Category; severity: Severity | "off" }[];
  failOn: Severity | "never";
  failed: boolean;
}
