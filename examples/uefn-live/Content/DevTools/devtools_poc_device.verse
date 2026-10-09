# POC-001 device for UEFN DevTools: announces the runtime, then counts.
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
            Sleep(1.0)
