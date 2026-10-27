using System.Buffers.Binary;
using System.Text;
using System.Text.Json;

namespace TabSpace.Native.Protocol;
public sealed class FrameCodec(Stream input, Stream output)
{
    public const int MaxBytes = 64 * 1024;
    private readonly SemaphoreSlim writer = new(1, 1);
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static async Task<bool> ReadExact(Stream stream, Memory<byte> buffer, bool allowEmpty, CancellationToken token)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer[offset..], token);
            if (read == 0)
            {
                if (allowEmpty && offset == 0) return false;
                throw new EndOfStreamException("Truncated native frame.");
            }
            offset += read;
        }
        return true;
    }
    public async Task<JsonDocument?> Read(CancellationToken token = default)
    {
        var header = new byte[4];
        if (!await ReadExact(input, header, true, token)) return null;
        var size = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (size is 0 or > MaxBytes) throw new InvalidDataException("Native frame size rejected.");
        var bytes = new byte[(int)size];
        await ReadExact(input, bytes, false, token);
        var text = Utf8.GetString(bytes);
        return JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 16, AllowTrailingCommas = false });
    }
    public async Task Write<T>(T value, CancellationToken token = default)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        if (bytes.Length > MaxBytes) throw new InvalidDataException("Native output too large.");
        var header = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(header, bytes.Length);
        await writer.WaitAsync(token);
        try { await output.WriteAsync(header, token); await output.WriteAsync(bytes, token); await output.FlushAsync(token); }
        finally { writer.Release(); }
    }
}
