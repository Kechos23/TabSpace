using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Threading;
using System.Windows.Media;
using DragGroup.Core;
using TabSpace.Native.Protocol;

namespace DragGroup.Native;
public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        try
        {
            using var registration = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "com.tabspace.draggroup.json")));
            var allowed = registration.RootElement.GetProperty("allowed_origins").EnumerateArray().Select(v => v.GetString()).ToArray();
            if (args.Length < 1 || !Regex.IsMatch(args[0], "^chrome-extension://[a-p]{32}/$") || allowed.Length is < 1 or > 2 || allowed.Distinct().Count() != allowed.Length || allowed.Any(origin => origin is null || !Regex.IsMatch(origin, "^chrome-extension://[a-p]{32}/$")) || !allowed.Contains(args[0])) return 3;
            var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            using var host = new Host(app);
            app.Startup += (_, _) => host.Start();
            return app.Run();
        }
        catch { Console.Error.WriteLine("Drag Group host could not start. Check registration, runtime and desktop availability."); return 2; }
    }
}
internal sealed class Host : IDisposable
{
    private readonly Application app;
    private readonly FrameCodec codec = new(Console.OpenStandardInput(), Console.OpenStandardOutput());
    private readonly CancellationTokenSource cancel = new();
    private readonly DispatcherTimer timer;
    private readonly Feedback overlay = new();
    private readonly Gesture gesture = new();
    private readonly ActivationGate activation = new();
    private readonly string nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
    private string? session, lastStatus;
    private Snapshot? snapshot;
    private IdentityMap? map;
    private IdentityMap? pendingMap;
    private nint mappedWindow;
    private bool wasDown, suppressUntilUp;
    private DateTimeOffset lastInspect = DateTimeOffset.MinValue, lastSnapshot = DateTimeOffset.MinValue;
    private bool disposed;
    private bool reading;
    private long invalidation;
    private EscapeObserver? escapeObserver;
    private PointerObserver? pointerObserver;
    private Desktop.Rect mapBounds;
    private string? lastPhase;
    private DateTimeOffset lastDragRead=DateTimeOffset.MinValue;
    private DateTimeOffset lastRequest=DateTimeOffset.MinValue;
    private int releases;
    private bool feedbackQueued,frameSubscribed;
    private void StopFeedback()
    {
        if(frameSubscribed){CompositionTarget.Rendering-=OnRenderFrame;frameSubscribed=false;}
        overlay.Hide();
    }
    private bool CanRenderFeedback()=>!disposed&&wasDown&&gesture.Active&&gesture.Armed&&DateTimeOffset.UtcNow-lastSnapshot<=TimeSpan.FromSeconds(3)&&Desktop.GetForegroundWindow()==mappedWindow;
    private void DrawFeedback()
    {
        if(!CanRenderFeedback()){StopFeedback();return;}
        try {
            if(Desktop.Bounds(mappedWindow)!=mapBounds){Cancel("Window moved during drag.");return;}
            // Sample for this presentation frame, not the previous 16 ms timer tick.
            if(!Desktop.GetCursorPos(out var cursor)||gesture.VisualSourceAt(cursor.X) is not {} source||gesture.TargetSlot is not {} target){StopFeedback();return;}
            overlay.Show(source,target,true,mapBounds);
        }catch{StopFeedback();}
    }
    private void OnRenderFrame(object? sender,EventArgs args)=>DrawFeedback();
    private void QueueFeedback()
    {
        if(feedbackQueued||disposed)return;
        // Once visible, composition frames consume the latest state themselves.
        if(frameSubscribed&&wasDown&&gesture.Active&&gesture.Armed)return;
        feedbackQueued=true;
        app.Dispatcher.BeginInvoke(DispatcherPriority.Render,new Action(()=>
        {
            feedbackQueued=false;
            if(!CanRenderFeedback()){StopFeedback();return;}
            if(!frameSubscribed){
                CompositionTarget.Rendering+=OnRenderFrame;frameSubscribed=true;
                // The first frame creates/shows the overlay presentation source.
                DrawFeedback();
            }
        }));
    }
    public Host(Application app) { this.app = app; timer = new DispatcherTimer(TimeSpan.FromMilliseconds(16), DispatcherPriority.Input, (_, _) => Tick(), app.Dispatcher); timer.Stop(); }
    public void Start()
    {
        try{escapeObserver=new EscapeObserver(()=>{invalidation++;if(gesture.Active||map is not null)Cancel("Escape cancelled the gesture.");});pointerObserver=new PointerObserver(OnPointer);wasDown=(Desktop.GetAsyncKeyState(1)&0x8000)!=0;}
        catch{app.Shutdown(5);return;}
        timer.Start();
        _ = Task.Run(async () =>
        {
            try
            {
                while (!cancel.IsCancellationRequested)
                {
                    using var frame = await codec.Read(cancel.Token);
                    if (frame is null) break;
                    var message = frame.RootElement.Clone();
                    await app.Dispatcher.InvokeAsync(() => Receive(message));
                }
            }
            catch (Exception) { /* No titles, URLs, raw frames or screen coordinates in diagnostics. */ }
            finally { await app.Dispatcher.InvokeAsync(() => app.Shutdown()); }
        });
    }
    private void Send(object message) => _ = Write(message);
    private async Task Write(object message) { try { await codec.Write(message, cancel.Token); } catch { await app.Dispatcher.InvokeAsync(() => app.Shutdown()); } }
    private void Status(string message) { if (message == lastStatus) return; lastStatus = message; Send(new { protocolVersion = 1, type = "status", session, message }); }
    private void Trace(string message){if(session is null)return;Send(new{protocolVersion=1,type="trace",session,message});}
    private void Receive(JsonElement message)
    {
        try
        {
            if (message.ValueKind != JsonValueKind.Object || message.GetProperty("protocolVersion").GetInt32() != 1) throw new InvalidDataException();
            var names = message.EnumerateObject().Select(p => p.Name).ToArray();
            if (names.Distinct().Count() != names.Length) throw new InvalidDataException();
            string type = message.GetProperty("type").GetString()!;
            string incomingSession = message.GetProperty("session").GetString()!;
            if (!Guid.TryParse(incomingSession, out _)) throw new InvalidDataException();
            string[] allowed = type switch { "hello" or "shutdown" => ["protocolVersion", "type", "session"], "snapshot" => ["protocolVersion", "type", "session", "nonce", "windowId", "beaconId", "tabs"], "result" => ["protocolVersion", "type", "session", "ok"], "mapAck" => ["protocolVersion", "type", "session", "mapId"], _ => throw new InvalidDataException() };
            if (names.Except(allowed).Any()) throw new InvalidDataException();
            if (type == "hello")
            {
                if (session is not null) throw new InvalidDataException();
                session = incomingSession; Send(new { protocolVersion = 1, type = "challenge", session, nonce,build="0.1.21" }); return;
            }
            if (incomingSession != session || session is null) throw new InvalidDataException();
            if (type == "shutdown") { app.Shutdown(); return; }
            if (type == "result") { if(!wasDown&&!gesture.Active){invalidation++;map=pendingMap=null;lastInspect=DateTimeOffset.MinValue;} Status(message.GetProperty("ok").GetBoolean() ? "Group created. Refreshing tab identities." : "Grouping cancelled. Refreshing the identity map."); return; }
            if (type == "mapAck")
            {
                if (pendingMap is null || snapshot is null || gesture.Active || (Desktop.GetAsyncKeyState(1) & 0x8000) != 0 || message.GetProperty("mapId").GetString() != pendingMap.MapId) return;
                var candidate=pendingMap;pendingMap=null;
                if (!Mapping.MembersMatch(candidate,snapshot) || !candidate.Bindings.Select(b=>b.Tab.Id).SequenceEqual(snapshot.Tabs.OrderBy(t=>t.Index).Select(t=>t.Id))) return;
                _=Confirm(candidate,mappedWindow,snapshot);
                return;
            }
            if (message.GetProperty("nonce").GetString() != nonce) throw new InvalidDataException();
            var items = message.GetProperty("tabs");
            if (items.ValueKind != JsonValueKind.Array || items.GetArrayLength() > 100) throw new InvalidDataException();
            var tabs = items.EnumerateArray().Select(t =>
            {
                var keys = t.EnumerateObject().Select(p => p.Name).ToArray();
                if (keys.Length != 5 || keys.Distinct().Count() != 5 || keys.Except(["id", "index", "pinned", "groupId", "highlighted"]).Any()) throw new InvalidDataException();
                return new BrowserTab(t.GetProperty("id").GetInt32(), t.GetProperty("index").GetInt32(), t.GetProperty("pinned").GetBoolean(), t.GetProperty("groupId").GetInt32(), t.GetProperty("highlighted").GetBoolean());
            }).ToArray();
            var fresh = new Snapshot(message.GetProperty("windowId").GetInt32(), message.GetProperty("beaconId").GetInt32(), tabs);
            if (fresh.WindowId < 0 || fresh.BeaconId < 0 || tabs.Any(t => t.Id < 0 || t.Index < 0 || t.GroupId < -1) || tabs.Select(t => t.Id).Distinct().Count() != tabs.Length) throw new InvalidDataException();
            snapshot = fresh; lastSnapshot = DateTimeOffset.UtcNow;
            if (gesture.Map is { } active && !Mapping.MembersMatch(active, fresh)) Cancel("Tab membership or grouping changed; drag cancelled.");
            if(!gesture.Active&&map is not null&&(!Mapping.MembersMatch(map,fresh)||!map.Bindings.Select(b=>b.Tab.Id).SequenceEqual(fresh.Tabs.OrderBy(t=>t.Index).Select(t=>t.Id))))map=null;
        }
        catch { app.Shutdown(4); }
    }
    private void Cancel(string reason) { invalidation++;gesture.Cancel();activation.Reset(); map = pendingMap = null; StopFeedback(); suppressUntilUp = wasDown; lastInspect=DateTimeOffset.MinValue; Status(reason);Trace(reason); }
    private async Task<Slot[]?> Read(nint window)
    {
        // UI Automation can block. Run it away from the input/message loop, allow
        // only one outstanding read and stop the process if a provider hangs.
        if(reading)return null;reading=true;
        try
        {
            var work=Task.Run(()=>Desktop.Read(window,$"DG:{nonce}"));
            if(await Task.WhenAny(work,Task.Delay(1000,cancel.Token))!=work){Cancel("Accessibility provider timed out; helper stopped.");app.Shutdown(6);return null;}
            return await work;
        }
        finally{reading=false;}
    }
    private async Task Inspect(nint foreground,Snapshot captured)
    {
        var epoch=invalidation;
        try
        {
            Desktop.Rect bounds;Slot[]? slots;
            if(mappedWindow==0)
            {
                if(reading)return;reading=true;
                try{
                    var work=Task.Run(()=>Desktop.Discover(foreground,$"DG:{nonce}"));
                    if(await Task.WhenAny(work,Task.Delay(1000,cancel.Token))!=work){Cancel("Accessibility discovery timed out; helper stopped.");app.Shutdown(6);return;}
                    var found=await work;foreground=found.Window;bounds=found.Bounds;slots=found.Slots;
                }finally{reading=false;}
            }
            else{bounds=Desktop.Bounds(foreground);slots=await Read(foreground);}
            if(slots is null||disposed||epoch!=invalidation||gesture.Active||(Desktop.GetAsyncKeyState(1)&0x8000)!=0)return;
            if(Desktop.Bounds(foreground)!=bounds)return;
            if(snapshot is null||!captured.Tabs.Select(t=>(t.Id,t.Index,t.Pinned,t.GroupId)).SequenceEqual(snapshot.Tabs.Select(t=>(t.Id,t.Index,t.Pinned,t.GroupId))))return;
            pendingMap=Mapping.Build(captured,slots,$"DG:{nonce}",DateTimeOffset.UtcNow);mappedWindow=foreground;
            Send(new{protocolVersion=1,type="mapped",session,mapId=pendingMap.MapId,windowId=pendingMap.WindowId,tabs=captured.Tabs.Select(t=>new{id=t.Id,index=t.Index,pinned=t.Pinned,groupId=t.GroupId,highlighted=t.Highlighted})});
        }
        catch(InvalidOperationException error){map=null;Status(error.Message);}
        catch{map=null;Status("UI Automation is unavailable; grouping paused.");}
    }
    private async Task Confirm(IdentityMap candidate,nint window,Snapshot captured)
    {
        var epoch=invalidation;
        try
        {
            var bounds=Desktop.Bounds(window);
            var slots=await Read(window);
            if(slots is null||disposed||epoch!=invalidation||gesture.Active||(Desktop.GetAsyncKeyState(1)&0x8000)!=0)return;
            if(Desktop.Bounds(window)!=bounds)return;
            if(!candidate.Bindings.Select(b=>b.Slot.RuntimeId).SequenceEqual(slots.OrderBy(s=>s.X).Select(s=>s.RuntimeId)))return;
            if(snapshot is null||!Mapping.MembersMatch(candidate,snapshot)||!candidate.Bindings.Select(b=>b.Tab.Id).SequenceEqual(snapshot.Tabs.OrderBy(t=>t.Index).Select(t=>t.Id)))return;
            map=Mapping.Build(captured,slots,$"DG:{nonce}",DateTimeOffset.UtcNow) with{MapId=candidate.MapId};
            mapBounds=Desktop.Bounds(window);
            Status("Ready — visible tab identities verified in this window. Overlap an ungrouped tab for 200 ms; release when the paired tab outlines appear.");
        }
        catch{map=null;Status("The identity map changed during acknowledgment; retrying.");}
    }
    private async Task Release((IdentityMap Map,int Source,int Target,double Direction) intent,nint window)
    {
        var epoch=invalidation;releases++;
        try
        {
            for(int attempt=0;attempt<4;attempt++)
            {
                await Task.Delay(attempt==0?80:70,cancel.Token);
                if(disposed||epoch!=invalidation||Desktop.GetForegroundWindow()!=window||wasDown||snapshot is null||!Mapping.MembersMatch(intent.Map,snapshot)){Trace("Release cancelled: focus, tab membership or input changed.");return;}
                if(reading)continue;
                var slots=await Read(window);
                if(slots is null||disposed||epoch!=invalidation||Desktop.GetForegroundWindow()!=window||wasDown)return;
                if(!Mapping.ReleaseOrderMatches(intent.Map,slots,intent.Source))continue;
                var originalTarget=intent.Map.Bindings.Single(b=>b.Tab.Id==intent.Target).Slot;
                var currentTarget=slots.Single(s=>s.RuntimeId==originalTarget.RuntimeId);
                if(Mapping.Crossed(originalTarget,currentTarget,intent.Direction)){Trace("Release cancelled: Chrome moved the target behind the dragged tab.");return;}
                Trace("Release verified. Requesting the Chrome group.");
                Send(new{protocolVersion=1,type="gesture",session,mapId=intent.Map.MapId,windowId=intent.Map.WindowId,sourceId=intent.Source,targetId=intent.Target});return;
            }
            Status("Chrome's tab identities did not settle after release; cancelled.");Trace("Release cancelled: tab identities did not settle.");
        }
        catch{Status("Final tab verification failed; grouping cancelled.");}
        finally{releases--;}
    }
    private void OnPointer(int message,Desktop.Point point)
    {
        try
        {
            var now=DateTimeOffset.UtcNow;
            if(message==0x201)
            {
                wasDown=true;invalidation++;lastPhase=null;gesture.Cancel();activation.Reset();QueueFeedback();
                // A low-level down event precedes Windows foreground activation.
                // Hit-test the real top-level window, then use only its already
                // proven, freshly maintained identity map. Never block the hook.
                if(mappedWindow==0||Desktop.WindowAt(point)!=mappedWindow)return;
                if(snapshot is null||now-lastSnapshot>TimeSpan.FromSeconds(3)||map is null||suppressUntilUp){Trace("Mouse down ignored: helper is refreshing or not ready.");return;}
                if(Desktop.Bounds(mappedWindow)!=mapBounds){map=null;Trace("Mouse down ignored: window moved or resized; wait for Ready.");return;}
                var topEdge=Desktop.TabTopEdge(mappedWindow);
                if(Mapping.SourceHit(map,point.X,point.Y,topEdge)?.Tab.Id==map.BeaconId)return;
                gesture.Down(map,point.X,point.Y,now,topEdge);
                if(gesture.Active)activation.Begin(Desktop.GetForegroundWindow()==mappedWindow,now);
                Trace(gesture.Source is {} source?$"Source captured: tab {source.Tab.Index+1}. Drag onto another tab and pause.":"Mouse down was outside a draggable unpinned, ungrouped tab body.");
            }
            else if(message==0x200&&wasDown&&gesture.Active){gesture.Move(point.X,point.Y,now);QueueFeedback();}
            else if(message==0x202)
            {
                wasDown=false;suppressUntilUp=false;invalidation++;QueueFeedback();
                if(!gesture.Active){map=pendingMap=null;lastInspect=DateTimeOffset.MinValue;return;}
                var intent=activation.Check(Desktop.GetForegroundWindow()==mappedWindow,now)==ActivationState.Ready?gesture.Release(point.X,point.Y,now):null;
                gesture.Cancel();activation.Reset();map=pendingMap=null;lastInspect=DateTimeOffset.MinValue;
                var window=mappedWindow;var releasedEpoch=invalidation;
                app.Dispatcher.BeginInvoke(DispatcherPriority.Render,new Action(()=>{
                    if(disposed||releasedEpoch!=invalidation||wasDown)return;
                    StopFeedback();if(intent is {} candidate)_=Release(candidate,window);else Trace("No group: release happened before the target was armed, or outside its body.");
                }));
            }
        }
        catch{gesture.Cancel();map=null;suppressUntilUp=wasDown;QueueFeedback();}
    }
    private async Task RefreshDragLayout(nint window)
    {
        var frozen=gesture.Map;var epoch=invalidation;
        try{var slots=await Read(window);if(slots is not null&&epoch==invalidation&&gesture.Active&&gesture.Map==frozen&&Desktop.GetForegroundWindow()==window){gesture.UpdateLayout(slots);Desktop.GetCursorPos(out var cursor);gesture.Move(cursor.X,cursor.Y,DateTimeOffset.UtcNow);QueueFeedback();}}catch{/* A transient drag tree cannot establish a new identity. Final release still verifies the full strip. */}
    }
    private void Tick()
    {
        try
        {
            var now = DateTimeOffset.UtcNow;
            bool down = wasDown;
            bool escape = (Desktop.GetAsyncKeyState(0x1B) & 0x8000) != 0;
            var foreground = Desktop.GetForegroundWindow();
            if (!down) suppressUntilUp = false;
            if(session is not null&&now-lastRequest>TimeSpan.FromSeconds(1)){lastRequest=now;Send(new{protocolVersion=1,type="requestSnapshot",session});}
            if (snapshot is null || session is null || now - lastSnapshot > TimeSpan.FromSeconds(3))
            {
                StopFeedback();
                if(gesture.Active||map is not null)Cancel("Paused: controller heartbeat missing; refresh is required.");
                if(snapshot is not null&&now-lastSnapshot>TimeSpan.FromSeconds(10))app.Shutdown(7);
                return;
            }
            if(escape){if(gesture.Active||map is not null)Cancel("Escape cancelled the gesture.");return;}
            if(gesture.Active)
            {
                var focus=activation.Check(foreground==mappedWindow,now);
                if(focus==ActivationState.Waiting)return;
                if(focus==ActivationState.Rejected){Cancel("Paused: focus changed or Chrome did not activate.");return;}
            }
            Desktop.GetCursorPos(out var cursor);
            if (!down && releases==0 && !reading && now - lastInspect >= TimeSpan.FromMilliseconds(map is null ? 100 : 400))
            {
                lastInspect = now;
                // Keep the opted-in window ready while another app has focus.
                // Fresh UIA/nonce/API acknowledgment still proves every map.
                var observed=mappedWindow!=0?mappedWindow:foreground;
                if(mappedWindow==0||Desktop.IsChrome(observed))_=Inspect(observed,snapshot);
            }
            if (down && gesture.Active)
            {
                gesture.Move(cursor.X, cursor.Y, now);
                if(!reading&&now-lastDragRead>TimeSpan.FromMilliseconds(gesture.Armed ? 30 : 60)){lastDragRead=now;_=RefreshDragLayout(foreground);}
                if (gesture.Target is { } target)
                {
                    QueueFeedback();
                    var phase=$"{(gesture.Armed?"Ready to release":"Hold on target")}: tab {target.Tab.Index+1}.";
                    if(phase!=lastPhase){lastPhase=phase;Trace(phase);}
                }
                else StopFeedback();
            }
            else StopFeedback();
        }
        catch { gesture.Cancel(); StopFeedback(); map = null; wasDown = (Desktop.GetAsyncKeyState(1) & 0x8000) != 0; Status("Drag cancelled because the browser layout changed."); }
    }
    public void Dispose()
    {
        if (disposed) return; disposed = true; timer.Stop(); pointerObserver?.Dispose();escapeObserver?.Dispose();gesture.Cancel(); StopFeedback(); overlay.Dispose(); cancel.Cancel();
    }
}
