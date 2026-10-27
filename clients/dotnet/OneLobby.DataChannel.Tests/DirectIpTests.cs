using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using OneLobby.Direct;
using OneLobby.Server;
using Xunit;
using Xunit.Abstractions;

namespace OneLobby.DataChannel.Tests;

/// <summary>
/// Direct IP (docs/direct-ip.md) with real libdatachannel over loopback, all in one process: the host runs the hub and
/// listens on TCP P, its peer links share UDP P (ICE UDP mux), joiners dial the typed address. No server anywhere.
/// </summary>
public sealed class DirectIpTests
{
    private readonly ITestOutputHelper _log;
    public DirectIpTests(ITestOutputHelper log) { _log = log; }

    private static readonly OneLobbyConfig Cfg = new("com.onelobby.directtest", "1", new Uri("ws://unused.invalid/"), SyncMode.Raw);

    private static readonly Random PortRng = new();

    /// <summary>
    /// A port that is free right now for both TCP and UDP on all IPv4 interfaces, plus the next <paramref name="span"/>-1
    /// ports after it. Candidates come from the OS (bind port 0, TCP-first and UDP-first in turn) and then from a random
    /// scan of 20000-45000, so a machine short of ephemeral ports or with excluded ranges (Hyper-V, WSL) still finds one.
    /// </summary>
    private static int FreePort(int span = 1)
    {
        for (var i = 0; i < 400; i++)
        {
            int p;
            if (i < 100) { var os = OsPort(udpFirst: i % 2 == 1); if (os <= 0) continue; p = os; }
            else lock (PortRng) p = PortRng.Next(20000, 45000);
            if (p + span - 1 > 65535) continue;
            if (RangeFree(p, span)) return p;
        }
        throw new InvalidOperationException($"no free TCP+UDP port run of {span} found");
    }

    private static int OsPort(bool udpFirst)
    {
        try
        {
            if (udpFirst)
            {
                using var u = new UdpClient(new IPEndPoint(IPAddress.Any, 0));
                return ((IPEndPoint)u.Client.LocalEndPoint!).Port;
            }
            var t = new TcpListener(IPAddress.Any, 0);
            t.Start();
            try { return ((IPEndPoint)t.LocalEndpoint).Port; } finally { t.Stop(); }
        }
        catch (SocketException) { return -1; }
    }

    private static bool RangeFree(int first, int span)
    {
        var held = new List<IDisposable>();
        try
        {
            for (var p = first; p < first + span; p++)
            {
                var t = new TcpListener(IPAddress.Any, p);
                t.Start();
                held.Add(new Stopper(t));
                held.Add(new UdpClient(new IPEndPoint(IPAddress.Any, p)));
            }
            return true;
        }
        catch (SocketException) { return false; }
        finally { foreach (var h in held) h.Dispose(); }
    }

    private sealed class Stopper : IDisposable
    {
        private readonly TcpListener _t;
        public Stopper(TcpListener t) { _t = t; }
        public void Dispose() => _t.Stop();
    }

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

    private static Lobby Await(Task<Lobby> t, Action pump, string what)
    {
        PumpUntil(() => t.IsCompleted, pump, what);
        return t.GetAwaiter().GetResult();
    }

    [Fact]
    public void HostAndTwoJoinersOverOneForwardablePort()
    {
        var logs = new ConcurrentQueue<string>();
        Action<string> sink = logs.Enqueue;
        DataChannelTransport.NativeLog += sink;
        try { RunTwoJoiners(); }
        finally
        {
            DataChannelTransport.NativeLog -= sink;
            foreach (var l in logs.Take(200)) _log.WriteLine(l);
        }
    }

    private void RunTwoJoiners()
    {
        var port = FreePort();
        var hostTransport = new DataChannelTransport();
        var hostClient = new LobbyClient(Cfg with { DisplayName = "Host", DirectPort = port }, hostTransport);
        var aClient = new LobbyClient(Cfg with { DisplayName = "Ann", DirectPort = port }, new DataChannelTransport());
        var bClient = new LobbyClient(Cfg with { DisplayName = "Bob", DirectPort = port }, new DataChannelTransport());
        Lobby? host = null, a = null, b = null;
        void Pump()
        {
            if (host != null) host.Pump(); else hostClient.Pump();
            if (a != null) a.Pump(); else aClient.Pump();
            if (b != null) b.Pump(); else bClient.Pump();
        }
        var sw = Stopwatch.StartNew();

        host = Await(hostClient.HostDirectAsync(new DirectHostOptions { Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, Password = "pw", MaxPlayers = 3, OpenPort = false }), Pump, "host");
        Assert.True(host.IsHost);
        Assert.Equal("", host.Code);
        _log.WriteLine("host addresses: " + string.Join(", ", host.DirectAddresses));
        var atHost = new List<(int From, string Text)>();
        host.MessageReceived += (f, p, c) => atHost.Add((f, Encoding.UTF8.GetString(p.Span)));

        a = Await(aClient.JoinDirectAsync("127.0.0.1:" + port, "pw"), Pump, "join a");
        PumpUntil(() => a.ReadyAsync.IsCompleted, Pump, "a ready (data channels open)");
        Assert.True(a.ReadyAsync.IsCompletedSuccessfully, a.ReadyAsync.Exception?.GetBaseException().Message);
        _log.WriteLine($"a ready after {sw.ElapsedMilliseconds} ms");

        // the host's side of the selected ICE pair is on UDP P (docs/direct-ip.md s.2: one port number, both protocols)
        PumpUntil(() => hostTransport.Links.Count == 1 && hostTransport.Links[0].LocalCandidate != null, Pump, "host reads its selected pair");
        _log.WriteLine("host pair: " + hostTransport.Links[0].LocalCandidate + " <-> " + hostTransport.Links[0].RemoteCandidate);
        Assert.Contains(" " + port + " typ ", hostTransport.Links[0].LocalCandidate);

        b = Await(bClient.JoinDirectAsync("127.0.0.1", "pw"), Pump, "join b (port from config)");
        PumpUntil(() => b.ReadyAsync.IsCompleted, Pump, "b ready: second peer connection on the same UDP port");
        Assert.True(b.ReadyAsync.IsCompletedSuccessfully, b.ReadyAsync.Exception?.GetBaseException().Message);
        _log.WriteLine($"b ready after {sw.ElapsedMilliseconds} ms");

        a.Send(host.LocalPeerId, Encoding.UTF8.GetBytes("from a"));
        b.Send(host.LocalPeerId, Encoding.UTF8.GetBytes("from b"));
        PumpUntil(() => atHost.Count >= 2, Pump, "both messages at host");
        Assert.Contains((a.LocalPeerId, "from a"), atHost);
        Assert.Contains((b.LocalPeerId, "from b"), atHost);
        var atB = new List<string>();
        b.MessageReceived += (f, p, c) => atB.Add(Encoding.UTF8.GetString(p.Span));
        a.Broadcast(Encoding.UTF8.GetBytes("hi all"));
        PumpUntil(() => atB.Contains("hi all"), Pump, "a's broadcast relayed by the host to b");
        Assert.All(host.Peers, p => Assert.False(p.Relayed));
        PumpUntil(() => hostTransport.Links.Count == 2 && hostTransport.Links.All(l => l.LocalCandidate != null), Pump, "both pairs known");
        foreach (var l in hostTransport.Links)
        {
            _log.WriteLine("host pair: " + l.LocalCandidate + " <-> " + l.RemoteCandidate);
            Assert.Contains(" " + port + " typ ", l.LocalCandidate);
        }

        // host leaves: no migration, both joiners end with host_left
        string? endA = null, endB = null;
        a.SessionEnded += r => endA = r;
        b.SessionEnded += r => endB = r;
        host.LeaveAsync();
        PumpUntil(() => endA != null && endB != null, Pump, "joiners see the session end");
        Assert.Equal("host_left", endA);
        Assert.Equal("host_left", endB);
        _log.WriteLine($"PASS in {sw.ElapsedMilliseconds} ms");

        // the listener is gone: the port can be hosted again
        PumpUntil(() =>
        {
            try { using var t = new TcpListener(IPAddress.Any, port); t.Start(); t.Stop(); return true; }
            catch (SocketException) { return false; }
        }, Pump, "port released", 5000);
        aClient.DisposeAsync().AsTask().Wait();
        bClient.DisposeAsync().AsTask().Wait();
        hostClient.DisposeAsync().AsTask().Wait();
    }

    [Fact]
    public void JoinerRestartsAndTakesItsSeatBackWithTheResumeToken() => RunRejoin();

    private void RunRejoin()
    {
        var port = FreePort();
        var hostClient = new LobbyClient(Cfg with { DisplayName = "Host", DirectPort = port }, new DataChannelTransport());
        var oldClient = new LobbyClient(Cfg with { DisplayName = "Ann", DirectPort = port }, new DataChannelTransport());
        var newClient = new LobbyClient(Cfg with { DisplayName = "Ann", DirectPort = port }, new DataChannelTransport());
        Lobby? host = null, old = null, back = null;
        void Pump()
        {
            if (host != null) host.Pump(); else hostClient.Pump();
            if (back != null) back.Pump(); else newClient.Pump();   // the old client stopped pumping: it "crashed"
        }
        void PumpAll() { Pump(); if (old != null) old.Pump(); else oldClient.Pump(); }

        host = Await(hostClient.HostDirectAsync(new DirectHostOptions { Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, OpenPort = false }), PumpAll, "host");
        var address = "127.0.0.1:" + port;
        old = Await(oldClient.JoinDirectAsync(address), PumpAll, "join");
        PumpUntil(() => old.ReadyAsync.IsCompleted, PumpAll, "old ready");
        var seat = old.LocalPeerId;
        var token = old.ResumeToken;
        Assert.False(string.IsNullOrEmpty(token));

        var bad = newClient.RejoinDirectAsync(address, "not-a-token");
        PumpUntil(() => bad.IsCompleted, Pump, "bad token answered");
        var err = Assert.Throws<OneLobbyException>(() => bad.GetAwaiter().GetResult());
        Assert.Equal(LobbyErrorCodes.InvalidToken, err.Code);

        var joined = new List<int>();
        host.PeerJoined += p => joined.Add(p.PeerId);
        back = Await(newClient.RejoinDirectAsync(address, token!), Pump, "rejoin");
        Assert.Equal(seat, back.LocalPeerId);
        Assert.Equal(JoinCode.Encode("127.0.0.1", port), back.JoinCode);
        Assert.NotEqual(token, back.ResumeToken);                  // a new token for the next drop
        PumpUntil(() => back.ReadyAsync.IsCompleted, Pump, "rejoined link ready");
        Assert.True(back.ReadyAsync.IsCompletedSuccessfully, back.ReadyAsync.Exception?.GetBaseException().Message);
        Assert.Contains(seat, joined);

        var atHost = new List<(int From, string Text)>();
        host.MessageReceived += (f, p, c) => atHost.Add((f, Encoding.UTF8.GetString(p.Span)));
        back.Send(host.LocalPeerId, Encoding.UTF8.GetBytes("back again"));
        PumpUntil(() => atHost.Count > 0, Pump, "message after rejoin");
        Assert.Equal((seat, "back again"), atHost[0]);
        Assert.Equal(2, host.Peers.Count);

        newClient.DisposeAsync().AsTask().Wait();
        oldClient.DisposeAsync().AsTask().Wait();
        hostClient.DisposeAsync().AsTask().Wait();
    }

    [Fact]
    public void WrongPasswordIsBadPassword()
    {
        var port = FreePort();
        var hostClient = new LobbyClient(Cfg with { DirectPort = port }, new DataChannelTransport());
        var joinClient = new LobbyClient(Cfg with { DirectPort = port }, new DataChannelTransport());
        Lobby? host = null;
        void Pump() { if (host != null) host.Pump(); else hostClient.Pump(); joinClient.Pump(); }
        host = Await(hostClient.HostDirectAsync(new DirectHostOptions { Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, Password = "pw", OpenPort = false }), Pump, "host");
        var t = joinClient.JoinDirectAsync("127.0.0.1", "PW");
        PumpUntil(() => t.IsCompleted, Pump, "join");
        var e = Assert.IsType<OneLobbyException>(t.Exception!.GetBaseException());
        Assert.Equal("bad_password", e.Code);
        host.LeaveAsync();
        _ = hostClient.DisposeAsync();
    }

    // A raw direct lobby has the same phase machine as a server one: StartAsync reaches every joiner as PhaseChanged,
    // a late joiner arrives InGame, and LateJoin = false turns joiners away with in_game. Joiners see the lobby name.
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void StartAsyncMovesARawDirectLobbyInGame(bool lateJoin) => RunStart(lateJoin);

    private void RunStart(bool lateJoin)
    {
        var port = FreePort();
        var hostClient = new LobbyClient(Cfg with { DisplayName = "Host", DirectPort = port }, new DataChannelTransport());
        var aClient = new LobbyClient(Cfg with { DisplayName = "Ann", DirectPort = port }, new DataChannelTransport());
        var bClient = new LobbyClient(Cfg with { DisplayName = "Bob", DirectPort = port }, new DataChannelTransport());
        Lobby? host = null, a = null, b = null;
        void Pump()
        {
            if (host != null) host.Pump(); else hostClient.Pump();
            if (a != null) a.Pump(); else aClient.Pump();
            if (b != null) b.Pump(); else bClient.Pump();
        }

        host = Await(hostClient.HostDirectAsync(new DirectHostOptions { Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, Name = "Test room", LateJoin = lateJoin, OpenPort = false }), Pump, "host");
        Assert.Equal("Test room", host.Name);
        a = Await(aClient.JoinDirectAsync("127.0.0.1:" + port), Pump, "join a");
        Assert.Equal("Test room", a.Name);
        Assert.Equal(LobbyPhase.Lobby, a.Phase);
        PumpUntil(() => a.ReadyAsync.IsCompleted, Pump, "a ready");

        var hostPhases = new List<LobbyPhase>();
        var aPhases = new List<LobbyPhase>();
        host.PhaseChanged += hostPhases.Add;
        a.PhaseChanged += aPhases.Add;
        _ = host.StartAsync();
        Assert.Equal(LobbyPhase.InGame, host.Phase);
        Assert.Equal(new[] { LobbyPhase.InGame }, hostPhases);
        PumpUntil(() => a.Phase == LobbyPhase.InGame, Pump, "a sees in_game");
        Assert.Equal(new[] { LobbyPhase.InGame }, aPhases);

        var late = bClient.JoinDirectAsync("127.0.0.1:" + port);
        PumpUntil(() => late.IsCompleted, Pump, "late join answered");
        if (lateJoin)
        {
            b = late.GetAwaiter().GetResult();
            Assert.Equal(LobbyPhase.InGame, b.Phase);
            PumpUntil(() => b.ReadyAsync.IsCompleted, Pump, "late joiner ready");
            Assert.True(b.ReadyAsync.IsCompletedSuccessfully, b.ReadyAsync.Exception?.GetBaseException().Message);
        }
        else
        {
            var e = Assert.IsType<OneLobbyException>(late.Exception!.GetBaseException());
            Assert.Equal(LobbyErrorCodes.InGame, e.Code);
        }
        host.LeaveAsync();
        aClient.DisposeAsync().AsTask().Wait();
        bClient.DisposeAsync().AsTask().Wait();
        hostClient.DisposeAsync().AsTask().Wait();
    }

    [Fact]
    public void NobodyListeningIsDirectUnreachable()
    {
        var port = FreePort();
        var c = new LobbyClient(Cfg with { DirectPort = port }, new DataChannelTransport());
        var sw = Stopwatch.StartNew();
        var t = c.JoinDirectAsync("127.0.0.1");
        PumpUntil(() => t.IsCompleted, c.Pump, "join fails", 8000);
        var e = Assert.IsType<OneLobbyException>(t.Exception!.GetBaseException());
        Assert.Equal("direct_unreachable", e.Code);
        Assert.True(sw.ElapsedMilliseconds < 6000, $"{sw.ElapsedMilliseconds} ms");
    }

    [Fact]
    public void SecondHostOnTheSamePortIsPortInUse()
    {
        var port = FreePort();
        var c1 = new LobbyClient(Cfg with { DirectPort = port }, new DataChannelTransport());
        var c2 = new LobbyClient(Cfg with { DirectPort = port }, new DataChannelTransport());
        var host = Await(c1.HostDirectAsync(new DirectHostOptions { Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, OpenPort = false }), c1.Pump, "host");
        var t = c2.HostDirectAsync(new DirectHostOptions { Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, OpenPort = false, FallbackPorts = 0 });
        Assert.True(t.IsFaulted);
        Assert.Equal("port_in_use", ((OneLobbyException)t.Exception!.GetBaseException()).Code);
        host.LeaveAsync();
    }

    private static async Task<string> GetJoinInfo(int port)
    {
        using var tcp = new TcpClient();
        await tcp.ConnectAsync("127.0.0.1", port);
        var s = tcp.GetStream();
        await s.WriteAsync(Encoding.ASCII.GetBytes("GET /joininfo HTTP/1.1\r\nHost: x\r\n\r\n"));
        using var r = new System.IO.StreamReader(s, Encoding.UTF8);
        using var cts = new CancellationTokenSource(5000);
        return await r.ReadToEndAsync(cts.Token);
    }

    [Fact]
    public void PublicAddressGivesAnInternetCodeAndSkipsTheRouter() => RunPublicAddress();

    private void RunPublicAddress()
    {
        var port = FreePort();
        var c = new LobbyClient(Cfg with { DirectPort = port }, new DataChannelTransport());
        var host = Await(c.HostDirectAsync(new DirectHostOptions { Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, PublicAddress = "198.51.100.9" }), c.Pump, "host");
        Assert.Equal(JoinCodeKind.Internet, host.JoinCodeKind);
        Assert.Equal(JoinCode.Encode("198.51.100.9", port), host.JoinCode);
        Assert.Equal("manual", host.PortMapping);
        Assert.Contains("; code " + host.JoinCode + " (Internet); port mapping manual", DirectLobby.HostLogLine(host));
        var info = GetJoinInfo(port).GetAwaiter().GetResult();
        Assert.Contains("\"joinCodeKind\":\"internet\"", info);
        Assert.Contains("\"joinCode\":\"" + host.JoinCode + "\"", info);
        host.LeaveAsync();
    }

    [Fact]
    public void PublicAddressMustBeDottedIPv4()
    {
        var c = new LobbyClient(Cfg, new DataChannelTransport());
        var t = c.HostDirectAsync(new DirectHostOptions { Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, PublicAddress = "my-pc.example.com" });
        Assert.True(t.IsFaulted);
        Assert.Equal("bad_address", ((OneLobbyException)t.Exception!.GetBaseException()).Code);
    }

    /// <summary>NAT-PMP gateway on loopback that stays silent until <see cref="On"/>, then answers like a router with a public WAN address.</summary>
    private sealed class SilentThenNatPmp : IDisposable
    {
        public readonly UdpClient Udp = new(new IPEndPoint(IPAddress.Loopback, 0));
        public volatile bool On;
        public int Requests;
        private readonly CancellationTokenSource _cts = new();
        public IPEndPoint Endpoint => (IPEndPoint)Udp.Client.LocalEndPoint!;
        public SilentThenNatPmp() => _ = Task.Run(Loop);

        private async Task Loop()
        {
            while (!_cts.IsCancellationRequested)
            {
                UdpReceiveResult r;
                try { r = await Udp.ReceiveAsync(_cts.Token); }
                catch (SocketException) { continue; }
                catch (Exception) { return; }
                Interlocked.Increment(ref Requests);
                if (!On) continue;
                var q = r.Buffer;
                byte[] reply;
                if (q[1] == 0) reply = new byte[] { 0, 128, 0, 0, 0, 0, 0, 1, 198, 51, 100, 9 };
                else
                {
                    var life = (q[8] << 24) | (q[9] << 16) | (q[10] << 8) | q[11];
                    var ext = life == 0 ? 0 : (q[4] << 8) | q[5];
                    reply = new byte[] { 0, (byte)(128 + q[1]), 0, 0, 0, 0, 0, 1, q[4], q[5], (byte)(ext >> 8), (byte)ext, q[8], q[9], q[10], q[11] };
                }
                await Udp.SendAsync(reply, reply.Length, r.RemoteEndPoint);
            }
        }

        public void Dispose() { _cts.Cancel(); Udp.Dispose(); }
    }

    private static PortMapperOptions SilentOpts(SilentThenNatPmp gw, int retryMs) => new()
    {
        TryUpnp = false,
        NatPmpEndpoint = gw.Endpoint,
        RequestTimeout = TimeSpan.FromMilliseconds(150),
        DiscoveryTimeout = TimeSpan.FromMilliseconds(150),
        RetryMs = retryMs,
    };

    [Fact]
    public void LateRouterAnswerTurnsTheCodeInternetAndRaisesJoinCodeChanged() => RunLateRouter();

    private void RunLateRouter()
    {
        using var gw = new SilentThenNatPmp();
        var port = FreePort();
        var c = new LobbyClient(Cfg with { DirectPort = port }, new DataChannelTransport());
        var host = Await(c.HostDirectAsync(new DirectHostOptions { Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, PortMapping = SilentOpts(gw, 100) }), c.Pump, "host");
        Assert.NotEqual(JoinCodeKind.Internet, host.JoinCodeKind);
        var changed = new List<(string, JoinCodeKind, int)>();
        host.JoinCodeChanged += (code, kind) => changed.Add((code, kind, Environment.CurrentManagedThreadId));
        var pumpThread = Environment.CurrentManagedThreadId;
        PumpUntil(() => gw.Requests >= 3, c.Pump, "router asked again");   // a couple of silent rounds first
        Assert.Empty(changed);
        gw.On = true;
        PumpUntil(() => changed.Count > 0, c.Pump, "JoinCodeChanged", 15000);
        Assert.Equal((JoinCode.Encode("198.51.100.9", port), JoinCodeKind.Internet, pumpThread), changed[0]);
        Assert.Equal(host.JoinCode, changed[0].Item1);
        Assert.Contains("(Internet)", DirectLobby.HostLogLine(host));
        Assert.Contains("\"joinCodeKind\":\"internet\"", GetJoinInfo(port).GetAwaiter().GetResult());
        host.LeaveAsync();
    }

    [Fact]
    public void RetryMsZeroAsksTheRouterOnlyOnce() => RunNoRetry();

    private void RunNoRetry()
    {
        using var gw = new SilentThenNatPmp();
        var c = new LobbyClient(Cfg with { DirectPort = FreePort() }, new DataChannelTransport());
        var host = Await(c.HostDirectAsync(new DirectHostOptions { Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, PortMapping = SilentOpts(gw, 0) }), c.Pump, "host");
        var asked = gw.Requests;
        Assert.True(asked > 0);
        var sw = Stopwatch.StartNew();
        PumpUntil(() => sw.ElapsedMilliseconds > 1200, c.Pump, "wait");
        Assert.Equal(asked, gw.Requests);
        host.LeaveAsync();
    }

    [Fact]
    public void ReservedPortSaysWindowsReservedIt()
    {
        Assert.Contains("another copy of the game", DirectLobby.PortFailureHint(anyBusy: true, anyReserved: false));
        Assert.Contains("Windows has reserved it", DirectLobby.PortFailureHint(anyBusy: false, anyReserved: true));
        Assert.Contains("busy or reserved", DirectLobby.PortFailureHint(anyBusy: true, anyReserved: true));
    }

    [Fact]
    public void BusyDefaultPortFallsBackToTheNextOneAndTheJoinerKeepsTheCode()
    {
        var port = FreePort(span: 2); // the fallback needs at least port + 1 free too
        var c1 = new LobbyClient(Cfg with { DirectPort = port }, new DataChannelTransport());
        var c2 = new LobbyClient(Cfg with { DirectPort = port }, new DataChannelTransport());
        var j = new LobbyClient(Cfg, new DataChannelTransport());
        var first = Await(c1.HostDirectAsync(new DirectHostOptions { Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, OpenPort = false }), c1.Pump, "host 1");
        var second = Await(c2.HostDirectAsync(new DirectHostOptions { Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, OpenPort = false }), c2.Pump, "host 2");
        Assert.True(JoinCode.TryDecode(second.JoinCode, out _, out var p2, out _));
        Assert.NotEqual(port, p2);
        Assert.InRange(p2, port + 1, port + DirectLobby.DefaultFallbackPorts);
        Assert.Equal(DirectLobby.FormatHostLog(port, p2, second.JoinCode, second.JoinCodeKind, "off"), DirectLobby.HostLogLine(second));
        Assert.StartsWith("OneLobby: direct host listening on TCP+UDP :" + p2 + " (" + port, DirectLobby.HostLogLine(second));
        Assert.StartsWith("OneLobby: direct host listening on TCP+UDP :" + port + ";", DirectLobby.HostLogLine(first));

        var joiner = Await(j.JoinDirectAsync("127.0.0.1:" + p2), () => { second.Pump(); j.Pump(); }, "join");
        Assert.Equal(JoinCode.Encode("127.0.0.1", p2), joiner.JoinCode);
        joiner.LeaveAsync();
        second.LeaveAsync();
        first.LeaveAsync();
    }

    [Fact]
    public void HostLogLineNamesTheBoundPortAndWhichPortsWereBusy()
    {
        Assert.Equal("OneLobby: direct host listening on TCP+UDP :47810; code 6B01-RGFE-P2B (Internet); port mapping UPnP",
            DirectLobby.FormatHostLog(47810, 47810, "6B01-RGFE-P2B", JoinCodeKind.Internet, "UPnP"));
        Assert.Equal("OneLobby: direct host listening on TCP+UDP :47811 (47810 busy); code 0A00-0BSE-P3S (SameNetwork); port mapping off",
            DirectLobby.FormatHostLog(47810, 47811, "0A00-0BSE-P3S", JoinCodeKind.SameNetwork, "off"));
        Assert.Equal("OneLobby: direct host listening on TCP+UDP :47813 (47810-47812 busy); no join code (no IPv4 address); port mapping off",
            DirectLobby.FormatHostLog(47810, 47813, "", JoinCodeKind.None, ""));
    }

    [Theory]
    [InlineData("192.168.1.20", "192.168.1.20:47810", false)]
    [InlineData(" 192.168.1.20:5000 ", "192.168.1.20:5000", false)]
    [InlineData("ws://203.0.113.7:47810/", "203.0.113.7:47810", false)]
    [InlineData("[2001:db8::1]:5000", "[2001:db8::1]:5000", true)]
    [InlineData("[2001:db8::1]", "[2001:db8::1]:47810", true)]
    [InlineData("2001:db8::1", "[2001:db8::1]:47810", true)]
    [InlineData("my-pc.tailnet.ts.net:47811", "my-pc.tailnet.ts.net:47811", false)]
    public void AddressesParse(string input, string expected, bool v6)
    {
        Assert.True(DirectAddress.TryParse(input, 47810, out var a));
        Assert.Equal(expected, a.ToString());
        Assert.Equal(v6, a.IsIPv6);
        Assert.EndsWith(" " + a.Port + " typ host", a.Candidate);
    }

    [Theory]
    [InlineData("")]
    [InlineData("1.2.3.4:0")]
    [InlineData("1.2.3.4:70000")]
    [InlineData("1.2.3.4:abc")]
    [InlineData("[::1")]
    [InlineData("bad host!")]
    public void BadAddressesDoNotParse(string input) => Assert.False(DirectAddress.TryParse(input, 47810, out _));

    [Fact]
    public void BadAddressIsReportedNotThrown()
    {
        var t = new LobbyClient(Cfg, new DataChannelTransport()).JoinDirectAsync("nope nope");
        Assert.Equal("bad_address", ((OneLobbyException)t.Exception!.GetBaseException()).Code);
    }

    [Fact]
    public void JoinByTheSameNetworkCode()
    {
        var port = FreePort();
        var hostClient = new LobbyClient(Cfg with { DisplayName = "Host" }, new DataChannelTransport());
        var joinClient = new LobbyClient(Cfg with { DisplayName = "Ann" }, new DataChannelTransport());
        Lobby? host = null, ann = null;
        void Pump()
        {
            if (host != null) host.Pump(); else hostClient.Pump();
            if (ann != null) ann.Pump(); else joinClient.Pump();
        }
        host = Await(hostClient.HostDirectAsync(new DirectHostOptions { Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, Port = port, OpenPort = false }), Pump, "host");
        if (host.JoinCode != "") Assert.Equal(JoinCodeKind.SameNetwork, host.JoinCodeKind);
        Assert.Equal("off", host.PortMapping);
        if (host.JoinCode == "") { host.LeaveAsync(); return; } // no IPv4 on this machine
        Assert.True(JoinCode.TryDecode(host.JoinCode, out var ip, out var p, out _));
        Assert.Equal(port, p);
        _log.WriteLine($"code {host.JoinCode} -> {ip}:{p}");
        ann = Await(joinClient.JoinDirectAsync(host.JoinCode.ToLowerInvariant().Replace('-', ' ')), Pump, "join by code");
        PumpUntil(() => ann.IsReady && host.Peers.Count == 2, Pump, "link up");
        host.LeaveAsync();
        _ = hostClient.DisposeAsync();
    }

    [Theory]
    [InlineData("6B01-RGFE-P2C", "bad_code")]   // one character off a valid code
    [InlineData("6b01 rgfe p2c", "bad_code")]   // same typo, typed loosely
    public void MistypedCodesFailAtOnce(string input, string code)
    {
        var t = new LobbyClient(Cfg, new DataChannelTransport()).JoinDirectAsync(input);
        Assert.True(t.IsFaulted);
        Assert.Equal(code, ((OneLobbyException)t.Exception!.GetBaseException()).Code);
    }

    [Fact]
    public void MidIsReadFromSdp()
    {
        Assert.Equal("0", DataChannelPeerLink.MidOf("v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\na=sctp-port:5000\r\n"));
        Assert.Null(DataChannelPeerLink.MidOf("v=0\r\n"));
    }
}
