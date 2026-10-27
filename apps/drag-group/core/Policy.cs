namespace DragGroup.Core;

public sealed record BrowserTab(int Id, int Index, bool Pinned, int GroupId, bool Highlighted);
public sealed record Snapshot(int WindowId, int BeaconId, BrowserTab[] Tabs);
public sealed record Slot(string RuntimeId, double X, double Y, double Width, double Height, bool Offscreen, string Label);
public sealed record Binding(BrowserTab Tab, Slot Slot);
public sealed record IdentityMap(string MapId, int WindowId, int BeaconId, DateTimeOffset CapturedAt, Binding[] Bindings);
public static class Mapping
{
    public static bool Crossed(Slot original,Slot current,double direction)=>direction!=0&&(current.X-original.X)*direction < -Math.Min(current.Width,original.Width)*.5;
    public static IdentityMap Build(Snapshot snapshot, Slot[] slots, string marker, DateTimeOffset now)
    {
        if (snapshot.Tabs.Length is < 3 or > 100 || snapshot.Tabs.Select(t => t.Id).Distinct().Count() != snapshot.Tabs.Length || snapshot.Tabs.Any(t => t.Id < 0)) throw new InvalidOperationException("Unsupported tab count or duplicate IDs.");
        var ordered = snapshot.Tabs.OrderBy(t => t.Index).ToArray();
        if (!ordered.Select(t => t.Index).SequenceEqual(Enumerable.Range(0, ordered.Length))) throw new InvalidOperationException("Incomplete Chrome order.");
        if (slots.Length != ordered.Length || slots.Select(s => s.RuntimeId).Distinct().Count() != slots.Length) throw new InvalidOperationException("Tab strip is incomplete or has ambiguous elements.");
        var visual = slots.OrderBy(s => s.X).ToArray();
        if (visual.Any(s => s.Offscreen || s.RuntimeId.Length == 0 || !double.IsFinite(s.X) || !double.IsFinite(s.Y) || !double.IsFinite(s.Width) || !double.IsFinite(s.Height) || s.Width < 16 || s.Height < 12 || s.Height > 100 || Math.Abs(s.Y - visual[0].Y) > 4)) throw new InvalidOperationException("Only a completely visible horizontal strip is supported.");
        // Chrome tab hit rectangles may share their rounded edge. Overlap in their
        // central hit zones, however, makes the frozen intent ambiguous.
        for (int i = 1; i < visual.Length; i++)
            if (visual[i - 1].X + visual[i - 1].Width * .75 >= visual[i].X + visual[i].Width * .25) throw new InvalidOperationException("Overlapping tab centres.");
        int beacon = Array.FindIndex(ordered, t => t.Id == snapshot.BeaconId);
        if (beacon < 0 || !ordered[beacon].Pinned || visual.Count(s => s.Label == marker) != 1 || visual[beacon].Label != marker) throw new InvalidOperationException("Controller challenge does not prove this window and order.");
        return new(Guid.NewGuid().ToString("N"), snapshot.WindowId, snapshot.BeaconId, now, ordered.Zip(visual).Select(pair => new Binding(pair.First, pair.Second)).ToArray());
    }
    public static bool MembersMatch(IdentityMap map, Snapshot current) => map.WindowId == current.WindowId && map.BeaconId == current.BeaconId && map.Bindings.Length == current.Tabs.Length && map.Bindings.All(b => current.Tabs.Any(t => t.Id == b.Tab.Id && t.Pinned == b.Tab.Pinned && t.GroupId == b.Tab.GroupId));
    public static Binding? Hit(IdentityMap map, double x, double y, bool centreOnly) => map.Bindings.SingleOrDefault(b => x >= b.Slot.X + b.Slot.Width * (centreOnly ? .25 : 0) && x < b.Slot.X + b.Slot.Width * (centreOnly ? .75 : 1) && y >= b.Slot.Y && y < b.Slot.Y + b.Slot.Height);
    public static bool IsCandidate(IdentityMap map, Binding binding) => binding.Tab.Id != map.BeaconId && !binding.Tab.Pinned && binding.Tab.GroupId == -1;
    public static bool Inside(Slot slot,double x,double y,double inset=.1) => x>=slot.X+slot.Width*inset&&x<slot.X+slot.Width*(1-inset)&&y>=slot.Y&&y<slot.Y+slot.Height;
    public static Binding? SourceHit(IdentityMap map,double x,double y,double? screenTop=null)
    {
        // A tab can be grabbed by its title, not only its centre. Keep the small
        // rounded edges and the close-button area out of the drag handle.
        // Maximized Chrome extends tab hit areas to the monitor's top edge,
        // sometimes above the UIA rectangle. Extend only a nearby proven row;
        // normal windows retain their title-bar exclusion.
        double Top(Slot slot)=>screenTop is {} edge&&double.IsFinite(edge)&&edge<=slot.Y&&slot.Y-edge<=slot.Height*.5?edge:slot.Y+2;
        var hits=map.Bindings.Where(b=>x>=b.Slot.X+4&&x<b.Slot.X+b.Slot.Width-Math.Min(b.Slot.Height*.9,b.Slot.Width*.25)&&y>=Top(b.Slot)&&y<b.Slot.Y+b.Slot.Height).ToArray();
        return hits.Length==1?hits[0]:null;
    }
    public static bool ReleaseOrderMatches(IdentityMap map, Slot[] current, int sourceId)
    {
        if(current.Any(s=>s.Offscreen||!double.IsFinite(s.X)||!double.IsFinite(s.Y)||!double.IsFinite(s.Width)||!double.IsFinite(s.Height)||s.Width<16||s.Height<12||s.Height>100||Math.Abs(s.Height-map.Bindings[0].Slot.Height)>4||Math.Abs(s.Y-map.Bindings[0].Slot.Y)>4))return false;
        var source = map.Bindings.Single(b => b.Tab.Id == sourceId).Slot.RuntimeId;
        if(current.Length!=map.Bindings.Length||current.Select(s=>s.RuntimeId).Distinct().Count()!=current.Length)return false;
        var others=map.Bindings.Where(b=>b.Slot.RuntimeId!=source).Select(b=>b.Slot.RuntimeId).ToArray();
        // Chrome may reparent/recreate only the dragged view. Accept one unique
        // replacement by elimination iff every other runtime identity survives in
        // exactly the old order. The browser executor also checks the exact API
        // tab set and the single selected source; titles never establish identity.
        var nonSource=current.OrderBy(s=>s.X).Where(s=>others.Contains(s.RuntimeId)).Select(s=>s.RuntimeId).ToArray();
        if(!others.SequenceEqual(nonSource))return false;
        var extras=current.Where(s=>!others.Contains(s.RuntimeId)).ToArray();
        return extras.Length==1&&(extras[0].RuntimeId==source||!map.Bindings.Any(b=>b.Slot.RuntimeId==extras[0].RuntimeId));
    }
}
public enum ActivationState { Waiting, Ready, Rejected }
public sealed class ActivationGate
{
    private DateTimeOffset? started;
    private bool activated;
    public void Begin(bool focused,DateTimeOffset now){started=now;activated=focused;}
    public ActivationState Check(bool focused,DateTimeOffset now)
    {
        if(started is null)return ActivationState.Rejected;
        if(!activated&&now-started.Value>=TimeSpan.FromMilliseconds(200))return ActivationState.Rejected;
        if(focused){activated=true;return ActivationState.Ready;}
        return !activated&&now-started.Value<TimeSpan.FromMilliseconds(200)?ActivationState.Waiting:ActivationState.Rejected;
    }
    public void Reset(){started=null;activated=false;}
}
public sealed class Gesture
{
    public IdentityMap? Map { get; private set; }
    public Binding? Source { get; private set; }
    public Binding? Target { get; private set; }
    public bool Armed { get; private set; }
    public bool Active => Source is not null;
    public bool HasMoved {get;private set;}
    public double Progress { get; private set; }
    public const int DwellMilliseconds = 200;
    public const int MaximumDragMilliseconds = 30000;
    public const double AcquireOverlap = .16, RetainOverlap = .07, RetreatFraction = .05;
    private double downX, downY;
    private double lastPointerX,travelDirection;
    private double targetDirection,targetPeak,blockedAt,blockedDirection;
    private int? blockedTargetId;
    private DateTimeOffset began, hovering;
    private Dictionary<string,Slot> live=new();
    private Slot Geometry(Binding binding)=>live.GetValueOrDefault(binding.Slot.RuntimeId,binding.Slot);
    private bool Passed(Binding binding)
    {
        // Chrome slides crossed neighbours behind the dragged tab. Their old
        // rectangles must no longer keep them eligible at their former position.
        var slot=Geometry(binding);
        return Mapping.Crossed(binding.Slot,slot,travelDirection);
    }
    private double RetreatDistance(Binding target)=>Math.Clamp(Math.Min(Source!.Slot.Width,target.Slot.Width)*RetreatFraction,Source.Slot.Height*.09375,Source.Slot.Height*.3125);
    private void ClearTarget(){Target=null;Armed=false;Progress=0;}
    private double OverlapScore(Slot slot,double x)
    {
        double left=Source!.Slot.X+x-downX,width=Source.Slot.Width;
        double overlap=Math.Max(0,Math.Min(left+width,slot.X+slot.Width)-Math.Max(left,slot.X));
        // Measured overlap is primary; proximity resolves unequal-width cases
        // where a wide source completely covers more than one narrow tab.
        double proximity=1-Math.Min(1,Math.Abs(left+width/2-slot.X-slot.Width/2)/((width+slot.Width)/2));
        return overlap/Math.Min(width,slot.Width)+proximity*.25;
    }
    private bool Overlaps(Slot slot,double x,double y,double fraction)
    {
        if(Source is null)return false;
        // Translate the captured tab rectangle by the mouse delta. The original
        // grab offset is preserved, so grabbing its left or right title area
        // produces identical overlap for an identical tab displacement.
        var source=Source.Slot;
        double left=source.X+x-downX,top=source.Y+y-downY;
        double horizontal=Math.Min(left+source.Width,slot.X+slot.Width)-Math.Max(left,slot.X);
        double vertical=Math.Min(top+source.Height,slot.Y+slot.Height)-Math.Max(top,slot.Y);
        return horizontal>=Math.Min(source.Width,slot.Width)*fraction&&vertical>=Math.Min(source.Height,slot.Height)*.6;
    }
    public void Down(IdentityMap map, double x, double y, DateTimeOffset now,double? screenTop=null)
    {
        Cancel();
        if (now - map.CapturedAt > TimeSpan.FromMilliseconds(1500) || now < map.CapturedAt) return;
        var source = Mapping.SourceHit(map, x, y,screenTop);
        if (source is null || !Mapping.IsCandidate(map, source)) return;
        var selected = map.Bindings.Where(b => b.Tab.Highlighted).ToArray();
        // The mousedown itself selects a formerly inactive source. Multi-selection
        // is checked again against fresh extension state immediately before apply.
        if (selected.Length > 1) return;
        Map = map; Source = source; downX = lastPointerX = x; downY = y;travelDirection=0; began = now;live=map.Bindings.ToDictionary(b=>b.Slot.RuntimeId,b=>b.Slot);
    }
    public void UpdateLayout(Slot[] slots)
    {
        if(Map is null||Source is null)return;
        var others=Map.Bindings.Where(b=>b.Tab.Id!=Source.Tab.Id).ToArray();
        if(others.Any(b=>slots.Count(s=>s.RuntimeId==b.Slot.RuntimeId)!=1))return;
        var visible=slots.Where(s=>others.Any(b=>b.Slot.RuntimeId==s.RuntimeId)).ToArray();
        if(visible.Any(s=>s.Offscreen||!double.IsFinite(s.X)||!double.IsFinite(s.Y)||s.Width<16||s.Height<12||Math.Abs(s.Y-Map.Bindings[0].Slot.Y)>4))return;
        if(!others.Select(b=>b.Slot.RuntimeId).SequenceEqual(visible.OrderBy(s=>s.X).Select(s=>s.RuntimeId)))return;
        live=visible.ToDictionary(s=>s.RuntimeId);
        if(Target is not null&&Passed(Target))ClearTarget();
    }
    public void Move(double x, double y, DateTimeOffset now)
    {
        if (Map is null || Source is null) return;
        if (now - began > TimeSpan.FromMilliseconds(MaximumDragMilliseconds)) { Cancel(); return; }
        if (!HasMoved&&Math.Sqrt(Math.Pow(x - downX, 2) + Math.Pow(y - downY, 2)) < Math.Clamp(Source.Slot.Width*.12,4,10)) return;
        HasMoved=true;
        if(x!=lastPointerX){travelDirection=Math.Sign(x-lastPointerX);lastPointerX=x;}
        if(Target is not null)
        {
            double position=targetDirection*x;
            targetPeak=Math.Max(targetPeak,position);
            if(targetPeak-position>=RetreatDistance(Target))
            {
                // Reversing a short distance signals cancellation even while the
                // wide source still overlaps the original or reordered target.
                // Block stationary reacquisition; moving towards it again must
                // cover this small distance and start a fresh dwell.
                blockedTargetId=Target.Tab.Id;blockedAt=x;blockedDirection=targetDirection;
                ClearTarget();return;
            }
        }
        // Acquire at 16% overlap of the narrower tab and retain at 7% to avoid
        // flicker. Subtract the initial rounded-edge overlap by requiring the
        // source to move towards this target by the acquisition distance.
        bool Towards(Binding binding)=>Math.Sign(binding.Slot.X-Source.Slot.X)*(x-downX)>=Math.Min(Source.Slot.Width,Geometry(binding).Width)*AcquireOverlap;
        bool CanAcquire(Binding b)=>b.Tab.Id!=blockedTargetId||blockedDirection*(x-blockedAt)>=RetreatDistance(b);
        if(Target is not null&&Passed(Target))ClearTarget();
        var eligible=Map.Bindings.Where(b=>b.Tab.Id!=Source.Tab.Id&&Mapping.IsCandidate(Map,b)&&CanAcquire(b)&&!Passed(b)).ToArray();
        var hits=eligible.Where(b=>Towards(b)&&Overlaps(Geometry(b),x,y,AcquireOverlap)).Select(b=>(Binding:b,Score:OverlapScore(Geometry(b),x))).ToArray();
        var ranked=hits.OrderByDescending(h=>h.Score).ToArray();
        Binding? hit=null;double bestScore=0;
        if(ranked.Length>0){
            var tied=ranked.Where(h=>ranked[0].Score-h.Score<.01).ToArray();
            if(tied.Length==1){hit=tied[0].Binding;bestScore=tied[0].Score;}
            else if(Target is not null&&tied.Any(h=>h.Binding.Tab.Id==Target.Tab.Id)){hit=Target;bestScore=tied.First(h=>h.Binding.Tab.Id==Target.Tab.Id).Score;}
        }
        if(Target is not null&&Overlaps(Geometry(Target),x,y,RetainOverlap))
        {
            double retainedScore=OverlapScore(Geometry(Target),x);
            // Retain identity through Chrome reorder, but do not let a passed
            // neighbour monopolize the gesture once another clearly dominates.
            double switchMargin=.12*Math.Min(1,Math.Min(Target.Slot.Width,hit?.Slot.Width??Target.Slot.Width)/Source.Slot.Width);
            if(hit is null&&ranked.Length>0&&ranked[0].Score>retainedScore+switchMargin){ClearTarget();return;}
            if(hit is null||hit.Tab.Id==Target.Tab.Id||bestScore<=retainedScore+switchMargin)
            {Progress=Math.Clamp((now-hovering).TotalMilliseconds/DwellMilliseconds,0,1);Armed=Progress>=1;return;}
        }
        if (hit is null || hit.Tab.Id == Source.Tab.Id || !Mapping.IsCandidate(Map, hit)) { ClearTarget();return; }
        if (Target?.Tab.Id != hit.Tab.Id) { Target = hit; hovering = now; Armed = false; Progress=0;targetDirection=travelDirection!=0?travelDirection:Math.Sign(hit.Slot.X-Source.Slot.X);targetPeak=targetDirection*x;blockedTargetId=null; }
    }
    public (IdentityMap Map, int Source, int Target,double Direction)? Release(double x, double y, DateTimeOffset now)
    {
        Move(x, y, now);
        var result = Armed && Map is not null && Source is not null && Target is not null ? (Map, Source.Tab.Id, Target.Tab.Id,targetDirection) : ((IdentityMap, int, int,double)?)null;
        Cancel(); return result;
    }
    public Slot? TargetSlot => Target is null?null:live.GetValueOrDefault(Target.Slot.RuntimeId,Target.Slot);
    // Chrome keeps an attached tab on the strip: only X follows the grab point.
    // Pointer Y still participates in gesture cancellation, not visual movement.
    public Slot? SourceSlot=>VisualSourceAt(lastPointerX);
    // Visual-only projection: never changes gesture direction, cancellation or dwell.
    public Slot? VisualSourceAt(double pointerX)=>Source is null||!double.IsFinite(pointerX)?null:Source.Slot with{X=Source.Slot.X+pointerX-downX,Y=TargetSlot?.Y??Source.Slot.Y};
    public void Cancel() { Map = null; Source = Target = null; Armed = HasMoved = false;Progress=0;blockedTargetId=null;live.Clear(); }
}
