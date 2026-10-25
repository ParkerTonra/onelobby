using System.Text.Json.Nodes;
using Xunit;

namespace OneLobby.Server.Tests;

public class HubTests
{
    [Fact]
    public void Hello_sends_welcome_with_stun_and_turn_rest_creds()
    {
        var (hub, clock) = T.NewHub(o => { o.TurnUrls = new() { "turn:r.example:3478", "turns:r.example:443" }; o.TurnSecret = "s3cret"; });
        var c = T.Ready(hub);
        var w = c.Last("welcome");
        var ice = w["ice"]!.AsArray();
        Assert.Equal(2, ice.Count);
        var turn = ice[1]!.AsObject();
        Assert.Equal(3600, (int)turn["ttl"]!);
        string user = (string)turn["username"]!;
        long expiry = long.Parse(user.Split(':')[0]);
        Assert.Equal(clock.NowMs / 1000 + 3600, expiry);
        Assert.Equal(TurnCredentials.Sign("s3cret", user), (string)turn["credential"]!);
        Assert.Equal(2, turn["urls"]!.AsArray().Count);
        Assert.Equal(16384, (int)w["limits"]!["maxMsg"]!);
        Assert.Null(w["peerId"]);
    }

    [Fact]
    public void Turn_credential_known_vector()
    {
        // HMAC-SHA1("secret", "1700000000:abc") base64, computed independently (python hmac).
        Assert.Equal("JHgegmW+/B84iarkT5SFAOC1Iqw=", TurnCredentials.Sign("secret", "1700000000:abc"));
        var (u, c) = TurnCredentials.Mint("secret", 1700000000, "abc");
        Assert.Equal("1700000000:abc", u);
        Assert.Equal(TurnCredentials.Sign("secret", u), c);
    }

    [Fact]
    public void No_turn_entry_without_secret()
    {
        var (hub, _) = T.NewHub(o => o.TurnUrls = new() { "turn:x:3478" });
        Assert.Single(T.Ready(hub).Last("welcome")["ice"]!.AsArray());
    }

    [Fact]
    public void Messages_before_hello_and_bad_json_are_bad_request()
    {
        var (hub, _) = T.NewHub();
        var c = new Client(hub);
        c.Join("ABC123");
        Assert.Equal("bad_request", c.LastError);
        c.Send("not json");
        Assert.Equal("bad_request", c.LastError);
        c.Send("{\"t\":\"zzz\"}"); // unknown types ignored
        Assert.Equal(2, c.Inbox.Count);
    }

    [Fact]
    public void Wrong_proto_closes()
    {
        var (hub, _) = T.NewHub();
        var c = new Client(hub).Send("{\"t\":\"hello\",\"proto\":\"lk9\",\"gameId\":\"g\",\"netVersion\":\"1\"}");
        Assert.Equal("bad_request", c.LastError);
        Assert.True(c.Closed);
    }

    [Fact]
    public void Game_allow_list()
    {
        var (hub, _) = T.NewHub(o => o.AllowedGames = new() { "com.example.allowed" });
        var bad = new Client(hub).Hello("other");
        Assert.Equal("game_not_allowed", bad.LastError);
        Assert.True(bad.Closed);
        Assert.True(T.Ready(hub, game: "com.example.allowed").Has("welcome"));
    }

    [Fact]
    public void Names_are_sanitised()
    {
        var (hub, _) = T.NewHub();
        var h = new Client(hub).Hello(name: "  Bo\u0000b‮\n  the   Great and Powerful Wizard of Everything ");
        h.Create();
        string name = (string)h.Last("lobby")["peers"]![0]!["name"]!;
        Assert.DoesNotContain('\u0000', name);
        Assert.DoesNotContain('‮', name);
        Assert.DoesNotContain('\n', name);
        Assert.True(name.Length <= 24);
        Assert.StartsWith("  Bob  the", name); // only control chars and bidi overrides are stripped, no trimming (spec)
        Assert.Equal("Player", Text.Sanitize("\u0001\u0002", 24, "Player"));
    }

    [Fact]
    public void Create_returns_lobby_with_code_and_host_is_peer_1()
    {
        var (hub, _) = T.NewHub();
        var h = T.Ready(hub).Create(meta: "{\"map\":\"a\"}");
        var l = h.Last("lobby");
        Assert.Equal(6, ((string)l["code"]!).Length);
        Assert.Equal(1, (int)l["hostId"]!);
        Assert.Equal(1, (int)l["you"]!);
        Assert.Equal("a", (string)l["meta"]!["map"]!);
        Assert.False(string.IsNullOrEmpty((string)l["resumeToken"]!));
        Assert.Equal("lockstep", (string)l["mode"]!);
    }

    [Theory]
    [InlineData("{\"t\":\"create\",\"maxPlayers\":1}")]
    [InlineData("{\"t\":\"create\",\"maxPlayers\":251}")]
    [InlineData("{\"t\":\"create\",\"maxPlayers\":4,\"visibility\":\"secret\"}")]
    [InlineData("{\"t\":\"create\",\"maxPlayers\":4,\"mode\":\"x\"}")]
    [InlineData("{\"t\":\"create\",\"maxPlayers\":4,\"meta\":{\"a\":1}}")]
    public void Create_validates(string json)
    {
        var (hub, _) = T.NewHub();
        Assert.Equal("bad_request", T.Ready(hub).Send(json).LastError);
    }

    [Fact]
    public void Meta_limits()
    {
        var (hub, _) = T.NewHub();
        var big = string.Join(",", Enumerable.Range(0, 17).Select(i => $"\"k{i}\":\"v\""));
        Assert.Equal("bad_request", T.Ready(hub).Create(meta: "{" + big + "}").LastError);
        Assert.Equal("bad_request", T.Ready(hub, "10.0.0.9").Create(meta: "{\"k\":\"" + new string('x', 65) + "\"}").LastError);
        var ok = string.Join(",", Enumerable.Range(0, 16).Select(i => $"\"k{i}\":\"{new string('x', 64)}\""));
        Assert.True(T.Ready(hub, "10.0.0.8").Create(meta: "{" + ok + "}").Has("lobby"));
    }

    [Fact]
    public void Join_by_code_normalises_input_and_notifies_host()
    {
        var (hub, _) = T.NewHub();
        var h = T.Ready(hub, name: "Host").Create();
        string code = h.Code;
        string typed = (code[..3] + " " + code[3..]).ToLowerInvariant();
        var j = T.Ready(hub, "10.0.0.2", "Joe").Join(typed);
        var l = j.Last("lobby");
        Assert.Equal(2, (int)l["you"]!);
        Assert.Equal(1, (int)l["hostId"]!);
        Assert.Equal(2, l["peers"]!.AsArray().Count);
        Assert.Equal("Joe", (string)h.Last("peer_joined")["peer"]!["name"]!);
        Assert.Equal(2, (int)h.Last("peer_joined")["peer"]!["peerId"]!);
    }

    [Fact]
    public void Crockford_decode_rules()
    {
        Assert.Equal("101123", Crockford.Normalize("iolI23"));
        Assert.Null(Crockford.Normalize("ABCDEU"));
        Assert.Null(Crockford.Normalize("ABCDE"));
        Assert.Null(Crockford.Normalize("ABCDEFG"));
        Assert.Equal("7HQ4K2", Crockford.Normalize("7hq 4k2"));
        var r = new Random(5);
        for (int i = 0; i < 1000; i++)
        {
            string c = Crockford.Generate(r.Next);
            Assert.Equal(c, Crockford.Normalize(c));
            Assert.DoesNotContain('I', c); Assert.DoesNotContain('L', c); Assert.DoesNotContain('O', c); Assert.DoesNotContain('U', c);
        }
    }

    [Fact]
    public void Unknown_code_and_partitioning()
    {
        var (hub, _) = T.NewHub();
        var h = T.Ready(hub).Create();
        Assert.Equal("unknown_code", T.Ready(hub, "10.0.0.2").Join("ZZZZZZ").LastError);
        Assert.Equal("unknown_code", T.Ready(hub, "10.0.0.3", game: "other").Join(h.Code).LastError);
        var mism = T.Ready(hub, "10.0.0.4", ver: "2").Join(h.Code);
        Assert.Equal("version_mismatch", mism.LastError);
        var data = mism.Last("error")["data"]!;
        Assert.Equal("1", (string)data["hostNetVersion"]!);
        Assert.Equal("2", (string)data["yourNetVersion"]!);
    }

    [Fact]
    public void Lobby_full_and_in_game_and_late_join()
    {
        var (hub, _) = T.NewHub();
        var h = T.Ready(hub).Create(max: 2);
        Assert.True(T.Ready(hub, "10.0.0.2").Join(h.Code).Has("lobby"));
        Assert.Equal("lobby_full", T.Ready(hub, "10.0.0.3").Join(h.Code).LastError);

        var h2 = T.Ready(hub, "10.0.0.4").Create(max: 4);
        h2.Send("{\"t\":\"phase\",\"phase\":\"in_game\"}");
        Assert.Equal("in_game", T.Ready(hub, "10.0.0.5").Join(h2.Code).LastError);
        h2.Send("{\"t\":\"phase\",\"phase\":\"lobby\"}");
        Assert.True(T.Ready(hub, "10.0.0.5").Join(h2.Code).Has("lobby"));

        var h3 = T.Ready(hub, "10.0.0.6").Send("{\"t\":\"create\",\"maxPlayers\":4,\"lateJoin\":true}");
        h3.Send("{\"t\":\"phase\",\"phase\":\"in_game\"}");
        Assert.True(T.Ready(hub, "10.0.0.7").Join(h3.Code).Has("lobby"));
    }

    [Fact]
    public void List_filters_partition_visibility_phase_and_meta()
    {
        var (hub, _) = T.NewHub(o => o.Region = "eu");
        T.Ready(hub, "10.0.0.1", "A").Create("public", name: "one", meta: "{\"map\":\"x\"}");
        T.Ready(hub, "10.0.0.2", "B").Create("public", name: "two", meta: "{\"map\":\"y\"}");
        T.Ready(hub, "10.0.0.3", "C").Create("unlisted");
        T.Ready(hub, "10.0.0.4", "D").Create("private");
        T.Ready(hub, "10.0.0.5", "E", game: "other").Create("public");
        T.Ready(hub, "10.0.0.6", "F", ver: "9").Create("public");
        var g = T.Ready(hub, "10.0.0.7", "G").Create("public", name: "ingame");
        g.Send("{\"t\":\"phase\",\"phase\":\"in_game\"}");

        var viewer = T.Ready(hub, "10.0.0.9");
        viewer.Send("{\"t\":\"list\",\"visibility\":\"public\"}");
        var items = viewer.Last("lobbies")["items"]!.AsArray();
        Assert.Equal(new[] { "one", "two" }, items.Select(i => (string)i!["name"]!).ToArray());
        Assert.Equal("eu", (string)items[0]!["region"]!);
        Assert.Equal("A", (string)items[0]!["hostName"]!);
        Assert.Equal(1, (int)items[0]!["players"]!);

        viewer.Send("{\"t\":\"list\",\"visibility\":\"public\",\"meta\":{\"map\":\"y\"}}");
        Assert.Equal("two", (string)viewer.Last("lobbies")["items"]![0]!["name"]!);
        viewer.Send("{\"t\":\"list\",\"visibility\":\"public\",\"limit\":1}");
        var page = viewer.Last("lobbies");
        Assert.Single(page["items"]!.AsArray());
        string cur = (string)page["cursor"]!;
        viewer.Send($"{{\"t\":\"list\",\"visibility\":\"public\",\"limit\":1,\"cursor\":\"{cur}\"}}");
        Assert.Equal("two", (string)viewer.Last("lobbies")["items"]![0]!["name"]!);
        Assert.Null(viewer.Last("lobbies")["cursor"]);
        viewer.Send("{\"t\":\"list\",\"visibility\":\"private\"}");
        Assert.Equal("bad_request", viewer.LastError);
    }

    [Fact]
    public void Signal_is_forwarded_verbatim_only_inside_a_lobby()
    {
        var (hub, _) = T.NewHub();
        var (h, j, _) = T.Pair(hub);
        var outsider = T.Ready(hub, "10.0.0.3").Create();
        j.Send("{\"t\":\"signal\",\"to\":1,\"sdp\":{\"type\":\"answer\",\"sdp\":\"v=0\"},\"ice\":{\"candidate\":\"c\",\"sdpMid\":\"0\",\"sdpMLineIndex\":0}}");
        var s = h.Last("signal");
        Assert.Equal(2, (int)s["from"]!);
        Assert.Equal("v=0", (string)s["sdp"]!["sdp"]!);
        Assert.Equal("c", (string)s["ice"]!["candidate"]!);
        // cross-lobby target: peerId 1 exists in outsider's lobby but j can only reach own lobby's members
        int before = outsider.Inbox.Count;
        j.Send("{\"t\":\"signal\",\"to\":7,\"sdp\":{}}");
        Assert.Equal("bad_request", j.LastError);
        Assert.Equal(before, outsider.Inbox.Count);
        var lone = T.Ready(hub, "10.0.0.4");
        lone.Send("{\"t\":\"signal\",\"to\":1}");
        Assert.Equal("bad_request", lone.LastError);
    }

    [Fact]
    public void Host_only_commands_enforced()
    {
        var (hub, _) = T.NewHub();
        var (h, j, _) = T.Pair(hub);
        j.Send("{\"t\":\"meta\",\"meta\":{}}"); Assert.Equal("not_host", j.LastError);
        j.Send("{\"t\":\"phase\",\"phase\":\"in_game\"}"); Assert.Equal("not_host", j.LastError);
        j.Send("{\"t\":\"kick\",\"peerId\":1}"); Assert.Equal("not_host", j.LastError);
        j.Send("{\"t\":\"approve\",\"peerId\":1,\"ok\":true}"); Assert.Equal("not_host", j.LastError);
        h.Send("{\"t\":\"meta\",\"meta\":{\"a\":\"b\"}}");
        Assert.False(h.Has("error"));
        var viewer = T.Ready(hub, "10.0.0.9");
        viewer.Send("{\"t\":\"list\",\"visibility\":\"public\"}");
        Assert.Equal("b", (string)viewer.Last("lobbies")["items"]![0]!["meta"]!["a"]!);
        h.Send("{\"t\":\"phase\",\"phase\":\"bogus\"}"); Assert.Equal("bad_request", h.LastError);
    }

    [Fact]
    public void Kick_removes_and_blocks_rejoin()
    {
        var (hub, _) = T.NewHub();
        var (h, j, code) = T.Pair(hub);
        var third = T.Ready(hub, "10.0.0.3").Join(code);
        h.Send("{\"t\":\"kick\",\"peerId\":2}");
        Assert.Equal("kicked", j.LastError);
        Assert.False(j.Has("peer_left"));
        Assert.Equal(2, (int)third.Last("peer_left")["peerId"]!);
        Assert.Equal("kicked", (string)h.Last("peer_left")["reason"]!);
        j.Join(code);
        Assert.Equal("kicked", j.LastError);
        h.Send("{\"t\":\"kick\",\"peerId\":1}");
        Assert.Equal("bad_request", h.LastError);
    }

    [Fact]
    public void Private_lobby_needs_approval()
    {
        var (hub, _) = T.NewHub();
        var h = T.Ready(hub, name: "Host").Create("private");
        var j = T.Ready(hub, "10.0.0.2", "Joe").Join(h.Code);
        Assert.False(j.Has("lobby"));
        var req = h.Last("join_request");
        int pid = (int)req["peer"]!["peerId"]!;
        Assert.Equal("Joe", (string)req["peer"]!["name"]!);
        h.Send($"{{\"t\":\"approve\",\"peerId\":{pid},\"ok\":true}}");
        Assert.Equal(pid, (int)j.Last("lobby")["you"]!);
        Assert.Equal(pid, (int)h.Last("peer_joined")["peer"]!["peerId"]!);

        var k = T.Ready(hub, "10.0.0.3", "Kim").Join(h.Code);
        int kid = (int)h.Last("join_request")["peer"]!["peerId"]!;
        h.Send($"{{\"t\":\"approve\",\"peerId\":{kid},\"ok\":false}}");
        Assert.Equal("kicked", k.LastError);
        Assert.Equal("denied", (string)k.Last("error")["data"]!["reason"]!);
        Assert.False(k.Has("lobby"));
    }

    [Fact]
    public void Leave_promotes_lowest_peer_and_last_leave_closes_lobby()
    {
        var (hub, _) = T.NewHub();
        var h = T.Ready(hub, name: "H").Create();
        var b = T.Ready(hub, "10.0.0.2", "B").Join(h.Code);
        var c = T.Ready(hub, "10.0.0.3", "C").Join(h.Code);
        h.Send("{\"t\":\"leave\"}");
        Assert.Equal("left", (string)b.Last("peer_left")["reason"]!);
        Assert.Equal(2, (int)b.Last("host_changed")["hostId"]!);
        Assert.Equal(2, (int)c.Last("host_changed")["hostId"]!);
        Assert.Equal(1, hub.LobbyCount);
        b.Send("{\"t\":\"leave\"}");
        c.Send("{\"t\":\"leave\"}");
        Assert.Equal(0, hub.LobbyCount);
        // host can leave then create again in same session
        h.Create();
        Assert.True(h.Has("lobby"));
    }

    [Fact]
    public void Codes_not_reused_for_24h()
    {
        var clock = new FakeClock();
        int draws = 0;
        // scripted entropy: first 12 draws give "000000" (twice), later draws give "111111"
        var hub = new Hub(new ServerOptions(), clock, null, _ => draws++ < 12 ? 0 : 1);
        var a = T.Ready(hub).Create();
        Assert.Equal("000000", a.Code);
        a.Send("{\"t\":\"leave\"}");
        var b = T.Ready(hub, "10.0.0.2").Create();
        Assert.Equal("111111", b.Code);   // 000000 was retired, so the second draw set is skipped
    }

    [Fact]
    public void Retired_codes_are_released_after_24h()
    {
        var (hub, clock) = T.NewHub();
        var a = T.Ready(hub).Create(); a.Send("{\"t\":\"leave\"}");
        Assert.Contains("onelobby_lobbies_retired 1", hub.Metrics.Render());
        clock.Advance(24L * 3600 * 1000 - 1); hub.Tick();
        Assert.Contains("onelobby_lobbies_retired 1", hub.Metrics.Render());
        clock.Advance(1); hub.Tick();
        Assert.Contains("onelobby_lobbies_retired 0", hub.Metrics.Render());
    }

    [Fact]
    public void Resume_within_60s_keeps_peer_id_and_host_changes_immediately()
    {
        var (hub, clock) = T.NewHub(o => o.IdleTimeoutMs = long.MaxValue / 4);
        var (h, j, code) = T.Pair(hub);
        string token = (string)h.Last("lobby")["resumeToken"]!;
        h.Disconnect();
        Assert.Equal("timeout", (string)j.Last("peer_left")["reason"]!);
        Assert.Equal(2, (int)j.Last("host_changed")["hostId"]!); // server mirror
        Assert.Equal(1, (int)j.Last("host_changed")["epoch"]!);
        clock.Advance(30_000); hub.Tick();
        var back = new Client(hub, "10.0.0.1").Hello(resume: token);
        Assert.Equal(1, (int)back.Last("welcome")["peerId"]!);
        Assert.Equal(1, (int)j.Last("peer_joined")["peer"]!["peerId"]!);
        Assert.Equal(2, ((JsonArray)back.Last("lobby")["peers"]!).Count);
        var l = back.Last("lobby");
        Assert.Equal(1, (int)l["you"]!);
        Assert.Equal(2, (int)l["hostId"]!);
        Assert.NotEqual(token, (string)l["resumeToken"]!);
        clock.Advance(40_000); hub.Tick();
        Assert.Equal(1, j.Inbox.Count(m => (string?)m["t"] == "peer_left")); // only the original timeout
        // old token is dead
        var again = new Client(hub, "10.0.0.5").Hello(resume: token);
        Assert.Null(again.Last("welcome")["peerId"]);
    }

    [Fact]
    public void Resume_window_expires_with_peer_left_timeout()
    {
        var (hub, clock) = T.NewHub(o => o.IdleTimeoutMs = long.MaxValue / 4);
        var (h, j, _) = T.Pair(hub);
        string token = (string)j.Last("lobby")["resumeToken"]!;
        j.Disconnect();
        Assert.Equal("timeout", (string)h.Last("peer_left")["reason"]!);
        clock.Advance(59_999); hub.Tick();
        // slot still reserved: counts toward players in the list
        var v = T.Ready(hub, "10.0.0.8"); v.Send("{\"t\":\"list\",\"visibility\":\"public\"}");
        Assert.Equal(2, (int)v.Last("lobbies")["items"]![0]!["players"]!);
        clock.Advance(1); hub.Tick();
        v.Send("{\"t\":\"list\",\"visibility\":\"public\"}");
        Assert.Equal(1, (int)v.Last("lobbies")["items"]![0]!["players"]!);
        var late = new Client(hub, "10.0.0.2").Hello(resume: token);
        Assert.Null(late.Last("welcome")["peerId"]);
        Assert.False(late.Has("lobby"));
    }

    [Fact]
    public void Resume_takes_over_a_still_open_socket()
    {
        var (hub, _) = T.NewHub();
        var (_, j, _) = T.Pair(hub);
        string token = (string)j.Last("lobby")["resumeToken"]!;
        var fresh = new Client(hub, "10.0.0.2").Hello(resume: token);
        Assert.True(fresh.Has("lobby"));
        Assert.True(j.Closed);
        Assert.Equal(2, (int)fresh.Last("welcome")["peerId"]!);
    }

    [Fact]
    public void Resume_with_a_token_for_another_game_leaves_the_live_socket_alone()
    {
        var (hub, _) = T.NewHub();
        var (_, j, _) = T.Pair(hub);
        string token = (string)j.Last("lobby")["resumeToken"]!;
        var other = new Client(hub, "10.0.0.2").Hello(game: "other", resume: token);
        Assert.Null(other.Last("welcome")["peerId"]);   // plain welcome, not a resume
        Assert.False(j.Closed);
        Assert.False(j.Has("error"));
    }

    [Fact]
    public void Idle_timeout_30s_and_ping_keeps_alive()
    {
        var (hub, clock) = T.NewHub();
        var a = T.Ready(hub, "10.0.0.1");
        var b = T.Ready(hub, "10.0.0.2");
        clock.Advance(20_000);
        b.Send("{\"t\":\"ping\",\"n\":7}");
        Assert.Equal(7, (int)b.Last("pong")["n"]!);
        clock.Advance(11_000); hub.Tick();
        Assert.True(a.Closed);
        Assert.False(b.Closed);
        Assert.Equal(1, hub.SocketCount);
    }

    [Fact]
    public void Rate_limit_create_per_ip()
    {
        var (hub, clock) = T.NewHub(o => o.OpenLobbiesPerIp = 100);
        var c = T.Ready(hub);
        for (int i = 0; i < 10; i++) { c.Create(); c.Send("{\"t\":\"leave\"}"); }
        c.Create();
        Assert.Equal("rate_limited", c.LastError);
        Assert.InRange((long)c.Last("error")["data"]!["retryAfterMs"]!, 1, 60_000);
        clock.Advance(60_000);
        c.Create();
        Assert.Equal("lobby", (string?)c.Inbox.Last()["t"]);
    }

    [Fact]
    public void Open_lobbies_per_ip_capped_at_8()
    {
        var (hub, _) = T.NewHub(o => o.CreatePerMin = 100);
        for (int i = 0; i < 8; i++) Assert.True(T.Ready(hub).Create().Has("lobby"));
        var over = T.Ready(hub).Create();
        Assert.Equal("rate_limited", over.LastError);
        Assert.Equal("max_lobbies", (string)over.Last("error")["data"]!["reason"]!);
        Assert.True(T.Ready(hub, "10.0.0.2").Create().Has("lobby"));
    }

    [Fact]
    public void Rate_limit_join_per_ip_60_per_min()
    {
        var (hub, clock) = T.NewHub();
        var c = T.Ready(hub, "10.0.0.2");
        for (int i = 0; i < 60; i++) { c.Join("ZZZZZZ"); Assert.Equal("unknown_code", c.LastError); }
        c.Join("ZZZZZZ");
        Assert.Equal("rate_limited", c.LastError);
        clock.Advance(60_000);
        c.Join("ZZZZZZ");
        Assert.Equal("unknown_code", c.LastError);
    }

    [Fact]
    public void Rate_limit_signal_20_per_second_per_peer()
    {
        var (hub, clock) = T.NewHub();
        var (h, j, _) = T.Pair(hub);
        for (int i = 0; i < 20; i++) j.Send("{\"t\":\"signal\",\"to\":1,\"ice\":{}}");
        Assert.False(j.Has("error"));
        j.Send("{\"t\":\"signal\",\"to\":1,\"ice\":{}}");
        Assert.Equal("rate_limited", j.LastError);
        Assert.Equal(20, h.Inbox.Count(m => (string?)m["t"] == "signal"));
        clock.Advance(1000);
        j.Send("{\"t\":\"signal\",\"to\":1,\"ice\":{}}");
        Assert.Equal(21, h.Inbox.Count(m => (string?)m["t"] == "signal"));
    }

    [Fact]
    public void Disable_ip_limits_for_load_tests()
    {
        var (hub, _) = T.NewHub(o => o.DisableIpLimits = true);
        var c = T.Ready(hub);
        for (int i = 0; i < 30; i++) Assert.True(c.Create().Has("lobby") && c.Send("{\"t\":\"leave\"}") is not null);
        Assert.Null(c.LastError);
    }

    [Fact]
    public void Global_lobby_peer_and_game_quota_caps()
    {
        var (hub, _) = T.NewHub(o => { o.MaxLobbies = 2; o.CreatePerMin = 100; o.OpenLobbiesPerIp = 100; });
        T.Ready(hub).Create(); T.Ready(hub).Create();
        Assert.Equal("server_full", T.Ready(hub).Create().LastError);

        var (hub2, _) = T.NewHub(o => { o.MaxPeers = 2; });
        T.Ready(hub2, "1.1.1.1"); T.Ready(hub2, "1.1.1.2");
        var over = new Client(hub2, "1.1.1.3");
        Assert.Equal("server_full", over.LastError);
        Assert.True(over.Closed);

        var (hub3, _) = T.NewHub(o => { o.GameQuotas = new() { ["small"] = 1 }; o.CreatePerMin = 100; o.OpenLobbiesPerIp = 100; });
        var a = T.Ready(hub3, game: "small").Create();
        Assert.Equal("server_full", T.Ready(hub3, game: "small").Create().LastError);
        Assert.True(T.Ready(hub3, game: "big").Create().Has("lobby"));
        a.Send("{\"t\":\"leave\"}");
        Assert.True(T.Ready(hub3, game: "small").Create().Has("lobby"));
    }

    [Fact]
    public void Message_size_cap()
    {
        var (hub, _) = T.NewHub(o => o.MaxMessageBytes = 200);
        var c = T.Ready(hub);
        c.Send("{\"t\":\"ping\",\"n\":\"" + new string('a', 300) + "\"}");
        Assert.Equal("bad_request", c.LastError);
        Assert.True(c.Closed);
    }

    [Fact]
    public void Path_telemetry_counts_relayed_vs_direct()
    {
        var (hub, _) = T.NewHub();
        var (h, j, _) = T.Pair(hub);
        h.Send("{\"t\":\"path\",\"path\":\"direct\"}");
        j.Send("{\"t\":\"path\",\"path\":\"relayed\"}");
        j.Send("{\"t\":\"path\",\"path\":\"relayed\"}");
        Assert.Equal(1, hub.Metrics.Get("onelobby_path_total", "path", "direct"));
        Assert.Equal(2, hub.Metrics.Get("onelobby_path_total", "path", "relayed"));
        var text = hub.Metrics.Render();
        Assert.Contains("onelobby_path_total{path=\"relayed\"} 2", text);
        Assert.Contains("onelobby_lobbies 1", text);
        Assert.Contains("onelobby_sockets 2", text);
    }

    [Fact]
    public void Max_players_is_capped_by_the_advertised_limit()
    {
        var (hub, _) = T.NewHub();
        var c = T.Ready(hub);
        Assert.Equal(64, (int)c.Last("welcome")["limits"]!["maxPlayers"]!);
        c.Send("{\"t\":\"create\",\"maxPlayers\":65}");
        Assert.Equal("bad_request", c.LastError);
        Assert.Equal("maxPlayers", (string)c.Last("error")["data"]!["field"]!);
        var (hub2, _) = T.NewHub(o => o.HardMaxPlayers = 250);
        Assert.True(T.Ready(hub2).Send("{\"t\":\"create\",\"maxPlayers\":250}").Has("lobby"));
    }

    [Fact]
    public void Malformed_code_is_bad_request_and_hello_validates_gameId()
    {
        var (hub, _) = T.NewHub();
        Assert.Equal("bad_request", T.Ready(hub).Join("7HQ4KU").LastError);
        Assert.Equal("bad_request", T.Ready(hub, "10.0.0.2").Join("ABC").LastError);
        var bad = new Client(hub, "10.0.0.3").Hello("bad id!");
        Assert.Equal("bad_request", bad.LastError);
        Assert.False(bad.Has("welcome"));
    }

    [Fact]
    public void Meta_and_phase_changes_resend_lobby_to_every_member()
    {
        var (hub, _) = T.NewHub();
        var (h, j, _) = T.Pair(hub);
        h.Send("{\"t\":\"phase\",\"phase\":\"in_game\"}");
        Assert.Equal("in_game", (string)j.Last("lobby")["phase"]!);
        Assert.Equal(2, (int)j.Last("lobby")["you"]!);
        Assert.Equal(1, (int)h.Last("lobby")["you"]!);
        h.Send("{\"t\":\"meta\",\"meta\":{\"k\":\"v\"}}");
        Assert.Equal("v", (string)j.Last("lobby")["meta"]!["k"]!);
    }

    [Fact]
    public void Client_host_changed_claim_needs_higher_epoch_and_own_peer_id()
    {
        var (hub, _) = T.NewHub();
        var (h, j, _) = T.Pair(hub);
        j.Send("{\"t\":\"host_changed\",\"hostId\":1,\"epoch\":1}");   // not own id: ignored
        j.Send("{\"t\":\"host_changed\",\"hostId\":2,\"epoch\":0}");   // epoch not greater: ignored
        Assert.False(h.Has("host_changed"));
        h.Disconnect();   // the host is gone: a claim from a member who is the (only) one left is applied
        j.Send("{\"t\":\"host_changed\",\"hostId\":2,\"epoch\":9}");
        Assert.Equal(2, (int)j.Last("host_changed")["hostId"]!);
        j.Send("{\"t\":\"phase\",\"phase\":\"in_game\"}");
        Assert.False(j.Has("error"));
    }

    [Fact]
    public void Client_host_changed_claim_is_ignored_while_the_host_is_connected_and_applies_when_it_goes()
    {
        var (hub, _) = T.NewHub();
        var (h, j, _) = T.Pair(hub);
        j.Send("{\"t\":\"host_changed\",\"hostId\":2,\"epoch\":3}");
        Assert.False(h.Has("host_changed"));
        Assert.False(j.Has("host_changed"));
        j.Send("{\"t\":\"phase\",\"phase\":\"in_game\"}");
        Assert.Equal("not_host", j.LastError);
        h.Disconnect();
        Assert.Equal(2, (int)j.Last("host_changed")["hostId"]!);
        Assert.Equal(3, (int)j.Last("host_changed")["epoch"]!);   // the claimed epoch, not epoch + 1
        j.Send("{\"t\":\"phase\",\"phase\":\"in_game\"}");
        Assert.Equal("in_game", (string)j.Last("lobby")["phase"]!);
    }

    [Fact]
    public void Client_host_changed_claim_dies_with_its_claimant()
    {
        var (hub, _) = T.NewHub();
        var (h, j, code) = T.Pair(hub);
        var k = T.Ready(hub, "10.0.0.2"); k.Join(code);
        j.Send("{\"t\":\"host_changed\",\"hostId\":2,\"epoch\":3}");
        j.Disconnect();   // claimant gone before the host
        h.Disconnect();
        Assert.Equal(3, (int)k.Last("host_changed")["hostId"]!);
        Assert.Equal(1, (int)k.Last("host_changed")["epoch"]!);
    }

    [Fact]
    public void Signal_needs_sdp_or_ice_and_a_connected_member()
    {
        var (hub, _) = T.NewHub();
        var (h, j, _) = T.Pair(hub);
        j.Send("{\"t\":\"signal\",\"to\":1}");
        Assert.Equal("bad_request", j.LastError);
        j.Send("{\"t\":\"signal\",\"to\":2,\"ice\":{\"candidate\":\"x\"}}"); // to self
        Assert.Equal(2, j.Inbox.Count(m => (string?)m["t"] == "error"));
        h.Disconnect();
        j.Send("{\"t\":\"signal\",\"to\":1,\"ice\":{\"candidate\":\"x\"}}"); // dropped peer
        Assert.Equal(3, j.Inbox.Count(m => (string?)m["t"] == "error"));
    }

    [Fact]
    public void Rate_scale_multiplies_per_ip_limits()
    {
        var (hub, _) = T.NewHub(o => o.RateScale = 20);
        var c = T.Ready(hub);
        for (int i = 0; i < 100; i++) { c.Create(); c.Send("{\"t\":\"leave\"}"); }
        Assert.Null(c.LastError);
    }

    [Fact]
    public void Shared_spec_vectors()
    {
        string? dir = AppContext.BaseDirectory;
        while (dir is not null && !File.Exists(Path.Combine(dir, "spec", "codes.json"))) dir = Path.GetDirectoryName(dir);
        if (dir is null) return; // server built outside the monorepo
        var codes = JsonNode.Parse(File.ReadAllText(Path.Combine(dir, "spec", "codes.json")))!;
        foreach (var v in codes["valid"]!.AsArray())
            Assert.Equal((string)v!["canonical"]!, Crockford.Normalize((string)v["input"]!));
        foreach (var v in codes["invalid"]!.AsArray())
            Assert.Null(Crockford.Normalize((string)v!["input"]!));
        var turn = JsonNode.Parse(File.ReadAllText(Path.Combine(dir, "spec", "vectors", "turn-rest.json")))!;
        foreach (var v in turn["vectors"]!.AsArray())
            Assert.Equal((string)v!["credential"]!, TurnCredentials.Sign((string)v["secret"]!, (string)v["username"]!));
        var mint = turn["mint"]!;
        var (u, c) = TurnCredentials.Mint((string)mint["secret"]!, (long)mint["nowSeconds"]! + (long)mint["ttl"]!, (string)mint["userId"]!);
        Assert.Equal((string)mint["expectUsername"]!, u);
        Assert.Equal((string)mint["expectCredential"]!, c);
    }

    [Fact]
    public void Client_ip_behind_a_proxy_is_the_entry_n_from_the_right()
    {
        // a client that forges the leftmost entry gets the address the proxy appended, not its claim
        Assert.Equal("203.0.113.7", ServerApp.PickClientIp("1.2.3.4, 203.0.113.7", "10.0.0.1", 1));
        Assert.Equal("1.2.3.4", ServerApp.PickClientIp("9.9.9.9, 1.2.3.4, 10.1.1.1", "10.0.0.1", 2));
        Assert.Equal("10.0.0.1", ServerApp.PickClientIp("203.0.113.7", "10.0.0.1", 2));   // header shorter than hops
        Assert.Equal("10.0.0.1", ServerApp.PickClientIp(null, "10.0.0.1", 1));
        Assert.Equal("10.0.0.1", ServerApp.PickClientIp("", "10.0.0.1", 1));
        Assert.Equal("unknown", ServerApp.PickClientIp(null, null, 1));
    }

    [Fact]
    public void Trust_proxy_hops_option_parses()
    {
        Assert.Equal(1, ServerOptions.Parse(new[] { "--trust-proxy" }, _ => null).TrustProxyHops);
        Assert.Equal(2, ServerOptions.Parse(new[] { "--trust-proxy", "--trust-proxy-hops", "2" }, _ => null).TrustProxyHops);
        Assert.Equal(3, ServerOptions.Parse(Array.Empty<string>(), k => k == "ONELOBBY_TRUST_PROXY_HOPS" ? "3" : null).TrustProxyHops);
    }

    [Fact]
    public void Options_parse_flags_and_env()
    {
        var o = ServerOptions.Parse(
            new[] { "--listen", "127.0.0.1:9000", "--turn-urls=turn:a:3478,turns:a:443", "--game-quota", "x=5", "--max-lobbies", "7", "--trust-proxy" },
            k => k == "ONELOBBY_TURN_SECRET" ? "sek" : k == "ONELOBBY_ALLOWED_GAMES" ? "a,b" : null);
        Assert.Equal("http://127.0.0.1:9000", o.ListenUrl());
        Assert.Equal(2, o.TurnUrls.Count);
        Assert.Equal("sek", o.TurnSecret);
        Assert.Equal(7, o.MaxLobbies);
        Assert.Equal(5, o.GameQuotas["x"]);
        Assert.True(o.TrustProxy);
        Assert.Contains("b", o.AllowedGames);
        Assert.Equal("http://0.0.0.0:8080", new ServerOptions().ListenUrl());
        Assert.Throws<ArgumentException>(() => ServerOptions.Parse(new[] { "--nope", "1" }, _ => null));
    }

    [Fact]
    public void Options_read_legacy_KEEPALIVE_env_when_ONELOBBY_is_unset()
    {
        var o = ServerOptions.Parse(Array.Empty<string>(),
            k => k == ServerOptions.LegacyEnvPrefix + "TURN_SECRET" ? "old" : k == ServerOptions.LegacyEnvPrefix + "MAX_LOBBIES" ? "9" : k == "ONELOBBY_MAX_LOBBIES" ? "3" : null);
        Assert.Equal("old", o.TurnSecret);
        Assert.Equal(3, o.MaxLobbies); // the new name wins
    }

    [Fact]
    public void Options_honor_host_PORT_below_explicit_listen()
    {
        Assert.Equal("http://0.0.0.0:10000", ServerOptions.Parse(Array.Empty<string>(), k => k == "PORT" ? "10000" : null).ListenUrl());
        Assert.Equal("http://0.0.0.0:7000", ServerOptions.Parse(Array.Empty<string>(),
            k => k == "PORT" ? "10000" : k == "ONELOBBY_LISTEN" ? ":7000" : null).ListenUrl());
        Assert.Equal("http://127.0.0.1:9000", ServerOptions.Parse(new[] { "--listen", "127.0.0.1:9000" }, k => k == "PORT" ? "10000" : null).ListenUrl());
        Assert.Throws<ArgumentException>(() => ServerOptions.Parse(Array.Empty<string>(), k => k == "PORT" ? "web" : null));
    }
}

