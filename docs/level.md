# Level snapshots

```
uefn level snapshot [--out file]
uefn level diff [before.json] [after.json]
```

`uefn level snapshot` reads every actor in the level open in UEFN and writes
`level.snapshot.json` at the project root. Each actor records:

- its guid (`id`), label, class and object path;
- its outliner folder, tags and data layers;
- its location, rotation (pitch, yaw, roll) and scale;
- for devices, the event bindings wired into them, and for Verse devices
  their editable settings, as UEFN reports them.

Actors are sorted by label and then guid, numbers are rounded (0.01 for
location and rotation, 0.0001 for scale) and empty fields are left out, so
the same level always gives the same file. Commit it to see level changes in
review like any other change.

`uefn level diff` matches actors by guid, so a moved or renamed actor shows as
a change, not as a removal plus an addition:

```
+ Trigger3 (BP_TriggerDevice_C) at (1200, 400, 0)
- Old Barrier (Barrier_C)
~ Fuel Pump0
    location: (-3967.89, 5344.45, 392) -> (-3800, 5344.45, 392)
1 added, 1 removed, 1 changed
```

With no file it compares `level.snapshot.json` with the live level; with one,
that file with the live level; with two, the two files. It exits 0 when they
match and 1 when they differ.

## For agents

The MCP server has the same pair:

- `uefn_level_snapshot` returns the level, actor counts per class and the
  actors matching optional `class` / `label` substrings (up to `limit`).
  `save: true` writes `level.snapshot.json` and needs `modify_project`.
- `uefn_level_diff` compares the saved snapshot with the live level.

The intended loop: save a snapshot, make an edit through UEFN's editor tools,
then diff to check the edit changed exactly what was meant.

## How it reads the level

Only the `mcp` adapter has an editor. The snapshot uses UEFN's editor
toolsets through `call_tool`: one `execute_tool_script` call runs a short
Python script inside the editor that calls `find_actors`, then
`get_actor_transform`, `get_tags` and `ListEventBindings` for each actor (and
`ListDeviceProperties` for Verse devices). Batching it there took 37s for
2,836 actors on UEFN 42.30, instead of thousands of MCP round trips.

A per-actor read that fails is reported as a warning and its field is left
out; the rest of the snapshot is still written.

Not covered yet: classic (non-Verse) device settings, which UEFN's device
tools only expose for Verse devices, and Verse Scene Graph entities.
