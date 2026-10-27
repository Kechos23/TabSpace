using System.Text.Json;
using TabSpace.Native.Protocol;
using System.IO;

namespace TabSpace.Native;
public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--inspect") { try { Console.WriteLine(JsonSerializer.Serialize(Inspector.InspectForeground())); return 0; } catch { Console.Error.WriteLine("UIA inspection unavailable."); return 2; } }
        try
        {
            var manifestPath = Path.Combine(AppContext.BaseDirectory, "com.tabspace.native.json");
            using var manifest = JsonDocument.Parse(File.ReadAllText(manifestPath));
            if (args.Length == 0 || !manifest.RootElement.GetProperty("allowed_origins").EnumerateArray().Any(o => string.Equals(o.GetString(), args[0], StringComparison.Ordinal)) || !System.Text.RegularExpressions.Regex.IsMatch(args[0], "^chrome-extension://[a-p]{32}/$")) { Console.Error.WriteLine("Unauthorized native origin."); return 3; }
            return Run().GetAwaiter().GetResult();
        }
        catch { Console.Error.WriteLine("Native host configuration or protocol unavailable."); return 2; }
    }
    private static async Task<int> Run()
    {
        var codec = new FrameCodec(Console.OpenStandardInput(), Console.OpenStandardOutput());
        using var cancellation = new CancellationTokenSource();
        while (true)
        {
            using var frame = await codec.Read(cancellation.Token); if (frame is null) return 0;
            var message = frame.RootElement;
            if (message.ValueKind != JsonValueKind.Object || message.GetProperty("protocolVersion").GetInt32() != 1) return 4;
            var properties = message.EnumerateObject().Select(p => p.Name).ToArray();
            if (properties.Distinct(StringComparer.Ordinal).Count() != properties.Length || properties.Any(p => p != "type" && p != "protocolVersion" && p != "requestId")) return 4;
            var type = message.GetProperty("type").GetString();
            if (type == "shutdown" || type == "cancel") return 0;
            if (type != "hello" || !Guid.TryParse(message.GetProperty("requestId").GetString(), out _)) return 4;
            await codec.Write(new { protocolVersion = 1, type = "capabilities", message = "Connected diagnostic host — gesture disabled pending identity/DPI acceptance", gestureEnabled = false }, cancellation.Token);
        }
    }
}
