# uefn deps

A dependency graph over Verse sources and tests, used to see what a change
touches and to pick which tests to run after an edit.

```
uefn deps [--format text|json|dot|mermaid]
uefn deps --impact <file|symbol> [--format text|json]
uefn deps --changed [--format text|json]
```

`--impact` lists the tests affected by changing a Verse file (path relative to
the project root, or absolute) or a symbol (class, module, device id, event
type). `--changed` does the same for every file git reports as modified.

## Graph

Nodes: `file`, `module`, `class`, `device`, `event`, `test`, `import`.
Edges: `declares`, `imports`, `references`, `emits`, `tests`, `extends`.

- A `class` node has kind `device` when it extends `creative_device` or a
  `*_device` type (directly or through project classes).
- `@editable` fields become `device:<FieldName>` nodes. Tests use the same name
  as the device id, which is what links them.
- `Emit("type", ...)` creates `event:<type>`; `ProbeInt("id", ...)` and friends
  create `probe:<id>` (kind `event`, label `probe <id>`).
- Tests are read from YAML steps and asserts, and from TypeScript with a regex
  pass for `device("X")`, `enter/leave/teleport("X")`, `event("x.y")`,
  `waitForEvent`, `toHaveOccurred` and `probe("x")`. Event names are normalised
  (`CaptureCompleted` equals `capture.completed`).

## Impact

A changed file affects what it declares and emits, the devices its classes
reference, and (through `extends`, class references and local `using` imports)
the classes and files that depend on those classes. A test is affected when it
exercises any affected device or event.

## Limitations

The scanner is a line and regex pass, not a Verse parser. It does not resolve
types, overloads or qualified names, event names built at runtime, or device
ids passed through variables in TypeScript tests. Class references are matched
by name across the whole project.
