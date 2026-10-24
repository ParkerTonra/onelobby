using System.Text.Json;
using LowkeyIndustries.Sim.Commands;
using LowkeyIndustries.Sim.Core;

namespace OneLobby.Lowkey;

/// <summary>
/// Lowkey Command &lt;-&gt; UTF-8 JSON bytes, the payload of <c>LockstepSession.Submit</c> / <c>Frame.Commands</c>.
/// It adds nothing to Lowkey's own wire format: it is the command log's format (<c>Command</c> is
/// <c>[JsonPolymorphic("$cmd")]</c>, one <c>[JsonDerivedType]</c> per concrete command) written with the Sim's own
/// <see cref="Json.Options"/>. The serializer is always asked for the base type, which is what makes it write the
/// <c>$cmd</c> discriminator first.
/// </summary>
public static class LowkeyCommandCodec
{
    public static byte[] Encode(Command command)
    {
        ArgumentNullException.ThrowIfNull(command);
        return JsonSerializer.SerializeToUtf8Bytes<Command>(command, Json.Options);
    }

    /// <summary>Throws <see cref="CommandCodecException"/> on malformed bytes, an unknown <c>$cmd</c> or a JSON null.</summary>
    public static Command Decode(ReadOnlySpan<byte> bytes)
    {
        try
        {
            return JsonSerializer.Deserialize<Command>(bytes, Json.Options)
                ?? throw new CommandCodecException("command payload is JSON null");
        }
        catch (Exception e) when (e is JsonException or NotSupportedException)
        {
            throw new CommandCodecException("bad command payload: " + e.Message, e);
        }
    }

    public static bool TryDecode(ReadOnlySpan<byte> bytes, out Command? command)
    {
        try { command = Decode(bytes); return true; }
        catch (CommandCodecException) { command = null; return false; }
    }

    /// <summary>
    /// A Dev* command is a cheat (DevCash, DevBuild, ...). A lobby host must drop these from remote peers
    /// (<c>CommandSourceExt.For</c> already marks them <c>CommandSource.Dev</c>, but marking is not refusing).
    /// </summary>
    public static bool IsDev(Command c) => c.GetType().Name.StartsWith("Dev", StringComparison.Ordinal);
}

public sealed class CommandCodecException : Exception
{
    public CommandCodecException(string message, Exception? inner = null) : base(message, inner) { }
}
