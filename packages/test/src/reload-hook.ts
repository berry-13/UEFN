/**
 * Module resolve hook (runs on Node's loader thread). Appends the current
 * reload generation to every project-local module URL, so that bumping the
 * generation makes the next import load the whole local module graph fresh
 * (tests and the helpers they import). node_modules and DevTools' own
 * packages are left alone.
 */
interface HookData {
  generation: SharedArrayBuffer;
  exclude: string[];
}

let generation: Int32Array | undefined;
let exclude: string[] = [];

export async function initialize(data: HookData): Promise<void> {
  generation = new Int32Array(data.generation);
  exclude = data.exclude;
}

type Resolved = { url: string; format?: string | null; shortCircuit?: boolean };
type NextResolve = (specifier: string, context: unknown) => Promise<Resolved>;

export async function resolve(specifier: string, context: unknown, next: NextResolve): Promise<Resolved> {
  const result = await next(specifier, context);
  if (!generation || !result.url.startsWith("file:")) return result;
  const url = new URL(result.url);
  if (url.pathname.includes("/node_modules/") || exclude.some((prefix) => result.url.startsWith(prefix))) return result;
  url.searchParams.set("devtools-gen", String(Atomics.load(generation, 0)));
  return { ...result, url: url.href };
}
