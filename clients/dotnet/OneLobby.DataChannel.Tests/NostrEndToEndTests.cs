using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using OneLobby.Direct;
using OneLobby.Direct.Nostr;
using Xunit;
using Xunit.Abstractions;

namespace OneLobby.DataChannel.Tests;

/// <summary>
/// Nostr signaling end to end with real libdatachannel over loopback: the host and joiners reach each other only through
/// version 1 codes and an in-memory relay network (no TCP connection to the host, no public relay).
/// </summary>
public sealed class NostrEndToEndTests
{
    private readonly ITestOutputHelper _log;
    public NostrEndToEndTests(ITestOutputHelper log) { _log = log; }

    private static readonly OneLobbyConfig Cfg = new("com.onelobby.nostrtest", "1", new Uri("ws://unused.invalid/"), SyncMode.Raw);
    private static readonly Random PortRng = new();

    private static int FreePort()
    {
        for (var i = 0; i < 200; i++)
        {
            int p;
            lock (PortRng) p = PortRng.Next(20000, 45000);
            try
            {
                var t = new TcpListener(IPAddress.Loopback, p);
                t.Start();
                t.Stop();
                using var u = new UdpClient(new IPEndPoint(IPAddress.Loopback, p));
                return p;
            }
            catch (SocketException) { }
        }
        throw new InvalidOperationException("no free port");
    }

    private static void PumpUntil(Func<bool> done, Action pump, string what, int timeoutMs = 30000)
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
    public void HostAndJoinersMeetOverNostrCodesAndRelays() => RunEndToEnd();

    private void RunEndToEnd()
    {
        var net = new FakeRelayNet();
        // loopback needs no STUN; an unroutable local one keeps the test off the internet
        var nostr = () => new NostrOptions { RelayFactory = net.Create, Stun = new[] { "stun:127.0.0.1:9" } };
        var port = FreePort();
        var hostClient = new LobbyClient(Cfg with { DisplayName = "Host", DirectPort = port }, new DataChannelTransport { BindAddress = "127.0.0.1" });
        var aClient = new LobbyClient(Cfg with { DisplayName = "Ann", DirectPort = port }, new DataChannelTransport { BindAddress = "127.0.0.1" });
        var bClient = new LobbyClient(Cfg with { DisplayName = "Bob", DirectPort = port }, new DataChannelTransport { BindAddress = "127.0.0.1" });
        Lobby? host = null, a = null, b = null;
        void Pump()
        {
            if (host != null) host.Pump(); else hostClient.Pump();
            if (a != null) a.Pump(); else aClient.Pump();
            if (b != null) b.Pump(); else bClient.Pump();
        }

        host = Await(hostClient.HostDirectAsync(new DirectHostOptions { BindAddress = System.Net.IPAddress.Loopback, Port = port, FallbackPorts = 0, OpenPort = false, Password = "pw", MaxPlayers = 3, Nostr = nostr() }), Pump, "host");
        _log.WriteLine("host: " + DirectLobby.HostLogLine(host));
        Assert.Equal(JoinCodeKind.Nostr, host.JoinCodeKind);
        Assert.True(JoinCode.TryDecodeRoom(host.JoinCode, out var room), host.JoinCode);
        Assert.Equal(12, room.Length);
        Assert.NotEqual(host.JoinCode, host.DirectCode);
        Assert.EndsWith("; nostr 3/3 relays", DirectLobby.HostLogLine(host));
        // the IP code is still a version 0 code for the same port
        if (host.DirectCode.Length > 0)
        {
            Assert.True(JoinCode.TryDecode(host.DirectCode, out _, out var p0, out _));
            Assert.Equal(port, p0);
        }

        // GET /joininfo carries both codes
        using (var http = new HttpClient())
        {
            var json = http.GetStringAsync("http://127.0.0.1:" + port + "/joininfo").GetAwaiter().GetResult();
            using var doc = JsonDocument.Parse(json);
            Assert.Equal(host.JoinCode, doc.RootElement.GetProperty("joinCode").GetString());
            Assert.Equal("nostr", doc.RootElement.GetProperty("joinCodeKind").GetString());
            Assert.Equal(host.DirectCode, doc.RootElement.GetProperty("directCode").GetString());
            Assert.Equal(host.DirectCodeKind == JoinCodeKind.Internet ? "internet" : host.DirectCodeKind == JoinCodeKind.SameNetwork ? "same_network" : "none",
                doc.RootElement.GetProperty("directCodeKind").GetString());
        }

        var atHost = new List<(int From, string Text)>();
        host.MessageReceived += (f, p, c) => atHost.Add((f, Encoding.UTF8.GetString(p.Span)));

        a = Await(aClient.JoinDirectAsync(host.JoinCode.ToLowerInvariant().Replace('-', ' '), "pw", nostr()), Pump, "join a over nostr");
        Assert.Equal(host.JoinCode, a.JoinCode);
        PumpUntil(() => a.ReadyAsync.IsCompleted, Pump, "a ready (data channels open)");
        Assert.True(a.ReadyAsync.IsCompletedSuccessfully, a.ReadyAsync.Exception?.GetBaseException().Message);

        b = Await(bClient.JoinDirectAsync(host.JoinCode, "pw", nostr()), Pump, "join b over nostr");
        PumpUntil(() => b.ReadyAsync.IsCompleted, Pump, "b ready");
        Assert.True(b.ReadyAsync.IsCompletedSuccessfully, b.ReadyAsync.Exception?.GetBaseException().Message);

        a.Send(host.LocalPeerId, Encoding.UTF8.GetBytes("from a"));
        b.Send(host.LocalPeerId, Encoding.UTF8.GetBytes("from b"));
        PumpUntil(() => atHost.Count >= 2, Pump, "both messages at host");
        Assert.Contains((a.LocalPeerId, "from a"), atHost);
        Assert.Contains((b.LocalPeerId, "from b"), atHost);
        var atB = new List<string>();
        b.MessageReceived += (f, p, c) => atB.Add(Encoding.UTF8.GetString(p.Span));
        a.Broadcast(Encoding.UTF8.GetBytes("hi all"));
        PumpUntil(() => atB.Contains("hi all"), Pump, "a's broadcast relayed by the host to b");
        Assert.Equal(2, host.Peers.Count(p => p.PeerId != host.LocalPeerId));

        // a wrong password is refused over Nostr as well
        var cClient = new LobbyClient(Cfg with { DisplayName = "Cy", DirectPort = port }, new DataChannelTransport { BindAddress = "127.0.0.1" });
        var bad = cClient.JoinDirectAsync(host.JoinCode, "nope", nostr());
        PumpUntil(() => bad.IsCompleted, () => { Pump(); cClient.Pump(); }, "bad password answered");
        Assert.Equal("bad_password", Assert.IsType<OneLobbyException>(bad.Exception!.GetBaseException()).Code);

        string? endA = null, endB = null;
        a.SessionEnded += r => endA = r;
        b.SessionEnded += r => endB = r;
        host.LeaveAsync();
        PumpUntil(() => endA != null && endB != null, Pump, "joiners see the session end");
        Assert.Equal("host_left", endA);
        Assert.Equal("host_left", endB);
        aClient.DisposeAsync().AsTask().Wait();
        bClient.DisposeAsync().AsTask().Wait();
        cClient.DisposeAsync().AsTask().Wait();
        hostClient.DisposeAsync().AsTask().Wait();
    }

    [Fact]
    public void No_relay_reachable_keeps_the_ip_code_and_logs_it_then_switches_when_one_answers() => RunNoRelay();

    private void RunNoRelay()
    {
        var net = new FakeRelayNet();
        FakeRelays? relays = null;
        var port = FreePort();
        var c = new LobbyClient(Cfg with { DisplayName = "Host", DirectPort = port }, new DataChannelTransport { BindAddress = "127.0.0.1" });
        var opts = new NostrOptions
        {
            RelayFactory = topic => { var r = (FakeRelays)net.Create(topic); r.Up = false; relays = r; return r; },
            Stun = new[] { "stun:127.0.0.1:9" },
        };
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var host = Await(c.HostDirectAsync(new DirectHostOptions { BindAddress = System.Net.IPAddress.Loopback, Port = port, FallbackPorts = 0, OpenPort = false, Nostr = opts }), c.Pump, "host");
        Assert.InRange(sw.ElapsedMilliseconds, NostrLimits.HostFirstRelayMs - 200, 8000); // waited the 3 s for a relay
        Assert.NotNull(relays);
        Assert.EndsWith("; nostr: no relay reachable", DirectLobby.HostLogLine(host));
        Assert.NotEqual(JoinCodeKind.Nostr, host.JoinCodeKind);
        Assert.Equal(host.DirectCode, host.JoinCode);
        var changed = new List<(string, JoinCodeKind)>();
        host.JoinCodeChanged += (code, kind) => changed.Add((code, kind));
        Assert.False(host.JoinCodeFinal);
        var early = host.FinalJoinCodeAsync(TimeSpan.FromMilliseconds(100));
        PumpUntil(() => early.IsCompleted, host.Pump, "timed-out wait gives the current code", 3000);
        Assert.Equal((host.DirectCode, false), early.Result);
        var final = host.FinalJoinCodeAsync(TimeSpan.FromSeconds(10));
        relays!.Up = true;
        PumpUntil(() => changed.Count > 0 && final.IsCompleted, host.Pump, "code switches to nostr once a relay answers", 5000);
        Assert.True(host.JoinCodeFinal);
        Assert.Equal((host.JoinCode, true), final.Result);
        Assert.Equal(JoinCodeKind.Nostr, host.JoinCodeKind);
        Assert.True(JoinCode.TryDecodeRoom(host.JoinCode, out _));
        Assert.EndsWith("; nostr 3/3 relays", DirectLobby.HostLogLine(host));
        c.DisposeAsync().AsTask().Wait();
    }

    [Fact]
    public void A_nostr_host_with_nostr_off_in_the_options_keeps_the_ip_code_only() => RunOff();

    private static void RunOff()
    {
        var port = FreePort();
        var c = new LobbyClient(Cfg with { DisplayName = "Host", DirectPort = port }, new DataChannelTransport { BindAddress = "127.0.0.1" });
        var host = Await(c.HostDirectAsync(new DirectHostOptions { BindAddress = System.Net.IPAddress.Loopback, Port = port, FallbackPorts = 0, OpenPort = false, Nostr = new NostrOptions { Enabled = false } }), c.Pump, "host");
        Assert.Equal(host.DirectCode, host.JoinCode);
        Assert.NotEqual(JoinCodeKind.Nostr, host.JoinCodeKind);
        Assert.True(host.JoinCodeFinal); // no relay to wait for, no router retry (OpenPort false)
        Assert.Equal((host.JoinCode, true), host.FinalJoinCodeAsync(TimeSpan.FromSeconds(10)).Result);
        Assert.DoesNotContain("nostr", DirectLobby.HostLogLine(host));
        c.DisposeAsync().AsTask().Wait();
    }
}

public sealed class NostrRelayPrecedenceTests
{
    [Fact]
    public void A_host_with_its_own_options_uses_the_blueprint_relays_unless_the_options_name_some()
    {
        var bp = Blueprint.Parse("{\"game\":{\"id\":\"com.you.game\"},\"hosting\":{\"nostrRelays\":[\"wss://relay.example.org\"]}}");
        var withBp = LobbyClient.FromBlueprint(bp, new DataChannelTransport());
        var plain = new LobbyClient(new OneLobbyConfig("com.you.game", "1", new Uri("ws://127.0.0.1:1/ws"), SyncMode.Raw), new DataChannelTransport());
        Assert.Equal(new[] { "wss://relay.example.org" }, DirectLobby.HostNostr(withBp, new DirectHostOptions().Nostr).EffectiveRelays);
        Assert.Equal(new[] { "wss://relay.example.org" }, DirectLobby.HostNostr(withBp, null).EffectiveRelays);
        var mine = new NostrOptions { Relays = new[] { "wss://mine.example.org" }, Stun = new string[0] };
        Assert.Same(mine, DirectLobby.HostNostr(withBp, mine));
        Assert.Equal(NostrOptions.DefaultRelays, DirectLobby.HostNostr(plain, new NostrOptions()).EffectiveRelays);
        var off = DirectLobby.HostNostr(withBp, new NostrOptions { Enabled = false, Stun = new string[0] });
        Assert.False(off.Enabled);
        Assert.Empty(off.Stun!);
    }
}

public sealed class NostrStunTests
{
    [Fact]
    public void The_hub_offers_the_stun_list_in_welcome_only_when_nostr_is_on_and_an_empty_list_means_none()
    {
        var on = DirectLobby.HubFor(new DirectHostOptions(), new NostrOptions());
        Assert.Equal(NostrOptions.DefaultStun, on.StunUrls);
        Assert.Equal(new[] { "stun:a.example:3478" }, DirectLobby.HubFor(new DirectHostOptions(), new NostrOptions { Stun = new[] { "stun:a.example:3478" } }).StunUrls);
        Assert.Empty(DirectLobby.HubFor(new DirectHostOptions(), new NostrOptions { Stun = new string[0] }).StunUrls);
        Assert.Empty(DirectLobby.HubFor(new DirectHostOptions(), new NostrOptions { Enabled = false }).StunUrls);
    }
}

public sealed class NostrBlueprintTests
{
    [Fact]
    public void Blueprint_reads_nostr_and_nostrRelays_and_feeds_the_host_options()
    {
        var bp = Blueprint.Parse("{\"game\":{\"id\":\"com.you.game\"},\"hosting\":{\"nostr\":false,\"nostrRelays\":[\"wss://relay.example.org\"]}}");
        Assert.False(bp.Hosting.Nostr);
        Assert.Equal(new[] { "wss://relay.example.org" }, bp.Hosting.Relays);
        var o = bp.ToDirectHostOptions();
        Assert.False(o.Nostr.Enabled);
        Assert.Equal(new[] { "wss://relay.example.org" }, o.Nostr.Relays);
        var d = Blueprint.Parse("{\"game\":{\"id\":\"com.you.game\"}}");
        Assert.True(d.Hosting.Nostr);
        Assert.Equal(Blueprint.DefaultNostrRelays, d.Hosting.Relays); // unset = the default list, as the schema says
        Assert.True(d.ToDirectHostOptions().Nostr.Enabled);
        Assert.Equal(NostrOptions.DefaultRelays, d.ToDirectHostOptions().Nostr.EffectiveRelays);
        // an explicit empty list falls back to the library default when used
        var empty = Blueprint.Parse("{\"game\":{\"id\":\"com.you.game\"},\"hosting\":{\"nostrRelays\":[]}}");
        Assert.Empty(empty.Hosting.Relays);
        Assert.Null(empty.ToDirectHostOptions().Nostr.Relays);
        // the round trip keeps them
        var back = Blueprint.Parse(bp.ToJson());
        Assert.False(back.Hosting.Nostr);
        Assert.Equal(bp.Hosting.Relays, back.Hosting.Relays);
        Assert.Throws<BlueprintException>(() => Blueprint.Parse("{\"game\":{\"id\":\"com.you.game\"},\"hosting\":{\"nostr\":\"yes\"}}"));
        Assert.Throws<BlueprintException>(() => Blueprint.Parse("{\"game\":{\"id\":\"com.you.game\"},\"hosting\":{\"nostrRelays\":[1]}}"));
    }

}
