using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using DragGroup.Core;

namespace DragGroup.Native;
internal static class Desktop
{
    internal sealed record WindowTabs(nint Window,Rect Bounds,Slot[] Slots);
    private delegate bool EnumWindow(nint window,nint parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback,nint parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(nint window);
    public static WindowTabs Discover(nint preferred,string marker)
    {
        var windows=new List<nint>();
        if(IsWindowVisible(preferred)&&IsChrome(preferred))windows.Add(preferred);
        EnumWindow collect=(window,_)=>{if(window!=preferred&&IsWindowVisible(window)&&IsChrome(window))windows.Add(window);return windows.Count<32;};
        EnumWindows(collect,0);GC.KeepAlive(collect);
        foreach(var window in windows)
        {
            try{var bounds=Bounds(window);var slots=Read(window,marker);if(Bounds(window)==bounds)return new(window,bounds,slots);}
            catch{/* Other profiles/windows cannot satisfy this connection's nonce. */}
        }
        throw new InvalidOperationException("Waiting for this window's visible controller and tab strip.");
    }
    [StructLayout(LayoutKind.Sequential)] public record struct Rect(int Left,int Top,int Right,int Bottom);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(nint window,out Rect rectangle);
    public static Rect Bounds(nint window)=>GetWindowRect(window,out var bounds)?bounds:throw new InvalidOperationException("Window bounds unavailable.");
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [DllImport("user32.dll")] private static extern nint WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern nint GetAncestor(nint window,uint flags);
    public static nint WindowAt(Point point)=>GetAncestor(WindowFromPoint(point),2);
    [DllImport("user32.dll")] private static extern bool IsZoomed(nint window);
    [DllImport("user32.dll")] private static extern nint MonitorFromWindow(nint window,uint flags);
    [StructLayout(LayoutKind.Sequential)] private struct MonitorInfo { public int Size;public Rect Monitor,Work;public uint Flags; }
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern bool GetMonitorInfoW(nint monitor,ref MonitorInfo info);
    public static double? TabTopEdge(nint window)
    {
        var info=new MonitorInfo{Size=Marshal.SizeOf<MonitorInfo>()};
        if(!GetMonitorInfoW(MonitorFromWindow(window,2),ref info))return null;
        var bounds=Bounds(window);var screen=info.Monitor;
        bool fullscreen=bounds.Left<=screen.Left&&bounds.Top<=screen.Top&&bounds.Right>=screen.Right&&bounds.Bottom>=screen.Bottom;
        return IsZoomed(window)||fullscreen?screen.Top:null;
    }
    [DllImport("user32.dll")] public static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out uint process);
    [DllImport("user32.dll")] private static extern bool IsIconic(nint window);
    public static bool IsChrome(nint window)
    {
        if (window == 0 || IsIconic(window)) return false;
        try { GetWindowThreadProcessId(window, out var pid); return pid != 0 && Process.GetProcessById((int)pid).ProcessName == "chrome"; } catch { return false; }
    }
    public static Slot[] Read(nint window, string marker)
    {
        if (!IsChrome(window)) throw new InvalidOperationException("Foreground window is not a normal Chrome window.");
        var root = AutomationElement.FromHandle(window);
        // The marker is a challenge on our own extension tab, never a user's page.
        var tabs=FindStrip(root,marker);
        if (tabs.Count > 100) throw new InvalidOperationException("More than 100 visible tabs is outside the prototype scope.");
        var result = new List<Slot>();
        foreach (AutomationElement tab in tabs)
        {
            var c = tab.Current; var b = c.BoundingRectangle;
            result.Add(new(string.Join(".", tab.GetRuntimeId()), b.X, b.Y, b.Width, b.Height, c.IsOffscreen, c.Name.Contains(marker,StringComparison.Ordinal)?marker:c.Name));
        }
        return result.ToArray();
    }
    private static AutomationElementCollection FindStrip(AutomationElement root,string marker)
    {
        // Do not search web documents for browser tabs. Large page AX trees can
        // otherwise stall the observer just when a real browsing tab is selected.
        var stack=new Stack<(AutomationElement Element,int Depth)>();stack.Push((root,0));int visited=0;
        var walker=TreeWalker.ControlViewWalker;
        while(stack.Count>0&&visited++<512)
        {
            var (element,depth)=stack.Pop();var type=element.Current.ControlType;
            if(type==ControlType.Document||depth>16)continue;
            if(type==ControlType.Tab)
            {
                var tabs=element.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.TabItem));
                if(tabs.Cast<AutomationElement>().Count(t=>t.Current.Name.Contains(marker,StringComparison.Ordinal))==1)return tabs;
                continue;
            }
            for(var child=walker.GetFirstChild(element);child is not null&&stack.Count+visited<512;child=walker.GetNextSibling(child))stack.Push((child,depth+1));
        }
        throw new InvalidOperationException("Activate the opted-in window; controller challenge not visible in the browser tab strip.");
    }
}
internal sealed class PointerObserver : IDisposable
{
    private delegate nint Hook(int code,nint message,nint data);
    [DllImport("user32.dll",SetLastError=true)] private static extern nint SetWindowsHookExW(int id,Hook procedure,nint module,uint thread);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(nint hook);
    [DllImport("user32.dll")] private static extern nint CallNextHookEx(nint hook,int code,nint message,nint data);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] private static extern nint GetModuleHandleW(string? module);
    private readonly Hook callback;
    private nint handle;
    public PointerObserver(Action<int,Desktop.Point> observe)
    {
        callback=(code,message,data)=>
        {
            try{if(code>=0&&(message==0x200||message==0x201||message==0x202))observe((int)message,Marshal.PtrToStructure<Desktop.Point>(data));}catch{/* Always pass input through, including on callback failure. */}
            return CallNextHookEx(0,code,message,data);
        };
        handle=SetWindowsHookExW(14,callback,GetModuleHandleW(null),0);
        if(handle==0)throw new InvalidOperationException("Mouse observer could not start.");
    }
    public void Dispose(){if(handle!=0){UnhookWindowsHookEx(handle);handle=0;}GC.KeepAlive(callback);}
}
internal sealed class Feedback : IDisposable
{
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong(nint window, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] private static extern int SetWindowLong(nint window, int index, int value);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(nint window, nint after, int x, int y, int width, int height, uint flags);
    private Window? window;
    private FeedbackSurface? surface;
    private Desktop.Rect? placement;
    public void Show(Slot source,Slot target, bool armed,Desktop.Rect browserBounds)
    {
        if (window is null)
        {
            surface=new FeedbackSurface();
            window = new Window { Width=1,Height=1,ShowActivated = false, ShowInTaskbar = false, Topmost = true, WindowStyle = WindowStyle.None, ResizeMode = ResizeMode.NoResize, AllowsTransparency = true, Background = Brushes.Transparent, IsHitTestVisible = false, Content = surface };
            window.SourceInitialized += (_, _) => { var handle = new WindowInteropHelper(window).Handle; SetWindowLong(handle, -20, GetWindowLong(handle, -20) | 0x20 | 0x08000000 | 0x80); };
        }
        double padding=Math.Max(source.Height,target.Height)*.12;
        // Keep the transparent window anchored to the browser strip. Moving a
        // small layered window before WPF repaints can carry its previous pixels.
        int left=browserBounds.Left,top=browserBounds.Top,right=browserBounds.Right;
        int bottom=(int)Math.Ceiling(Math.Max(source.Y+source.Height,target.Y+target.Height)+padding);
        var bounds=new Desktop.Rect(left,top,right,bottom);
        if(placement!=bounds)
        {
            window.Hide();surface!.Clear();
            var handle=new WindowInteropHelper(window).EnsureHandle();
            if(!SetWindowPos(handle,new nint(-1),left,top,right-left,bottom-top,0x10))throw new InvalidOperationException("Overlay positioning failed.");
            placement=bounds;
        }
        if (!window.IsVisible)
        {
            // Show an empty surface first: Show may apply WPF initial sizing.
            // Reapply physical bounds before committing the fresh drawing.
            window.Show();
            if(!SetWindowPos(new WindowInteropHelper(window).Handle,new nint(-1),left,top,right-left,bottom-top,0x10))throw new InvalidOperationException("Overlay positioning failed.");
        }
        surface!.SetState(source,target,left,top,armed);
    }
    public void Hide() {surface?.Clear();window?.Hide();}
    public void Dispose() { window?.Close(); window = null; }
}
internal sealed class EscapeObserver : IDisposable
{
    private delegate nint Hook(int code,nint message,nint data);
    [DllImport("user32.dll",SetLastError=true)] private static extern nint SetWindowsHookExW(int id,Hook procedure,nint module,uint thread);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(nint hook);
    [DllImport("user32.dll")] private static extern nint CallNextHookEx(nint hook,int code,nint message,nint data);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] private static extern nint GetModuleHandleW(string? module);
    private readonly Hook callback;
    private nint handle;
    public EscapeObserver(Action escape)
    {
        callback=(code,message,data)=>{if(code>=0&&(message==0x100||message==0x104)&&Marshal.ReadInt32(data)==0x1B)escape();return CallNextHookEx(0,code,message,data);};
        handle=SetWindowsHookExW(13,callback,GetModuleHandleW(null),0);
        if(handle==0)throw new InvalidOperationException("Escape cancellation observer could not start.");
    }
    public void Dispose(){if(handle!=0){UnhookWindowsHookEx(handle);handle=0;}GC.KeepAlive(callback);}
}
