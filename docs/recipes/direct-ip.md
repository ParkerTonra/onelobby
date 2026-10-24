# Recipe: host by IP (no server)

The host's game is the server, like Terraria "Host & Play" or Minecraft "Open to LAN": it runs the lobby hub in-process
and listens on one port, **47810** by default (TCP for signaling, UDP for the game). Friends join by typing the host's
address. Nobody runs a lobby server, so nothing can go offline. Design and sources: [docs/direct-ip.md](../direct-ip.md).

Scope today: .NET desktop through `OneLobby.DataChannel` (any .NET app, Unity desktop). Godot and browsers come later.
Snippets tagged `csharp compile` are compiled by `docs/check-snippets.mjs`.

## 1. Reference

From a clone of this repo (not on NuGet yet), reference three projects:

```
dotnet add reference path/to/onelobby/clients/dotnet/OneLobby.Core/OneLobby.Core.csproj
dotnet add reference path/to/onelobby/clients/dotnet/OneLobby.DataChannel/OneLobby.DataChannel.csproj
dotnet add reference path/to/onelobby/clients/dotnet/OneLobby.Direct/OneLobby.Direct.csproj
```

`OneLobby.DataChannel` needs its native library built once (`clients/dotnet/OneLobby.DataChannel/native/build-windows.ps1`
or `build-posix.sh`), see the [.NET recipe](dotnet-generic.md).

## 2. Host and join

```csharp compile file=DirectNet.cs
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using OneLobby;
using OneLobby.DataChannel;
using OneLobby.Direct;

public sealed class DirectNet
{
    readonly LobbyClient _client;
    public Lobby? Lobby { get; private set; }
    public string Status { get; private set; } = "";

    // port is a game setting (default 47810); the host forwards this one number, TCP and UDP.
    public DirectNet(string displayName, int port = DirectLobby.DefaultPort)
    {
        var config = new OneLobbyConfig("com.you.yourgame", "1", new Uri("ws://unused.invalid/"),
                                         SyncMode.Raw, DisplayName: displayName, DirectPort: port);
        _client = new LobbyClient(config, new DataChannelTransport());
    }

    /// <summary>Call every frame: pumps the lobby, or the client until the lobby exists.</summary>
    public void Pump() { if (Lobby != null) Lobby.Pump(); else _client.Pump(); }

    public async Task<IReadOnlyList<string>> HostAsync(string? password = null)
    {
        try
        {
            Lobby = await _client.HostDirectAsync(new DirectHostOptions { Password = password, MaxPlayers = 4 });
            Lobby.SessionEnded += reason => { Status = "Session ended: " + reason; Lobby = null; };
            return Lobby.DirectAddresses;             // show these with a Copy button: "192.168.1.20:47810"
        }
        catch (OneLobbyException e) { Status = Describe(e); return Array.Empty<string>(); }
    }

    public async Task<bool> JoinAsync(string address, string? password = null)
    {
        try
        {
            Lobby = await _client.JoinDirectAsync(address, password);  // "192.168.1.20", "203.0.113.7:47810", "[2001:db8::1]:47810"
            Lobby.SessionEnded += reason => { Status = reason == "host_left" ? "The host closed the game." : "Session ended: " + reason; Lobby = null; };
            return true;
        }
        catch (OneLobbyException e) { Status = Describe(e); return false; }
    }

    static string Describe(OneLobbyException e) => e.Code switch
    {
        "direct_unreachable" => "No answer from that address. Check it, and that the host forwarded TCP and UDP port 47810.",
        "bad_password" => "Wrong password.",
        "bad_address" => "That is not an address. Try 192.168.1.20 or 192.168.1.20:47810.",
        "port_in_use" => "Port 47810 is busy: is another copy of the game hosting?",
        "version_mismatch" => "You and the host run different versions of the game.",
        "lobby_full" => "The game is full.",
        _ => "Multiplayer unavailable: " + e.Message,
    };
}
```

`HostDirectAsync` and `JoinDirectAsync` complete inside `Pump()`, like `HostAsync`. Everything after that is the normal
`Lobby` API (`Send`, `Broadcast`, `MessageReceived`, `Lockstep`, `Chat`, `Voice`). Rules that differ from the hosted
server:

- No join codes: `lobby.Code` is empty, `ListAsync` returns nothing. The address is the invitation.
- When the host leaves, the session ends for everyone (`SessionEnded("host_left")`). No host migration.
- No STUN or TURN: the game never contacts an outside server.

## 3. What to tell the host (put this on the host screen)

- "Your address: `192.168.1.20:47810`" (every entry of `lobby.DirectAddresses`), each with a Copy button, in large
  monospace. Friends on the same network type it as is.
- "Friends outside your network: forward **TCP and UDP port 47810** on your router to this PC, then give them your
  public IP with the port. Or use a virtual LAN (Tailscale, ZeroTier, Hamachi) and give them that address."
- "If Windows asks, allow access on Private networks." Keep this text on screen until someone joins: the game cannot see
  the answer.

## Done when

1. Build the smoke tool: `dotnet build clients/dotnet/OneLobby.DataChannel.Smoke -c Release`.
2. In one terminal: `OneLobby.DataChannel.Smoke host-direct 47810` prints `addresses ...`.
3. In another (same machine, or another PC on the network with one of those addresses):
   `OneLobby.DataChannel.Smoke join-direct 192.168.1.20` prints a `pair` line and `PASS`, and the host prints `PASS host`.
4. Through a forwarded port, from outside the network: `join-direct <public-ip>` passes, and the joiner's `pair` line
   shows the public address as `remote[...]` (that is the typed-address candidate at work).
   No second network? `join-direct <LAN address> --only-typed` drops every candidate the host offers, so the typed
   address is the only way in (the outside-joiner case); it passes with that address as `remote[...]`.
