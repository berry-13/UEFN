# GitHub integration

`uefn test` can report to GitHub Actions: annotations on the test file, a
Markdown job summary, JUnit XML, and a PR comment body.

## Reporters

```
uefn test --reporter github,junit
```

`--reporter` takes `console`, `json`, `junit` or `github`, repeated or
comma-separated. The default is `console`. When `GITHUB_ACTIONS=true`, `github`
is added automatically. `--json` keeps working as before.

| Reporter | Output |
|---|---|
| `console` | Human-readable output (unchanged) |
| `json` | The run summary, on stdout (or in `--output` when `junit` is not selected) |
| `junit` | JUnit XML in `--output` (default `junit.xml` in `paths.results`) |
| `github` | Workflow commands on stdout, plus Markdown appended to `$GITHUB_STEP_SUMMARY` |

### github

- One `::group::` per test with failing attempts, artifact directories and
  correlations (at most 5 failing attempts are listed per test).
- `::error file=...,line=...,title=...::message` per failing test. `file` is
  relative to `GITHUB_WORKSPACE`. `line` is the `name:` line for YAML tests;
  TypeScript tests get the file only. `%`, `\r` and `\n` are escaped in messages,
  and `:` and `,` also in properties.
- `::notice` for flaky tests (reliability strictly between 0 and 1, from `--repeat`).
- A Markdown table (test, status, reliability, duration, correlations, artifact
  directories) appended to the job summary.

Artifact directories are paths on the runner. They are reachable from the run
page only if the workflow uploads the results directory (the generated workflow
does this on failure). `actions/upload-artifact@v4` skips hidden directories by
default, so the upload step sets `include-hidden-files: true`; keep it if you
edit the step.

### junit

One `<testsuite>` per test; each `--repeat` iteration is a `<testcase>` named
`<test> #<n>`. Suite properties carry `reliability`, `attempts`, `passed`,
`failed` and each correlation. Failures carry `expected 50, received 100`, the
failed step or assertion, the failed stage (as `type`) and the artifact directory.
A run-level error (compile, session) becomes an `<error>` testcase in a
`uefn-devtools run` suite. Output is deterministic for a given summary.

## Workflow

```
uefn init --github
```

Writes `.github/workflows/uefn-devtools.yml` (refuses to overwrite). It checks
out, sets up Node 22, installs the project's dependencies (`npm ci` when a
`package-lock.json` exists, otherwise `npm install`), runs
`npx uefn test --reporter github,junit` and uploads the results directory
(`paths.results` from your config, `.devtools/results` by default) on failure.
Only official `actions/*` actions are used. It uses whatever adapter your config
selects (`simulated` by default).

The CLI must be a devDependency of the project (`npm install --save-dev
@uefn-devtools/cli`), because TypeScript tests import `@uefn-devtools/test` and
that has to resolve on a fresh runner; a global install is not enough. With pnpm
or yarn, replace the install step.

Assumptions to check: the template expects `@uefn-devtools/cli` on npm, which
is not published yet. Until it is, install it from a tarball or git checkout. The self-hosted Windows job for
the `mcp` adapter is commented out and unverified: it needs UEFN and Fortnite on
the runner, and headless operation is not established (see `capabilities.md`).

## PR comments

```
uefn ci comment --from .devtools/results/<day>/<run>/summary.json > comment.md
gh pr comment "$PR_NUMBER" --body-file comment.md
```

The output starts with a hidden `<!-- uefn-devtools-summary -->` marker so a
workflow can find and update its own comment. The run link is included when
`GITHUB_SERVER_URL`, `GITHUB_REPOSITORY` and `GITHUB_RUN_ID` are set. Posting
needs `pull-requests: write` permission on the job.
