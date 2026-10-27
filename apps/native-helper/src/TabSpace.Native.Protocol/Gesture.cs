namespace TabSpace.Native.Protocol;

public enum GesturePhase { Idle, Candidate, Dragging, HoverTarget, Armed, Released, Cancelled }
public record TabIdentity(int TabId, int WindowId, string Label, bool Pinned, double X, double Y, double Width, double Height);
public record FrozenMap(string ConnectionGeneration, long MappingGeneration, DateTimeOffset CapturedAt, IReadOnlyList<TabIdentity> Tabs, bool ProfileProven, bool CompleteStrip);
public static class IdentityResolver
{
    public static bool Validate(FrozenMap map, DateTimeOffset now)
    {
        if (!map.ProfileProven || !map.CompleteStrip || now - map.CapturedAt > TimeSpan.FromSeconds(2) || map.CapturedAt > now || map.Tabs.Count < 2) return false;
        if (map.Tabs.Select(t => t.TabId).Distinct().Count() != map.Tabs.Count || map.Tabs.Select(t => t.WindowId).Distinct().Count() != 1) return false;
        if (map.Tabs.Select(t => t.Label).Distinct(StringComparer.Ordinal).Count() != map.Tabs.Count) return false;
        if (map.Tabs.Any(t => t.Width <= 0 || t.Height <= 0 || !double.IsFinite(t.X) || !double.IsFinite(t.Y) || !double.IsFinite(t.Width) || !double.IsFinite(t.Height))) return false;
        for (int i = 0; i < map.Tabs.Count; i++) for (int j = i + 1; j < map.Tabs.Count; j++)
        { var a = map.Tabs[i]; var b = map.Tabs[j]; if (a.X < b.X + b.Width && b.X < a.X + a.Width && a.Y < b.Y + b.Height && b.Y < a.Y + a.Height) return false; }
        return true;
    }
    public static TabIdentity? Hit(FrozenMap map, double x, double y, bool centerOnly)
    {
        var candidates = map.Tabs.Where(t => x >= t.X + (centerOnly ? t.Width * .25 : 0) && x < t.X + t.Width * (centerOnly ? .75 : 1) && y >= t.Y && y < t.Y + t.Height).ToArray();
        return candidates.Length == 1 && !candidates[0].Pinned ? candidates[0] : null;
    }
}
public sealed class GestureMachine
{
    public GesturePhase Phase { get; private set; } = GesturePhase.Idle;
    private FrozenMap? map; private TabIdentity? source, target; private double downX, downY; private DateTimeOffset began, hoverBegan;
    public void Down(FrozenMap frozen, double x, double y, DateTimeOffset now)
    {
        Cancel(); if (!IdentityResolver.Validate(frozen, now)) return;
        var hit = IdentityResolver.Hit(frozen, x, y, false); if (hit is null) return;
        map = frozen; source = hit; downX = x; downY = y; began = now; Phase = GesturePhase.Candidate;
    }
    public void Move(double x, double y, DateTimeOffset now, bool focused, long generation)
    {
        if (map is null || source is null || !focused || generation != map.MappingGeneration || now - began > TimeSpan.FromSeconds(8)) { Cancel(); return; }
        if (Phase == GesturePhase.Candidate && Math.Sqrt(Math.Pow(x - downX, 2) + Math.Pow(y - downY, 2)) < 8) return;
        var hit = IdentityResolver.Hit(map, x, y, true);
        if (hit is null || hit.TabId == source.TabId) { target = null; Phase = GesturePhase.Dragging; return; }
        if (target?.TabId != hit.TabId) { target = hit; hoverBegan = now; Phase = GesturePhase.HoverTarget; }
        else if (now - hoverBegan >= TimeSpan.FromMilliseconds(650)) Phase = GesturePhase.Armed;
    }
    public (int Source, int Target, int Window)? Release(double x, double y, DateTimeOffset now, long generation)
    {
        var result = Phase == GesturePhase.Armed && map is not null && source is not null && target is not null && generation == map.MappingGeneration && now - began <= TimeSpan.FromSeconds(8) && IdentityResolver.Hit(map, x, y, true)?.TabId == target.TabId ? (source.TabId, target.TabId, source.WindowId) : ((int, int, int)?)null;
        Cancel(); Phase = result is null ? GesturePhase.Cancelled : GesturePhase.Released; return result;
    }
    public void Cancel() { map = null; source = target = null; Phase = GesturePhase.Cancelled; }
}
