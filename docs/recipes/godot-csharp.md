# Recipe: Godot 4 C# (desktop and web)

Godot uses `OneLobby.Core` unchanged and adds `OneLobby.Godot` for the WebRTC transport, microphone capture and Opus.
Godot snippets are not compiled by `check-snippets.mjs` (they need GodotSharp); the engine-free parts are in
`dotnet-generic.md` and are. Use Godot 4.5 or newer with the .NET build (tested on 4.5.1 and 4.7.2; `OneLobby.Godot`
builds against GodotSharp 4.5.1, and a newer project's GodotSharp takes its place).

## 1. Add the packages

```
dotnet add package OneLobby.Core
dotnet add package OneLobby.Godot
```

Desktop: copy the `webrtc-native` GDExtension into `addons/` (the demo in `clients/dotnet/demo-godot/` shows where).
Web export: nothing extra, but see "Web builds" below.

## 2. Autoload `Multiplayer.cs`

Add it under Project Settings, Autoload, as `Net`. The lobby server is a setting with a pre-filled default.

```csharp godot
using System;
using System.Threading.Tasks;
using Godot;
using OneLobby;
using OneLobby.Godot;

public partial class Net : Node
{
    public const string DefaultServer = "wss://lobby.onelobby.example/ws";
    LobbyClient _client = null!;
    public Lobby? Lobby { get; private set; }
    [Signal] public delegate void StatusEventHandler(string text);

    public override void _Ready()
    {
        string server = DefaultServer;
        foreach (var arg in OS.GetCmdlineArgs())                              // --lobby-server=ws://127.0.0.1:8080/ws
            if (arg.StartsWith("--lobby-server=")) server = arg["--lobby-server=".Length..];
        var cfg = new ConfigFile();
        if (cfg.Load("user://settings.cfg") == Error.Ok)
            server = (string)cfg.GetValue("multiplayer", "lobby_server", server);

        var config = new OneLobbyConfig("com.you.yourgame", "1", new Uri(server), SyncMode.Raw, DisplayName: "Player");
        _client = new LobbyClient(config, new GodotTransport());
        _client.Error += e => EmitSignal(SignalName.Status, e.Message);
    }

    public override void _Process(double delta)                               // events fire on the main thread
    {
        if (Lobby != null) Lobby.Pump(); else _client.Pump();                 // _client.Pump() only matters before a lobby exists
    }

    public async Task<string?> HostAsync()
    {
        try { Lobby = await _client.HostAsync(new LobbyOptions("My game", MaxPlayers: 2, Visibility: Visibility.Public)); return Lobby.Code; }
        catch (Exception e) { EmitSignal(SignalName.Status, "Multiplayer unavailable: " + e.Message); return null; }
    }

    public async Task<bool> JoinAsync(string code)
    {
        try { Lobby = await _client.JoinAsync(code); return true; }
        catch (Exception e) { EmitSignal(SignalName.Status, "Multiplayer unavailable: " + e.Message); return false; }
    }

    public async Task<System.Collections.Generic.IReadOnlyList<LobbySummary>> BrowseAsync()
    {
        try { return await _client.ListAsync(); }
        catch (Exception e) { EmitSignal(SignalName.Status, "Multiplayer unavailable: " + e.Message); return Array.Empty<LobbySummary>(); }
    }
}
```

## 3. Host / Join / Browse buttons

```csharp godot
public partial class MultiplayerMenu : Control
{
    Net _net = null!;
    public override void _Ready()
    {
        _net = GetNode<Net>("/root/Net");
        var status = GetNode<Label>("Status");
        _net.Status += text => status.Text = text;

        GetNode<Button>("Host").Pressed += async () =>
        {
            var code = await _net.HostAsync();
            if (code != null) status.Text = $"Share this code: {code}";
        };
        GetNode<Button>("Join").Pressed += async () =>
        {
            if (await _net.JoinAsync(GetNode<LineEdit>("Code").Text)) status.Text = "Joined.";
        };
        GetNode<Button>("Browse").Pressed += async () =>
        {
            var list = GetNode<ItemList>("Lobbies");
            list.Clear();
            foreach (var s in await _net.BrowseAsync()) list.AddItem($"{s.Name} ({s.Players}/{s.MaxPlayers})");
        };
    }
}
```

## 4. Game traffic

Raw mode: `Lobby.Send` / `Broadcast` and `MessageReceived` (see `raw-mode.md`). Lockstep: set `SyncMode.Lockstep` and drain
frames in `_Process` after `Pump()` (the loop in `AGENTS.md` rule 3 and DESIGN s.11.1): decode each command, call your
sim, `ReportHash` every `HashEveryTicks`. The sim must be deterministic and not read Godot nodes or the clock.

## Web builds

Browser peers use the browser's own WebRTC through `OneLobby.Godot`'s web path. Serve the export with
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (the `deploy/Caddyfile` snippet
does this) if you use threads. Voice needs `audio/driver/enable_input` on.

## Done when

- The project builds with `dotnet build` and the menu shows Host / Join / Browse.
- With a local `onelobby-server`, two Godot instances (`--lobby-server=ws://127.0.0.1:8080/ws`; use 127.0.0.1, not localhost): one presses Host and shows a
  code, the other joins it, and a message sent by one arrives in the other's `MessageReceived`.
- With the server address wrong, the game still starts and plays, and the menu shows "Multiplayer unavailable".
