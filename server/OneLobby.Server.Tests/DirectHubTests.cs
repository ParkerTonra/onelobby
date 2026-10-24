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
