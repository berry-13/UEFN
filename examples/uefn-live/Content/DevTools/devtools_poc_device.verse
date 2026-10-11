# POC-001 device for UEFN DevTools: announces the runtime, then counts.
# Each tick is also profiled: a perf.span around the one-second wait and a
# perf.sample with the player count, for `uefn profile`.
using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }

devtools_poc_device := class(creative_device):
    Emitter:devtools_emitter = devtools_emitter{}

    OnBegin<override>()<suspends>:void =
        Emitter.Hello()
        var Counter:int = 0
        loop:
            set Counter += 1
            Emitter.ProbeInt("poc.counter", Counter)
            if (Counter >= 60):
                break
            Start := Emitter.ProfileBegin()
            Sleep(1.0)
            Emitter.ProfileEnd("poc.tick", Start, array{DevToolsInt("counter", Counter)})
            Emitter.PerfSample("poc", array{DevToolsInt("players", GetPlayspace().GetPlayers().Length)})
