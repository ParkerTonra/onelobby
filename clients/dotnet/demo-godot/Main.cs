using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Godot;
using Keepalive;
using Keepalive.Godot;
using Keepalive.Gridpaint;

namespace KeepaliveDemo;

/// <summary>
/// Gridpaint over Keepalive: Host / Join / Browse, code field, chat line, push-to-talk (hold V).
/// The UI is built in code. Headless automation (after `--`):
///   --server=ws://host:8080/ws  --name=NAME
///   --auto-host --expect-peers=N [--code-file=F]     host, wait for N joiners, start, play
///   --auto-join=CODE | --auto-join-file=F            join (code given or read from a file)
///   --run-ticks=N  --result-file=F                   stop after N ticks, write tick/hash lines and chat lines
///   --paint                                          bot paints a random cell every 10 ticks
/// </summary>
public partial class Main : Node
{
    private readonly GodotTransport _transport = new();
    private LobbyClient? _client;
    private Lobby? _lobby;
    private GridpaintGame? _game;
    private GodotVoiceAudio? _audio;
    private GridView _grid = null!;
    private LineEdit _server = null!, _name = null!, _code = null!, _chatInput = null!;
    private RichTextLabel _chatLog = null!;
    private Label _status = null!, _hashLabel = null!, _roster = null!;
    private ItemList _browse = null!;
    private CheckButton _voiceToggle = null!;
    private ProgressBar _meter = null!;
    private Button _start = null!;

    private readonly Dictionary<string, string> _args = new();
    private string? _resultFile;
    private long _runTicks;
    private int _expectPeers;
    private bool _autoHost, _autoStarted, _paintBot;
    private string? _autoJoinFile;
    private bool _desync;
    private ulong _lastHash;
    private long _lastHashTick;
    private ulong _rng = 88172645463325252UL;

    public override void _Ready()
    {
        foreach (var a in OS.GetCmdlineUserArgs())
        {
            var s = a.TrimStart('-');
            var eq = s.IndexOf('=');
            if (eq < 0) _args[s] = "";
            else _args[s[..eq]] = s[(eq + 1)..];
        }
        BuildUi();
        _resultFile = _args.GetValueOrDefault("result-file");
        _runTicks = long.Parse(_args.GetValueOrDefault("run-ticks", "0"));
        _expectPeers = int.Parse(_args.GetValueOrDefault("expect-peers", "1"));
        _paintBot = _args.ContainsKey("paint");
        if (_args.TryGetValue("server", out var srv)) _server.Text = srv;
        if (_args.TryGetValue("name", out var nm)) _name.Text = nm;
        if (_args.ContainsKey("auto-host")) { _autoHost = true; OnHost(); }
        else if (_args.TryGetValue("auto-join", out var code) && code.Length > 0) { _code.Text = code; OnJoin(); }
        else if (_args.TryGetValue("auto-join-file", out var f)) _autoJoinFile = f;
    }

    // ---- UI ------------------------------------------------------------------------------------------------------

    private void BuildUi()
    {
        var root = new MarginContainer();
        root.AddThemeConstantOverride("margin_left", 12);
        root.AddThemeConstantOverride("margin_right", 12);
        root.AddThemeConstantOverride("margin_top", 12);
        root.AddThemeConstantOverride("margin_bottom", 12);
        AddChild(new CanvasLayer().AddTo(root));
        root.SetAnchorsPreset(Control.LayoutPreset.FullRect);

        var col = new VBoxContainer();
        root.AddChild(col);

        var row1 = new HBoxContainer();
        col.AddChild(row1);
        row1.AddChild(new Label { Text = "Server" });
        _server = new LineEdit { Text = "ws://localhost:8080/ws", CustomMinimumSize = new Vector2(260, 0) };
        row1.AddChild(_server);
        row1.AddChild(new Label { Text = "Name" });
        _name = new LineEdit { Text = "Player" + (new Random().Next(100, 999)), CustomMinimumSize = new Vector2(110, 0) };
        row1.AddChild(_name);

        var row2 = new HBoxContainer();
        col.AddChild(row2);
        var host = new Button { Text = "Host" };
        host.Pressed += OnHost;
        row2.AddChild(host);
        _code = new LineEdit { PlaceholderText = "7HQ 4K2", CustomMinimumSize = new Vector2(110, 0), MaxLength = 12 };
        row2.AddChild(_code);
        var join = new Button { Text = "Join" };
        join.Pressed += OnJoin;
        row2.AddChild(join);
        var browse = new Button { Text = "Browse" };
        browse.Pressed += OnBrowse;
        row2.AddChild(browse);
        _start = new Button { Text = "Start game", Disabled = true };
        _start.Pressed += () => _ = _lobby?.StartAsync();
        row2.AddChild(_start);

        _status = new Label { Text = "Not connected" };
        col.AddChild(_status);

        var mid = new HBoxContainer { SizeFlagsVertical = Control.SizeFlags.ExpandFill };
        col.AddChild(mid);
        _grid = new GridView { CustomMinimumSize = new Vector2(384, 384) };
        _grid.CellClicked = (x, y) => _lobby?.Lockstep?.Submit(GridpaintGame.PaintCommand(x, y));
        mid.AddChild(_grid);

        var side = new VBoxContainer { SizeFlagsHorizontal = Control.SizeFlags.ExpandFill };
        mid.AddChild(side);
        _browse = new ItemList { CustomMinimumSize = new Vector2(0, 90) };
        _browse.ItemActivated += i => { _code.Text = (string)_browse.GetItemMetadata((int)i); OnJoin(); };
        side.AddChild(new Label { Text = "Lobbies (double-click to join)" });
        side.AddChild(_browse);
        _roster = new Label { Text = "Players: -" };
        side.AddChild(_roster);
        _hashLabel = new Label { Text = "hash: -" };
        side.AddChild(_hashLabel);
        _chatLog = new RichTextLabel { ScrollFollowing = true, SizeFlagsVertical = Control.SizeFlags.ExpandFill, CustomMinimumSize = new Vector2(0, 120) };
        side.AddChild(_chatLog);
        _chatInput = new LineEdit { PlaceholderText = "chat (Enter to send)" };
        _chatInput.TextSubmitted += t =>
        {
            if (_lobby != null && t.Length > 0) _lobby.Chat.Send(t);
            _chatInput.Text = "";
        };
        side.AddChild(_chatInput);

        var voiceRow = new HBoxContainer();
        side.AddChild(voiceRow);
        _voiceToggle = new CheckButton { Text = "Voice (hold V)" };
        _voiceToggle.Toggled += on => { if (_lobby != null) _lobby.Voice.Enabled = on; };
        voiceRow.AddChild(_voiceToggle);
        _meter = new ProgressBar { MaxValue = 1, Step = 0.01, CustomMinimumSize = new Vector2(100, 16), ShowPercentage = false };
        voiceRow.AddChild(_meter);

        // the root container is parented through a CanvasLayer so it fills the window
        GetWindow().Title = "Keepalive Gridpaint";
    }

    // ---- lobby flow ------------------------------------------------------------------------------------------------

    private LobbyClient NewClient()
    {
        var cfg = new KeepaliveConfig(GridpaintGame.GameId, GridpaintGame.NetVersion, new Uri(_server.Text.Trim()),
            SyncMode.Lockstep, GridpaintGame.TickRate, GridpaintGame.HashEveryTicks, _name.Text.Trim());
        var c = new LobbyClient(cfg, _transport);
        c.Error += e => SetStatus("Server error: " + e.Code + " " + e.Message);
        return c;
    }

    private async void OnHost()
    {
        if (_lobby != null) return;
        try
        {
            _client = NewClient();
            SetStatus("Creating lobby...");
            var lobby = await _client.HostAsync(new LobbyOptions(_name.Text.Trim() + "'s game", GridpaintGame.MaxPlayers, Visibility.Public));
            Enter(lobby);
            if (_args.TryGetValue("code-file", out var cf)) File.WriteAllText(cf, lobby.Code);
        }
        catch (Exception e) { SetStatus("Host failed: " + e.Message); _client = null; }
    }

    private async void OnJoin()
    {
        if (_lobby != null) return;
        try
        {
            _client = NewClient();
            SetStatus("Joining " + _code.Text + "...");
            Enter(await _client.JoinAsync(_code.Text));
        }
        catch (Exception e) { SetStatus("Join failed: " + e.Message); _client = null; }
    }

    private async void OnBrowse()
    {
        try
        {
            _client ??= NewClient();
            SetStatus("Browsing...");
            var list = await _client.ListAsync();
            _browse.Clear();
            foreach (var l in list)
            {
                var i = _browse.AddItem($"{Crockford.Format(l.Code)}  {l.Name}  {l.Players}/{l.MaxPlayers}");
                _browse.SetItemMetadata(i, l.Code);
            }
            SetStatus(list.Count == 0 ? "No public lobbies" : list.Count + " lobbies");
        }
        catch (Exception e) { SetStatus("Browse failed: " + e.Message); }
    }

    private void Enter(Lobby lobby)
    {
        _lobby = lobby;
        _game = new GridpaintGame(lobby.Code);
        _grid.Game = _game;
        var ls = lobby.Lockstep!;
        ls.Snapshot = () => _game!.Snapshot();
        ls.Restore = (t, b) => { _game!.Restore(t, b.Span); _grid.QueueRedraw(); };
        ls.Desync += d => { _desync = true; Log($"DESYNC at tick {d.Tick} (resync #{d.ResyncCount})"); };
        lobby.Chat.Received += l =>
        {
            var who = lobby.Peers.FirstOrDefault(p => p.PeerId == l.PeerId)?.Name ?? ("#" + l.PeerId);
            _chatLog.AppendText($"{who}: {l.Text}\n");
            Result($"chat {l.PeerId} {l.Text}");
        };
        lobby.Chat.Rejected += (_, r) => _chatLog.AppendText($"(message not sent: {r})\n");
        lobby.PeerJoined += p => Log("joined: " + p.Name);
        lobby.PeerLeft += (p, r) => Log($"left: {p.Name} ({r})");
        lobby.HostChanged += h => Log("host is now #" + h);
        lobby.SessionEnded += r => { SetStatus("Session ended: " + r); _lobby = null; };
        lobby.PhaseChanged += p => Log("phase: " + p);
        lobby.Voice.VoiceError += e => Log("voice: " + e);
        _start.Disabled = !lobby.IsHost;
        _voiceToggle.ButtonPressed = false;
        SetStatus($"In lobby {Crockford.Format(lobby.Code)} as #{lobby.LocalPeerId}{(lobby.IsHost ? " (host)" : "")}");
        Result("lobby " + lobby.Code + " peer " + lobby.LocalPeerId + (lobby.IsHost ? " host" : ""));
    }

    private void SetStatus(string s) { _status.Text = s; GD.Print("[keepalive] " + s); }
    private void Log(string s) { _chatLog.AppendText("* " + s + "\n"); GD.Print("[keepalive] " + s); }

    private void Result(string line)
    {
        if (_resultFile != null) File.AppendAllText(_resultFile, line + "\n");
    }

    // ---- per-frame loop (DESIGN s.11.1) --------------------------------------------------------------------------

    public override void _Process(double delta)
    {
        if (_lobby == null)
        {
            _client?.Pump();
            if (_autoJoinFile != null && _lobby == null && File.Exists(_autoJoinFile))
            {
                var code = File.ReadAllText(_autoJoinFile).Trim();
                _autoJoinFile = null;
                if (code.Length > 0) { _code.Text = code; OnJoin(); }
            }
            return;
        }
        var lobby = _lobby;
        lobby.Pump();
        if (_lobby == null) return; // session ended during the pump
        var ls = lobby.Lockstep!;
        var drained = 0;
        while (ls.TryNextFrame(out var f))
        {
            _game!.Apply(f.Tick, f.Commands);
            if (f.Tick % GridpaintGame.HashEveryTicks == 0)
            {
                var h = _game.Hash();
                ls.ReportHash(f.Tick, h);
                _lastHash = h; _lastHashTick = f.Tick;
                _desync = false;
                Result($"hash {f.Tick} {h}");
            }
            if (_paintBot && f.Tick % 10 == (lobby.LocalPeerId % 10)) BotPaint();
            if (f.Tick == 100) lobby.Chat.Send("hello from " + _name.Text);
            if (_runTicks > 0 && f.Tick >= _runTicks) { Finish(); return; }
            if (++drained > 200 || ls.FramesBuffered <= 2) break;
        }
        _grid.QueueRedraw();
        _roster.Text = "Players: " + string.Join(", ", lobby.Peers.Select(p => p.Name + (p.PeerId == lobby.HostPeerId ? "*" : "")));
        _hashLabel.Text = $"tick {ls.Tick}  hash@{_lastHashTick}: {_lastHash:x16}  {(_desync ? "DESYNC" : "in sync")}";
        _meter.Value = lobby.Voice.InputLevel;
        lobby.Voice.PushToTalk(Input.IsKeyPressed(Key.V) && !_chatInput.HasFocus());

        if (_autoHost && !_autoStarted && lobby.IsReady && lobby.Peers.Count >= _expectPeers + 1 && lobby.Phase == LobbyPhase.Lobby)
        {
            _autoStarted = true;
            _ = lobby.StartAsync();
            Log("auto-start");
        }
    }

    private void BotPaint()
    {
        _rng ^= _rng << 13; _rng ^= _rng >> 7; _rng ^= _rng << 17;
        _lobby!.Lockstep!.Submit(GridpaintGame.PaintCommand((int)(_rng % 16), (int)((_rng >> 8) % 16)));
    }

    private void Finish()
    {
        Result($"final {_game!.Tick} {_game.Hash()}");
        GetTree().Quit();
    }

    public override void _ExitTree()
    {
        _audio?.Dispose();
    }

    public override void _Notification(int what)
    {
        if (what == NotificationWMCloseRequest && _lobby != null) _ = _lobby.LeaveAsync();
    }

    public override void _Input(InputEvent @event)
    {
        // opt-in voice: enabling creates the Opus codec and the Godot audio adapter
        if (_lobby != null && _voiceToggle.ButtonPressed && _lobby.Voice.Audio == null)
        {
            _audio = GodotVoiceAudio.Attach(this, _lobby.Voice);
            _lobby.Voice.Enabled = true;
        }
    }
}

internal static class UiExt
{
    public static T AddTo<T>(this T node, Node child) where T : Node { node.AddChild(child); return node; }
}
