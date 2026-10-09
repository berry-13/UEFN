# UEFN DevTools runtime emitter
#
# Writes structured DevTools lines into the UEFN output log, where the
# DevTools log transport (packages/uefn/src/log-transport.ts) picks them up.
# Wire format: docs/protocol.md.
#
#   [UEFN-DEVTOOLS]|1|<kind>|<seq>|<name>|key:t=value|...
#
# STATUS: compiles unchanged on UEFN 42.30 (live, 2026-10-09). That its
# lines reach the editor log during a play session is not verified yet
# (POC-001 steps 4 to 8, docs/capabilities.md).
#
# Copy this file into your project's Verse folder (DevTools never edits your
# gameplay files) and give one devtools_emitter instance to the devices that
# report state. Use exactly one emitter per session so sequence numbers, and
# therefore event ids and parent links, are unique.

using { /UnrealEngine.com/Temporary/Diagnostics }
using { /UnrealEngine.com/Temporary/SpatialMath }
using { /Verse.org/Simulation }

devtools_log<public> := class(log_channel){}

# Percent-encodes the characters the wire format reserves.
DevToolsEscape<public>(Value:string)<transacts>:string =
    var Result:string = ""
    for (Char : Value):
        if (Char = '%'):
            set Result += "%25"
        else if (Char = '|'):
            set Result += "%7C"
        else if (Char = '='):
            set Result += "%3D"
        else if (Char = '\n'):
            set Result += "%0A"
        else:
            set Result += array{Char}
    Result

# Typed field builders for devtools_emitter.Emit.
DevToolsString<public>(Key:string, Value:string)<transacts>:string =
    DevToolsEscape(Key) + "=" + DevToolsEscape(Value)

DevToolsInt<public>(Key:string, Value:int)<transacts>:string =
    DevToolsEscape(Key) + ":i={Value}"

DevToolsFloat<public>(Key:string, Value:float)<transacts>:string =
    DevToolsEscape(Key) + ":f={Value}"

# A position or direction as x,y,z (Unreal units).
DevToolsVector<public>(Key:string, Value:vector3)<transacts>:string =
    DevToolsEscape(Key) + ":v={Value.X},{Value.Y},{Value.Z}"

DevToolsBool<public>(Key:string, Value:logic)<transacts>:string =
    if (Value?) then DevToolsEscape(Key) + ":b=true" else DevToolsEscape(Key) + ":b=false"

# Entity references: Kind is one of player, device, team, scene, verse, asset.
DevToolsSource<public>(Kind:string, Id:string)<transacts>:string =
    "src=" + DevToolsEscape(Kind) + ":" + DevToolsEscape(Id)

DevToolsTarget<public>(Kind:string, Id:string)<transacts>:string =
    "tgt=" + DevToolsEscape(Kind) + ":" + DevToolsEscape(Id)

# Causal parent: pass the sequence number returned by an earlier Emit.
DevToolsParent<public>(Seq:int)<transacts>:string =
    "parent:i={Seq}"

DevToolsTrace<public>(TraceId:string)<transacts>:string =
    DevToolsString("trace", TraceId)

devtools_emitter<public> := class:
    Logger<private>:log = log{Channel := devtools_log}
    # Offset for this emitter's sequence numbers. A second emitter in the same
    # session (such as a generated scenario device) sets a distinct range so
    # event ids stay unique, e.g. devtools_emitter{SeqStart := 1000000}.
    SeqStart<public>:int = 0
    var NextSeq<private>:int = 0

    # Announces that the runtime is live. DevTools waits for this line in the
    # WAITING_FOR_RUNTIME stage before running any test.
    Hello<public>()<transacts>:void =
        Logger.Print("[UEFN-DEVTOOLS]|1|H|0|0.1.0")

    # Emits an event and returns its sequence number for use as a parent.
    Emit<public>(EventType:string, Fields:[]string)<transacts>:int =
        set NextSeq += 1
        var Line:string = "[UEFN-DEVTOOLS]|1|E|{SeqStart + NextSeq}|" + DevToolsEscape(EventType)
        for (Field : Fields):
            set Line += "|" + Field
        Logger.Print(Line)
        SeqStart + NextSeq

    # Reports the current value of a probe, e.g. ProbeInt("team.1.score", 50).
    ProbeInt<public>(ProbeId:string, Value:int)<transacts>:void =
        set NextSeq += 1
        Logger.Print("[UEFN-DEVTOOLS]|1|P|{SeqStart + NextSeq}|" + DevToolsEscape(ProbeId) + "|v:i={Value}")

    ProbeFloat<public>(ProbeId:string, Value:float)<transacts>:void =
        set NextSeq += 1
        Logger.Print("[UEFN-DEVTOOLS]|1|P|{SeqStart + NextSeq}|" + DevToolsEscape(ProbeId) + "|v:f={Value}")

    ProbeString<public>(ProbeId:string, Value:string)<transacts>:void =
        set NextSeq += 1
        Logger.Print("[UEFN-DEVTOOLS]|1|P|{SeqStart + NextSeq}|" + DevToolsEscape(ProbeId) + "|v=" + DevToolsEscape(Value))

    # Profiling (docs/profiler.md). UNVERIFIED like the rest of this file.
    #
    # Time source is GetSimulationElapsedTime (seconds of simulation time).
    # Simulation time advances per frame, so a span that begins and ends
    # inside one synchronous handler will usually read 0 ms: spans measure
    # work that suspends (Sleep, Await, Race) across frames, not CPU cost.

    # Simulation time in milliseconds, for ProfileBegin / ProfileEnd.
    ProfileNow<public>()<transacts>:float =
        GetSimulationElapsedTime() * 1000.0

    # Starts a span; pass the returned start time to ProfileEnd.
    ProfileBegin<public>()<transacts>:float =
        ProfileNow()

    # Ends a span started with ProfileBegin and emits it as perf.span.
    # Fields may carry DevToolsParent(Seq) to attach the span to the event
    # whose handler it measured. Returns the span's sequence number.
    ProfileEnd<public>(Name:string, StartMs:float, Fields:[]string)<transacts>:int =
        ProfileSpan(Name, ProfileNow() - StartMs, Fields)

    # Emits a span whose duration was measured elsewhere. The event is
    # emitted when the span ends; DevTools derives start = timestamp - duration.
    ProfileSpan<public>(Name:string, DurationMs:float, Fields:[]string)<transacts>:int =
        Emit("perf.span", array{DevToolsString("name", Name), DevToolsFloat("duration_ms", DurationMs)} + Fields)

    # Emits a perf.sample. Metrics are typed fields, e.g.
    #   PerfSample("world", array{DevToolsFloat("frame_ms", FrameMs), DevToolsInt("players", PlayerCount)})
    # Canonical metric keys: frame_ms, tick_ms, entities, players, devices, memory_mb.
    PerfSample<public>(Scope:string, Metrics:[]string)<transacts>:int =
        Emit("perf.sample", array{DevToolsString("scope", Scope)} + Metrics)
