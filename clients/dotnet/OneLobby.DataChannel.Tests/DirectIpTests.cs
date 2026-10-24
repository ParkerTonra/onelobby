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

    private static int FreePort()
    {
        // a port free for both TCP and UDP right now
        for (var i = 0; i < 50; i++)
        {
            var t = new TcpListener(IPAddress.Loopback, 0);
            t.Start();
            var p = ((IPEndPoint)t.LocalEndpoint).Port;
            t.Stop();
            try { using var u = new UdpClient(new IPEndPoint(IPAddress.Any, p)); return p; }
            catch (SocketException) { }
        }
        throw new InvalidOperationException("no free port");
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

        host = Await(hostClient.HostDirectAsync(new DirectHostOptions { Password = "pw", MaxPlayers = 3, OpenPort = false }), Pump, "host");
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
    public void WrongPasswordIsBadPassword()
    {
        var port = FreePort();
        var hostClient = new LobbyClient(Cfg with { DirectPort = port }, new DataChannelTransport());
        var joinClient = new LobbyClient(Cfg with { DirectPort = port }, new DataChannelTransport());
        Lobby? host = null;
        void Pump() { if (host != null) host.Pump(); else hostClient.Pump(); joinClient.Pump(); }
        host = Await(hostClient.HostDirectAsync(new DirectHostOptions { Password = "pw", OpenPort = false }), Pump, "host");
        var t = joinClient.JoinDirectAsync("127.0.0.1", "PW");
        PumpUntil(() => t.IsCompleted, Pump, "join");
        var e = Assert.IsType<OneLobbyException>(t.Exception!.GetBaseException());
        Assert.Equal("bad_password", e.Code);
        host.LeaveAsync();
        _ = hostClient.DisposeAsync();
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
        var host = Await(c1.HostDirectAsync(new DirectHostOptions { OpenPort = false }), c1.Pump, "host");
        var t = c2.HostDirectAsync(new DirectHostOptions { OpenPort = false });
        Assert.True(t.IsFaulted);
        Assert.Equal("port_in_use", ((OneLobbyException)t.Exception!.GetBaseException()).Code);
        host.LeaveAsync();
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
        host = Await(hostClient.HostDirectAsync(new DirectHostOptions { Port = port, OpenPort = false }), Pump, "host");
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
