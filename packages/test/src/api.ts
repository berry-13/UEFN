import { globalState, type TestBody, type TestOptions } from "./context.ts";
import { slugify } from "./names.ts";

function register(name: string, body: TestBody, options: TestOptions, flags: { skip?: boolean; only?: boolean }): void {
  const file = globalState.loadingFile;
  if (!file) throw new Error(`test("${name}") must be declared at the top level of a test file loaded by the runner`);
  globalState.registry.push({ id: slugify(name), name, file, format: "typescript", body, options, ...flags });
}

type TestFn = {
  (name: string, body: TestBody): void;
  (name: string, options: TestOptions, body: TestBody): void;
  skip(name: string, body: TestBody): void;
  only(name: string, body: TestBody): void;
};

function overload(flags: { skip?: boolean; only?: boolean }) {
  return (name: string, a: TestBody | TestOptions, b?: TestBody) => {
    if (typeof a === "function") register(name, a, {}, flags);
    else if (b) register(name, b, a, flags);
    else throw new TypeError(`test("${name}") is missing its body`);
  };
}

/** Declares a gameplay test. Mirrors the Playwright shape (spec §7.1). */
export const test: TestFn = Object.assign(overload({}) as TestFn, {
  skip: (name: string, body: TestBody) => register(name, body, {}, { skip: true }),
  only: (name: string, body: TestBody) => register(name, body, {}, { only: true }),
});
