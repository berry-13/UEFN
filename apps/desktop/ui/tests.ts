import type { RunnerStreamEvent, TestsResponse } from "@uefn-devtools/daemon";
import type { AssertionResult, RunSummary, TestAttempt, TestResult } from "@uefn-devtools/protocol";
import { api } from "./api.ts";
import { byId, duration, h, inline, replace, throttle, type Child } from "./dom.ts";
import { table } from "./state-view.ts";

/** Failed attempts shown per test; the rest are summarised. */
const MAX_FAILED_ATTEMPTS = 10;

/** Tests panel: discovery, run controls, live progress from `runner` events and results. */
export class TestsView {
  private tests: TestsResponse["tests"] = [];
  private results = new Map<string, TestResult>();
  private running = false;
  private total = 0;
  private attempts = 0;
  private lastAttemptText = "";

  private readonly list = byId("test-list");
  private readonly resultsBox = byId("results");
  private readonly form = byId<HTMLFormElement>("run-form");
  private readonly repeat = byId<HTMLInputElement>("run-repeat");
  private readonly seed = byId<HTMLInputElement>("run-seed");
  private readonly compile = byId<HTMLInputElement>("run-compile");
  private readonly runAll = byId<HTMLButtonElement>("run-all");
  private readonly progress = byId<HTMLProgressElement>("run-progress");
  private readonly stage = byId("run-stage");
  private readonly live = byId("run-live");
  private readonly error = byId("run-error");
  // Throttled so a long repeat run does not flood screen readers; skipped once the run has finished.
  private readonly announceAttempt = throttle(() => {
    if (this.running) this.live.textContent = this.lastAttemptText;
  }, 1500);

  constructor() {
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.run();
    });
    this.list.addEventListener("click", (e) => {
      const button = (e.target as Element).closest<HTMLButtonElement>("button[data-test-id]");
      if (button) void this.run(button.dataset.testId);
    });
  }

  async load(): Promise<void> {
    try {
      const response = await api.tests();
      this.tests = response.tests;
      this.renderList(response.errors);
    } catch (error) {
      replace(this.list, h("p", { class: "error" }, `Could not list tests: ${(error as Error).message}`));
    }
  }

  private renderList(errors: TestsResponse["errors"] = []): void {
    replace(
      this.list,
      table(
        "Discovered tests",
        ["Test", "File", "Format", "Last result", "Actions"],
        this.tests.map((t) => {
          const result = this.results.get(t.id);
          return [
            t.name,
            h("code", {}, t.file),
            t.format === "typescript" ? "TypeScript" : "YAML",
            result ? statusBadge(result.status, result.attempts.length > 1 ? ` (${pct(result.reliability)} reliable)` : "") : "not run",
            h(
              "button",
              { type: "button", "data-test-id": t.id, "aria-disabled": this.running ? "true" : undefined },
              "Run",
              h("span", { class: "visually-hidden" }, ` ${t.name}`),
            ),
          ];
        }),
        "No tests found under the project's tests directory.",
      ),
      errors.length
        ? h(
            "div",
            { class: "error-list" },
            h("h4", {}, "Files that failed to load"),
            h("ul", {}, errors.map((e) => h("li", {}, h("code", {}, e.file), `: ${e.message}`))),
          )
        : null,
    );
  }

  private async run(filter?: string): Promise<void> {
    if (this.running) return;
    const repeat = Number(this.repeat.value || "1");
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 1000) {
      this.showError("Repeat must be a whole number from 1 to 1000.");
      this.repeat.setAttribute("aria-invalid", "true");
      this.repeat.focus();
      return;
    }
    this.repeat.removeAttribute("aria-invalid");
    const seedText = this.seed.value.trim();
    const seed = seedText ? Number(seedText) : undefined;
    if (seed !== undefined && !Number.isInteger(seed)) {
      this.showError("Seed must be a whole number.");
      this.seed.setAttribute("aria-invalid", "true");
      this.seed.focus();
      return;
    }
    this.seed.removeAttribute("aria-invalid");
    this.error.hidden = true;
    this.setRunning(true);
    try {
      const summary = await api.runTests({
        repeat,
        compile: this.compile.checked,
        ...(seed !== undefined ? { seed } : {}),
        // Test ids are matched as substrings; an exact id narrows to that test in practice.
        ...(filter ? { filter } : {}),
      });
      this.finish(summary);
    } catch (error) {
      this.showError(`Test run failed: ${(error as Error).message}`);
    } finally {
      this.setRunning(false);
    }
  }

  /** Progress for any run, including ones started by other clients of the daemon. */
  onRunner(event: RunnerStreamEvent): void {
    switch (event.kind) {
      case "stage": {
        const stage = String(event.stage);
        if (stage === "DISCOVERING") this.reset();
        const test = typeof event.test === "string" ? ` (${event.test}${typeof event.iteration === "number" ? `, iteration ${event.iteration + 1}` : ""})` : "";
        this.stage.textContent = `Stage: ${stage}${test}`;
        break;
      }
      case "discovered": {
        const tests = (event.tests as unknown[] | undefined)?.length ?? 0;
        this.total = tests;
        this.updateProgress();
        this.live.textContent = `Run started: ${tests} test${tests === 1 ? "" : "s"} discovered.`;
        break;
      }
      case "attempt": {
        const attempt = event.attempt as TestAttempt;
        const test = event.test as { name: string };
        const repeat = typeof event.repeat === "number" ? event.repeat : 1;
        this.attempts++;
        const expected = this.expectedAttempts(repeat);
        this.updateProgress(expected);
        this.lastAttemptText = `Attempt ${this.attempts} of ${expected}: ${test.name} ${attempt.status}.`;
        this.announceAttempt();
        break;
      }
      case "test": {
        const result = event.result as TestResult;
        this.results.set(result.id, result);
        this.renderList();
        break;
      }
      case "done":
        this.finish(event.summary as RunSummary);
        break;
    }
  }

  private expectedAttempts(repeat: number): number {
    return Math.max(this.total * repeat, this.attempts);
  }

  private reset(): void {
    this.total = 0;
    this.attempts = 0;
    this.progress.removeAttribute("value");
    this.setRunning(true);
  }

  private updateProgress(expected?: number): void {
    const max = expected ?? this.total;
    if (max <= 0) {
      this.progress.removeAttribute("value");
      return;
    }
    this.progress.max = max;
    this.progress.value = this.attempts;
    this.progress.setAttribute("aria-valuetext", `${this.attempts} of ${max} attempts`);
  }

  private finish(summary: RunSummary): void {
    for (const t of summary.tests) this.results.set(t.id, t);
    const passed = summary.tests.filter((t) => t.status === "passed").length;
    this.progress.max = Math.max(1, this.attempts);
    this.progress.value = this.progress.max;
    this.stage.textContent = `Finished: ${summary.status}`;
    this.live.textContent = `Run ${summary.status}: ${passed} of ${summary.tests.length} tests passed in ${duration(summary.durationMs)}.`;
    this.setRunning(false);
    this.renderList();
    this.renderSummary(summary);
  }

  private setRunning(running: boolean): void {
    this.running = running;
    this.runAll.setAttribute("aria-disabled", String(this.running));
    this.runAll.textContent = this.running ? "Running tests..." : "Run all tests";
    this.form.setAttribute("aria-busy", String(this.running));
    for (const b of this.list.querySelectorAll("button[data-test-id]")) b.setAttribute("aria-disabled", String(this.running));
  }

  private showError(message: string): void {
    this.error.textContent = message;
    this.error.hidden = false;
  }

  private renderSummary(summary: RunSummary): void {
    const facts: [string, Child][] = [
      ["Status", statusBadge(summary.status)],
      ["Run", summary.runId],
      ["Duration", duration(summary.durationMs)],
      ["Compile", summary.compile ? `${summary.compile.success ? "succeeded" : "failed"}, ${summary.compile.diagnostics} diagnostics, ${duration(summary.compile.durationMs)}` : "skipped"],
    ];
    if (summary.failedStage) facts.push(["Failed stage", summary.failedStage]);
    if (summary.error) facts.push(["Error", summary.error]);
    if (summary.artifactDir) facts.push(["Artifacts", h("code", {}, summary.artifactDir)]);
    replace(
      this.resultsBox,
      h("div", { class: "card" }, h("dl", { class: "facts" }, facts.map(([t, v]) => [h("dt", {}, t), h("dd", {}, v)]))),
      summary.tests.length ? summary.tests.map(renderResult) : h("p", { class: "empty" }, "No tests ran."),
    );
  }
}

function renderResult(result: TestResult): HTMLElement {
  const failed = result.attempts.filter((a) => a.status !== "passed");
  return h(
    "article",
    { class: `card result ${result.status}` },
    h("h4", {}, result.name, " ", statusBadge(result.status)),
    h(
      "dl",
      { class: "facts" },
      h("dt", {}, "Reliability"),
      h("dd", {}, `${pct(result.reliability)} (${result.passed} passed, ${result.failed} failed of ${result.attempts.length})`),
      h("dt", {}, "File"),
      h("dd", {}, h("code", {}, result.file)),
    ),
    result.correlations.length
      ? [
          h("h5", {}, "Correlations with failure"),
          h(
            "ul",
            {},
            result.correlations.map((c) =>
              h("li", {}, `${c.description}: seen in ${c.failingRuns} failing and ${c.passingRuns} passing runs`),
            ),
          ),
        ]
      : null,
    failed.length
      ? [
          h("h5", {}, "Failures"),
          failed.slice(0, MAX_FAILED_ATTEMPTS).map((a, i) => renderAttempt(a, i === 0)),
          failed.length > MAX_FAILED_ATTEMPTS ? h("p", { class: "muted" }, `${failed.length - MAX_FAILED_ATTEMPTS} more failed attempts not shown.`) : null,
        ]
      : null,
  );
}

function renderAttempt(attempt: TestAttempt, open: boolean): HTMLElement {
  const failedAssertions = attempt.assertions.filter((a) => !a.passed);
  return h(
    "details",
    { open },
    h(
      "summary",
      {},
      `Attempt ${attempt.iteration + 1}: ${attempt.status}${attempt.failedStage ? ` in ${attempt.failedStage}` : ""}${attempt.seed !== undefined ? `, seed ${attempt.seed}` : ""}, ${duration(attempt.durationMs)}`,
    ),
    attempt.error ? h("pre", { class: "code error-text" }, attempt.error) : null,
    failedAssertions.length
      ? table(
          `Failed assertions, attempt ${attempt.iteration + 1}`,
          ["Assertion", "Expected", "Received", "Message"],
          failedAssertions.map((a: AssertionResult) => [a.description, value(a.expected), value(a.received), a.message ?? ""]),
          "",
          true,
        )
      : null,
    attempt.steps.some((s) => !s.passed)
      ? h(
          "ul",
          { class: "steps" },
          attempt.steps.filter((s) => !s.passed).map((s) => h("li", {}, `Step failed: ${s.description}${s.error ? `: ${s.error}` : ""}`)),
        )
      : null,
  );
}

function value(v: unknown): Child {
  return v === undefined ? h("span", { class: "muted" }, "none") : h("code", {}, inline(v));
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`;
}

function statusBadge(status: string, extra = ""): HTMLElement {
  return h("span", { class: `badge ${status}` }, status, extra);
}
