/**
 * Normalises event names so `CaptureCompleted`, `capture.completed` and
 * `PlayerEnteredArea` / `player.entered_area` are interchangeable.
 */
export function normalizeEventType(name: string): string {
  if (name.includes(".") || !/[A-Z]/.test(name)) return name;
  const words = name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+/g);
  if (!words || words.length < 2) return name.toLowerCase();
  const [first, ...rest] = words.map((w) => w.toLowerCase());
  return `${first}.${rest.join("_")}`;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "test";
}

export function playerId(id: string | number): string {
  return typeof id === "number" ? `player${id}` : id;
}
