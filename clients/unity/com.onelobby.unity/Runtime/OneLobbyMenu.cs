#nullable enable
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using OneLobby.Direct;
using OneLobby.Direct.Nostr;
using UnityEngine;
using UnityEngine.UIElements;

namespace OneLobby.Unity
{
    /// <summary>
    /// The drop-in multiplayer menu for Unity: add this component to an empty GameObject and the menu is there. Name, Host with a
    /// big code, Join by a pasted code, address or invite, the roster with ready and countdown, kick and ban, chat, settings with
    /// the relay line and the connection check, the lobby browser and the "why it failed" screen with logs. It draws
    /// <see cref="MenuModel"/> (OneLobby.Core: every decision) with UI Toolkit controls built in code, takes every string from
    /// <see cref="MenuText"/>, and needs no asset, prefab, scene object or event system in your project.
    /// <code>
    /// var menu = new GameObject("Menu").AddComponent&lt;OneLobbyMenu&gt;();
    /// menu.GameStarted += lobby =&gt; StartMyGame(lobby);
    /// </code>
    /// It finds an <see cref="OneLobbyRunner"/> in the scene or adds one (the runner owns the <see cref="LobbyClient"/> and pumps
    /// it), reads the blueprint from <see cref="Blueprint"/> or from <c>Resources/onelobby.json</c>, and hosts and joins direct
    /// lobbies (no server) by itself through the runner. Controls carry the same names as the Godot menus' unique names
    /// (<see cref="ControlNames"/>); find one with <see cref="Q(string)"/>.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class OneLobbyMenu : MonoBehaviour
    {
        /// <summary>The blueprint a game keeps at <c>Assets/Resources/onelobby.json</c> (no Inspector step), loaded as <c>Resources.Load&lt;TextAsset&gt;("onelobby")</c>.</summary>
        public const string BlueprintResourceName = "onelobby";

        [Serializable]
        public struct TextOverride
        {
            public string Key;
            public string Text;
        }

        [Tooltip("The blueprint (onelobby.json). Empty: Assets/Resources/onelobby.json. With neither, the menu hosts and joins direct lobbies only.")]
        public TextAsset? Blueprint;
        [Tooltip("The menu pumps the lobby itself when nothing else does. A OneLobbyRunner pumps its own client; the menu never pumps twice.")]
        public bool Pump = true;
        [Tooltip("Hide the menu while a game runs, show it again when the lobby comes back.")]
        public bool AutoHideOnStart = true;
        [Tooltip("Act on --host, --join=<code>, --name=<name> and --local from the command line.")]
        public bool BootFlags = true;
        [Tooltip("Base address of an invite link (\"https://game.example/play\"); with it the copied invite sentence ends with the link.")]
        public string InviteBase = "";
        [Tooltip("Rewording: MenuText keys and their new text. Also settable from code with Texts.")]
        public List<TextOverride> TextOverrides = new();
        [Tooltip("Style sheets added after the stock one: restyle by overriding the control names and classes (docs/recipes/menu.md).")]
        public StyleSheet[] StyleSheets = Array.Empty<StyleSheet>();
        [Tooltip("Your own PanelSettings (theme, scaling). Empty: a stock one that scales with the screen from 800x450.")]
        public PanelSettings? PanelSettings;
        [Tooltip("Draw order of the menu's panel above other UI Toolkit panels.")]
        public int SortingOrder = 1000;

        /// <summary>The host started the game, or the player joined a game that is already running. The menu hides itself when <see cref="AutoHideOnStart"/> is true.</summary>
        public event Action<Lobby>? GameStarted;
        /// <summary>The game went back to the lobby; the menu shows the lobby again.</summary>
        public event Action<Lobby>? ReturnedToLobby;
        /// <summary>The player left the lobby.</summary>
        public event Action? Left;

        /// <summary>Rewording from code: {MenuText key: new text}, merged over <see cref="TextOverrides"/>. Set before the first frame.</summary>
        public Dictionary<string, string> Texts { get; set; } = new();

        /// <summary>
        /// The client the menu drives. Set it before the first frame to use your own (then the menu pumps it, and hosts and joins
        /// direct lobbies only when you set <see cref="HostDirect"/> and <see cref="JoinDirect"/>); default: the runner's.
        /// </summary>
        public LobbyClient? Client { get; set; }

        /// <summary>The runner whose client the menu drives (found or added at the first frame); null when <see cref="Client"/> was set.</summary>
        public OneLobbyRunner? Runner { get; set; }

        /// <summary>The model the menu draws (set at the first frame).</summary>
        public MenuModel? Model { get; private set; }

        /// <summary>The command line the boot flags and <c>--local</c> are read from (default: the process command line).</summary>
        public string[]? BootArgs { get; set; }

        /// <summary>Runs the connection check instead of <c>Client.CheckConnectionAsync</c> (a test gives a fake; see <see cref="MenuModel.CheckRunner"/>). Set it before the first frame.</summary>
        public Func<CheckOptions?, Task<CheckResult>>? CheckRunner { get; set; }

        private LobbyOptions? _hostOptions;
        private RoomJoinOptions? _joinOptions;
        private MenuRoute _route = MenuRoute.Auto;
        private Func<string?, Task<Lobby>>? _hostDirect;
        private Func<string, string?, Task<Lobby>>? _joinDirect;

        /// <summary>Base options for Host (see <see cref="MenuModel.HostOptions"/>).</summary>
        public LobbyOptions? HostOptions { get => _hostOptions; set { _hostOptions = value; if (Model != null) Model.HostOptions = value; } }
        /// <summary>Base options for Join (see <see cref="MenuModel.JoinOptions"/>).</summary>
        public RoomJoinOptions? JoinOptions { get => _joinOptions; set { _joinOptions = value; if (Model != null) Model.JoinOptions = value; } }
        /// <summary><c>Auto</c> (the blueprint decides), <c>Direct</c> or <c>Server</c>.</summary>
        public MenuRoute Route { get => _route; set { _route = value; if (Model != null) Model.Route = value; } }
        /// <summary>How to host a direct lobby. Default: the runner's <see cref="OneLobbyRunner.HostDirectAsync"/> with the blueprint's direct options.</summary>
        public Func<string?, Task<Lobby>>? HostDirect { get => _hostDirect; set { _hostDirect = value; if (Model != null) Model.HostDirect = value; } }
        /// <summary>How to join a direct code or address. Default: the runner's <see cref="OneLobbyRunner.JoinDirectAsync(string, string)"/>.</summary>
        public Func<string, string?, Task<Lobby>>? JoinDirect { get => _joinDirect; set { _joinDirect = value; if (Model != null) Model.JoinDirect = value; } }

        /// <summary>The names of every control a controller may touch (the same list as the Godot menu's header).</summary>
        public static IReadOnlyList<string> ControlNames => OneLobbyMenuView.Names;

        /// <summary>The root of the menu's control tree; null before the first frame.</summary>
        public VisualElement? Root => _view?.Root;

        /// <summary>True while the menu is drawn (it is hidden while a game runs when <see cref="AutoHideOnStart"/> is true).</summary>
        public bool IsShown => _view != null && _view.Root.style.display != DisplayStyle.None;

        /// <summary>The name of the control that has keyboard focus, or "".</summary>
        public string FocusedControl => _view?.FocusedName() ?? "";

        /// <summary>The control with this name (<see cref="ControlNames"/>), or null.</summary>
        public VisualElement? Q(string name) => _view?.Find(name);

        /// <summary>The control with this name as a <typeparamref name="T"/>, or null.</summary>
        public T? Q<T>(string name) where T : VisualElement => _view?.Find(name) as T;

        private OneLobbyMenuView? _view;
        private GameObject? _panelObject;
        private PanelSettings? _ownPanelSettings;
        private bool _started, _hooked, _overrodeText;
        private bool _local;
        private Lobby? _heldLobby;
        private List<Action> _later = new();
        private Action<Lobby>? _gameStartedHandler, _returnedHandler;
        private Action? _changedHandler, _leftHandler;

        private void Start()
        {
            if (_started) return;
            _started = true;
            var args = BootArgs ?? Environment.GetCommandLineArgs();
            _local = MenuModel.ArgsSayLocal(args);
            ApplyTexts();
            ResolveClient();
            var client = Client!;
            Model = new MenuModel(client)
            {
                HostOptions = _hostOptions, JoinOptions = _joinOptions, Route = _local ? MenuRoute.Direct : _route, InviteBase = InviteBase,
                HostDirect = _hostDirect, JoinDirect = _joinDirect,
                Clipboard = text => GUIUtility.systemCopyBuffer = text,
                LogsPath = System.IO.Path.Combine(Application.persistentDataPath, "onelobby-menu-log.txt"),
                CheckRunner = CheckRunner,
                // `--local`: 127.0.0.1 only, nothing leaves this PC, so the check does not run by itself (the button still does).
                // Read here, not with the boot flags: a game that applies the flags itself later would be too late for the check on open.
                LocalOnly = _local,
            };
            _view = new OneLobbyMenuView(Model, () => AutoHideOnStart, a => _later.Add(a), () => { });
            BuildPanel();
            Hook();
            _view.Refresh();
            if (BootFlags) Model.ApplyBootFlags(args);
        }

        private void ApplyTexts()
        {
            var merged = new Dictionary<string, string>();
            foreach (var o in TextOverrides)
                if (!string.IsNullOrEmpty(o.Key)) merged[o.Key] = o.Text ?? "";
            foreach (var kv in Texts) merged[kv.Key] = kv.Value;
            if (merged.Count == 0) return;
            MenuText.Override(merged);
            _overrodeText = true;
        }

        /// <summary>The runner whose client the menu drives: the one in the scene, or a new one made with the blueprint and, for --local, the loopback bind set before its client exists.</summary>
        private void ResolveClient()
        {
            if (Client != null) return;
            var runner = Runner != null ? Runner : FindFirstObjectByType<OneLobbyRunner>();
            if (runner == null)
            {
                var bp = Blueprint != null ? Blueprint : Resources.Load<TextAsset>(BlueprintResourceName);
                // inactive while its fields are set: the runner reads some of them when it wakes up
                var go = new GameObject("OneLobbyRunner");
                go.SetActive(false);
                runner = go.AddComponent<OneLobbyRunner>();
                runner.Blueprint = bp;
                if (bp == null)
                {
                    Debug.LogWarning("OneLobbyMenu: no blueprint (a TextAsset on the menu, or Assets/Resources/onelobby.json); the menu hosts and joins direct lobbies only. " +
                                     "Add an onelobby.json to use a lobby server.");
                    runner.GameId = GameIdFromProduct();
                    runner.LobbyServer = ""; // the server the player saved, else none
                }
                go.SetActive(true);
            }
            if (_local && string.IsNullOrWhiteSpace(runner.BindAddress)) runner.BindAddress = "127.0.0.1"; // before the client exists: its sockets stay on loopback
            Runner = runner;
            Client = runner.Client;
            var blueprint = Client.Blueprint;
            if (blueprint == null || blueprint.Hosting.Direct)
            {
                _hostDirect ??= HostDirectThroughRunner;
                _joinDirect ??= (text, password) => runner.JoinDirectAsync(text, password);
            }
        }

        private static string GameIdFromProduct()
        {
            var chars = new System.Text.StringBuilder();
            foreach (var c in Application.productName.ToLowerInvariant()) chars.Append(char.IsLetterOrDigit(c) ? c : '-');
            return chars.Length == 0 ? "game" : chars.ToString();
        }

        private Task<Lobby> HostDirectThroughRunner(string? password)
        {
            var name = Model?.NameText;
            var blueprint = Client!.Blueprint;
            var options = blueprint != null
                ? blueprint.ToDirectHostOptions(null, string.IsNullOrEmpty(name) ? null : name)
                : new DirectHostOptions { Name = (string.IsNullOrEmpty(name) ? "Player" : name) + "'s game" };
            options.Password = password;
            if (_local)
            {
                options.BindAddress = System.Net.IPAddress.Loopback;
                options.Nostr = new NostrOptions { Enabled = false };
                options.OpenPort = false;
                options.PublicAddress = "127.0.0.1"; // the join code a local host shows must work on this PC: it carries this address, not the network one
            }
            return Runner!.HostDirectAsync(options);
        }

        private void BuildPanel()
        {
            _panelObject = new GameObject("OneLobbyMenuUI");
            _panelObject.transform.SetParent(transform, false);
            var doc = _panelObject.AddComponent<UIDocument>();
            doc.panelSettings = PanelSettings != null ? PanelSettings : (_ownPanelSettings = MakePanelSettings());
            var root = doc.rootVisualElement;
            var stock = Resources.Load<StyleSheet>("OneLobbyMenu");
            if (stock != null) root.styleSheets.Add(stock);
            else Debug.LogWarning("OneLobbyMenu: the stock style sheet (Resources/OneLobbyMenu.uss) is missing; the menu is unstyled.");
            foreach (var sheet in StyleSheets)
                if (sheet != null) root.styleSheets.Add(sheet);
            root.style.flexGrow = 1;
            root.Add(_view!.Root);
        }

        private PanelSettings MakePanelSettings()
        {
            // The engine logs "No Theme Style Sheet set" while a PanelSettings is created, before it can be given one; that line is about a state of
            // a few microseconds, so it is muted for this one call.
            var filter = Debug.unityLogger.filterLogType;
            Debug.unityLogger.filterLogType = LogType.Error;
            PanelSettings ps;
            try { ps = ScriptableObject.CreateInstance<PanelSettings>(); }
            finally { Debug.unityLogger.filterLogType = filter; }
            ps.name = "OneLobbyMenuPanelSettings";
            ps.themeStyleSheet = Resources.Load<ThemeStyleSheet>("OneLobbyMenuTheme");
            if (ps.themeStyleSheet == null) Debug.LogWarning("OneLobbyMenu: the stock theme (Resources/OneLobbyMenuTheme.tss) is missing; the menu will not render properly.");
            ps.scaleMode = PanelScaleMode.ScaleWithScreenSize;
            ps.referenceResolution = new Vector2Int(800, 450);
            ps.screenMatchMode = PanelScreenMatchMode.MatchWidthOrHeight;
            ps.match = 0.5f;
            ps.sortingOrder = SortingOrder;
            return ps;
        }

        /// <summary>
        /// The model's events reach the menu only while it is enabled. A C# event keeps calling a destroyed component, and the model
        /// lives as long as its client.
        /// </summary>
        private void Hook()
        {
            if (_hooked || Model == null) return;
            _hooked = true;
            _gameStartedHandler = l => GameStarted?.Invoke(l);
            _returnedHandler = l => ReturnedToLobby?.Invoke(l);
            _changedHandler = OnChanged;
            _leftHandler = OnLeft;
            Model.GameStarted += _gameStartedHandler;
            Model.ReturnedToLobby += _returnedHandler;
            Model.Changed += _changedHandler;
            Model.Left += _leftHandler;
        }

        private void Unhook()
        {
            if (!_hooked || Model == null) return;
            _hooked = false;
            Model.GameStarted -= _gameStartedHandler;
            Model.ReturnedToLobby -= _returnedHandler;
            Model.Changed -= _changedHandler;
            Model.Left -= _leftHandler;
        }

        private void OnChanged()
        {
            if (Model?.Lobby != null) _heldLobby = Model.Lobby;
            _view?.Refresh();
        }

        private void OnLeft()
        {
            // a direct lobby the runner adopted is still its Lobby: tell it the player left, so it stops pumping it and lets go of the background hold
            var held = _heldLobby;
            _heldLobby = null;
            if (Runner != null && held != null && ReferenceEquals(Runner.Lobby, held)) _ = LeaveRunnerQuietly(Runner);
            Left?.Invoke();
        }

        private static async Task LeaveRunnerQuietly(OneLobbyRunner runner)
        {
            try { await runner.LeaveAsync(); }
            catch (Exception) { /* already left: nothing to tell the player */ }
        }

        private void OnEnable()
        {
            if (!_started || Model == null) return;
            Hook();
            _view?.Refresh();
        }

        private void OnDisable() => Unhook();

        private void OnDestroy()
        {
            Unhook();
            if (_overrodeText)
            {
                _overrodeText = false;
                MenuText.Override(null); // static: it must not outlive this menu (play mode without a domain reload keeps statics)
            }
            if (_ownPanelSettings != null) Destroy(_ownPanelSettings);
            _view = null;
        }

        private void Update()
        {
            if (_later.Count > 0)
            {
                var run = _later;
                _later = new List<Action>();
                foreach (var a in run) a();
            }
            if (Model == null) return;
            if (Pump)
            {
                // a OneLobbyRunner pumps its own client, and the lobby it adopted (a direct one); anything else is pumped here, once
                var lobby = Model.Lobby;
                if (lobby != null) { if (Runner == null || !ReferenceEquals(Runner.Lobby, lobby)) lobby.Pump(); }
                else if (Runner == null) Model.Client.Pump();
            }
            _view?.Tick();
        }

        /// <summary>Leaves the lobby from code (the same as the Leave button).</summary>
        public async Task LeaveAsync()
        {
            if (Model != null) await Model.LeaveAsync();
        }
    }
}
