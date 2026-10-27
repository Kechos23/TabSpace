using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Automation;

namespace TabSpace.Native;
public static class Inspector
{
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out uint process);
    public static object InspectForeground()
    {
        var hwnd = GetForegroundWindow(); GetWindowThreadProcessId(hwnd, out var pid);
        if (pid == 0 || Process.GetProcessById((int)pid).ProcessName != "chrome") return new { supported = false, reason = "Foreground application is not Chrome." };
        var root = AutomationElement.FromHandle(hwnd);
        var conditions = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem);
        var elements = root.FindAll(TreeScope.Descendants, conditions);
        var bounds = new List<object>();
        foreach (AutomationElement element in elements)
        {
            if (bounds.Count >= 300) break; // bounded diagnostic output, never a desktop-wide scan on mouse move
            var c = element.Current; if (c.IsOffscreen) continue;
            var b = c.BoundingRectangle;
            bounds.Add(new { x = b.X, y = b.Y, width = b.Width, height = b.Height });
        }
        return new { supported = false, reason = "Tab geometry available; profile/tab identity is unproven. Gesture disabled.", visibleTabs = bounds.Count, bounds };
    }
}
