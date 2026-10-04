# Example gameplay device instrumented with the DevTools runtime.
# Requires runtime/verse/devtools.verse to be copied into the project.
#
# STATUS: UNVERIFIED against UEFN (see docs/capabilities.md). The simulated
# adapter does not compile Verse; it only discovers these files.

using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }
using { /UnrealEngine.com/Temporary/Diagnostics }

capture_manager := class(creative_device):
    @editable
    CapturePointA:capture_area_device = capture_area_device{}

    @editable
    ScoreManager:score_manager_device = score_manager_device{}

    @editable
    CaptureReward:int = 50

    DevTools:devtools_emitter = devtools_emitter{}

    var AwardedScore:int = 0

    OnBegin<override>()<suspends>:void =
        DevTools.Hello()
        CapturePointA.AreaIsScoredEvent.Subscribe(OnAreaScored)

    OnAreaScored(Agent:agent):void =
        Completed := DevTools.Emit("capture.completed", array{
            DevToolsSource("device", "CapturePointA"),
            DevToolsString("device", "CapturePointA")})
        ScoreManager.Activate(Agent)
        set AwardedScore += CaptureReward
        DevTools.Emit("capture_manager.award", array{
            DevToolsParent(Completed),
            DevToolsInt("delta", CaptureReward),
            DevToolsInt("current", AwardedScore)})
        DevTools.ProbeInt("capture_manager.awarded_score", AwardedScore)
