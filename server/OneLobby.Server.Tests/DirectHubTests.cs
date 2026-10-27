using System.Text.Json.Nodes;
using Xunit;

namespace OneLobby.Server.Tests;

/// <summary>The hub options a game hosting by IP uses (docs/direct-ip.md s.2, s.5 step 2).</summary>
public class DirectHubTests
{
    private static (Hub Hub, FakeClock Clock) Direct(string? password = null) => T.NewHub(o =>
    {
        var d = HubOptions.ForDirect(4, password);
        o.SingleLobby = d.SingleLobby; o.IssueCodes = d.IssueCodes; o.Password = d.Password;
        o.StunUrls = d.StunUrls; o.TurnUrls = d.TurnUrls; o.MaxLobbies = d.MaxLobbies;
        o.HardMaxPlayers = d.HardMaxPlayers; o.MaxPeers = d.MaxPeers;
    });

    private static Client JoinNoCode(Client c, string? password = null)
    {
        var o = new JsonObject { ["t"] = "join" };
        if (password is not null) o["password"] = password;
        return c.Send(o.ToJsonString());
    }

    [Fact]
    public void Join_without_code_joins_the_one_lobby()
    {
        var (hub, _) = Direct();
        var h = T.Ready(hub, "local", "Host").Create("unlisted");
        var j = JoinNoCode(T.Ready(hub, "10.0.0.2", "Joe"));
        Assert.Null(j.LastError);
        Assert.Equal(2, j.PeerId);
        Assert.Equal(1, (int)j.Last("lobby")["hostId"]!);
        Assert.True(h.Has("peer_joined"));
    }

    [Fact]
    public void Client_host_changed_claims_are_rejected_outright_in_a_direct_lobby()
    {
        var (hub, _) = Direct();
        var h = T.Ready(hub, "local", "Host").Create("unlisted");
        var j = JoinNoCode(T.Ready(hub, "10.0.0.2", "Joe"));
        j.Send("{\"t\":\"host_changed\",\"hostId\":2,\"epoch\":7}");
        Assert.False(h.Has("host_changed"));
        h.Disconnect();
        Assert.Equal(1, (int)j.Last("host_changed")["epoch"]!);   // the server's own promotion, not the parked claim
    }

    [Fact]
    public void Signals_between_two_joiners_are_refused_in_a_direct_lobby_but_host_and_joiner_talk()
    {
        var (hub, _) = Direct();
        var h = T.Ready(hub, "local", "Host").Create("unlisted");
        var a = JoinNoCode(T.Ready(hub, "10.0.0.2", "Ann"));
        var b = JoinNoCode(T.Ready(hub, "10.0.0.3", "Bob"));
        a.Send("{\"t\":\"signal\",\"to\":" + b.PeerId + ",\"sdp\":{\"type\":\"offer\",\"sdp\":\"v=0\"}}");
        Assert.Equal("bad_request", a.LastError);
        Assert.False(b.Has("signal"));
        a.Send("{\"t\":\"signal\",\"to\":1,\"sdp\":{\"type\":\"answer\",\"sdp\":\"v=0\"}}");
        Assert.True(h.Has("signal"));
        h.Send("{\"t\":\"signal\",\"to\":" + b.PeerId + ",\"sdp\":{\"type\":\"offer\",\"sdp\":\"v=0\"}}");
        Assert.True(b.Has("signal"));
    }

    [Fact]
    public void Join_without_code_before_any_lobby_is_unknown_code()
    {
        var (hub, _) = Direct();
        Assert.Equal("unknown_code", JoinNoCode(T.Ready(hub, "10.0.0.2")).LastError);
    }

    [Fact]
    public void Codes_are_hidden_list_is_empty_and_no_ice_servers()
    {
        var (hub, _) = Direct();
        var h = T.Ready(hub, "local", "Host").Create("public");
        Assert.Equal("", h.Code);
        Assert.Empty(h.Last("welcome")["ice"]!.AsArray());
        var l = T.Ready(hub, "10.0.0.2").Send("{\"t\":\"list\",\"visibility\":\"public\"}");
        Assert.Empty(l.Last("lobbies")["items"]!.AsArray());
    }

    [Fact]
    public void Bad_password_is_refused_and_good_password_admits()
    {
        var (hub, _) = Direct("hunter2");
        T.Ready(hub, "local", "Host").Create("unlisted");
        Assert.Equal("bad_password", JoinNoCode(T.Ready(hub, "10.0.0.2")).LastError);
        Assert.Equal("bad_password", JoinNoCode(T.Ready(hub, "10.0.0.3"), "Hunter2").LastError);
        var ok = JoinNoCode(T.Ready(hub, "10.0.0.4"), "hunter2");
        Assert.Null(ok.LastError);
        Assert.True(ok.Has("lobby"));
    }

    [Fact]
    public void Empty_password_means_none()
    {
        Assert.Null(HubOptions.ForDirect(4, "").Password);
        var (hub, _) = Direct("");
        T.Ready(hub, "local", "Host").Create("unlisted");
        Assert.Null(JoinNoCode(T.Ready(hub, "10.0.0.2")).LastError);
    }

    [Fact]
    public void Second_lobby_is_refused_even_after_the_first_closes()
    {
        var (hub, _) = Direct();
        var h = T.Ready(hub, "local", "Host").Create("unlisted");
        var rival = T.Ready(hub, "10.0.0.2", "Rival").Create("unlisted");
        Assert.Equal("server_full", rival.LastError);
        h.Send("{\"t\":\"leave\"}");
        Assert.Equal(0, hub.LobbyCount);
        Assert.Equal("server_full", T.Ready(hub, "10.0.0.3", "Late").Create("unlisted").LastError);
    }

    [Fact]
    public void Max_players_comes_from_the_host_settings()
    {
        var (hub, _) = Direct();
        Assert.Equal("bad_request", T.Ready(hub, "local").Create("unlisted", max: 8).LastError);
    }

    [Fact]
    public void Hosted_defaults_are_unchanged()
    {
        var o = new ServerOptions();
        Assert.False(o.SingleLobby);
        Assert.True(o.IssueCodes);
        Assert.Null(o.Password);
        var (hub, _) = T.NewHub();
        var h = T.Ready(hub).Create();
        Assert.Equal(6, h.Code.Length);
        Assert.Equal("bad_request", JoinNoCode(T.Ready(hub, "10.0.0.2")).LastError);
    }
}
