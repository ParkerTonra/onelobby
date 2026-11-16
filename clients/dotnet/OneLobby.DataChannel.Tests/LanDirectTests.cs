using System;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;
using OneLobby.Direct;
using Xunit;

namespace OneLobby.DataChannel.Tests;

/// <summary>
/// LAN discovery wired into a real direct host (spec/lan-discovery.md): everything on 127.0.0.1. The host listens on loopback only,
/// the finder is asked to ask 127.0.0.1, so no packet leaves the machine. These bind sockets: CI runs them, a dev PC need not.
/// </summary>
public sealed class LanDirectTests
{
    private static readonly OneLobbyConfig Cfg = new("com.onelobby.lantest", "1", new Uri("ws://unused.invalid/"), SyncMode.Raw);

    private static int FreeUdpPort()
    {
        using var u = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        return ((IPEndPoint)u.Client.LocalEndPoint!).Port;
    }

    private static void PumpUntil(Func<bool> done, Action pump, string what, int timeoutMs = 20000)
    {
        var sw = Stopwatch.StartNew();
        while (!done())
        {
            pump();
            if (sw.ElapsedMilliseconds > timeoutMs) throw new TimeoutException("timed out: " + what);
            Thread.Sleep(5);
        }
    }

    [Fact]
    public async Task AHostWithLanOnIsFoundOnLoopbackAndTheRowGoesWhenTheLobbyCloses()
    {
        NativeLib.Require();
        var lanPort = FreeUdpPort();
        var client = new LobbyClient(Cfg with { DisplayName = "Sam" }, new DataChannelTransport { BindAddress = "127.0.0.1" });
        var task = client.HostDirectAsync(new DirectHostOptions
        {
            BindAddress = IPAddress.Loopback, Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, OpenPort = false,
            MaxPlayers = 3, Password = "pw", Lan = true, LanPort = lanPort,
        });
        PumpUntil(() => task.IsCompleted, () => client.Pump(), "host");
        var host = await task;
        var finder = client.CreateLanFinder(new LanFinderOptions { Targets = new[] { "127.0.0.1" }, Port = lanPort, AskIntervalMs = 100, MinGapMs = 40, RowTimeoutMs = 600, Enabled = true });
        Assert.Equal(LanFinderStatus.Running, finder.Start());
        PumpUntil(() => finder.Games.Count == 1, () => { host.Pump(); finder.Pump(); }, "the row appears");
        var row = finder.Games[0];
        Assert.Equal("127.0.0.1", row.Address);
        Assert.Equal(("Sam's game", "Sam", 1, 3, true, true), (row.LobbyName, row.HostName, row.Players, row.MaxPlayers, row.HasPassword, row.SameVersion));
        Assert.True(row.Port > 0);
        _ = host.LeaveAsync();
        PumpUntil(() => finder.Games.Count == 0, () => finder.Pump(), "the row goes after the lobby closed");
        finder.Stop();
        await client.DisposeAsync();
    }

    [Fact]
    public async Task AHostWithLanOffOpensNoLanSocket()
    {
        NativeLib.Require();
        var lanPort = FreeUdpPort();
        var client = new LobbyClient(Cfg with { DisplayName = "Sam" }, new DataChannelTransport { BindAddress = "127.0.0.1" });
        var created = 0;
        var task = client.HostDirectAsync(new DirectHostOptions
        {
            BindAddress = IPAddress.Loopback, Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, OpenPort = false,
            Lan = false, LanPort = lanPort, LanUdp = () => { created++; return new SystemLanUdp(); },
        });
        PumpUntil(() => task.IsCompleted, () => client.Pump(), "host");
        var host = await task;
        Assert.Equal(0, created);
        // and the LAN port is free: nothing listens on it
        using (var probe = new UdpClient(new IPEndPoint(IPAddress.Loopback, lanPort))) { }
        _ = host.LeaveAsync();
        await client.DisposeAsync();
    }
}
