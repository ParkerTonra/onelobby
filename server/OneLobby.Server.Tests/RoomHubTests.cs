using System.Text.Json.Nodes;
using Xunit;

namespace OneLobby.Server.Tests;

/// <summary>The hub additions of the room layer (spec/room.md s.7, spec/signaling.md "Room additions").</summary>
public class RoomHubTests
{
    private const string PidA = "0123456789abcdef0123456789abcdef";
    private const string PidB = "fedcba9876543210fedcba9876543210";

    private static Client HelloWith(Hub hub, string ip, string name, string? playerId)
    {
        var c = new Client(hub, ip);
        var o = new JsonObject { ["t"] = "hello", ["proto"] = "lk1", ["gameId"] = "g", ["netVersion"] = "1", ["name"] = name,
            ["client"] = new JsonObject { ["lib"] = "test", ["ver"] = "0", ["platform"] = "test" } };
        if (playerId is not null) o["playerId"] = playerId;
        return c.Send(o.ToJsonString());
    }

    private static Client CreateWith(Client c, string extra, int max = 2) =>
        c.Send($"{{\"t\":\"create\",\"name\":\"L\",\"maxPlayers\":{max},\"visibility\":\"public\",\"mode\":\"raw\",\"tickRate\":20,\"lateJoin\":true,\"meta\":{{}}{extra}}}");

    [Fact]
    public void Welcome_lists_the_room_feature()
    {
        var (hub, _) = T.NewHub();
        var f = T.Ready(hub).Last("welcome")["features"]!.AsArray().Select(x => (string?)x).ToList();
        Assert.Contains("set_name", f);
        Assert.Contains("room", f);
    }

    [Fact]
    public void Password_lobby_refuses_a_missing_or_wrong_password_and_lists_hasPassword()
    {
        var (hub, _) = T.NewHub();
        var host = CreateWith(T.Ready(hub, "10.0.0.1", "Host"), ",\"password\":\"Hunter2\"", 3);
        string code = host.Code;

        var none = T.Ready(hub, "10.0.0.2", "A").Join(code);
        Assert.Equal("bad_password", none.LastError);
        Assert.False(none.Has("lobby"));
        var wrong = T.Ready(hub, "10.0.0.3", "B").Send($"{{\"t\":\"join\",\"code\":\"{code}\",\"password\":\"hunter2\"}}");
        Assert.Equal("bad_password", wrong.LastError);
        var ok = T.Ready(hub, "10.0.0.4", "C").Send($"{{\"t\":\"join\",\"code\":\"{code}\",\"password\":\"Hunter2\"}}");
        Assert.True(ok.Has("lobby"));

        var lister = T.Ready(hub, "10.0.0.5", "L").Send("{\"t\":\"list\",\"visibility\":\"public\"}");
        var items = lister.Last("lobbies")["items"]!.AsArray();
        Assert.True((bool)items[0]!["hasPassword"]!);
    }

    [Fact]
    public void Lobby_without_a_password_lists_no_hasPassword_and_empty_password_means_none()
    {
        var (hub, _) = T.NewHub();
        var host = CreateWith(T.Ready(hub, "10.0.0.1", "Host"), ",\"password\":\"\"");
        Assert.True(T.Ready(hub, "10.0.0.2", "A").Join(host.Code).Has("lobby"));
        var items = T.Ready(hub, "10.0.0.3").Send("{\"t\":\"list\",\"visibility\":\"public\"}").Last("lobbies")["items"]!.AsArray();
        Assert.Null(items[0]!["hasPassword"]);
    }

    [Fact]
    public void Bad_password_values_are_bad_request()
    {
        var (hub, _) = T.NewHub();
        Assert.Equal("bad_request", CreateWith(T.Ready(hub, "10.0.0.1"), ",\"password\":5").LastError);
        Assert.Equal("bad_request", CreateWith(T.Ready(hub, "10.0.0.2"), $",\"password\":\"{new string('x', 65)}\"").LastError);
    }

    [Fact]
    public void Spectator_slots_extend_the_capacity_and_are_echoed()
    {
        var (hub, _) = T.NewHub();
        var host = CreateWith(T.Ready(hub, "10.0.0.1", "Host"), ",\"spectators\":1", 2);
        Assert.Equal(1, (int)host.Last("lobby")["spectators"]!);
        Assert.Equal(2, (int)host.Last("lobby")["maxPlayers"]!);
        Assert.True(T.Ready(hub, "10.0.0.2", "B").Join(host.Code).Has("lobby"));
        Assert.True(T.Ready(hub, "10.0.0.3", "C").Join(host.Code).Has("lobby"));
        Assert.Equal("lobby_full", T.Ready(hub, "10.0.0.4", "D").Join(host.Code).LastError);
    }

    [Fact]
    public void Spectators_out_of_range_are_bad_request()
    {
        var (hub, _) = T.NewHub();
        Assert.Equal("bad_request", CreateWith(T.Ready(hub, "10.0.0.1"), ",\"spectators\":-1").LastError);
        Assert.Equal("bad_request", CreateWith(T.Ready(hub, "10.0.0.2"), ",\"spectators\":\"2\"").LastError);
        Assert.Equal("bad_request", CreateWith(T.Ready(hub, "10.0.0.3"), ",\"spectators\":250").LastError); // 2 + 250 > 250
    }

    [Fact]
    public void Lobby_without_spectators_keeps_its_old_capacity()
    {
        var (hub, _) = T.NewHub();
        var host = CreateWith(T.Ready(hub, "10.0.0.1", "Host"), "", 2);
        Assert.Equal(0, (int)host.Last("lobby")["spectators"]!);
        Assert.True(T.Ready(hub, "10.0.0.2").Join(host.Code).Has("lobby"));
        Assert.Equal("lobby_full", T.Ready(hub, "10.0.0.3").Join(host.Code).LastError);
    }

    [Fact]
    public void Banned_player_id_is_refused_at_join_and_others_get_in()
    {
        var (hub, _) = T.NewHub();
        var host = CreateWith(HelloWith(hub, "10.0.0.1", "Host", PidA), "", 4);
        host.Send($"{{\"t\":\"bans\",\"ids\":[\"{PidB}\"]}}");
        Assert.Null(host.LastError);

        var banned = HelloWith(hub, "10.0.0.2", "Bob", PidB).Join(host.Code);
        Assert.Equal("banned", banned.LastError);
        Assert.False(banned.Has("lobby"));
        // another address with the same id is refused too: the ban is on the id
        Assert.Equal("banned", HelloWith(hub, "10.0.0.9", "Bob", PidB).Join(host.Code).LastError);
        // a different id, and a client that sent none, are fine
        Assert.True(HelloWith(hub, "10.0.0.3", "Cara", PidA).Join(host.Code).Has("lobby"));
        Assert.True(HelloWith(hub, "10.0.0.4", "Dan", null).Join(host.Code).Has("lobby"));

        // an empty set lifts it
        host.Send("{\"t\":\"bans\",\"ids\":[]}");
        Assert.True(HelloWith(hub, "10.0.0.5", "Bob", PidB).Join(host.Code).Has("lobby"));
    }

    [Fact]
    public void Malformed_player_id_is_ignored_not_an_error()
    {
        var (hub, _) = T.NewHub();
        var c = HelloWith(hub, "10.0.0.1", "Ann", "NOT-AN-ID");
        Assert.Null(c.LastError);
        Assert.True(c.Has("welcome"));
    }

    [Fact]
    public void Bans_is_host_only_and_validated()
    {
        var (hub, _) = T.NewHub();
        var (host, joiner, _) = T.Pair(hub);
        joiner.Send($"{{\"t\":\"bans\",\"ids\":[\"{PidA}\"]}}");
        Assert.Equal("not_host", joiner.LastError);
        host.Send("{\"t\":\"bans\",\"ids\":[\"zzz\"]}");
        Assert.Equal("bad_request", host.LastError);
        host.Send("{\"t\":\"bans\"}");
        Assert.Equal("bad_request", host.LastError);
        var many = string.Join(",", Enumerable.Range(0, 257).Select(i => $"\"{i:x32}\""));
        host.Send($"{{\"t\":\"bans\",\"ids\":[{many}]}}");
        Assert.Equal("bad_request", host.LastError);
    }

    [Fact]
    public void Kick_passes_its_code_and_reason_to_the_removed_peer()
    {
        var (hub, _) = T.NewHub();
        var (host, joiner, _) = T.Pair(hub);
        host.Send($"{{\"t\":\"kick\",\"peerId\":{joiner.PeerId},\"ban\":false,\"code\":\"too_loud\",\"closeReason\":\"Please use push to talk.\"}}");
        var err = joiner.Inbox.Last(m => (string?)m["t"] == "error");
        Assert.Equal("kicked", (string?)err["code"]);
        var data = err["data"]!.AsObject();
        Assert.Equal("too_loud", (string?)data["code"]);
        Assert.Equal("Please use push to talk.", (string?)data["closeReason"]);
        Assert.False((bool)data["ban"]!);
    }

    [Fact]
    public void Kick_without_a_code_is_unchanged_and_a_bad_code_is_refused()
    {
        var (hub, _) = T.NewHub();
        var (host, joiner, _) = T.Pair(hub);
        host.Send($"{{\"t\":\"kick\",\"peerId\":{joiner.PeerId},\"code\":\"Bad Code\"}}");
        Assert.Equal("bad_request", host.LastError);
        Assert.False(joiner.Has("error"));
        host.Send($"{{\"t\":\"kick\",\"peerId\":{joiner.PeerId}}}");
        var err = joiner.Inbox.Last(m => (string?)m["t"] == "error");
        Assert.Equal("kicked", (string?)err["code"]);
        Assert.Null(err["data"]);
    }

    [Fact]
    public void Direct_hub_option_password_wins_over_a_lobby_password()
    {
        var (hub, _) = T.NewHub(o => o.Password = "hub");
        var host = CreateWith(T.Ready(hub, "10.0.0.1", "Host"), ",\"password\":\"lobby\"");
        Assert.Equal("bad_password", T.Ready(hub, "10.0.0.2").Join(host.Code).LastError);
        Assert.True(T.Ready(hub, "10.0.0.3").Send($"{{\"t\":\"join\",\"code\":\"{host.Code}\",\"password\":\"hub\"}}").Has("lobby"));
    }
}
