/** Tiny DOM helpers. Everything is built with createElement and textContent, never innerHTML. */

export type Child = Node | string | number | null | undefined | false;
/** Children may be nested arrays; they are flattened in order. */
export type Children = Child | readonly Children[];
type Prop = string | number | boolean | null | undefined | ((event: Event) => void);

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, Prop> = {},
  ...children: Children[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "class") el.className = String(value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: readonly Children[]): void {
  for (const child of (children as unknown[]).flat(Infinity) as Child[]) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

export function replace(parent: Element, ...children: Children[]): void {
  parent.replaceChildren();
  append(parent, children);
}

/** Session-clock milliseconds as seconds, e.g. `12.345 s`. */
export function seconds(ms: number | undefined): string {
  return ms === undefined ? "" : `${(ms / 1000).toFixed(3)} s`;
}

export function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function json(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Compact one-line JSON for table cells. */
export function inline(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function yesNo(value: boolean | undefined): string {
  return value === undefined ? "" : value ? "yes" : "no";
}

/** Calls `fn` at most once per `ms`, always running the last call. */
export function throttle(fn: () => void, ms: number): () => void {
  let timer: number | undefined;
  let last = 0;
  return () => {
    if (timer !== undefined) return;
    const wait = Math.max(0, last + ms - Date.now());
    timer = window.setTimeout(() => {
      timer = undefined;
      last = Date.now();
      fn();
    }, wait);
  };
}
