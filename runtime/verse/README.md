# DevTools Verse runtime

`devtools.verse` is the in-game half of the instrumentation layer. It writes
[wire-format](../../docs/protocol.md#runtime-wire-format) lines into the UEFN
output log, and the DevTools log transport turns them into `RuntimeEvent`s.

```verse
capture_manager := class(creative_device):
    DevTools:devtools_emitter = devtools_emitter{}

    OnBegin<override>()<suspends>:void =
        DevTools.Hello()

    OnCaptured(Agent:agent):void =
        Seq := DevTools.Emit("capture.completed", array{
            DevToolsSource("device", "CapturePointA"),
            DevToolsString("device", "CapturePointA"),
            DevToolsInt("team", 1)})
        DevTools.ProbeInt("capture_manager.awarded_score", 50)
```

Rules:

- Copy the file into your project; DevTools never rewrites your gameplay Verse.
- Use one `devtools_emitter` per session, so sequence numbers stay unique.
- Use the canonical event types (`docs/protocol.md`) where they apply. The
  state model and the built-in assertions understand those.

**Status:** this file has not been compiled against UEFN yet. Compiling it is
the first runtime step of POC-001 in [`docs/capabilities.md`](../../docs/capabilities.md).
