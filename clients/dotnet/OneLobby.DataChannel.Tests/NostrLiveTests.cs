using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading;
using OneLobby.Direct;
using Xunit;
using Xunit.Abstractions;

namespace OneLobby.DataChannel.Tests;

/// <summary>A fact that is skipped unless <c>ONELOBBY_LIVE_NOSTR=1</c>: it talks to real public relays and STUN servers.</summary>
public sealed class LiveNostrFactAttribute : FactAttribute
{
    public LiveNostrFactAttribute()
    {
        if (Environment.GetEnvironmentVariable("ONELOBBY_LIVE_NOSTR") != "1") Skip = "set ONELOBBY_LIVE_NOSTR=1 to run against real Nostr relays";
    }
}

public sealed class NostrLiveTests
{
    private readonly ITestOutputHelper _log;
    public NostrLiveTests(ITestOutputHelper log) { _log = log; }

    private static readonly OneLobbyConfig Cfg = new("com.onelobby.nostrlive", "1", new Uri("ws://unused.invalid/"), SyncMode.Raw);

    [LiveNostrFact]
    public void C_sharp_host_and_joiner_meet_over_real_relays() => Run();

    private void Run()
    {
        var port = 47820 + new Random().Next(0, 60);
        var hostClient = new LobbyClient(Cfg with { DisplayName = "Host", DirectPort = port }, new DataChannelTransport());
        var joinClient = new LobbyClient(Cfg with { DisplayName = "Ann", DirectPort = port }, new DataChannelTransport());
        Lobby? host = null, joiner = null;
        void Pump()
        {
            if (host != null) host.Pump(); else hostClient.Pump();
            if (joiner != null) joiner.Pump(); else joinClient.Pump();
        }
        var sw = Stopwatch.StartNew();
        var t = hostClient.HostDirectAsync(new DirectHostOptions { Port = port, FallbackPorts = 5, OpenPort = false });
        var deadline = sw.ElapsedMilliseconds + 30000;
        while (!t.IsCompleted && sw.ElapsedMilliseconds < deadline) { Pump(); Thread.Sleep(2); }
        host = t.GetAwaiter().GetResult();
        _log.WriteLine($"host up after {sw.ElapsedMilliseconds} ms: {DirectLobby.HostLogLine(host)}");
        _log.WriteLine($"JoinCode {host.JoinCode} ({host.JoinCodeKind}); DirectCode {host.DirectCode}");
        Assert.Equal(JoinCodeKind.Nostr, host.JoinCodeKind);

        var atHost = new List<string>();
        host.MessageReceived += (f, p, c) => atHost.Add(Encoding.UTF8.GetString(p.Span));
        var j = joinClient.JoinDirectAsync(host.JoinCode);
        deadline = sw.ElapsedMilliseconds + 30000;
        while (!j.IsCompleted && sw.ElapsedMilliseconds < deadline) { Pump(); Thread.Sleep(2); }
        Assert.True(j.IsCompleted, "join timed out");
        joiner = j.GetAwaiter().GetResult();
        _log.WriteLine($"joined after {sw.ElapsedMilliseconds} ms");
        deadline = sw.ElapsedMilliseconds + 30000;
        while (!joiner.ReadyAsync.IsCompleted && sw.ElapsedMilliseconds < deadline) { Pump(); Thread.Sleep(2); }
        Assert.True(joiner.ReadyAsync.IsCompletedSuccessfully, joiner.ReadyAsync.Exception?.GetBaseException().Message);
        _log.WriteLine($"data channels open after {sw.ElapsedMilliseconds} ms");
        joiner.Send(host.LocalPeerId, Encoding.UTF8.GetBytes("over nostr"));
        deadline = sw.ElapsedMilliseconds + 10000;
        while (!atHost.Contains("over nostr") && sw.ElapsedMilliseconds < deadline) { Pump(); Thread.Sleep(2); }
        Assert.Contains("over nostr", atHost);
        _log.WriteLine($"message arrived after {sw.ElapsedMilliseconds} ms");
        host.LeaveAsync();
        Pump();
        joinClient.DisposeAsync().AsTask().Wait();
        hostClient.DisposeAsync().AsTask().Wait();
    }
}
