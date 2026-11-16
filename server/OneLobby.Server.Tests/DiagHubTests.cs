using System.Text.Json.Nodes;
using Xunit;

namespace OneLobby.Server.Tests;

/// <summary>The hub's part of diagnostics (spec/diagnostics.md s.7): the joiner's report goes to the host only, rebuilt and rate limited.</summary>
public class DiagHubTests
{
    private const string Good =
        "{\"cause\":\"nat_blocked\",\"stage\":\"ice\",\"elapsedMs\":15000,\"relaySet\":false,\"candidateTypes\":{\"local\":[\"host\",\"srflx\"],\"remote\":[\"host\",\"srflx\"]},\"clientVersion\":\"0.7.2\"}";

    private static string Diag(string report) => $"{{\"t\":\"diag\",\"report\":{report}}}";

    private static JsonNode Vectors()
    {
        string? dir = AppContext.BaseDirectory;
        while (dir is not null && !File.Exists(Path.Combine(dir, "spec", "codes.json"))) dir = Path.GetDirectoryName(dir);
        Assert.NotNull(dir);
        return JsonNode.Parse(File.ReadAllText(Path.Combine(dir!, "spec", "vectors", "diagnostics.json")))!;
    }

    [Fact]
    public void Welcome_lists_the_diag_feature()
    {
        var (hub, _) = T.NewHub();
        var f = T.Ready(hub).Last("welcome")["features"]!.AsArray().Select(x => (string?)x).ToList();
        Assert.Contains("diag", f);
    }

    [Fact]
    public void A_joiners_report_reaches_the_host_only_with_from_stamped_by_the_hub()
    {
        var (hub, _) = T.NewHub();
        var (host, joe, code) = T.Pair(hub);
        var other = T.Ready(hub, "10.0.0.3", "Kim").Join(code);
        int joeId = joe.PeerId;
        host.Inbox.Clear(); joe.Inbox.Clear(); other.Inbox.Clear();

        // a client-supplied "from" is ignored
        joe.Send("{\"t\":\"diag\",\"from\":3,\"report\":" + Good + "}");

        var got = host.Last("diag");
        Assert.Equal(joeId, (int)got["from"]!);
        Assert.Equal("nat_blocked", (string)got["report"]!["cause"]!);
        Assert.False(other.Has("diag"));
        Assert.False(joe.Has("diag"));
        Assert.Null(joe.LastError);
    }

    [Fact]
    public void The_hub_rebuilds_the_report_and_drops_unknown_fields()
    {
        var (hub, _) = T.NewHub();
        var (host, joe, _) = T.Pair(hub);
        joe.Send(Diag(Good.Replace("{\"cause\"", "{\"address\":\"203.0.113.9\",\"name\":\"Sam\",\"cause\"")));
        var r = host.Last("diag")["report"]!.AsObject();
        Assert.Equal(new[] { "cause", "stage", "elapsedMs", "relaySet", "candidateTypes", "clientVersion" }, r.Select(kv => kv.Key).ToArray());
        Assert.DoesNotContain("203.0.113.9", host.Last("diag").ToJsonString());
    }

    [Fact]
    public void Valid_and_invalid_reports_follow_the_shared_vectors()
    {
        var v = Vectors()["report"]!;
        foreach (var c in v["valid"]!.AsArray())
        {
            var (hub, _) = T.NewHub();
            var (host, joe, _) = T.Pair(hub);
            joe.Send(Diag(c!["input"]!.ToJsonString()));
            Assert.Null(joe.LastError);
            Assert.Equal(c["output"]!.ToJsonString(), host.Last("diag")["report"]!.ToJsonString());
        }
        foreach (var c in v["invalid"]!.AsArray())
        {
            var (hub, _) = T.NewHub();
            var (host, joe, _) = T.Pair(hub);
            joe.Send(Diag(c!["input"]!.ToJsonString()));
            Assert.Equal("bad_request", joe.LastError);
            Assert.False(host.Has("diag"));
        }
    }

    [Fact]
    public void A_frame_over_the_cap_is_refused()
    {
        var (hub, _) = T.NewHub();
        var (host, joe, _) = T.Pair(hub);
        joe.Send("{\"t\":\"diag\",\"pad\":\"" + new string('x', 1100) + "\",\"report\":" + Good + "}");
        Assert.Equal("bad_request", joe.LastError);
        Assert.False(host.Has("diag"));
    }

    [Fact]
    public void Only_three_reports_per_minute_per_peer_then_rate_limited()
    {
        var (hub, clock) = T.NewHub();
        var (host, joe, _) = T.Pair(hub);
        for (int i = 0; i < 3; i++) joe.Send(Diag(Good));
        Assert.Null(joe.LastError);
        joe.Send(Diag(Good));
        Assert.Equal("rate_limited", joe.LastError);
        Assert.Equal(3, host.Inbox.Count(m => (string?)m["t"] == "diag"));
        clock.Advance(61_000);
        joe.Inbox.Clear();
        joe.Send(Diag(Good));
        Assert.Null(joe.LastError);
        Assert.Equal(4, host.Inbox.Count(m => (string?)m["t"] == "diag"));
    }

    [Fact]
    public void The_host_and_a_peer_outside_a_lobby_cannot_send_one()
    {
        var (hub, _) = T.NewHub();
        var (host, _, _) = T.Pair(hub);
        host.Send(Diag(Good));
        Assert.Equal("bad_request", host.LastError);
        var loose = T.Ready(hub, "10.0.0.9", "Zed").Send(Diag(Good));
        Assert.Equal("bad_request", loose.LastError);
    }

    [Fact]
    public void A_peer_waiting_for_approval_is_not_in_the_lobby()
    {
        var (hub, _) = T.NewHub();
        var host = T.Ready(hub, "10.0.0.1", "Host").Create("private");
        var waiting = T.Ready(hub, "10.0.0.2", "Joe").Join(host.Code);
        host.Inbox.Clear();
        waiting.Send(Diag(Good));
        Assert.Equal("bad_request", waiting.LastError);
        Assert.False(host.Has("diag"));
    }
}
