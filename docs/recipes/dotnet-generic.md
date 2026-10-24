# Recipe: generic .NET

`OneLobby.Core` is engine-agnostic (`netstandard2.1` and `net8.0`). It needs an `ITransport` that opens WebRTC data
channels: `OneLobby.Godot` provides one for Godot; for tests use `InMemoryNetwork` (in `OneLobby.Core`). Snippets tagged `csharp compile` are compiled by `docs/check-snippets.mjs` against `OneLobby.Core`.

## 1. Reference

```
dotnet add package OneLobby.Core
```

## 2. Lobby wrapper: Host, Join, Browse

```csharp compile file=Net.cs
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using OneLobby;

public sealed class Net
{
    readonly LobbyClient _client;
    public LobbyClient Client => _client;
    public Lobby? Lobby { get; private set; }
    public string Status { get; private set; } = "";

    // lobbyServer comes from the game's settings (a --lobby-server flag, a config file): never a constant.
    public Net(string lobbyServer, ITransport transport, string displayName)
    {
        var config = new OneLobbyConfig("com.you.yourgame", "1", new Uri(lobbyServer),
                                         SyncMode.Raw, DisplayName: displayName);
        _client = new LobbyClient(config, transport);
        _client.Error += e => Status = $"Multiplayer error: {e.Message}";
    }

    public async Task<string?> HostAsync(CancellationToken ct = default)
    {
        try
        {
            Lobby = await _client.HostAsync(new LobbyOptions("My game", MaxPlayers: 2, Visibility: Visibility.Public), ct);
            return Lobby.Code;                        // show "7HQ 4K2"
        }
        catch (Exception e) { Status = $"Multiplayer unavailable: {e.Message}"; return null; }
    }

    public async Task<bool> JoinAsync(string code, CancellationToken ct = default)
    {
        try { Lobby = await _client.JoinAsync(code, ct); return true; }
        catch (Exception e) { Status = $"Multiplayer unavailable: {e.Message}"; return false; }
    }

    public async Task<IReadOnlyList<LobbySummary>> BrowseAsync(CancellationToken ct = default)
    {
        try { return await _client.ListAsync(null, ct); }
        catch (Exception e) { Status = $"Multiplayer unavailable: {e.Message}"; return Array.Empty<LobbySummary>(); }
    }
}
```

Never block the game loop on these: `await` them from a UI handler and keep ticking while they run.

## 3. Pump and send bytes

```csharp compile file=Loop.cs
using System;
using OneLobby;

public static class Loop
{
    // Call once per frame (or per game-loop iteration). Events fire here, on the calling thread.
    public static void Frame(Net net, Action<int, byte[]> onMessage)
    {
        var lobby = net.Lobby;
        if (lobby is null) net.Client.Pump();   // before a lobby exists, pending Host/Join/Browse calls complete here
        else lobby.Pump();                       // once joined, Lobby.Pump() is the one per-frame call
    }

    public static void Wire(Lobby lobby, Action<int, byte[]> onMessage)
    {
        lobby.MessageReceived += (from, payload, channel) => onMessage(from, payload.ToArray());
        lobby.PeerLeft += (peer, reason) => Console.WriteLine($"{peer.Name} left ({reason})");
        lobby.HostChanged += newHost => Console.WriteLine($"Host is now {newHost}");
    }

    public static void SendMove(Lobby lobby, byte cell)
    {
        if (lobby.IsHost) lobby.Broadcast(new byte[] { 2, cell });
        else lobby.Send(lobby.HostPeerId, new byte[] { 1, cell });
    }
}
```

For lockstep instead of raw, set `SyncMode.Lockstep`, then per frame:
`lobby.Lockstep!.Submit(bytes)`, `while (lobby.Lockstep.TryNextFrame(out var f)) { apply f.Commands; sim.Tick(); }`,
and `ReportHash(tick, hash)` every `HashEveryTicks` ticks. Set `Lockstep.Snapshot` (host) and `Restore` (joiner) for late join.

## Done when

- `dotnet build` is clean with the snippets above.
- Two processes (or two tests using the in-memory transport) host and join: `lobby.Peers.Count == 2` on both sides, and a
  byte array sent with `Send` arrives in `MessageReceived` with the sender's `PeerId`.
- Pointing `lobbyServer` at a dead address makes `HostAsync` return `null` and set `Status`, with the game still running.
