import type { DevToolsConfig } from "@uefn-devtools/protocol";

export type Permission = "read_project" | "compile" | "run_tests" | "start_sessions" | "modify_project";
export type PermissionSet = Record<Permission, boolean>;

const PRESETS: Record<DevToolsConfig["mcp_server"]["mode"], PermissionSet> = {
  read_only: { read_project: true, compile: false, run_tests: false, start_sessions: false, modify_project: false },
  development: { read_project: true, compile: true, run_tests: true, start_sessions: true, modify_project: false },
  full_access: { read_project: true, compile: true, run_tests: true, start_sessions: true, modify_project: true },
};

/** Mode preset (spec §60) with explicit per-scope overrides applied on top. */
export function resolvePermissions(
  settings: DevToolsConfig["mcp_server"],
  modeOverride?: DevToolsConfig["mcp_server"]["mode"],
): PermissionSet {
  const base = { ...PRESETS[modeOverride ?? settings.mode] };
  if (modeOverride) return base;
  for (const [key, value] of Object.entries(settings.permissions)) {
    if (typeof value === "boolean") base[key as Permission] = value;
  }
  return base;
}
