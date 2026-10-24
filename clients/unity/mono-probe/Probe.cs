#nullable enable
using System;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using OneLobby;
using OneLobby.Unity;

// Runs OneLobby.Core + System.Text.Json (the DLLs shipped in com.onelobby.unity) and the package's ClientWebSocket
// signaling adapter on Unity's own Mono, against a real onelobby-server. Peer links are not created (host + list only).
sealed class SignalingOnlyTransport : ITransport
{
    static readonly Stopwatch Clock = Stopwatch.StartNew();
    public long NowMs => Clock.ElapsedMilliseconds;
    public ISignalingSocket ConnectSignaling(Uri url) => new UnitySignalingSocket(url);
    public IPeerLink CreatePeerLink(PeerLinkOptions options) => throw new NotSupportedException("signaling-only probe");
    public void Poll() { }
}

static class Probe
{
    static T Wait<T>(Task<T> t, params Action[] pumps)
    {
        var sw = Stopwatch.StartNew();
        while (!t.IsCompleted) { foreach (var p in pumps) p(); Thread.Sleep(5); if (sw.ElapsedMilliseconds > 10000) throw new TimeoutException(); }
        return t.GetAwaiter().GetResult();
    }

    static int Main(string[] args)
    {
        Console.WriteLine("runtime: " + typeof(object).Assembly.Location + " | " + Type.GetType("Mono.Runtime")?.GetMethod("GetDisplayName", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)?.Invoke(null, null));
        Console.WriteLine("System.Text.Json: " + typeof(System.Text.Json.JsonDocument).Assembly.Location);
        var url = new Uri(args.Length > 0 ? args[0] : "ws://127.0.0.1:18080/ws");
        var cfg = new OneLobbyConfig("com.onelobby.monoprobe", "1", url, SyncMode.Raw, DisplayName: "MonoHost");
        var a = new LobbyClient(cfg, new SignalingOnlyTransport());
        var b = new LobbyClient(cfg with { DisplayName = "MonoLister" }, new SignalingOnlyTransport());
        Lobby? lobby = null;
        lobby = Wait(a.HostAsync(new LobbyOptions("mono probe", 4, Visibility.Public, Meta: new System.Collections.Generic.Dictionary<string, string> { ["map"] = "arena" })), () => a.Pump());
        Console.WriteLine($"hosted {lobby.Code} peer {lobby.LocalPeerId}");
        var list = Wait(b.ListAsync(), () => lobby.Pump(), () => b.Pump());
        var found = list.FirstOrDefaultCode(lobby.Code);
        Console.WriteLine($"list: {list.Count} lobby(s); ours found={found != null} name='{found?.Name}' host='{found?.HostName}' players={found?.Players}/{found?.MaxPlayers}");
        Wait(lobby.LeaveAsync().ContinueWith(_ => 0), () => lobby.Pump());
        Wait(b.DisposeAsync().AsTask().ContinueWith(_ => 0));
        Wait(a.DisposeAsync().AsTask().ContinueWith(_ => 0));
        Thread.Sleep(300);
        var ok = found != null && found.Name == "mono probe" && found.HostName == "MonoHost";
        Console.WriteLine(ok ? "PASS" : "FAIL");
        return ok ? 0 : 1;
    }

    static LobbySummary? FirstOrDefaultCode(this System.Collections.Generic.IReadOnlyList<LobbySummary> l, string code)
    {
        foreach (var s in l) if (s.Code == code) return s;
        return null;
    }
}
