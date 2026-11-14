using System;
using System.Runtime.InteropServices;

namespace OneLobby.DataChannel.Tests;

/// <summary>
/// The live WebRTC tests need libdatachannel (datachannel.dll / libdatachannel.so, built by native/build-windows.ps1 or
/// build-posix.sh; the runtimes/ folder is not committed). Without it every peer link fails at creation and the tests
/// would wait for their whole timeout before saying "timed out: ... ready"; <see cref="Require"/> fails at once with the
/// cause instead.
/// </summary>
internal static class NativeLib
{
    private static readonly Lazy<string?> Problem = new(Probe);

    public static void Require()
    {
        if (Problem.Value is { } p) throw new InvalidOperationException(p);
    }

    private static string? Probe()
    {
        try
        {
            // the same lookup the DllImport does: next to the assembly, then the runtime's native search path
            if (NativeLibrary.TryLoad(Rtc.Lib, typeof(DataChannelTransport).Assembly, null, out var h))
            {
                NativeLibrary.Free(h);
                return null;
            }
        }
        catch (Exception e) when (e is DllNotFoundException or BadImageFormatException) { }
        return "libdatachannel (" + Rtc.Lib + ") cannot be loaded, so no peer link can open. Build it with "
            + "clients/dotnet/OneLobby.DataChannel/native/build-windows.ps1 (or build-posix.sh), or download the native-win-x64 / "
            + "native-linux-x64 artifact of the datachannel-natives workflow into clients/dotnet/OneLobby.DataChannel/runtimes/<rid>/native/.";
    }
}
