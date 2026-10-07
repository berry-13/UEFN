# UEFN DevTools runtime emitter
#
# Writes structured DevTools lines into the UEFN output log, where the
# DevTools log transport (packages/uefn/src/log-transport.ts) picks them up.
# Wire format: docs/protocol.md.
#
#   [UEFN-DEVTOOLS]|1|<kind>|<seq>|<name>|key:t=value|...
#
# STATUS: UNVERIFIED. This file has not yet been compiled against UEFN.
# Compiling it and confirming the lines reach the log file is step 2 of
# POC-001 (docs/capabilities.md). Expect small syntax fixes.
#
# Copy this file into your project's Verse folder (DevTools never edits your
# gameplay files) and give one devtools_emitter instance to the devices that
# report state. Use exactly one emitter per session so sequence numbers, and
# therefore event ids and parent links, are unique.

using { /UnrealEngine.com/Temporary/Diagnostics }

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
    var NextSeq<private>:int = 0

    # Announces that the runtime is live. DevTools waits for this line in the
    # WAITING_FOR_RUNTIME stage before running any test.
    Hello<public>()<transacts>:void =
        Logger.Print("[UEFN-DEVTOOLS]|1|H|0|0.1.0")

    # Emits an event and returns its sequence number for use as a parent.
    Emit<public>(EventType:string, Fields:[]string)<transacts>:int =
        set NextSeq += 1
        var Line:string = "[UEFN-DEVTOOLS]|1|E|{NextSeq}|" + DevToolsEscape(EventType)
        for (Field : Fields):
            set Line += "|" + Field
        Logger.Print(Line)
        NextSeq

    # Reports the current value of a probe, e.g. ProbeInt("team.1.score", 50).
    ProbeInt<public>(ProbeId:string, Value:int)<transacts>:void =
        set NextSeq += 1
        Logger.Print("[UEFN-DEVTOOLS]|1|P|{NextSeq}|" + DevToolsEscape(ProbeId) + "|v:i={Value}")

    ProbeFloat<public>(ProbeId:string, Value:float)<transacts>:void =
        set NextSeq += 1
        Logger.Print("[UEFN-DEVTOOLS]|1|P|{NextSeq}|" + DevToolsEscape(ProbeId) + "|v:f={Value}")

    ProbeString<public>(ProbeId:string, Value:string)<transacts>:void =
        set NextSeq += 1
        Logger.Print("[UEFN-DEVTOOLS]|1|P|{NextSeq}|" + DevToolsEscape(ProbeId) + "|v=" + DevToolsEscape(Value))
