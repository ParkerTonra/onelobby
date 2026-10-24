using System.Text.Json.Nodes;

namespace OneLobby.Server.Tests;

public sealed class FakeClock : IClock
{
    public long NowMs { get; set; } = 1_800_000_000_000;
    public void Advance(long ms) => NowMs += ms;
}

/// <summary>A fake socket bound to a hub.</summary>
public sealed class Client
{
    public Hub Hub { get; }
    public Session? Session { get; private set; }
    public List<JsonObject> Inbox { get; } = new();
    public bool Closed { get; private set; }
    public string Ip { get; }

    public Client(Hub hub, string ip = "10.0.0.1")
    {
        Hub = hub; Ip = ip;
        Session = hub.Connect(ip, text => Inbox.Add((JsonObject)JsonNode.Parse(text)!), () => Closed = true);
    }

    public Client Send(string json) { if (Session is not null) Hub.Receive(Session, json); return this; }

    public Client Hello(string game = "g", string ver = "1", string name = "Ann", string? resume = null)
    {
        var o = new JsonObject { ["t"] = "hello", ["proto"] = "lk1", ["gameId"] = game, ["netVersion"] = ver, ["name"] = name,
            ["client"] = new JsonObject { ["lib"] = "test", ["ver"] = "0", ["platform"] = "test" } };
        if (resume is not null) o["resumeToken"] = resume;
        return Send(o.ToJsonString());
    }

    public Client Create(string vis = "public", int max = 4, string name = "L", string? meta = null) =>
        Send($"{{\"t\":\"create\",\"name\":\"{name}\",\"maxPlayers\":{max},\"visibility\":\"{vis}\",\"mode\":\"lockstep\",\"tickRate\":20,\"lateJoin\":false,\"meta\":{meta ?? "{}"}}}");

    public Client Join(string code) => Send($"{{\"t\":\"join\",\"code\":\"{code}\"}}");

    public void Disconnect() => Hub.Disconnect(Session!);

    public JsonObject Last(string t) => Inbox.Last(m => (string?)m["t"] == t);
    public bool Has(string t) => Inbox.Any(m => (string?)m["t"] == t);
    public string? LastError => Inbox.LastOrDefault(m => (string?)m["t"] == "error") is { } e ? (string?)e["code"] : null;
    public string Code => (string)Last("lobby")["code"]!;
    public int PeerId => (int)Last("lobby")["you"]!;
}

public static class T
{
    public static (Hub Hub, FakeClock Clock) NewHub(Action<ServerOptions>? cfg = null, int seed = 1)
    {
        var o = new ServerOptions();
        cfg?.Invoke(o);
        var clock = new FakeClock();
        var rng = new Random(seed);
        return (new Hub(o, clock, null, rng.Next), clock);
    }

    public static Client Ready(Hub hub, string ip = "10.0.0.1", string name = "Ann", string game = "g", string ver = "1") =>
        new Client(hub, ip).Hello(game, ver, name);

    public static (Client Host, Client Joiner, string Code) Pair(Hub hub, string vis = "public")
    {
        var h = Ready(hub, "10.0.0.1", "Host").Create(vis);
        var j = Ready(hub, "10.0.0.2", "Joe").Join(h.Code);
        return (h, j, h.Code);
    }
}
