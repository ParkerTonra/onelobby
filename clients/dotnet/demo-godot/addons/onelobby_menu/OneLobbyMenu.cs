using System;
using System.Collections.Generic;
using System.Linq;
using Godot;
using OneLobby.Godot;

namespace OneLobby;

/// <summary>
/// The drop-in multiplayer menu for Godot C#: add <c>OneLobbyMenu.tscn</c> to a scene, connect <see cref="GameStarted"/>, done.
/// It draws <see cref="MenuModel"/> (OneLobby.Core, all the decisions live there) on the same node tree and unique names as the
/// GDScript menu's <c>menu.tscn</c>, and forwards input to it. Stock controls on the engine's default Theme: a game restyles it
/// by giving the root (or any parent) a Theme. Every string comes from <see cref="MenuText"/>. It reads <c>onelobby.json</c>
/// (<see cref="ConfigPath"/>), builds its own <see cref="LobbyClient"/> from it (saved settings under <c>user://</c>), and calls
/// <c>Client.Pump()</c> itself (set <see cref="Pump"/> to false when your game pumps).
/// <code>
/// GetNode&lt;OneLobbyMenu&gt;("OneLobbyMenu").GameStarted += lobby =&gt; StartMyGame(lobby);
/// </code>
/// Nodes a controller may touch, all with unique names (<c>%Name</c>); the same list as the GDScript menu's header:
///   Pages
///   start:      StartPage StartTitle StartNote NameLabel NameEdit HostButton JoinLabel JoinEdit JoinButton PasswordEdit BrowseButton SettingsButton StartCheckLine
///   connecting: ConnectingPage ConnectingLabel ConnectingCancel
///   lobby:      LobbyPage CodeCaption CodeLabel CopyCodeButton CopyInviteButton PlayersHeader RosterList RosterNote CountdownLabel
///               ReadyButton StartButton CancelStartButton LeaveButton LobbyNote RequestsHeader RequestsList ReasonEdit BansHeader BansList
///               LobbySettingsToggle LobbySettingsBox AutoStartLabel AutoStartOption MinPlayersLabel MinPlayersSpin CountdownSecondsLabel
///               CountdownSpin LateJoinCheck ChatBox ChatLog ChatEdit ChatSendButton
///   error:      ErrorPage ErrorTitle ErrorMessage ErrorHint ErrorCode CopyLogsButton SaveLogsButton LogNote ErrorBackButton
///   settings:   SettingsPage SettingsTitle RelayLabel RelayStatus RelayEdit RelaySaveButton RelayClearButton RelayNote ServerLabel
///               ServerEdit ServerSaveButton ServerNote ConnectionCheckButton CheckVerdict CheckFacts SettingsCopyLogsButton SettingsBackButton
///   browse:     BrowsePage BrowseTitle BrowseStatus BrowseList BrowseRefreshButton BrowseBackButton
/// (The roster, ban, request and browse rows are built at run time inside RosterList, BansList, RequestsList and BrowseList.)
/// </summary>
public partial class OneLobbyMenu : Control
{
    public const string DefaultConfigPath = "res://onelobby.json";

    /// <summary>The host started the game, or the player joined a game that is already running. The menu hides itself when <see cref="AutoHideOnStart"/> is true.</summary>
    /// <remarks>A C# event rather than a Godot signal: a <see cref="Lobby"/> is not a Godot type, so it cannot travel in a signal.</remarks>
    public event Action<Lobby>? GameStarted;

    /// <summary>The game went back to the lobby; the menu shows the lobby again.</summary>
    public event Action<Lobby>? ReturnedToLobby;

    /// <summary>The player left the lobby.</summary>
    [Signal] public delegate void LeftEventHandler();

    /// <summary>The blueprint to read when <see cref="Client"/> is not set.</summary>
    [Export(PropertyHint.File, "*.json")] public string ConfigPath { get; set; } = DefaultConfigPath;

    /// <summary>The menu calls <c>Client.Pump()</c> every frame. Turn it off when your game pumps (e.g. from <c>_PhysicsProcess</c>).</summary>
    [Export] public bool Pump { get; set; } = true;

    /// <summary>Hide the menu while a game runs, show it again when the lobby comes back.</summary>
    [Export] public bool AutoHideOnStart { get; set; } = true;

    /// <summary>
    /// Act on <c>--host</c>, <c>--join=&lt;code&gt;</c> and <c>--name=&lt;name&gt;</c> (after <c>--</c> on the command line). One switch for all three.
    /// They are applied right after the scene's <c>_Ready</c> calls, so a parent that sets <see cref="HostDirect"/> / <see cref="JoinDirect"/> in its own
    /// <c>_Ready</c> is in time. <c>--local</c> is read whatever this says.
    /// </summary>
    [Export] public bool BootFlags { get; set; } = true;

    /// <summary>Base address of an invite link ("https://game.example/play"); with it the copied invite sentence ends with the link.</summary>
    [Export] public string InviteBase { get; set; } = "";

    /// <summary>Rewording: {text key: new text}, keys as in <see cref="MenuText.Table"/>.</summary>
    [Export] public global::Godot.Collections.Dictionary<string, string> Texts { get; set; } = new();

    /// <summary>The client the menu drives. Set it before the menu enters the tree to use your own; default: one made from <see cref="ConfigPath"/>.</summary>
    public LobbyClient? Client { get; set; }

    /// <summary>The model the menu draws (set when the menu enters the tree).</summary>
    public MenuModel? Model { get; private set; }

    /// <summary>The command line the boot flags and <c>--local</c> are read from (default: <c>OS.GetCmdlineUserArgs()</c>).</summary>
    public string[] BootArgs { get; set; } = Array.Empty<string>();

    /// <summary>Runs the connection check instead of <c>Client.CheckConnectionAsync</c> (a test gives a fake; see <see cref="MenuModel.CheckRunner"/>). Set it before the menu enters the tree.</summary>
    public Func<CheckOptions?, System.Threading.Tasks.Task<CheckResult>>? CheckRunner { get; set; }

    private LobbyOptions? _hostOptions;
    private RoomJoinOptions? _joinOptions;
    private MenuRoute _route = MenuRoute.Auto;
    private bool _local;
    private Func<string?, System.Threading.Tasks.Task<Lobby>>? _hostDirect;
    private Func<string, string?, System.Threading.Tasks.Task<Lobby>>? _joinDirect;

    /// <summary>Base options for Host (see <see cref="MenuModel.HostOptions"/>).</summary>
    public LobbyOptions? HostOptions { get => _hostOptions; set { _hostOptions = value; if (Model != null) Model.HostOptions = value; } }

    /// <summary>Base options for Join (see <see cref="MenuModel.JoinOptions"/>).</summary>
    public RoomJoinOptions? JoinOptions { get => _joinOptions; set { _joinOptions = value; if (Model != null) Model.JoinOptions = value; } }

    /// <summary><c>Auto</c> (the blueprint decides), <c>Direct</c> or <c>Server</c>. A menu started with <c>--local</c> stays on <c>Direct</c>: no lobby server.</summary>
    public MenuRoute Route { get => _route; set { _route = value; if (Model != null) Model.Route = _local ? MenuRoute.Direct : value; } }

    /// <summary>Host a direct lobby (OneLobby.Direct); see <see cref="MenuModel.HostDirect"/>.</summary>
    public Func<string?, System.Threading.Tasks.Task<Lobby>>? HostDirect { get => _hostDirect; set { _hostDirect = value; if (Model != null) Model.HostDirect = value; } }

    /// <summary>Join a direct code or address (OneLobby.Direct); see <see cref="MenuModel.JoinDirect"/>.</summary>
    public Func<string, string?, System.Threading.Tasks.Task<Lobby>>? JoinDirect { get => _joinDirect; set { _joinDirect = value; if (Model != null) Model.JoinDirect = value; } }

    private static readonly string[] AutoStartKeys = { "off", "all_ready", "players" };
    private static readonly string[] AutoStartTexts = { "auto_start_off", "auto_start_all_ready", "auto_start_players" };

    private int _shown = -1;
    private string _rosterSig = "", _bansSig = "", _requestsSig = "", _browseSig = "";
    private readonly Dictionary<int, Label> _pingLabels = new();
    private ulong _pingAt;
    private bool _syncing;
    private bool _hooked;

    private T U<T>(string name) where T : Node => GetNode<T>("%" + name);

    public override void _Ready()
    {
        if (Texts.Count > 0) MenuText.Override(Texts.ToDictionary(kv => kv.Key, kv => kv.Value));
        Client ??= MakeClient();
        var args = BootArgs.Length > 0 ? BootArgs : OS.GetCmdlineUserArgs();
        _local = MenuModel.ArgsSayLocal(args);
        Model = new MenuModel(Client)
        {
            HostOptions = _hostOptions, JoinOptions = _joinOptions, Route = _local ? MenuRoute.Direct : _route, InviteBase = InviteBase,
            HostDirect = _hostDirect, JoinDirect = _joinDirect,
            Clipboard = text => DisplayServer.ClipboardSet(text),
            LogsPath = ProjectSettings.GlobalizePath("user://onelobby-menu-log.txt"),
            CheckRunner = CheckRunner,
            // `--local` (after `--`): 127.0.0.1 only, nothing leaves this PC, so the check does not run by itself (the button still does)
            // and Host never goes to a lobby server (the direct route above). Read here, not from BootFlags: a game that applies the
            // boot flags itself later would be too late for the check on open.
            LocalOnly = _local,
        };
        Model.GameStarted += l => GameStarted?.Invoke(l);
        Model.ReturnedToLobby += l => ReturnedToLobby?.Invoke(l);
        // Deferred: a parent's _Ready comes after this one, and that is where a game hands over HostDirect / JoinDirect (OneLobby.Direct).
        // Queued before the first Refresh, so the check on open (deferred from there) still comes after the boot flags.
        Callable.From(() => { if (IsInstanceValid(this) && IsInsideTree() && BootFlags) Model?.ApplyBootFlags(args); }).CallDeferred();
        Hook();
        Bind();
        ApplyStaticText();
        Refresh();
    }

    /// <summary>
    /// The model's <see cref="MenuModel.Changed"/> and <see cref="MenuModel.Left"/> reach the menu only while it is in the tree. A C#
    /// event keeps calling a node after it is freed (a Godot signal would not), and the model lives as long as its client.
    /// </summary>
    private void Hook()
    {
        if (_hooked || Model == null) return;
        _hooked = true;
        Model.Changed += Refresh;
        Model.Left += EmitLeft;
    }

    private void Unhook()
    {
        if (!_hooked || Model == null) return;
        _hooked = false;
        Model.Changed -= Refresh;
        Model.Left -= EmitLeft;
    }

    private void OpenCheck() => _ = Model?.StartShown();

    private void EmitLeft() => EmitSignal(SignalName.Left);

    /// <summary>Back in the tree after being taken out (the first time, <c>_Ready</c> does this): listen again and draw what changed meanwhile.</summary>
    public override void _EnterTree()
    {
        if (Model == null) return;
        Hook();
        Refresh();
    }

    /// <summary>Out of the tree, or about to be freed: stop listening to the model.</summary>
    public override void _ExitTree() => Unhook();

    /// <summary>A client from the blueprint file, over the Godot transport, with the player's settings kept under <c>user://</c>.</summary>
    private LobbyClient MakeClient()
    {
        var json = global::Godot.FileAccess.FileExists(ConfigPath) ? global::Godot.FileAccess.GetFileAsString(ConfigPath) : "";
        if (json.Length == 0)
        {
            GD.PushWarning("OneLobbyMenu: no blueprint at " + ConfigPath + "; using a direct-only default. Add an onelobby.json or set Client.");
            var id = new string(ProjectSettings.GetSetting("application/config/name", "game").AsString().ToLowerInvariant().Select(c => char.IsLetterOrDigit(c) ? c : '-').ToArray());
            json = "{\"game\":{\"id\":\"" + (id.Length == 0 ? "game" : id) + "\"},\"engine\":\"godot-csharp\"}";
        }
        return LobbyClient.FromBlueprint(Blueprint.Parse(json), new GodotTransport(), null, null, c => c.WithUserSettings());
    }

    public override void _Process(double delta)
    {
        if (Pump && Client != null) Client.Pump();
        if (Model == null || Model.Screen != MenuScreen.Lobby) return;
        U<Label>("CountdownLabel").Text = Model.CountdownText();
        U<Label>("CountdownLabel").Visible = Model.CountingDown;
        var now = Time.GetTicksMsec();
        if (now - _pingAt > 500)
        {
            _pingAt = now;
            UpdatePings();
        }
    }

    /// <summary>ui_cancel goes back one screen (out of settings, browse, an error, a connect in progress, or the lobby).</summary>
    public override void _UnhandledInput(InputEvent @event)
    {
        if (Model != null && Visible && @event.IsActionPressed("ui_cancel") && Model.Back()) GetViewport().SetInputAsHandled();
    }

    /// <summary>Leaves the lobby from code (the same as the Leave button).</summary>
    public async System.Threading.Tasks.Task LeaveAsync()
    {
        if (Model != null) await Model.LeaveAsync();
    }

    // ---- wiring ---------------------------------------------------------------------------------------------------------

    private void Bind()
    {
        var m = Model!;
        U<LineEdit>("NameEdit").TextSubmitted += _ => CommitName();
        U<LineEdit>("NameEdit").FocusExited += CommitName;
        U<Button>("HostButton").Pressed += () =>
        {
            CommitName();
            m.SetPassword(U<LineEdit>("PasswordEdit").Text);
            _ = m.HostAsync();
        };
        U<LineEdit>("JoinEdit").TextChanged += OnJoinText;
        U<LineEdit>("JoinEdit").TextSubmitted += _ => Join();
        U<Button>("JoinButton").Pressed += Join;
        U<Button>("BrowseButton").Pressed += () => _ = m.OpenBrowseAsync();
        U<Button>("SettingsButton").Pressed += m.OpenSettings;
        U<Button>("ConnectingCancel").Pressed += m.CancelConnecting;
        U<Button>("CopyCodeButton").Pressed += () => Copied(U<Button>("CopyCodeButton"), "copy_code", m.CopyCode());
        U<Button>("CopyInviteButton").Pressed += () => Copied(U<Button>("CopyInviteButton"), "copy_invite", m.CopyInvite());
        U<Button>("ReadyButton").Pressed += m.ToggleReady;
        U<Button>("StartButton").Pressed += m.StartGame;
        U<Button>("CancelStartButton").Pressed += m.CancelCountdown;
        U<Button>("LeaveButton").Pressed += () => _ = m.LeaveAsync();
        U<Button>("LobbySettingsToggle").Toggled += _ => Refresh();
        U<OptionButton>("AutoStartOption").ItemSelected += i => { if (!_syncing) m.SetLobbySetting("auto_start", AutoStartKeys[i]); };
        U<SpinBox>("MinPlayersSpin").ValueChanged += v => { if (!_syncing) m.SetLobbySetting("min_players", (int)v); };
        U<SpinBox>("CountdownSpin").ValueChanged += v => { if (!_syncing) m.SetLobbySetting("countdown_seconds", (int)v); };
        U<CheckBox>("LateJoinCheck").Toggled += on => { if (!_syncing) m.SetLobbySetting("late_join", on); };
        U<LineEdit>("ChatEdit").TextSubmitted += _ => SendChat();
        U<Button>("ChatSendButton").Pressed += SendChat;
        U<Button>("CopyLogsButton").Pressed += m.CopyLogs;
        U<Button>("SaveLogsButton").Pressed += m.SaveLogs;
        U<Button>("ErrorBackButton").Pressed += () => m.Back();
        U<Button>("RelaySaveButton").Pressed += () =>
        {
            if (m.SaveRelay(U<LineEdit>("RelayEdit").Text)) U<LineEdit>("RelayEdit").Text = "";
        };
        U<Button>("RelayClearButton").Pressed += () =>
        {
            U<LineEdit>("RelayEdit").Text = "";
            m.ClearRelay();
        };
        U<Button>("ServerSaveButton").Pressed += () => m.SaveServer(U<LineEdit>("ServerEdit").Text);
        U<Button>("ConnectionCheckButton").Pressed += () => _ = m.RunCheckAsync();
        U<Button>("SettingsCopyLogsButton").Pressed += m.CopyLogs;
        U<Button>("SettingsBackButton").Pressed += () => m.Back();
        U<Button>("BrowseRefreshButton").Pressed += () => _ = m.RefreshBrowseAsync();
        U<Button>("BrowseBackButton").Pressed += () => m.Back();
        var auto = U<OptionButton>("AutoStartOption");
        auto.Clear();
        foreach (var key in AutoStartTexts) auto.AddItem(MenuText.T(key));
    }

    private void CommitName()
    {
        if (Model == null || _syncing) return;
        var edit = U<LineEdit>("NameEdit");
        var cleaned = Model.SetName(edit.Text);
        if (cleaned != edit.Text) edit.Text = cleaned;
    }

    private void OnJoinText(string text)
    {
        if (_syncing) return;
        var cleaned = Model!.SetJoinText(text);
        if (cleaned == text) return;
        _syncing = true;
        var edit = U<LineEdit>("JoinEdit");
        var col = edit.CaretColumn;
        edit.Text = cleaned;
        edit.CaretColumn = Math.Min(col, cleaned.Length);
        _syncing = false;
    }

    private void Join()
    {
        CommitName();
        Model!.SetJoinText(U<LineEdit>("JoinEdit").Text);
        Model.SetPassword(U<LineEdit>("PasswordEdit").Text);
        _ = Model.JoinAsync();
    }

    private void SendChat()
    {
        Model!.SendChat(U<LineEdit>("ChatEdit").Text);
        U<LineEdit>("ChatEdit").Text = "";
    }

    private void Copied(Button button, string key, bool ok)
    {
        button.Text = MenuText.T(ok ? "copied" : "copy_failed");
        GetTree().CreateTimer(1.5).Timeout += () =>
        {
            if (IsInstanceValid(button)) button.Text = MenuText.T(key);
        };
    }

    // ---- text -----------------------------------------------------------------------------------------------------------

    private void ApplyStaticText()
    {
        static string T(string key) => MenuText.T(key);
        U<Label>("StartTitle").Text = T("title");
        U<Label>("NameLabel").Text = T("name_label");
        U<LineEdit>("NameEdit").PlaceholderText = T("name_placeholder");
        U<Button>("HostButton").Text = T("host");
        U<Label>("JoinLabel").Text = T("join_label");
        U<LineEdit>("JoinEdit").PlaceholderText = T("join_placeholder");
        U<Button>("JoinButton").Text = T("join");
        U<LineEdit>("PasswordEdit").PlaceholderText = T("password_placeholder");
        U<Button>("BrowseButton").Text = T("browse");
        U<Button>("SettingsButton").Text = T("settings");
        U<Button>("ConnectingCancel").Text = T("cancel");
        U<Label>("CodeCaption").Text = T("code_caption");
        U<Button>("CopyCodeButton").Text = T("copy_code");
        U<Button>("CopyInviteButton").Text = T("copy_invite");
        U<Button>("CancelStartButton").Text = T("cancel_countdown");
        U<Button>("LeaveButton").Text = T("leave");
        U<Button>("StartButton").Text = T("start");
        U<LineEdit>("ReasonEdit").PlaceholderText = T("reason_placeholder");
        U<Label>("RequestsHeader").Text = T("requests_header");
        U<Label>("BansHeader").Text = T("bans_header");
        U<Button>("LobbySettingsToggle").Text = T("lobby_settings");
        U<Label>("AutoStartLabel").Text = T("setting_auto_start");
        U<Label>("MinPlayersLabel").Text = T("setting_min_players");
        U<Label>("CountdownSecondsLabel").Text = T("setting_countdown");
        U<CheckBox>("LateJoinCheck").Text = T("setting_late_join");
        U<LineEdit>("ChatEdit").PlaceholderText = T("chat_placeholder");
        U<Button>("ChatSendButton").Text = T("chat_send");
        U<Button>("CopyLogsButton").Text = T("copy_logs");
        U<Button>("SaveLogsButton").Text = T("save_logs");
        U<Button>("ErrorBackButton").Text = T("back");
        U<Label>("SettingsTitle").Text = T("settings_title");
        U<Label>("RelayLabel").Text = T("relay_label");
        U<LineEdit>("RelayEdit").PlaceholderText = T("relay_placeholder");
        U<Button>("RelaySaveButton").Text = T("relay_save");
        U<Button>("RelayClearButton").Text = T("relay_clear");
        U<Label>("ServerLabel").Text = T("server_label");
        U<LineEdit>("ServerEdit").PlaceholderText = T("server_placeholder");
        U<Button>("ServerSaveButton").Text = T("server_save");
        U<Button>("ConnectionCheckButton").Text = T("check");
        U<Button>("SettingsCopyLogsButton").Text = T("copy_logs");
        U<Button>("SettingsBackButton").Text = T("back");
        U<Label>("BrowseTitle").Text = T("browse_title");
        U<Button>("BrowseRefreshButton").Text = T("browse_refresh");
        U<Button>("BrowseBackButton").Text = T("back");
        var auto = U<OptionButton>("AutoStartOption");
        for (var i = 0; i < 3; i++) auto.SetItemText(i, T(AutoStartTexts[i]));
    }

    // ---- drawing --------------------------------------------------------------------------------------------------------

    private Control? PageFor(MenuScreen s) => s switch
    {
        MenuScreen.Start => U<Control>("StartPage"),
        MenuScreen.Connecting => U<Control>("ConnectingPage"),
        MenuScreen.Lobby => U<Control>("LobbyPage"),
        MenuScreen.Error => U<Control>("ErrorPage"),
        MenuScreen.Settings => U<Control>("SettingsPage"),
        MenuScreen.Browse => U<Control>("BrowsePage"),
        _ => null,
    };

    private void Refresh()
    {
        if (Model == null) return;
        var s = Model.Screen;
        var page = PageFor(s);
        foreach (var name in new[] { "StartPage", "ConnectingPage", "LobbyPage", "ErrorPage", "SettingsPage", "BrowsePage" })
        {
            var p = U<Control>(name);
            p.Visible = p == page;
        }
        Visible = !(s == MenuScreen.Playing && AutoHideOnStart);
        var entering = (int)s != _shown;
        _shown = (int)s;
        switch (s)
        {
            case MenuScreen.Start: DrawStart(entering); break;
            case MenuScreen.Connecting: U<Label>("ConnectingLabel").Text = Model.ConnectingText; break;
            case MenuScreen.Lobby: DrawLobby(entering); break;
            case MenuScreen.Error: DrawError(); break;
            case MenuScreen.Settings: DrawSettings(entering); break;
            case MenuScreen.Browse: DrawBrowse(); break;
        }
        if (entering && page != null) Callable.From(() => FocusFirst(s)).CallDeferred();
    }

    private void SetText(LineEdit edit, string text)
    {
        if (edit.Text == text) return;
        _syncing = true;
        edit.Text = text;
        _syncing = false;
    }

    private void DrawStart(bool entering)
    {
        var m = Model!;
        U<Label>("NameLabel").Visible = m.NamesAllowed;
        U<LineEdit>("NameEdit").Visible = m.NamesAllowed;
        U<Button>("BrowseButton").Visible = m.CanBrowse();
        U<Label>("StartNote").Text = m.StartNote;
        U<Label>("StartNote").Visible = m.StartNote != "";
        U<Label>("StartCheckLine").Text = m.StartCheckLine;
        U<Label>("StartCheckLine").Visible = m.StartCheckLine != "";
        if (entering)
        {
            CallDeferred(MethodName.OpenCheck); // not before a boot flag has had its say; the model runs the check once
            SetText(U<LineEdit>("NameEdit"), m.NameText);
            SetText(U<LineEdit>("JoinEdit"), m.JoinText);
            SetText(U<LineEdit>("PasswordEdit"), "");
        }
    }

    private void DrawLobby(bool entering)
    {
        var m = Model!;
        if (m.Lobby == null) return;
        var host = m.IsHost;
        var active = m.RoomActive;
        U<Label>("CodeLabel").Text = m.CodeText();
        U<Button>("CopyInviteButton").Visible = m.InviteAvailable;
        U<Label>("PlayersHeader").Text = m.PlayersHeader();
        U<Label>("RosterNote").Text = MenuText.T("plain_list_note");
        U<Label>("RosterNote").Visible = m.Lobby.Room.Supported == false;
        var ready = U<Button>("ReadyButton");
        ready.Visible = active && m.MeIsPlayer;
        ready.SetPressedNoSignal(m.MeReady);
        ready.Text = MenuText.T(m.MeReady ? "not_ready" : "ready");
        U<Button>("StartButton").Visible = host;
        U<Button>("StartButton").Disabled = m.CountingDown;
        U<Button>("CancelStartButton").Visible = host && m.CountingDown;
        var note = m.LobbyNote;
        if (note == "" && !host && !m.CountingDown) note = MenuText.T("start_wait");
        U<Label>("LobbyNote").Text = note;
        U<Label>("LobbyNote").Visible = note != "";
        U<Label>("CountdownLabel").Text = m.CountdownText();
        U<Label>("CountdownLabel").Visible = m.CountingDown;
        U<LineEdit>("ReasonEdit").Visible = host && active;
        DrawRoster();
        DrawRequests(host);
        DrawBans();
        U<Button>("LobbySettingsToggle").Visible = host && active;
        var box = U<Control>("LobbySettingsBox");
        box.Visible = host && active && U<Button>("LobbySettingsToggle").ButtonPressed;
        if (box.Visible && m.LobbySettings() is { } st)
        {
            _syncing = true;
            U<OptionButton>("AutoStartOption").Select(Array.IndexOf(AutoStartKeys, st.AutoStart));
            U<SpinBox>("MinPlayersSpin").Value = st.MinPlayers;
            U<SpinBox>("CountdownSpin").Value = st.CountdownSeconds;
            U<CheckBox>("LateJoinCheck").ButtonPressed = st.LateJoin;
            _syncing = false;
        }
        var chat = U<Control>("ChatBox");
        chat.Visible = m.ChatShown;
        if (chat.Visible)
            U<RichTextLabel>("ChatLog").Text = string.Join("\n", m.ChatLines.Select(l => MenuText.T("chat_line", l.Name, l.Text)));
        if (entering)
        {
            U<LineEdit>("ChatEdit").Text = "";
            U<LineEdit>("ReasonEdit").Text = "";
        }
    }

    private static void Clear(Control box)
    {
        foreach (var c in box.GetChildren())
        {
            box.RemoveChild(c);
            c.QueueFree();
        }
    }

    private void DrawRoster()
    {
        var m = Model!;
        var rows = m.RosterRows();
        var sig = string.Join("|", rows.Select(r => $"{r.Id},{r.Name},{r.Me},{r.Host},{r.Ready},{r.Spectator},{r.Reconnecting},{r.CanKick}"));
        if (sig == _rosterSig) return;
        _rosterSig = sig;
        var list = U<Control>("RosterList");
        Clear(list);
        _pingLabels.Clear();
        foreach (var r in rows)
        {
            var row = new HFlowContainer();
            row.AddThemeConstantOverride("h_separation", 12);
            row.AddChild(new Label { Text = r.Name + (r.Me ? " " + MenuText.T("you") : "") });
            var marks = m.RowMarks(r);
            if (marks != "") row.AddChild(new Label { Text = marks });
            var ping = new Label();
            row.AddChild(ping);
            _pingLabels[r.Id] = ping;
            if (r.CanKick)
            {
                var id = r.Id;
                var kick = new Button { Text = MenuText.T("kick") };
                kick.Pressed += () =>
                {
                    m.Kick(id, U<LineEdit>("ReasonEdit").Text);
                    U<LineEdit>("ReasonEdit").Text = "";
                };
                row.AddChild(kick);
                var ban = new Button { Text = MenuText.T("ban") };
                ban.Pressed += () =>
                {
                    m.Ban(id, U<LineEdit>("ReasonEdit").Text);
                    U<LineEdit>("ReasonEdit").Text = "";
                };
                row.AddChild(ban);
            }
            list.AddChild(row);
        }
        UpdatePings();
    }

    private void UpdatePings()
    {
        if (Model?.Lobby == null) return;
        var l = Model.Lobby;
        foreach (var (id, label) in _pingLabels)
        {
            var ms = id != l.LocalPeerId ? l.PingMs(id) : 0;
            label.Text = ms > 0 ? MenuText.T("ping", ms) : "";
        }
    }

    private void DrawRequests(bool host)
    {
        var m = Model!;
        var items = host ? m.Requests : Array.Empty<MenuRequest>();
        U<Label>("RequestsHeader").Visible = items.Count > 0;
        U<Control>("RequestsList").Visible = items.Count > 0;
        var sig = string.Join("|", items.Select(r => r.PeerId + "," + r.Name));
        if (sig == _requestsSig) return;
        _requestsSig = sig;
        var list = U<Control>("RequestsList");
        Clear(list);
        foreach (var r in items)
        {
            var id = r.PeerId;
            var row = new HFlowContainer();
            row.AddChild(new Label { Text = r.Name });
            var yes = new Button { Text = MenuText.T("let_in") };
            yes.Pressed += () => m.Approve(id, true);
            row.AddChild(yes);
            var no = new Button { Text = MenuText.T("refuse") };
            no.Pressed += () => m.Approve(id, false);
            row.AddChild(no);
            list.AddChild(row);
        }
    }

    private void DrawBans()
    {
        var m = Model!;
        var rows = m.BanRows();
        U<Label>("BansHeader").Visible = rows.Count > 0;
        U<Control>("BansList").Visible = rows.Count > 0;
        var sig = string.Join("|", rows.Select(b => b.Key + "," + b.Text));
        if (sig == _bansSig) return;
        _bansSig = sig;
        var list = U<Control>("BansList");
        Clear(list);
        foreach (var b in rows)
        {
            var key = b.Key;
            var row = new HFlowContainer();
            row.AddChild(new Label { Text = b.Text });
            var undo = new Button { Text = MenuText.T("unban") };
            undo.Pressed += () => m.Unban(key);
            row.AddChild(undo);
            list.AddChild(row);
        }
    }

    private void DrawError()
    {
        var e = Model!.Error;
        U<Label>("ErrorTitle").Text = e.Title;
        U<Label>("ErrorMessage").Text = e.Message;
        U<Label>("ErrorHint").Text = e.Hint;
        U<Label>("ErrorHint").Visible = e.Hint != "";
        U<Label>("ErrorCode").Text = MenuText.T("error_code", e.Code);
        U<Label>("ErrorCode").Visible = e.Code != "";
        U<Label>("LogNote").Text = Model.LogNote;
        U<Label>("LogNote").Visible = Model.LogNote != "";
    }

    private void DrawSettings(bool entering)
    {
        var m = Model!;
        U<Label>("RelayStatus").Text = m.RelayStatusText();
        U<Label>("RelayNote").Text = m.RelayNote;
        U<Label>("RelayNote").Visible = m.RelayNote != "";
        U<Label>("ServerNote").Text = m.SettingsNote;
        U<Label>("ServerNote").Visible = m.SettingsNote != "";
        if (entering)
        {
            SetText(U<LineEdit>("RelayEdit"), "");
            SetText(U<LineEdit>("ServerEdit"), m.ServerText);
        }
        U<Button>("ConnectionCheckButton").Visible = m.ConnectionCheckShown;
        U<Button>("ConnectionCheckButton").Disabled = m.CheckRunning;
        U<Label>("CheckVerdict").Text = m.CheckVerdict;
        U<Label>("CheckVerdict").Visible = m.CheckVerdict != "";
        U<Label>("CheckFacts").Text = string.Join("\n", m.CheckFacts);
        U<Label>("CheckFacts").Visible = m.CheckFacts.Count > 0;
    }

    private void DrawBrowse()
    {
        var m = Model!;
        U<Label>("BrowseStatus").Text = m.BrowseStatus;
        U<Label>("BrowseStatus").Visible = m.BrowseStatus != "";
        var sig = string.Join("|", m.BrowseItems.Select(i => i.Code + "," + i.Name + "," + i.HostName + "," + i.Players + "," + i.MaxPlayers));
        if (sig == _browseSig) return;
        _browseSig = sig;
        var list = U<Control>("BrowseList");
        Clear(list);
        foreach (var it in m.BrowseItems)
        {
            var code = it.Code;
            var row = new HFlowContainer();
            row.AddChild(new Label { Text = MenuModel.BrowseRowText(it) });
            var join = new Button { Text = MenuText.T("browse_join") };
            join.Pressed += () => _ = m.JoinListedAsync(code);
            row.AddChild(join);
            list.AddChild(row);
        }
        if (_shown == (int)MenuScreen.Browse && list.GetChildCount() > 0) FocusFirst(MenuScreen.Browse);
    }

    // ---- focus ----------------------------------------------------------------------------------------------------------

    /// <summary>A sensible first control on every screen, so keyboard and gamepad work without a mouse click.</summary>
    private void FocusFirst(MenuScreen s)
    {
        if (Model == null || s != Model.Screen) return;
        Control? target = null;
        switch (s)
        {
            case MenuScreen.Start: target = U<Control>("HostButton"); break;
            case MenuScreen.Connecting: target = U<Control>("ConnectingCancel"); break;
            case MenuScreen.Lobby:
                target = U<Control>("ReadyButton").Visible ? U<Control>("ReadyButton") : U<Control>("StartButton").Visible ? U<Control>("StartButton") : U<Control>("LeaveButton");
                break;
            case MenuScreen.Error: target = U<Control>("ErrorBackButton"); break;
            case MenuScreen.Settings: target = U<Control>("RelayEdit"); break;
            case MenuScreen.Browse:
                target = U<Control>("BrowseBackButton");
                var list = U<Control>("BrowseList");
                if (list.GetChildCount() > 0)
                {
                    var buttons = list.GetChild(0).FindChildren("*", "Button", true, false);
                    if (buttons.Count > 0) target = (Control)buttons[0];
                }
                break;
        }
        if (target != null && target.IsVisibleInTree()) target.GrabFocus();
    }
}
