import { z } from "zod";

export const Vector3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vector3 = z.infer<typeof Vector3>;

export const Project = z.object({
  name: z.string(),
  root: z.string(),
  /** Path of the `.uefnproject` file, when one was found. */
  projectFile: z.string().optional(),
  verseFiles: z.array(z.string()),
  testFiles: z.array(z.string()),
});
export type Project = z.infer<typeof Project>;

export const DiagnosticSeverity = z.enum(["error", "warning", "info"]);

export const Diagnostic = z.object({
  severity: DiagnosticSeverity,
  message: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
  code: z.string().optional(),
});
export type Diagnostic = z.infer<typeof Diagnostic>;

export const CompileResult = z.object({
  success: z.boolean(),
  durationMs: z.number(),
  diagnostics: z.array(Diagnostic),
  /** Unparsed adapter output, kept for failure artifacts. */
  raw: z.string().optional(),
});
export type CompileResult = z.infer<typeof CompileResult>;

export const DeviceInfo = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string().optional(),
  location: Vector3.optional(),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;
