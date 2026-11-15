using System;
using System.Collections.Generic;
using System.Linq;
using OneLobby.Direct;
using OneLobby.Direct.Nostr;
using OneLobby.Server;
using Xunit;

namespace OneLobby.DataChannel.Tests;

/// <summary>Direct ice_servers (spec/nostr-signaling.md s.5): what the hub offers and what each side's links get.</summary>
public class DirectIceServersTests
{
    private static readonly IceServer Turn = new(new[] { "turn:turn.example.com:3478" }, "1:x", "cred");
    private static readonly IceServer Stun = new(new[] { "stun:stun.example.com:3478" });
    private static readonly IceServer Own = new(new[] { "turns:own.example.com:443?transport=tcp" }, "u", "p");

    private sealed class Capture : ITransport
    {
        public PeerLinkOptions? Last;
        public long NowMs => 0;
        public ISignalingSocket ConnectSignaling(Uri url) => throw new NotSupportedException();
        public IPeerLink CreatePeerLink(PeerLinkOptions options) { Last = options; return null!; }
        public void Poll() { }
    }

    private static PeerLinkOptions Opts(params IceServer[] ice) => new(1, true, ice, false);

    [Fact]
    public void The_hub_gets_the_host_ice_servers_after_stun_whether_nostr_is_on_or_off()
    {
        var o = new DirectHostOptions { IceServers = new[] { Turn } };
        var on = DirectLobby.HubFor(o, new NostrOptions { Stun = new[] { "stun:a.example:3478" } });
        Assert.Equal(new[] { "stun:a.example:3478" }, on.StunUrls);
        Assert.Equal(new[] { new IceEntry(Turn.Urls, Turn.Username, Turn.Credential) }, on.ExtraIce, new EntryComparer());
        var off = DirectLobby.HubFor(o, new NostrOptions { Enabled = false });
        Assert.Empty(off.StunUrls);
        Assert.Single(off.ExtraIce);
        Assert.Empty(DirectLobby.HubFor(new DirectHostOptions(), new NostrOptions()).ExtraIce);
    }

    private sealed class EntryComparer : IEqualityComparer<IceEntry>
    {
        public bool Equals(IceEntry? a, IceEntry? b) => a != null && b != null && a.Urls.SequenceEqual(b.Urls) && a.Username == b.Username && a.Credential == b.Credential;
        public int GetHashCode(IceEntry e) => e.Urls.Count;
    }

    [Fact]
    public void An_ip_joiner_uses_the_turn_entries_of_the_welcome_and_its_own_and_no_stun()
    {
        var inner = new Capture();
        new DirectJoinTransport(inner, new[] { "candidate:1" }, new[] { Own }).CreatePeerLink(Opts(Stun, Turn));
        Assert.Equal(new[] { Turn, Own }, inner.Last!.IceServers);
        Assert.True(inner.Last.NoIceServers);
        new DirectJoinTransport(inner, new[] { "candidate:1" }).CreatePeerLink(Opts(Stun));
        Assert.Empty(inner.Last!.IceServers);
    }

    [Fact]
    public void A_nostr_joiner_appends_its_own_entries_to_the_hosts_list_or_to_default_stun()
    {
        var inner = new Capture();
        var t = new NostrJoinTransport(inner, "ABCDEFGHJKM", new NostrOptions { Stun = new[] { "stun:d.example" } }, new[] { Own });
        t.CreatePeerLink(Opts(Stun, Turn));
        Assert.Equal(new[] { Stun, Turn, Own }, inner.Last!.IceServers);
        t.CreatePeerLink(Opts());
        Assert.Equal(2, inner.Last!.IceServers.Count);
        Assert.Equal("stun:d.example", inner.Last.IceServers[0].Urls[0]);
        Assert.Same(Own, inner.Last.IceServers[1]);
    }

    [Fact]
    public void The_host_keeps_turn_only_without_nostr_and_everything_with_it()
    {
        Assert.Equal(new[] { Turn }, DirectHostTransport.TurnOnly(new[] { Stun, Turn }));
        Assert.Empty(DirectHostTransport.TurnOnly(new[] { Stun }));
    }
}

public class DirectHostPinTests
{
    private static readonly IceServer Turn = new(new[] { "turn:turn.example.com:3478" }, "1:x", "cred");

    [Fact]
    public void A_host_link_is_pinned_to_the_forwarded_port()
    {
        var o = DirectHostTransport.Pinned(new PeerLinkOptions(2, true, new[] { Turn }, false), 47810, nostr: false);
        Assert.Equal((47810, 47810), (o.PortRangeBegin, o.PortRangeEnd));
        Assert.True(o.NoIceServers);
        Assert.Equal(new[] { Turn }, o.IceServers);
    }

    [Fact]
    public void A_relay_only_host_link_is_not_pinned_because_libjuice_has_no_turn_in_mux_mode()
    {
        var o = DirectHostTransport.Pinned(new PeerLinkOptions(2, true, new[] { Turn }, true), 47810, nostr: true);
        Assert.Equal((0, 0), (o.PortRangeBegin, o.PortRangeEnd));
        Assert.True(o.RelayOnly);
        Assert.Equal(new[] { Turn }, o.IceServers);
    }
}

public class RelayCandidatesTests
{
    private const string Host = "a=candidate:1 1 UDP 2122 10.0.0.1 5000 typ host";
    private const string Relay = "a=candidate:2 1 UDP 100 1.2.3.4 6000 typ relay raddr 0.0.0.0 rport 0";

    [Fact]
    public void Only_typ_relay_counts()
    {
        Assert.True(RelayCandidates.IsRelay(Relay));
        Assert.False(RelayCandidates.IsRelay(Host));
        Assert.False(RelayCandidates.IsRelay("candidate:3 1 UDP 1 5.5.5.5 1 typ srflx raddr 1.1.1.1 rport 1"));
    }

    [Fact]
    public void FilterSdp_drops_non_relay_candidate_lines_and_keeps_the_rest_and_the_line_endings()
    {
        var sdp = string.Join("\r\n", "v=0", Host, Relay, "a=mid:0", "");
        Assert.Equal(string.Join("\r\n", "v=0", Relay, "a=mid:0", ""), RelayCandidates.FilterSdp(sdp));
        Assert.Equal("v=0\na=mid:0\n", RelayCandidates.FilterSdp("v=0\n" + Host + "\na=mid:0\n"));
        Assert.Equal("", RelayCandidates.FilterSdp(""));
    }
}
