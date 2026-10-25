using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using OneLobby.DataChannel;
using OneLobby.Server;
using Xunit;
using Xunit.Abstractions;

namespace OneLobby.DataChannel.Tests;

/// <summary>
/// Real WebRTC: two DataChannelTransport peers (libdatachannel) in one process, signaling through a real OneLobby.Server
/// on a loopback port. Needs the native library (native/build-windows.ps1 or build-linux.sh); without it the test fails
/// with a pointer to the build script rather than passing silently.
/// </summary>
public sealed class LiveWebRtcTests : IAsyncLifetime
{
    private readonly ITestOutputHelper _log;
    private WebApplication _app = null!;
    private string _ws = "";

    public LiveWebRtcTests(ITestOutputHelper log) { _log = log; }

    public async Task InitializeAsync()
    {
        _app = ServerApp.Build(new ServerOptions { RateScale = 20 }, listenUrl: "http://127.0.0.1:0");
        await _app.StartAsync();
        var http = _app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        _ws = http.Replace("http://", "ws://") + "/ws";
    }

    public async Task DisposeAsync() { await _app.StopAsync(); await _app.DisposeAsync(); }

    private static void PumpUntil(Func<bool> done, Action pump, string what, int timeoutMs = 20000)
    {
        var sw = Stopwatch.StartNew();
        while (!done())
        {
            pump();
            if (sw.ElapsedMilliseconds > timeoutMs) throw new TimeoutException("timed out: " + what);
            Thread.Sleep(2);
        }
    }

    [Fact]
    public void TwoPeersConnectAndExchangeReliableFastAndBroadcast()
    {
        var logs = new ConcurrentQueue<string>();
        Action<string> sink = logs.Enqueue;
        DataChannelTransport.NativeLog += sink;
        try { Run(); }
        finally
        {
            DataChannelTransport.NativeLog -= sink;
            foreach (var l in logs) _log.WriteLine(l);
        }
    }

    private void Run()
    {
        var cfg = new OneLobbyConfig("com.onelobby.dctest", "1", new Uri(_ws), SyncMode.Raw);
        var hostClient = new LobbyClient(cfg with { DisplayName = "Host" }, new DataChannelTransport());
        var joinClient = new LobbyClient(cfg with { DisplayName = "Joiner" }, new DataChannelTransport());
        Lobby? host = null, joiner = null;
        void Pump()
        {
            if (host != null) host.Pump(); else hostClient.Pump();
            if (joiner != null) joiner.Pump(); else joinClient.Pump();
        }
        var sw = Stopwatch.StartNew();

        var ht = hostClient.HostAsync(new LobbyOptions("dc loopback", MaxPlayers: 2));
        PumpUntil(() => ht.IsCompleted, Pump, "host");
        host = ht.GetAwaiter().GetResult();
        var atHost = new List<(int From, string Text, Channel Ch)>();
        host.MessageReceived += (f, p, c) => atHost.Add((f, Encoding.UTF8.GetString(p.Span), c));

        var jt = joinClient.JoinAsync(host.Code);
        PumpUntil(() => jt.IsCompleted, Pump, "join");
        joiner = jt.GetAwaiter().GetResult();
        var atJoiner = new List<string>();
        joiner.MessageReceived += (f, p, c) => atJoiner.Add(Encoding.UTF8.GetString(p.Span));
        PumpUntil(() => joiner.ReadyAsync.IsCompleted, Pump, "joiner ready (data channels open)");
        Assert.True(joiner.ReadyAsync.IsCompletedSuccessfully, joiner.ReadyAsync.Exception?.GetBaseException().Message);
        _log.WriteLine($"WebRTC link open after {sw.ElapsedMilliseconds} ms (code {host.Code})");

        joiner.Send(host.LocalPeerId, Encoding.UTF8.GetBytes("hello over libdatachannel"));
        PumpUntil(() => atHost.Any(m => m.Ch == Channel.Reliable), Pump, "reliable at host");
        var r = atHost.First(m => m.Ch == Channel.Reliable);
        Assert.Equal("hello over libdatachannel", r.Text);
        Assert.Equal(joiner.LocalPeerId, r.From);

        var tries = 0;
        PumpUntil(() =>
        {
            if (tries++ % 20 == 0) joiner.Send(host.LocalPeerId, Encoding.UTF8.GetBytes("fast"), Channel.Fast);
            return atHost.Any(m => m.Ch == Channel.Fast);
        }, Pump, "fast at host");

        // a small broadcast and a 15 KiB one (many SCTP fragments, still one OneLobby frame) arrive intact
        // (larger payloads are chunked by Core: LargeMessageTests).
        var big = new string('x', 15 * 1024);
        host.Broadcast(Encoding.UTF8.GetBytes("welcome"));
        host.Broadcast(Encoding.UTF8.GetBytes(big));
        PumpUntil(() => atJoiner.Contains("welcome") && atJoiner.Contains(big), Pump, "broadcasts at joiner");

        // the IPeerLink contract: reliable frames arrive in send order, exactly once
        atJoiner.Clear();
        for (var i = 0; i < 2000; i++) host.Send(joiner.LocalPeerId, Encoding.UTF8.GetBytes("n" + i));
        PumpUntil(() => atJoiner.Count >= 2000, Pump, "2000 reliable frames at joiner");
        Pump();
        Assert.Equal(Enumerable.Range(0, 2000).Select(i => "n" + i), atJoiner);

        var roster = string.Join(", ", host.Peers.Select(p => $"{p.PeerId}:{p.Name} relayed={p.Relayed}"));
        _log.WriteLine($"PASS in {sw.ElapsedMilliseconds} ms; host roster: {roster}");
        Assert.Equal(2, host.Peers.Count);

        // FlushAsync then an immediate leave: 2 MB queued in libdatachannel all reach the host before PeerLeft
        atHost.Clear();
        var hostSawLeave = false;
        var countAtLeave = -1;
        host.PeerLeft += (_, _) => { hostSawLeave = true; countAtLeave = atHost.Count; };
        var chunk = new string('y', 4096);
        for (var i = 0; i < 500; i++) joiner.Send(host.LocalPeerId, Encoding.UTF8.GetBytes(i + ":" + chunk));
        _log.WriteLine($"queued after send: {joiner.ReliableBufferedBytes} bytes");
        var flush = joiner.FlushAsync(TimeSpan.FromSeconds(15));
        PumpUntil(() => flush.IsCompleted, Pump, "joiner flush");
        Assert.True(flush.GetAwaiter().GetResult());
        Assert.Equal(0, joiner.ReliableBufferedBytes);
        joiner.LeaveAsync();
        PumpUntil(() => hostSawLeave, Pump, "host sees joiner leave");
        Assert.Equal(500, countAtLeave);
        Assert.Equal(Enumerable.Range(0, 500).Select(i => i + ":" + chunk), atHost.Select(m => m.Text));
        Assert.Single(host.Peers);
        host.LeaveAsync();
        joinClient.DisposeAsync().AsTask().Wait();
        hostClient.DisposeAsync().AsTask().Wait();
    }

    [Fact]
    public void TurnUrlsGetCredentialsInLibdatachannelForm()
    {
        Assert.Equal("stun:stun.example.org:3478", DataChannelPeerLink.ToLibUrl("stun:stun.example.org:3478", null, null));
        Assert.Equal("turn:1700000000%3A3:a%2Bb%2F%3D@turn.example.org:3478?transport=udp",
            DataChannelPeerLink.ToLibUrl("turn:turn.example.org:3478?transport=udp", "1700000000:3", "a+b/="));
        Assert.Null(DataChannelPeerLink.ToLibUrl("http://x", "u", "p"));
    }
}
