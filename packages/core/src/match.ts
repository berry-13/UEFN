/** Deep partial match: every key in `expected` must equal the value in `actual`. */
export function matches(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected) || looseNumberEqual(actual, expected);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matches(actual[i], e));
  }
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(expected).every(([k, v]) => matches((actual as Record<string, unknown>)[k], v));
}

/** Team ids arrive as strings in references and as numbers in payloads. */
function looseNumberEqual(a: unknown, b: unknown): boolean {
  return (typeof a === "number" && typeof b === "string" && String(a) === b) ||
    (typeof a === "string" && typeof b === "number" && a === String(b));
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
