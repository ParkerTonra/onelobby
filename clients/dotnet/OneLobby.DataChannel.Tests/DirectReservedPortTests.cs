using System;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using OneLobby.Direct;
using Xunit;

namespace OneLobby.DataChannel.Tests;

/// <summary>
/// Windows reserves port ranges (Hyper-V, WSL, Docker: `netsh int ipv4 show excludedportrange`); binding one fails with
/// AccessDenied, not AddressAlreadyInUse. A host whose default port is reserved must fall back like a busy one.
/// </summary>
public sealed class DirectReservedPortTests
{
    private static readonly OneLobbyConfig Cfg = new("com.onelobby.directtest", "1", new Uri("ws://unused.invalid/"), SyncMode.Raw);

    [Fact]
    public void ReservedDefaultPortFallsBackToTheNextOne()
    {
        var port = ReservedPortWithFreeNeighbour();
        if (port == 0) return; // not Windows, or no reserved range with a free port right after it
        var c = new LobbyClient(Cfg with { DirectPort = port }, new DataChannelTransport { BindAddress = "127.0.0.1" });
        var lobby = Await(c.HostDirectAsync(new DirectHostOptions { BindAddress = System.Net.IPAddress.Loopback, Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, OpenPort = false, FallbackPorts = 1 }), c.Pump);
        Assert.True(JoinCode.TryDecode(lobby.JoinCode, out _, out var p, out _));
        Assert.Equal(port + 1, p);
        lobby.LeaveAsync();
    }

    private static Lobby Await(Task<Lobby> t, Action pump)
    {
        var sw = Stopwatch.StartNew();
        while (!t.IsCompleted && sw.Elapsed < TimeSpan.FromSeconds(10)) { pump(); Thread.Sleep(5); }
        return t.GetAwaiter().GetResult();
    }

    private static int ReservedPortWithFreeNeighbour()
    {
        if (!OperatingSystem.IsWindows()) return 0;
        string text;
        try
        {
            var psi = new ProcessStartInfo("netsh", "int ipv4 show excludedportrange protocol=tcp")
            { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true };
            using var proc = Process.Start(psi)!;
            text = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit(5000);
        }
        catch (Exception) { return 0; }
        foreach (Match m in Regex.Matches(text, @"^\s*(\d+)\s+(\d+)", RegexOptions.Multiline))
        {
            var end = int.Parse(m.Groups[2].Value);
            if (end >= 65535 || !Reserved(end) || !Free(end + 1)) continue;
            return end;
        }
        return 0;
    }

    private static bool Reserved(int port)
    {
        try { using var t = new TcpListener(IPAddress.Loopback, port); t.Start(); t.Stop(); return false; }
        catch (SocketException e) { return e.SocketErrorCode == SocketError.AccessDenied; }
    }

    private static bool Free(int port)
    {
        try
        {
            var t = new TcpListener(IPAddress.Loopback, port);
            t.Start();
            t.Stop();
            using var u = new UdpClient(new IPEndPoint(IPAddress.Loopback, port));
            return true;
        }
        catch (SocketException) { return false; }
    }
}
