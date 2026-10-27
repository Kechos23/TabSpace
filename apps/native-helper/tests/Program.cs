using System.Buffers.Binary;
using System.Text;
using TabSpace.Native.Protocol;

static void Check(bool ok, string test) { if (!ok) throw new Exception(test); }
static async Task Reject(Func<Task> work) { try { await work(); } catch { return; } throw new Exception("Expected rejection."); }
var text = Encoding.UTF8.GetBytes("{\"type\":\"hello\"}"); var bytes = new byte[text.Length + 4]; BinaryPrimitives.WriteInt32LittleEndian(bytes, text.Length); text.CopyTo(bytes, 4);
var output = new MemoryStream(); var codec = new FrameCodec(new FragmentStream(bytes), output);
using (var message = await codec.Read()) Check(message!.RootElement.GetProperty("type").GetString() == "hello", "fragmented exact read");
Check(await codec.Read() is null, "clean EOF");
await Reject(async () => await new FrameCodec(new MemoryStream(bytes[..^1]), output).Read());
var large = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(large, FrameCodec.MaxBytes + 1); await Reject(async () => await new FrameCodec(new MemoryStream(large), output).Read());
await Reject(async () => await new FrameCodec(new MemoryStream([1, 0, 0, 0, 255]), output).Read());
await Task.WhenAll(Enumerable.Range(0, 20).Select(i => codec.Write(new { i })));
output.Position = 0; var reader = new FrameCodec(output, new MemoryStream()); var seen = new HashSet<int>();
while (await reader.Read() is { } frame) { using (frame) seen.Add(frame.RootElement.GetProperty("i").GetInt32()); }
Check(seen.Count == 20, "serialized concurrent writes");
var now = DateTimeOffset.UtcNow; var map = new FrozenMap("generation", 1, now, [new(1, 7, "A", false, -200, 0, 100, 30), new(2, 7, "B", false, -100, 0, 100, 30)], true, true);
Check(IdentityResolver.Validate(map, now), "valid negative coordinates");
Check(!IdentityResolver.Validate(map with { ProfileProven = false }, now), "unproven profile rejection");
Check(!IdentityResolver.Validate(map with { CompleteStrip = false }, now), "overflow rejection");
Check(!IdentityResolver.Validate(map with { Tabs = [map.Tabs[0], map.Tabs[1] with { Label = "A" }] }, now), "duplicate labels rejection");
var gesture = new GestureMachine();gesture.Down(map, -150, 15, now);gesture.Move(-50, 15, now.AddMilliseconds(40), true, 1);gesture.Move(-50, 15, now.AddMilliseconds(750), true, 1);Check(gesture.Release(-50, 15, now.AddMilliseconds(800), 1) == (1, 2, 7), "deliberate dwell fixture");
gesture.Down(map, -150, 15, now);gesture.Move(-50, 15, now.AddMilliseconds(40), true, 1);Check(gesture.Release(-50, 15, now.AddMilliseconds(100), 1) is null, "normal reorder fixture");
gesture.Down(map, -150, 15, now);gesture.Move(-50, 15, now.AddMilliseconds(800), true, 2);Check(gesture.Release(-50, 15, now.AddMilliseconds(900), 2) is null, "generation cancellation");
Console.WriteLine("Native protocol and gesture fixture checks passed (14 assertions). Real Chrome gesture acceptance remains pending.");
sealed class FragmentStream(byte[] bytes) : MemoryStream(bytes)
{ public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => base.ReadAsync(buffer[..Math.Min(buffer.Length, 1)], cancellationToken); }
