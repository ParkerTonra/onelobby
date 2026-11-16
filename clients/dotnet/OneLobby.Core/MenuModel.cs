using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;

namespace OneLobby
{
    /// <summary>The screens of the drop-in menu.</summary>
    public enum MenuScreen { Start, Connecting, Lobby, Error, Settings, Browse, Playing }

    /// <summary>Where Host and Join go: <c>Auto</c> lets the blueprint decide, <c>Direct</c> always uses the direct delegates, <c>Server</c> the lobby server.</summary>
    public enum MenuRoute { Auto, Direct, Server }

    /// <summary>What a join field holds: a lobby-server code, a direct code, an <c>ip:port</c> address, or nothing usable.</summary>
    public enum MenuJoinKind { None, Lobby, Direct, Address }

    /// <summary>The result of <see cref="MenuModel.ParseJoin"/>: for a lobby code the canonical 6 characters, otherwise the text as typed.</summary>
    public readonly record struct MenuJoinParse(MenuJoinKind Kind, string Value);

    /// <summary>The boot flags the menu acts on (<c>--host</c>, <c>--join=&lt;code&gt;</c>, <c>--name=&lt;name&gt;</c>).</summary>
    public sealed record MenuBootFlags(bool Host, string Join, string Name);

    /// <summary>What the error screen shows. <c>Reason</c> is the removal sentence of a kick or ban (the host's own text, or the default of the code).</summary>
    public sealed record MenuError(string Title, string Message, string Hint, string Code, bool Removed, bool Ban, string Reason)
    {
        public static readonly MenuError None = new("", "", "", "", false, false, "");
    }

    /// <summary>One roster row.</summary>
    public sealed record MenuRosterRow(int Id, string Name, bool Me, bool Host, bool Ready, bool Spectator, bool Reconnecting, int PingMs, bool CanKick);

    /// <summary>One line of the ban list; <c>Key</c> is what <see cref="MenuModel.Unban"/> takes.</summary>
    public sealed record MenuBanRow(string Key, string Text);

    /// <summary>A player asking to join a lobby that approves joins.</summary>
    public sealed record MenuRequest(int PeerId, string Name);

    /// <summary>A line of the lobby's chat log, with the sender's name.</summary>
    public sealed record MenuChatLine(int PeerId, string Name, string Text);

    /// <summary>The settings the room layer lets the host change; <c>AutoStart</c> is <c>off</c>, <c>all_ready</c> or <c>players</c>.</summary>
    public sealed record MenuLobbySettings(string AutoStart, int MinPlayers, int CountdownSeconds, bool LateJoin);

    /// <summary>
    /// The drop-in menu's brain: which screen is showing and every decision behind it. No engine types: it takes its
    /// <see cref="LobbyClient"/> by injection (and the clipboard, the connection check and the direct routes as delegates), so a
    /// Godot controller, a Unity one or a test drives it the same way. It is a port of the GDScript <c>OneLobbyMenuModel</c>.
    /// <code>
    /// var m = new MenuModel(client) { Clipboard = text => GodotClipboard.Set(text) };
    /// m.SetJoinText("7HQ 4K2");
    /// await m.JoinAsync();      // Screen: Connecting, then Lobby (or Error with a plain sentence)
    /// m.ToggleReady();
    /// </code>
    /// The client must be pumped (<see cref="LobbyClient.Pump"/>, every frame) for anything that waits to finish; everything runs on
    /// the pumping thread. <see cref="HostAsync"/> and <see cref="JoinAsync"/> never throw: a failure becomes the Error screen.
    /// <see cref="Changed"/> fires after any state change. Texts come from <see cref="MenuText"/>.
    /// </summary>
    public sealed class MenuModel
    {
        public const int ChatKeep = 100;

        private readonly LobbyClient _client;
        private int _ticket;
        private bool _gameStarted;
        private bool _direct;
        private LobbyError? _lastError;

        public MenuModel(LobbyClient client)
        {
            _client = client ?? throw new ArgumentNullException(nameof(client));
            _client.Error += e => _lastError = e;
            LoadDefaults();
        }

        // ---- events -----------------------------------------------------------------------------------------------------

        /// <summary>Something on a screen changed: draw again.</summary>
        public event Action? Changed;
        /// <summary>The lobby's phase went to in-game (the host started, or a late join into a running game).</summary>
        public event Action<Lobby>? GameStarted;
        /// <summary>The phase went back to the lobby after a game.</summary>
        public event Action<Lobby>? ReturnedToLobby;
        /// <summary>The player left the lobby on purpose.</summary>
        public event Action? Left;

        // ---- injected things and options ----------------------------------------------------------------------------------

        public LobbyClient Client => _client;

        /// <summary><see cref="MenuRoute.Auto"/>: the blueprint decides (a lobby server when <c>hosting.server</c> is true; direct only when it is off or no server is known and the direct delegates are set).</summary>
        public MenuRoute Route { get; set; } = MenuRoute.Auto;

        /// <summary>Base options for Host (the blueprint's when null, else a plain lobby named after the player); the menu adds the typed password.</summary>
        public LobbyOptions? HostOptions { get; set; }

        /// <summary>Base options for Join; the menu adds the typed password.</summary>
        public RoomJoinOptions? JoinOptions { get; set; }

        /// <summary>
        /// Hosts a direct lobby (OneLobby.Direct: <c>client.HostDirectAsync(...)</c>); gets the typed password or null. Core cannot
        /// reference that package, so a game that wants direct hosting passes this. Null: a direct route shows the "no server" sentence.
        /// </summary>
        public Func<string?, Task<Lobby>>? HostDirect { get; set; }

        /// <summary>Joins a direct code or an <c>ip:port</c> address (<c>client.JoinDirectAsync(...)</c>); gets the text and the typed password or null.</summary>
        public Func<string, string?, Task<Lobby>>? JoinDirect { get; set; }

        /// <summary>Base address of an invite link ("https://game.example/play"). Optional: with it, and a lobby-server code, the copied invite sentence ends with the link.</summary>
        public string InviteBase { get; set; } = "";

        /// <summary>The query key of an invite link.</summary>
        public string InviteParam { get; set; } = "join";

        /// <summary>Where Save logs writes (a path the game can write: the Godot controller sets a <c>user://</c> file).</summary>
        public string LogsPath { get; set; } = "onelobby-menu-log.txt";

        /// <summary>Called with the text to copy. Null: nothing is copied and the copy calls return false.</summary>
        public Action<string>? Clipboard { get; set; }

        /// <summary>Runs the connection check: gets <see cref="CheckOptions"/>. Default: the client's own.</summary>
        public Func<CheckOptions?, Task<CheckResult>>? CheckRunner { get; set; }

        public CheckOptions? CheckOptions { get; set; }

        // ---- what the screens show ----------------------------------------------------------------------------------------

        public MenuScreen Screen { get; private set; } = MenuScreen.Start;
        public Lobby? Lobby { get; private set; }
        public string NameText { get; private set; } = "";
        public string JoinText { get; private set; } = "";
        public string PasswordText { get; private set; } = "";
        public string StartNote { get; private set; } = "";
        public string ConnectingText { get; private set; } = "";
        public MenuError Error { get; private set; } = MenuError.None;
        public string LobbyNote { get; private set; } = "";
        public RemovalInfo? Removal { get; private set; }
        public IReadOnlyList<MenuChatLine> ChatLines { get; private set; } = Array.Empty<MenuChatLine>();
        public IReadOnlyList<MenuRequest> Requests { get; private set; } = Array.Empty<MenuRequest>();
        public IReadOnlyList<LobbySummary> BrowseItems { get; private set; } = Array.Empty<LobbySummary>();
        public string BrowseStatus { get; private set; } = "";
        public string SettingsNote { get; private set; } = "";
        public string RelayNote { get; private set; } = "";
        public string ServerText { get; private set; } = "";
        /// <summary>One line, "" before a check.</summary>
        public string CheckVerdict { get; private set; } = "";
        /// <summary>Three lines (UDP, network type, relay), empty before a check.</summary>
        public IReadOnlyList<string> CheckFacts { get; private set; } = Array.Empty<string>();
        public bool CheckRunning { get; private set; }
        public string LogNote { get; private set; } = "";

        /// <summary>Reads the saved name, the last code and the lobby server into the start and settings screens.</summary>
        public void LoadDefaults()
        {
            var s = _client.Settings.Effective();
            NameText = s.Name;
            var last = s.LastCode;
            JoinText = last.Length == Crockford.CodeLength ? Crockford.Format(last) : last;
            ServerText = _client.EffectiveServer;
        }

        public string ScreenName => Screen switch
        {
            MenuScreen.Start => "start", MenuScreen.Connecting => "connecting", MenuScreen.Lobby => "lobby", MenuScreen.Error => "error",
            MenuScreen.Settings => "settings", MenuScreen.Browse => "browse", _ => "playing",
        };

        // ---- what the blueprint (or its absence) switches -------------------------------------------------------------------

        /// <summary>False for a blueprint with <c>players.identity</c> "anonymous": no name field.</summary>
        public bool NamesAllowed => _client.Blueprint == null || _client.Blueprint.Players.Identity != "anonymous";

        public int MaxNameLength => _client.Blueprint?.Players.MaxNameLength ?? 24;

        /// <summary>Browse needs a lobby server address (and a blueprint that uses one).</summary>
        public bool CanBrowse() =>
            (_client.Blueprint == null || _client.Blueprint.Hosting.Server) && Route != MenuRoute.Direct && _client.EffectiveServer.Length > 0;

        public bool ConnectionCheckShown => _client.Blueprint == null || _client.Blueprint.Diagnostics.ShowConnectionCheck;

        public bool ChatShown => Lobby != null && (_client.Blueprint == null || _client.Blueprint.Chat.Text);

        public bool ApproveJoinsOn => _client.Blueprint is { Lobby: { ApproveJoins: true } };

        /// <summary>Copy invite is always offered while a lobby is open.</summary>
        public bool InviteAvailable => Lobby != null;

        /// <summary>True for a lobby made with the direct delegates.</summary>
        public bool LobbyIsDirect => Lobby != null && _direct;

        /// <summary>True when the host answered with the room layer (ready, start, kick and ban work). False for an old host or before its answer.</summary>
        public bool RoomActive => Lobby != null && Lobby.Room.Supported == true;

        public bool IsHost => Lobby != null && Lobby.IsHost;

        // ---- the start screen -----------------------------------------------------------------------------------------------

        /// <summary>Cleans a name the way the room does and remembers it as typed; returns the cleaned text.</summary>
        public string SetName(string text)
        {
            NameText = SettingsRules.CleanName(text, MaxNameLength);
            return NameText;
        }

        /// <summary>Keeps what is typed in the join field tidy: a code is upper-cased and stripped of stray characters, an address or a link is kept.</summary>
        public string SetJoinText(string text)
        {
            JoinText = CleanJoinText(text);
            return JoinText;
        }

        public void SetPassword(string text) => PasswordText = text.Length > 64 ? text.Substring(0, 64) : text;

        public static string CleanJoinText(string text)
        {
            var t = text.TrimStart(' ', '\t', '\r', '\n');
            foreach (var ch in new[] { ':', '/', '.', '?', '#', '=', '@' })
                if (t.IndexOf(ch) >= 0) return t;
            var sb = new System.Text.StringBuilder();
            foreach (var ch in t.ToUpperInvariant())
                if (ch == ' ' || ch == '-' || (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z')) sb.Append(ch);
            var o = sb.ToString();
            return o.Length > 40 ? o.Substring(0, 40) : o;
        }

        /// <summary>
        /// What a join field holds. A link yields its lobby code. A pasted invite sentence ("Join my game in Fortress: code 7HQ 4K2")
        /// yields its code: the words after its "code" marker first, then the whole text as one code, then the words scanned from the
        /// END (a game title can look like a code, so the title is never tried first). A bare code, an <c>ip:port</c>, a direct code
        /// and a link work as ever.
        /// </summary>
        public static MenuJoinParse ParseJoin(string? text)
        {
            var t = (text ?? "").Trim();
            if (t.Length == 0) return new MenuJoinParse(MenuJoinKind.None, "");
            var words = new List<string>();
            foreach (var w in t.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
            {
                var c = TrimToken(w);
                if (c.Length > 0) words.Add(c);
            }
            if (words.Count > 1)
            {
                for (var i = 0; i < words.Count - 1; i++)
                {
                    if (!string.Equals(words[i], "code", StringComparison.OrdinalIgnoreCase)) continue;
                    var got = AfterMarker(words, i + 1);
                    if (got.Kind != MenuJoinKind.None) return got;
                    break;
                }
            }
            var whole = ParseOne(t);
            if (whole.Kind != MenuJoinKind.None || words.Count < 2) return whole;
            for (var i = words.Count - 1; i >= 0; i--)
            {
                if (i >= 1 && IsGroupPair(words[i - 1], words[i]))
                {
                    var pair = ParseOne(words[i - 1] + " " + words[i]);
                    if (pair.Kind == MenuJoinKind.Lobby) return pair;
                }
                var one = ParseOne(words[i]);
                if (one.Kind != MenuJoinKind.None) return one;
            }
            return whole;
        }

        private static MenuJoinParse ParseOne(string t)
        {
            if (t.IndexOf('?') >= 0 || t.Contains("://") || t.IndexOf('#') >= 0)
            {
                var fromLink = InviteLink.Parse(t);
                if (!string.IsNullOrEmpty(fromLink)) return new MenuJoinParse(MenuJoinKind.Lobby, fromLink!);
            }
            var six = Crockford.Normalize(t);
            if (!string.IsNullOrEmpty(six)) return new MenuJoinParse(MenuJoinKind.Lobby, six!);
            if (JoinCode.Normalize(t) != null) return new MenuJoinParse(MenuJoinKind.Direct, t);
            if (IsAddress(t)) return new MenuJoinParse(MenuJoinKind.Address, t);
            return new MenuJoinParse(MenuJoinKind.None, t);
        }

        /// <summary>An IPv4 address, with an optional port (<c>192.168.1.20:47810</c>).</summary>
        private static bool IsAddress(string input)
        {
            var s = input.Trim();
            var port = 47810;
            var colon = s.IndexOf(':');
            if (colon >= 0)
            {
                var halves = s.Split(':');
                if (halves.Length != 2 || !int.TryParse(halves[1], NumberStyles.None, CultureInfo.InvariantCulture, out port)) return false;
                s = halves[0];
            }
            if (port < 1 || port > 65535) return false;
            var parts = s.Split('.');
            if (parts.Length != 4) return false;
            foreach (var p in parts)
                if (!int.TryParse(p, NumberStyles.None, CultureInfo.InvariantCulture, out var n) || n < 0 || n > 255) return false;
            return true;
        }

        private const string Edge = "\"'`()[]{}<>.,;:!“”‘’";

        /// <summary>Strips quotes, brackets and trailing punctuation around a word of a pasted sentence (a link keeps its inner marks).</summary>
        private static string TrimToken(string w)
        {
            var a = 0;
            var b = w.Length;
            while (a < b && Edge.IndexOf(w[a]) >= 0) a++;
            while (b > a && Edge.IndexOf(w[b - 1]) >= 0) b--;
            return w.Substring(a, b - a);
        }

        /// <summary>Two words shaped like the lobby screen's grouping ("7HQ" "4K2"): three characters each, so ordinary words ("game in") are not taken.</summary>
        private static bool IsGroupPair(string a, string b) => a.Length == 3 && b.Length == 3;

        private static MenuJoinParse AfterMarker(List<string> words, int at)
        {
            var one = ParseOne(words[at]);
            if (one.Kind != MenuJoinKind.None) return one;
            if (at + 1 < words.Count && IsGroupPair(words[at], words[at + 1]))
            {
                var two = ParseOne(words[at] + " " + words[at + 1]);
                if (two.Kind == MenuJoinKind.Lobby) return two;
            }
            return new MenuJoinParse(MenuJoinKind.None, "");
        }

        /// <summary>The boot flags: <c>--host</c>, <c>--join=&lt;code&gt;</c> and <c>--name=&lt;name&gt;</c>.</summary>
        public static MenuBootFlags ParseBootFlags(IEnumerable<string>? args)
        {
            var host = false;
            string join = "", name = "";
            foreach (var a in args ?? Array.Empty<string>())
            {
                if (a == "--host") host = true;
                else if (a.StartsWith("--join=", StringComparison.Ordinal)) join = a.Substring(7);
                else if (a.StartsWith("--name=", StringComparison.Ordinal)) name = a.Substring(7);
            }
            return new MenuBootFlags(host, join, name);
        }

        /// <summary>Acts on the boot flags at once (the controller passes its command line). Returns what it started: "host", "join" or "".</summary>
        public string ApplyBootFlags(IEnumerable<string>? args)
        {
            var f = ParseBootFlags(args);
            if (f.Name.Length > 0) SetName(f.Name);
            if (f.Join.Length > 0)
            {
                SetJoinText(f.Join);
                _ = JoinAsync();
                return "join";
            }
            if (f.Host)
            {
                _ = HostAsync();
                return "host";
            }
            return "";
        }

        /// <summary>Saves the name (when this game has names). The client uses it when its config name is empty or "Player".</summary>
        public void CommitName()
        {
            if (!NamesAllowed) return;
            _client.Settings.Save(name: NameText);
        }

        public void NoteInvited()
        {
            StartNote = MenuText.T("start_invited");
            Changed?.Invoke();
        }

        private string? TypedPassword => PasswordText.Length > 0 ? PasswordText : null;

        private bool UseDirectToHost()
        {
            if (Route == MenuRoute.Direct) return true;
            if (Route == MenuRoute.Server || HostDirect == null) return false;
            var bp = _client.Blueprint;
            return bp != null ? !bp.Hosting.Server && bp.Hosting.Direct : _client.EffectiveServer.Length == 0;
        }

        public async Task HostAsync()
        {
            if (Screen != MenuScreen.Start) return;
            CommitName();
            var t = Begin(MenuText.T("connecting_host"));
            Lobby? l = null;
            Exception? failure = null;
            var direct = UseDirectToHost();
            try
            {
                if (direct)
                {
                    if (HostDirect == null) throw new OneLobbyException(LobbyErrorCodes.NoServer, "no lobby server address and no direct route");
                    l = await HostDirect(TypedPassword).ConfigureAwait(true);
                }
                else
                {
                    var o = HostOptions ?? _client.Blueprint?.ToLobbyOptions(null, DisplayNameOrPlayer())
                        ?? new LobbyOptions(DisplayNameOrPlayer() + "'s game");
                    if (TypedPassword != null) o = o with { Password = TypedPassword };
                    l = await _client.HostAsync(o).ConfigureAwait(true);
                }
            }
            catch (Exception ex) { failure = ex; }
            Connected(t, l, failure, direct);
        }

        private string DisplayNameOrPlayer() => NameText.Length > 0 && NamesAllowed ? NameText : "Player";

        public async Task JoinAsync()
        {
            if (Screen != MenuScreen.Start) return;
            var p = ParseJoin(JoinText);
            if (p.Kind == MenuJoinKind.None)
            {
                ShowError(Friendly.DescribeError("bad_code"), "bad_code");
                return;
            }
            CommitName();
            var shown = p.Kind == MenuJoinKind.Lobby ? Crockford.Format(p.Value) : p.Value;
            var t = Begin(p.Kind == MenuJoinKind.Address ? MenuText.T("connecting_join_address") : MenuText.T("connecting_join", shown));
            Lobby? l = null;
            Exception? failure = null;
            var direct = p.Kind != MenuJoinKind.Lobby;
            try
            {
                if (p.Kind == MenuJoinKind.Lobby)
                {
                    var o = new RoomJoinOptions { Role = JoinOptions?.Role ?? RoomRole.Player, Data = JoinOptions?.Data, Password = TypedPassword ?? JoinOptions?.Password };
                    l = await _client.JoinAsync(p.Value, o).ConfigureAwait(true);
                }
                else
                {
                    if (JoinDirect == null) throw new OneLobbyException("bad_address", "no direct route to join an address");
                    l = await JoinDirect(p.Value, TypedPassword).ConfigureAwait(true);
                }
            }
            catch (Exception ex) { failure = ex; }
            Connected(t, l, failure, direct);
        }

        private int Begin(string text)
        {
            _ticket++;
            ConnectingText = text;
            Error = MenuError.None;
            StartNote = "";
            SetScreen(MenuScreen.Connecting);
            return _ticket;
        }

        private void Connected(int ticket, Lobby? l, Exception? failure, bool direct)
        {
            if (ticket != _ticket)
            {
                // the player cancelled while it waited: a lobby that still arrived is left at once
                if (l != null) _ = Safe(l.LeaveAsync());
                return;
            }
            if (l == null)
            {
                var d = Friendly.DescribeError(failure);
                ShowError(d, d.Code);
                return;
            }
            _direct = direct;
            Attach(l);
            _gameStarted = false;
            LobbyNote = "";
            SetScreen(MenuScreen.Lobby);
            if (l.Phase == LobbyPhase.InGame) StartPlaying();
        }

        private static async Task Safe(Task t)
        {
            try { await t.ConfigureAwait(true); } catch (Exception) { /* leaving: nothing to tell the player */ }
        }

        // ---- the lobby ------------------------------------------------------------------------------------------------------

        private void Attach(Lobby l)
        {
            Lobby = l;
            Removal = null;
            ChatLines = Array.Empty<MenuChatLine>();
            Requests = Array.Empty<MenuRequest>();
            bool Same() => ReferenceEquals(Lobby, l);
            void Poke() { if (Same()) Changed?.Invoke(); }
            var r = l.Room;
            r.Changed += Poke;
            r.BansChanged += Poke;
            r.Unsupported += Poke;
            r.SupportConfirmed += Poke;
            r.CountdownUpdated += _ => Poke();
            r.CountdownCancelled += _ => Poke();
            r.StateChanged += (_, _) => Poke();
            r.SettingsChanged += _ => Poke();
            r.Removed += info => { if (Same()) OnRemoved(info); };
            l.PhaseChanged += p => { if (Same()) OnPhase(p); };
            l.SessionEnded += reason => { if (Same()) OnEnded(reason); };
            l.JoinRequested += peer =>
            {
                if (!Same()) return;
                Requests = Requests.Concat(new[] { new MenuRequest(peer.PeerId, peer.Name) }).ToList();
                Changed?.Invoke();
            };
            l.PeerJoined += _ => Poke();
            l.PeerLeft += (_, _) => Poke();
            l.PeerReady += _ => Poke();
            l.HostChanged += _ => Poke();
            l.PeerRenamed += (_, _) => Poke();
            l.Chat.Received += line =>
            {
                if (!Same()) return;
                var kept = ChatLines.Concat(new[] { new MenuChatLine(line.PeerId, l.Room.Player(line.PeerId)?.Name ?? "", line.Text) });
                ChatLines = kept.Skip(Math.Max(0, ChatLines.Count + 1 - ChatKeep)).ToList();
                Changed?.Invoke();
            };
        }

        private void OnPhase(LobbyPhase p)
        {
            if (p == LobbyPhase.InGame) StartPlaying();
            else if (p == LobbyPhase.Lobby && Screen == MenuScreen.Playing)
            {
                _gameStarted = false;
                SetScreen(MenuScreen.Lobby);
                if (Lobby != null) ReturnedToLobby?.Invoke(Lobby);
            }
        }

        private void StartPlaying()
        {
            if (_gameStarted || Lobby == null) return;
            _gameStarted = true;
            SetScreen(MenuScreen.Playing);
            GameStarted?.Invoke(Lobby);
        }

        /// <summary>The host removed this player: the host's reason, or the default sentence of the code.</summary>
        private void OnRemoved(RemovalInfo info)
        {
            Removal = info;
            var code = string.IsNullOrEmpty(info.Code) ? "kicked" : info.Code;
            var banned = info.Ban || code == "banned";
            var d = Friendly.DescribeError(code);
            var reason = info.Reason ?? "";
            Error = new MenuError(MenuText.T(banned ? "banned_title" : "removed_title"), reason.Length > 0 ? reason : d.Message, d.Hint ?? "", code, true, info.Ban, reason);
            LogNote = "";
            SetScreen(MenuScreen.Error);
        }

        private void OnEnded(string reason)
        {
            if (Removal != null) return; // the removal screen already says why
            FriendlyError d;
            switch (reason)
            {
                case "host_left":
                    d = new FriendlyError(reason, MenuText.T("host_left"), MenuText.T("host_left_hint"));
                    break;
                case "ice_failed":
                    d = _lastError is { Code: "ice_failed" } le ? Friendly.DescribeError(le) : Friendly.DescribeError("ice_failed");
                    break;
                default:
                    d = Friendly.DescribeError(reason);
                    break;
            }
            ShowError(d, reason, false, MenuText.T("ended_title"));
        }

        /// <summary>Roster rows (a plain peer list against a host with no room layer).</summary>
        public IReadOnlyList<MenuRosterRow> RosterRows()
        {
            if (Lobby == null) return Array.Empty<MenuRosterRow>();
            var l = Lobby;
            var active = RoomActive;
            var rows = new List<MenuRosterRow>();
            foreach (var e in l.Room.Entries)
            {
                var me = e.Id == l.LocalPeerId;
                rows.Add(new MenuRosterRow(e.Id, e.Name, me, e.Id == l.HostPeerId,
                    active && e.Ready && e.Role == RoomRole.Player, e.Role == RoomRole.Spectator,
                    e.Status == RoomStatus.Reconnecting, me ? 0 : l.PingMs(e.Id), active && l.IsHost && !me));
            }
            return rows;
        }

        public string PlayersHeader()
        {
            if (Lobby == null) return "";
            if (!RoomActive) return MenuText.T("players_header_plain", Lobby.Room.Entries.Count);
            var cap = Lobby.Room.Settings.MaxPlayers;
            var n = Lobby.Room.Players.Count;
            return cap > 0 ? MenuText.T("players_header", n, cap) : MenuText.T("players_header_plain", n);
        }

        /// <summary>The marks of a row as one line ("Host, Ready").</summary>
        public string RowMarks(MenuRosterRow row)
        {
            var marks = new List<string>();
            if (row.Host) marks.Add(MenuText.T("mark_host"));
            if (row.Spectator) marks.Add(MenuText.T("mark_spectator"));
            if (row.Ready) marks.Add(MenuText.T("mark_ready"));
            if (row.Reconnecting) marks.Add(MenuText.T("mark_reconnecting"));
            return string.Join(", ", marks);
        }

        /// <summary>The code the lobby screen shows: a direct host's grouped code, else the lobby-server code as "7HQ 4K2".</summary>
        public string CodeText()
        {
            if (Lobby == null) return "";
            if (_direct && Lobby.JoinCode.Length > 0) return Lobby.JoinCode;
            var c = Lobby.Code;
            return c.Length == Crockford.CodeLength ? Crockford.Format(c) : c;
        }

        /// <summary>
        /// The invite sentence: <c>Join my game in &lt;title&gt;: code 7HQ 4K2</c> (no title: <c>Join my game: code 7HQ 4K2</c>), then a
        /// space and the invite link when <see cref="InviteBase"/> is set and the code is a lobby-server code.
        /// </summary>
        public string InviteText()
        {
            if (Lobby == null) return "";
            var title = _client.Blueprint?.Game.Title ?? "";
            var code = CodeText();
            var text = title.Length > 0 ? MenuText.T("invite_sentence", title, code) : MenuText.T("invite_sentence_untitled", code);
            if (InviteBase.Length > 0 && !_direct && Crockford.Normalize(Lobby.Code) != null)
            {
                try { text += " " + InviteLink.Make(Lobby.Code, InviteBase, InviteParam); }
                catch (ArgumentException) { /* a base that is not an absolute http(s) address: no link */ }
            }
            return text;
        }

        public string CountdownText()
        {
            var cd = Lobby?.Room.Countdown;
            return cd == null ? "" : MenuText.T("countdown", (int)Math.Ceiling(cd.RemainingMs / 1000.0));
        }

        public bool CountingDown => Lobby != null && Lobby.Room.Countdown != null;

        public bool MeReady => Lobby != null && (Lobby.Room.Me?.Ready ?? false);

        public bool MeIsPlayer => Lobby != null && (Lobby.Room.Me?.Role ?? RoomRole.Player) == RoomRole.Player;

        public bool CopyCode() => Copy(CodeText());

        public bool CopyInvite()
        {
            var text = InviteText();
            return text.Length > 0 && Copy(text);
        }

        private bool Copy(string text)
        {
            if (Clipboard == null) return false;
            Clipboard(text);
            return true;
        }

        public void ToggleReady()
        {
            if (RoomActive) Try(() => Lobby!.Room.ToggleReady());
        }

        /// <summary>Host: start. With the room layer: the countdown, then everyone's phase changes. An old host (no room layer) starts at once.</summary>
        public void StartGame()
        {
            if (Lobby == null || !Lobby.IsHost) return;
            if (RoomActive) Try(() => Lobby.Room.Start());
            else _ = Safe(Lobby.StartAsync());
        }

        public void CancelCountdown()
        {
            if (RoomActive && Lobby!.IsHost) Try(() => Lobby.Room.CancelCountdown());
        }

        public void Kick(int peerId, string reason = "")
        {
            if (RoomActive && Lobby!.IsHost) Try(() => Lobby.Room.Kick(peerId, null, reason.Trim().Length > 0 ? reason : null));
        }

        public void Ban(int peerId, string reason = "")
        {
            if (RoomActive && Lobby!.IsHost) Try(() => Lobby.Room.Ban(peerId, null, reason.Trim().Length > 0 ? reason : null));
        }

        public void Unban(string key)
        {
            if (Lobby == null || !Lobby.IsHost) return;
            Lobby.Room.Unban(key);
            Changed?.Invoke();
        }

        /// <summary>The ban list (the host's); the key is what <see cref="Unban"/> takes.</summary>
        public IReadOnlyList<MenuBanRow> BanRows()
        {
            var rows = new List<MenuBanRow>();
            if (Lobby == null || !Lobby.IsHost) return rows;
            foreach (var e in Lobby.Room.Bans.List())
            {
                var who = string.IsNullOrEmpty(e.Name) ? MenuText.T("ban_unknown") : e.Name!;
                var reason = e.Reason ?? "";
                rows.Add(new MenuBanRow(e.Id ?? e.Ip ?? "", reason.Length > 0 ? MenuText.T("ban_row_reason", who, reason) : who));
            }
            return rows;
        }

        /// <summary>The settings the room layer lets the host change; null without the room layer.</summary>
        public MenuLobbySettings? LobbySettings()
        {
            if (!RoomActive) return null;
            var s = Lobby!.Room.Settings;
            var auto = s.AutoStart == AutoStartMode.AllReady ? "all_ready" : s.AutoStart == AutoStartMode.Players ? "players" : "off";
            return new MenuLobbySettings(auto, s.MinPlayers, s.CountdownMs / 1000, s.LateJoin != LateJoinPolicy.Refuse);
        }

        /// <summary>Host: changes one of <c>auto_start</c> ("off", "all_ready", "players"), <c>min_players</c>, <c>countdown_seconds</c>, <c>late_join</c> (bool).</summary>
        public void SetLobbySetting(string key, object value)
        {
            if (!RoomActive || !Lobby!.IsHost) return;
            var c = new RoomSettingsChange();
            switch (key)
            {
                case "auto_start":
                    c.AutoStart = Convert.ToString(value, CultureInfo.InvariantCulture) switch { "all_ready" => AutoStartMode.AllReady, "players" => AutoStartMode.Players, _ => AutoStartMode.Off };
                    break;
                case "min_players": c.MinPlayers = Convert.ToInt32(value, CultureInfo.InvariantCulture); break;
                case "countdown_seconds": c.CountdownMs = Convert.ToInt32(value, CultureInfo.InvariantCulture) * 1000; break;
                case "late_join": c.LateJoin = Convert.ToBoolean(value, CultureInfo.InvariantCulture) ? LateJoinPolicy.Allow : LateJoinPolicy.Refuse; break;
                default: return;
            }
            Try(() => Lobby.Room.Configure(c));
        }

        public void Approve(int peerId, bool ok)
        {
            if (Lobby != null && Lobby.IsHost) _ = Safe(Lobby.ApproveAsync(peerId, ok));
            Requests = Requests.Where(r => r.PeerId != peerId).ToList();
            Changed?.Invoke();
        }

        public void SendChat(string text)
        {
            if (Lobby == null || !ChatShown || text.Trim().Length == 0) return;
            try { Lobby.Chat.Send(text); }
            catch (OneLobbyException) { /* chat switched off by the blueprint */ }
        }

        private void Try(Action call)
        {
            string code = "";
            try { call(); }
            catch (OneLobbyException ex) { code = ex.Code; }
            NoteCode(code);
        }

        private void NoteCode(string code)
        {
            LobbyNote = "";
            if (code.Length > 0)
            {
                var d = Friendly.DescribeError(code);
                LobbyNote = d.Message + (string.IsNullOrEmpty(d.Hint) ? "" : " " + d.Hint);
            }
            Changed?.Invoke();
        }

        /// <summary>Leaves the lobby (the leave message goes out first) and shows the start screen.</summary>
        public async Task LeaveAsync()
        {
            var l = Lobby;
            if (l != null)
            {
                Lobby = null;
                SetScreen(MenuScreen.Start);
                try { await l.FlushAsync(TimeSpan.FromSeconds(1)).ConfigureAwait(true); } catch (Exception) { /* leaving anyway */ }
                await Safe(l.LeaveAsync()).ConfigureAwait(true);
            }
            SetScreen(MenuScreen.Start);
            Left?.Invoke();
        }

        /// <summary>ui_cancel and the Back buttons. Returns false when there was nothing to go back from (the start screen, a game running).</summary>
        public bool Back()
        {
            switch (Screen)
            {
                case MenuScreen.Settings:
                case MenuScreen.Browse:
                    SetScreen(MenuScreen.Start);
                    break;
                case MenuScreen.Error:
                    Lobby = null;
                    SetScreen(MenuScreen.Start);
                    break;
                case MenuScreen.Connecting:
                    CancelConnecting();
                    break;
                case MenuScreen.Lobby:
                    _ = LeaveAsync();
                    break;
                default:
                    return false;
            }
            return true;
        }

        /// <summary>Gives up waiting for Host or Join. A lobby that still arrives is left; a failure is not shown.</summary>
        public void CancelConnecting()
        {
            if (Screen != MenuScreen.Connecting) return;
            _ticket++;
            SetScreen(MenuScreen.Start);
        }

        // ---- error screen ---------------------------------------------------------------------------------------------------

        private void ShowError(FriendlyError d, string code, bool removed = false, string? title = null)
        {
            Error = new MenuError(title ?? MenuText.T("error_title"), d.Message, d.Hint ?? "", code.Length > 0 ? code : d.Code, removed, false, "");
            LogNote = "";
            SetScreen(MenuScreen.Error);
        }

        public void CopyLogs()
        {
            LogNote = Copy(_client.NetLog.Export()) ? MenuText.T("logs_copied") : MenuText.T("copy_failed");
            Changed?.Invoke();
        }

        public void SaveLogs()
        {
            string path;
            try { path = _client.NetLog.Save(LogsPath); }
            catch (Exception) { path = ""; }
            LogNote = path.Length > 0 ? MenuText.T("logs_saved", path) : MenuText.T("logs_not_saved");
            Changed?.Invoke();
        }

        // ---- settings -------------------------------------------------------------------------------------------------------

        public void OpenSettings()
        {
            if (Screen != MenuScreen.Start) return;
            SettingsNote = "";
            RelayNote = "";
            ServerText = _client.EffectiveServer;
            SetScreen(MenuScreen.Settings);
        }

        /// <summary>"Relay in use: turn:host:3478 &lt;hidden&gt; &lt;hidden&gt;", or the plain sentence when there is none or it does not parse.</summary>
        public string RelayStatusText()
        {
            if (_client.Settings.RelayStatus().Invalid) return MenuText.T("relay_invalid");
            var masked = _client.Settings.MaskedRelay();
            return masked.Length > 0 ? MenuText.T("relay_set", masked) : MenuText.T("relay_none");
        }

        /// <summary>Saves a pasted relay line. The line is never shown again, only its masked form.</summary>
        public bool SaveRelay(string line)
        {
            if (line.Trim().Length == 0) return false;
            var r = _client.Settings.Save(relay: line);
            RelayNote = MenuText.T(r.Ok ? "relay_saved" : "relay_bad_input");
            Changed?.Invoke();
            return r.Ok;
        }

        public void ClearRelay()
        {
            _client.Settings.Save(relay: "");
            RelayNote = MenuText.T("relay_cleared");
            Changed?.Invoke();
        }

        public bool SaveServer(string text)
        {
            var r = _client.Settings.Save(server: text);
            if (r.Ok) ServerText = _client.EffectiveServer;
            SettingsNote = MenuText.T(r.Ok ? "server_saved" : "server_bad_input");
            Changed?.Invoke();
            return r.Ok;
        }

        /// <summary>Runs the connection check and keeps its one-line verdict and three facts.</summary>
        public async Task RunCheckAsync()
        {
            if (CheckRunning) return;
            CheckRunning = true;
            CheckVerdict = MenuText.T("check_running");
            CheckFacts = Array.Empty<string>();
            Changed?.Invoke();
            CheckResult? r = null;
            string failed = "";
            try { r = await (CheckRunner != null ? CheckRunner(CheckOptions) : _client.CheckConnectionAsync(CheckOptions)).ConfigureAwait(true); }
            catch (Exception ex) { failed = Friendly.DescribeError(ex).Message; }
            CheckRunning = false;
            if (r == null)
            {
                CheckVerdict = failed;
                CheckFacts = Array.Empty<string>();
            }
            else
            {
                CheckVerdict = r.Message;
                var relay = r.Relay ?? "none";
                CheckFacts = new[]
                {
                    MenuText.T("check_udp", Fact("udp_", r.Udp ?? "unknown", "udp_unknown")),
                    MenuText.T("check_nat", Fact("nat_", r.NatType ?? "unknown", "nat_unknown")),
                    MenuText.T("check_relay", relay != "none" ? Fact("relay_", relay, "relay_none_fact") : MenuText.T("relay_none_fact")),
                };
            }
            Changed?.Invoke();
        }

        private static string Fact(string prefix, string value, string fallback) => MenuText.T(MenuText.Has(prefix + value) ? prefix + value : fallback);

        // ---- browse ---------------------------------------------------------------------------------------------------------

        public async Task OpenBrowseAsync()
        {
            if (Screen != MenuScreen.Start || !CanBrowse()) return;
            SetScreen(MenuScreen.Browse);
            await RefreshBrowseAsync().ConfigureAwait(true);
        }

        public async Task RefreshBrowseAsync()
        {
            BrowseStatus = MenuText.T("browse_loading");
            BrowseItems = Array.Empty<LobbySummary>();
            Changed?.Invoke();
            IReadOnlyList<LobbySummary> items = Array.Empty<LobbySummary>();
            string failed = "";
            try { items = await _client.ListAsync().ConfigureAwait(true); }
            catch (Exception ex) { failed = Friendly.DescribeError(ex).Message; }
            if (Screen != MenuScreen.Browse) return;
            BrowseStatus = failed.Length > 0 ? failed : items.Count > 0 ? "" : MenuText.T("browse_empty");
            BrowseItems = items;
            Changed?.Invoke();
        }

        /// <summary>The text of a browse row: "Name (Host) 2/4".</summary>
        public static string BrowseRowText(LobbySummary s) => MenuText.T("browse_row", s.Name, s.HostName, s.Players, s.MaxPlayers);

        /// <summary>Joins a listed lobby.</summary>
        public async Task JoinListedAsync(string code)
        {
            if (Screen != MenuScreen.Browse) return;
            SetScreen(MenuScreen.Start);
            SetJoinText(code);
            await JoinAsync().ConfigureAwait(true);
        }

        private void SetScreen(MenuScreen s)
        {
            Screen = s;
            Changed?.Invoke();
        }
    }
}
