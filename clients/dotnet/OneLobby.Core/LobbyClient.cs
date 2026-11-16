using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace OneLobby
{
    /// <summary>
    /// Entry point: talks to onelobby-server over the transport's signaling socket and hands out <see cref="Lobby"/>s.
    /// Requests complete (and their continuations are signalled) from inside <see cref="Pump"/>, never from another thread.
    /// </summary>
    /// <remarks>The async calls throw <see cref="OneLobbyException"/> (with the server error <c>Code</c>, such as
    /// lobby_full, unknown_code, version_mismatch, rate_limited, or the local codes timeout and server_closed).</remarks>
    public sealed class LobbyClient : IAsyncDisposable
    {
        private const long RequestTimeoutMs = 10_000;

        private sealed class Op
        {
            public string? Request;
            /// <summary>Builds the request once the hub's welcome (its features) is known.</summary>
            public Func<string>? Build;
            public string[] Expect = Array.Empty<string>();
            public Action<JsonElement> Complete = _ => { };
            public Action<Exception> Fail = _ => { };
            public bool Sent;
            public long DeadlineMs;
            public long ConnectDeadlineMs;
            public CancellationTokenRegistration Reg;
        }

        private readonly OneLobbyConfig _config;
        private OneLobbyConfig? _effectiveConfig;
        private readonly SettingsOptions _use;
        private bool _relayWarned;

        /// <summary>The config with the saved name filled in when the game gave none (spec/settings.md s.5).</summary>
        internal OneLobbyConfig Config
        {
            get
            {
                var n = EffectiveName();
                if (n == _config.DisplayName) return _config;
                if (_effectiveConfig == null || _effectiveConfig.DisplayName != n) _effectiveConfig = _config with { DisplayName = n };
                return _effectiveConfig;
            }
        }

        /// <summary>
        /// The player's saved settings (name, relay line, last code, lobby server; spec/settings.md): <c>Load()</c>, <c>Effective()</c>,
        /// <c>Save(name: ...)</c>, <c>MaskedRelay()</c>. The client applies them as defaults; an explicit config value always wins.
        /// </summary>
        public PlayerSettings Settings { get; }

        /// <summary>A plain sentence for the player: a saved relay line was skipped because it is not valid. Fires once, never holds the line.</summary>
        public event Action<string>? Warning;

        private string EffectiveName()
        {
            var given = _config.DisplayName ?? "";
            if (!_use.Name || !(given.Length == 0 || given == "Player")) return given;
            if (Blueprint != null && Blueprint.Players.Identity == "anonymous") return given;
            var saved = SettingsRules.CleanName(Settings.Effective().Name, Blueprint?.Players.MaxNameLength ?? 24);
            return saved.Length > 0 ? saved : given;
        }

        /// <summary>Where the hub is: the config's lobby server, or the saved one when the game and onelobby.json gave none.</summary>
        internal Uri HubUri
        {
            get
            {
                if (Direct || !ReferenceEquals(_hubUri, OneLobby.Blueprint.NoServer) || !_use.Server) return _hubUri;
                var s = Settings.Effective().Server;
                return s.Length > 0 && Uri.TryCreate(s, UriKind.Absolute, out var u) ? u : _hubUri;
            }
        }

        /// <summary>
        /// The lobby server this client uses now as text, e.g. <c>wss://lobby.mygame.example/ws</c>: the config's, or (when the
        /// config has none) the one the player saved in the settings; empty when there is none or the client is direct.
        /// </summary>
        public string EffectiveServer => Direct || ReferenceEquals(HubUri, OneLobby.Blueprint.NoServer) ? "" : HubUri.ToString();

        /// <summary>The list plus this player's saved relay entry, unless it is already in it (spec/settings.md s.5).</summary>
        internal IReadOnlyList<IceServer> WithSavedRelay(IReadOnlyList<IceServer>? ice)
        {
            var list = ice ?? Array.Empty<IceServer>();
            if (!_use.Relay) return list;
            var (entry, invalid) = Settings.RelayStatus();
            if (invalid && !_relayWarned)
            {
                _relayWarned = true;
                Warning?.Invoke(SettingsRules.RelaySkippedWarning);
            }
            if (entry == null) return list;
            if (list.Any(e => e != null && e.Urls.SequenceEqual(entry.Urls) && e.Username == entry.Username && e.Credential == entry.Credential)) return list;
            return list.Concat(new[] { entry }).ToList();
        }

        /// <summary>Saves the code of a lobby this player hosted or joined as <c>lastCode</c> (a code that does not clean is not saved).</summary>
        internal void RememberCode(string? code)
        {
            if (!_use.LastCode) return;
            var c = SettingsRules.CleanLastCode(code);
            if (!string.IsNullOrEmpty(c)) Settings.Save(lastCode: c);
        }
        internal ITransport Transport { get; private set; }
        private readonly ITransport _baseTransport;
        /// <summary>Where the hub is: the config's lobby server, or a direct-IP host (docs/design/direct-ip.md).</summary>
        private Uri _hubUri;
        /// <summary>Direct IP: the hub lives in the host, so the host leaving ends the session (no migration).</summary>
        internal bool Direct { get; private set; }
        /// <summary>Disposed when the lobby closes (a direct host's embedded hub and listener).</summary>
        private IDisposable? _owned;
        /// <summary>Direct-IP joiner: no WebSocket answer within this long means direct_unreachable (0 = off).</summary>
        internal const long DirectConnectTimeoutMs = 5000;

        /// <summary>The wait above for a Nostr joiner (spec/nostr-signaling.md s.4: the socket gives up itself after 15 s).</summary>
        internal long DirectConnectTimeout { get; set; } = DirectConnectTimeoutMs;
        private IReadOnlyList<IceServer> _ice = Array.Empty<IceServer>();
        /// <summary>The hub's ICE list and this player's saved relay (a direct joiner's goes in through <c>JoinDirectOptions</c>, see OneLobby.Direct).</summary>
        internal IReadOnlyList<IceServer> Ice
        {
            get => Direct && _owned == null ? _ice : WithSavedRelay(_ice);
            private set => _ice = value;
        }
        /// <summary>Optional messages the hub handles (<c>welcome.features</c>, e.g. "set_name"); empty for an older hub.</summary>
        internal IReadOnlyCollection<string> Features { get; private set; } = Array.Empty<string>();
        internal ISignalingSocket? Socket { get; private set; }

        private Op? _op;
        private long _opStartMs;
        private (string Mine, string Theirs)? _opVersions;
        private Lobby? _lobby;
        private bool _welcomed;
        private bool _helloWired;
        private string? _helloResume;
        private JsonElement? _stashedLobby;
        private long _lastPingMs;
        private int _pingN;

        public event Action<LobbyError>? Error;

        /// <summary>The library version the report carries (<c>0.7.2</c>).</summary>
        internal static readonly string LibVersion = ReadVersion();

        private static string ReadVersion()
        {
            var v = System.Reflection.CustomAttributeExtensions.GetCustomAttribute<System.Reflection.AssemblyInformationalVersionAttribute>(typeof(LobbyClient).Assembly)?.InformationalVersion ?? "0.7.2";
            var plus = v.IndexOf('+');
            return plus >= 0 ? v.Substring(0, plus) : v;
        }

        /// <summary>
        /// The net log (spec/diagnostics.md s.5): a ring buffer of connection steps with timings. <c>NetLog.Export()</c> is
        /// the text a player copies; addresses are masked unless asked for, credentials never print. It stays on this machine.
        /// </summary>
        public NetLog NetLog { get; }

        /// <summary>The last <see cref="CheckConnectionAsync"/> result: its NAT reading joins a later failure's diagnosis and the report to the host.</summary>
        public CheckResult? LastCheck { get; private set; }

        /// <summary>How this client reaches lobbies: <c>server</c> (code), <c>ip</c> (typed address) or <c>nostr</c>.</summary>
        internal string Route => !Direct ? "server" : _hubUri.Scheme == "onelobby-nostr" ? "nostr" : "ip";

        public LobbyClient(OneLobbyConfig config, ITransport transport)
        {
            _config = config ?? throw new ArgumentNullException(nameof(config));
            Transport = _baseTransport = transport ?? throw new ArgumentNullException(nameof(transport));
            _hubUri = config.LobbyServer;
            _use = config.Settings ?? new SettingsOptions();
            Settings = new PlayerSettings(config.SettingsStore ?? (config.SettingsFile != null ? KeyValueStores.FromFile(config.SettingsFile) : KeyValueStores.Memory()), config.GameId, config.SettingsEnv);
            var dg = config.Diagnostics ?? new DiagnosticsOptions();
            var t0 = transport.NowMs;
            NetLog = new NetLog(dg.LogSize, () => Transport.NowMs - t0, new NetLogMeta("onelobby-dotnet " + LibVersion, Signaling.Proto, "dotnet"), dg.LogPath);
            if (!string.IsNullOrEmpty(dg.LogPath)) NetLog.FlushOnExit(dg.LogPath);
            NetLog.Add("info", "client onelobby-dotnet " + LibVersion + " protocol " + Signaling.Proto + " game version " + config.NetVersion);
        }

        /// <summary>
        /// Checks what this network allows (spec/diagnostics.md s.8): whether UDP gets out, the NAT type (two STUN servers from
        /// one socket) and whether a relay takes its login. Contacts only the STUN servers it is given (default: the ones the
        /// client connects with) and the TURN entry in <c>options.IceServers</c> (default: the ICE servers of the last lobby server
        /// welcome). A menu runs it on demand; the library never does.
        /// </summary>
        public async Task<CheckResult> CheckConnectionAsync(CheckOptions? options = null)
        {
            var o = options ?? new CheckOptions { IceServers = Ice };
            var r = await ConnectionCheck.CheckAsync(o).ConfigureAwait(false);
            LastCheck = r;
            NetLog.Add("info", "connection check udp=" + r.Udp + " nat=" + r.NatType + " relay=" + r.Relay + " verdict=" + r.Verdict);
            return r;
        }

        /// <summary>
        /// Points this client at a direct-IP hub (OneLobby.Direct): <paramref name="wrap"/> decorates the transport given
        /// to the constructor, <paramref name="hub"/> replaces the lobby server, <paramref name="owned"/> is disposed when
        /// the lobby closes. Fails if a lobby or request is active.
        /// </summary>
        internal void UseDirect(Func<ITransport, ITransport> wrap, Uri hub, IDisposable? owned, long connectTimeoutMs = DirectConnectTimeoutMs)
        {
            if (_op != null || _lobby != null) throw new InvalidOperationException("leave the current lobby first");
            Socket?.Dispose();
            Socket = null;
            _owned?.Dispose();
            Transport = wrap(_baseTransport);
            _hubUri = hub;
            _owned = owned;
            Direct = true;
            DirectConnectTimeout = connectTimeoutMs;
        }

        /// <summary>Direct-IP join: the hub runs one lobby, so no code; the optional password is checked by the hub.</summary>
        internal Task<Lobby> JoinSingleLobbyAsync(string? password, CancellationToken ct = default) => JoinSingleLobbyAsync(password, null, ct);

        /// <summary>As above, with the room layer's join options (role, starting data); the password is also sent to the host's room.</summary>
        internal Task<Lobby> JoinSingleLobbyAsync(string? password, RoomJoinOptions? room, CancellationToken ct)
        {
            var setup = new RoomSetup { Join = JoinSetup(room, password) };
            return Run(null, Signaling.JoinDirect(password), new[] { "lobby" }, e => EnterLobby(e, setup), ct);
        }

        private static RoomJoinOptions JoinSetup(RoomJoinOptions? o, string? password) =>
            new RoomJoinOptions { Role = o?.Role ?? RoomRole.Player, Data = o?.Data, Password = password ?? o?.Password };

        private IKeyValueStore? _idStore, _banStore;
        private BanList? _bans;
        private string? _pid;

        /// <summary>
        /// This install's player id for the game (32 hex characters, made once and kept: spec/room.md s.1). It is sent in the
        /// hello so hubs can refuse banned ids and hosts can keep a player's seat. Not an account or a hardware id.
        /// </summary>
        public string PlayerId => _pid ??= KeyValueStores.LoadPlayerId(
            _idStore ??= Config.PlayerIdStore ?? (Config.PlayerIdFile != null ? KeyValueStores.FromFile(Config.PlayerIdFile) : KeyValueStores.Memory()), Config.GameId);

        /// <summary>The host-side ban list (also <c>lobby.Room.Bans</c>): persistent per game, see <see cref="OneLobbyConfig.BanFile"/>.</summary>
        public BanList Bans => _bans ??= new BanList(
            _banStore ??= Config.BanStore ?? (Config.BanFile != null ? KeyValueStores.FromFile(Config.BanFile) : KeyValueStores.Memory()), Config.GameId);

        /// <summary>The room options every lobby this client hosts starts from: the blueprint's <c>room</c>, then <see cref="OneLobbyConfig.Room"/>.</summary>
        internal RoomOptions RoomDefaults => (Blueprint?.Room.ToOptions(Blueprint.Players.MaxNameLength) ?? new RoomOptions()).Merge(Config.Room);

        /// <summary>The blueprint this client was built from (<see cref="FromBlueprint"/>), or null. A blueprint client enforces it.</summary>
        public Blueprint? Blueprint { get; private set; }

        /// <summary>
        /// A client that runs from <c>onelobby.json</c>. <paramref name="lobbyServerOverride"/> (when not empty) replaces
        /// <c>hosting.lobbyServer</c>, the per-player layer above the file;
        /// <paramref name="configure"/> may adjust the final config. Throws <see cref="OneLobbyException"/>
        /// <c>identity_anonymous</c> / <c>bad_config</c> (path <c>displayName</c>) when the name breaks <c>players.*</c>.
        /// </summary>
        public static LobbyClient FromBlueprint(Blueprint blueprint, ITransport transport, string? displayName = null,
            string? lobbyServerOverride = null, Func<OneLobbyConfig, OneLobbyConfig>? configure = null)
        {
            if (blueprint == null) throw new ArgumentNullException(nameof(blueprint));
            blueprint.CheckDisplayName(displayName);
            var config = blueprint.ToConfig(displayName);
            if (!string.IsNullOrEmpty(lobbyServerOverride))
            {
                if (!Uri.TryCreate(lobbyServerOverride, UriKind.Absolute, out var u))
                    throw new BlueprintException("lobbyServer", "type", "not a URL: " + lobbyServerOverride);
                config = config with { LobbyServer = u };
            }
            if (configure != null) config = configure(config);
            return new LobbyClient(config, transport) { Blueprint = blueprint };
        }

        /// <summary>Creates a lobby from the blueprint (<see cref="Blueprint.ToLobbyOptions"/>). Needs a blueprint client with a lobby server.</summary>
        public Task<Lobby> HostAsync(CancellationToken ct = default)
        {
            if (Blueprint == null) return Task.FromException<Lobby>(new InvalidOperationException("HostAsync() needs a client made with FromBlueprint; pass LobbyOptions"));
            return HostAsync(Blueprint.ToLobbyOptions(null, Config.DisplayName), ct);
        }

        public Task<Lobby> HostAsync(LobbyOptions options, CancellationToken ct = default)
        {
            var room = RoomDefaults.Merge(options.Room);
            if (room.PasswordRequired == true && string.IsNullOrEmpty(options.Password))
                return Task.FromException<Lobby>(new OneLobbyException(LobbyErrorCodes.PasswordRequired, "this game requires a lobby password (room.passwordRequired); pass LobbyOptions.Password"));
            if (options.Password != null && options.Password.Length > 64)
                return Task.FromException<Lobby>(new ArgumentOutOfRangeException(nameof(options), "password must be at most 64 characters"));
            var setup = new RoomSetup { Options = room, Password = options.Password ?? "", MaxPlayers = options.MaxPlayers };
            return Run<Lobby>(null, null, new[] { "lobby" }, e =>
            {
                var lobby = EnterLobby(e, setup);
                lobby.RateLimit = options.RateLimit;
                if (!Direct) RememberCode(lobby.Code);
                return lobby;
            }, ct, () =>
            {
                var roomHub = Features.Contains("room");
                var spectators = Math.Max(0, Math.Min(64, room.Spectators ?? 0));
                if (roomHub && options.MaxPlayers + spectators > 250) throw new ArgumentOutOfRangeException(nameof(options), "MaxPlayers + spectators is more than the hub allows (250)");
                // a hub without the room feature has no spectator slots: it gets the sum as its capacity and the room splits it
                return Signaling.Create(Config, options, roomHub ? options.MaxPlayers : options.MaxPlayers + spectators,
                    room.LateJoin is { } lj ? lj != LateJoinPolicy.Refuse : options.LateJoin,
                    roomHub && !Direct ? options.Password : null, roomHub ? spectators : 0);
            });
        }

        public Task<Lobby> JoinAsync(string code, CancellationToken ct = default) => JoinAsync(code, null, ct);

        /// <summary>Joins a lobby with a password, a role (spectator) and your starting per-player data (spec/room.md s.4.2).</summary>
        public Task<Lobby> JoinAsync(string code, RoomJoinOptions? options, CancellationToken ct = default)
        {
            var norm = Crockford.Normalize(code);
            if (norm == null) return Task.FromException<Lobby>(new OneLobbyException("unknown_code", "not a valid join code"));
            var setup = new RoomSetup { Join = JoinSetup(options, null) };
            return Run(null, Signaling.Join(norm, options?.Password), new[] { "lobby" }, e =>
            {
                var lobby = EnterLobby(e, setup);
                RememberCode(norm);
                return lobby;
            }, ct);
        }

        public Task<Lobby> RejoinAsync(string resumeToken, CancellationToken ct = default) =>
            Run(resumeToken, null, new[] { "lobby" }, e => EnterLobby(e), ct);

        public Task<IReadOnlyList<LobbySummary>> ListAsync(IReadOnlyDictionary<string, string>? metaFilter = null,
            CancellationToken ct = default) =>
            Blueprint is { Hosting: { Server: false } }
            ? Task.FromException<IReadOnlyList<LobbySummary>>(new OneLobbyException(LobbyErrorCodes.ListingDisabled,
                "listing needs a lobby server (hosting.server is false in onelobby.json)"))
            : Run<IReadOnlyList<LobbySummary>>(null, Signaling.List(metaFilter), new[] { "lobbies" }, e =>
            {
                var items = new List<LobbySummary>();
                if (e.TryGetProperty("items", out var arr) && arr.ValueKind == JsonValueKind.Array)
                    foreach (var it in arr.EnumerateArray()) items.Add(Signaling.ParseSummary(it));
                return items;
            }, ct);

        private Lobby EnterLobby(JsonElement reply, RoomSetup? setup = null)
        {
            var msg = Signaling.ParseLobby(reply);
            if (setup == null && msg.You == msg.HostId) setup = new RoomSetup { Options = RoomDefaults };
            var lobby = new Lobby(this, msg, setup);
            if (Blueprint != null) lobby.Voice.Mode = Blueprint.Chat.VoiceMode == "voiceActivity" ? VoiceMode.VoiceActivity : VoiceMode.PushToTalk;
            _lobby = lobby;
            lobby.Start();
            return lobby;
        }

        private Task<T> Run<T>(string? resume, string? request, string[] expect, Func<JsonElement, T> finish, CancellationToken ct, Func<string>? build = null)
        {
            if (_op != null) return Task.FromException<T>(new InvalidOperationException("another request is in flight"));
            if (!Direct && ReferenceEquals(HubUri, OneLobby.Blueprint.NoServer))
                return Task.FromException<T>(new OneLobbyException(LobbyErrorCodes.NoServer,
                    "no lobby server address (set hosting.lobbyServer in onelobby.json or pass lobbyServerOverride; direct-only games use HostDirectAsync)"));
            if (_lobby != null && expect[0] == "lobby") return Task.FromException<T>(new InvalidOperationException("already in a lobby; leave it first"));
            var tcs = new TaskCompletionSource<T>();
            _opStartMs = Transport.NowMs;
            _opVersions = null;
            var op = new Op { Request = request, Build = build, Expect = expect, DeadlineMs = Transport.NowMs + RequestTimeoutMs };
            if (Direct) op.ConnectDeadlineMs = Transport.NowMs + DirectConnectTimeout;
            op.Complete = e =>
            {
                try { tcs.TrySetResult(finish(e)); }
                catch (Exception ex) { tcs.TrySetException(ex); }
            };
            op.Fail = ex => tcs.TrySetException(ex);
            if (ct.CanBeCanceled)
                op.Reg = ct.Register(() => { if (_op == op) _op = null; tcs.TrySetCanceled(); });
            _op = op;
            if (Socket == null || Socket.State == SocketState.Closed)
            {
                Socket?.Dispose();
                NetLog.Add("sig", "open route=" + Route, HubUri.Scheme == "onelobby-nostr" ? null : SettingsRules.RedactUrl(HubUri.ToString()));
                Socket = Transport.ConnectSignaling(HubUri);
                _welcomed = false;
                _helloWired = false;
            }
            _helloResume = resume;
            if (_welcomed) Send(op);
            return tcs.Task;
        }

        private void Send(Op op)
        {
            op.Sent = true;
            if (op.Build != null)
            {
                string req;
                try { req = op.Build(); }
                catch (Exception ex) { FailOp(ex); return; }
                Socket!.Send(req);
            }
            else if (op.Request != null) Socket!.Send(op.Request);
            else if (_stashedLobby is { } s) { _stashedLobby = null; FinishOp(s); }
        }

        private void FinishOp(JsonElement e)
        {
            var op = _op!;
            _op = null;
            op.Reg.Dispose();
            op.Complete(e);
        }

        /// <summary>The error codes a connect failure carries a diagnosis for (spec/diagnostics.md s.9).</summary>
        private static readonly string[] DiagnosedCodes = { "connect_failed", "direct_unreachable", "version_mismatch", "server_closed", "closed" };

        /// <summary>Puts the diagnosis on a connect failure (the code is unchanged) and logs it.</summary>
        private void Diagnosed(Exception ex)
        {
            if (!(ex is OneLobbyException oe) || oe.Diagnosis != null || Array.IndexOf(DiagnosedCodes, oe.Code) < 0) return;
            // a failure after the welcome is a refused join: only a version mismatch is about connecting
            if (_welcomed && oe.Code != "version_mismatch") return;
            var facts = new DiagnoseFacts
            {
                Side = "joiner", Route = Route, Error = oe.Code,
                Reached = _welcomed ? Reached.Signaling : Reached.None,
                ElapsedMs = Math.Max(0, Transport.NowMs - _opStartMs),
                Versions = _opVersions,
            };
            oe.Diagnosis = Diagnose.Run(facts);
            NetLog.Add("diag", "cause " + oe.Diagnosis.Cause + " stage " + oe.Diagnosis.Stage + " after " + facts.ElapsedMs + " ms");
        }

        private void FailOp(Exception ex)
        {
            var op = _op;
            if (op == null) return;
            if (ex is OneLobbyException lo) NetLog.Add("error", lo.Code, code: lo.Code);
            Diagnosed(ex);
            _op = null;
            op.Reg.Dispose();
            op.Fail(ex);
        }

        /// <summary><c>stun,turn</c> from an ICE list: the kinds only, never a URL or a login.</summary>
        private static string IceKinds(IReadOnlyList<IceServer> ice)
        {
            var kinds = new List<string>();
            foreach (var s in ice)
                foreach (var u in s.Urls)
                {
                    var c = u.IndexOf(':');
                    var k = c > 0 ? u.Substring(0, c).ToLowerInvariant() : "other";
                    if (k != "stun" && k != "stuns" && k != "turn" && k != "turns") k = "other";
                    if (!kinds.Contains(k)) kinds.Add(k);
                }
            return kinds.Count == 0 ? "none" : string.Join(",", kinds);
        }

        internal void SendRaw(string json) { if (Socket != null && Socket.State == SocketState.Open) Socket.Send(json); }

        internal void LobbyClosed(Lobby l)
        {
            if (_lobby != l) return;
            _lobby = null;
            if (_owned != null)
            {
                // a direct host's hub: queued messages (the host's own "leave") flush, then joiners are disconnected
                _owned.Dispose();
                _owned = null;
            }
        }

        internal void RaiseError(LobbyError e) => Error?.Invoke(e);

        /// <summary>
        /// Polls the transport and the signaling socket. You need it only before a lobby exists (to complete HostAsync,
        /// JoinAsync or ListAsync); once you hold a <see cref="Lobby"/>, call <see cref="Lobby.Pump"/>, which does this too.
        /// Calling both is harmless.
        /// </summary>
        public void Pump()
        {
            Transport.Poll();
            var now = Transport.NowMs;
            var sock = Socket;
            if (sock != null)
            {
                if (sock.State == SocketState.Open && !_helloWired && (_op != null || _lobby != null))
                {
                    _helloWired = true;
                    sock.Send(Signaling.Hello(Config, _helloResume, PlayerId));
                }
                while (sock.TryReceive(out var text)) Dispatch(text);
                if (Direct && _op != null && !_welcomed && (sock.State == SocketState.Closed
                    || (sock.State == SocketState.Connecting && _op.ConnectDeadlineMs > 0 && now > _op.ConnectDeadlineMs)))
                {
                    // docs/design/direct-ip.md s.3: no answer on the host's TCP port
                    FailOp(new OneLobbyException("direct_unreachable",
                        _hubUri.Scheme == "onelobby-nostr"
                            ? (string.IsNullOrEmpty(sock.CloseReason) ? "no answer through the Nostr relays" : sock.CloseReason!) // the socket says why, as in JS
                            : "no answer from the host at " + _hubUri.Host + ":" + _hubUri.Port + " (" + (sock.CloseReason ?? "timed out") + ")"));
                    if (sock.State != SocketState.Closed) { sock.Dispose(); Socket = null; }
                    return;
                }
                if (sock.State == SocketState.Closed)
                {
                    FailOp(new OneLobbyException("server_closed", sock.CloseReason ?? "closed"));
                    _lobby?.OnSocketClosed();
                }
                else if (sock.State == SocketState.Open && _welcomed && now - _lastPingMs >= 10_000)
                {
                    _lastPingMs = now;
                    sock.Send(Signaling.Ping(++_pingN));
                }
            }
            if (_op != null && now > _op.DeadlineMs) FailOp(new OneLobbyException("timeout", "no answer from the lobby server"));
            _lobby?.PumpLobby();
        }

        private void Dispatch(string text)
        {
            JsonDocument doc;
            try { doc = JsonDocument.Parse(text); }
            catch (JsonException) { return; }
            using (doc)
            {
                var e = doc.RootElement;
                var t = Signaling.Str(e, "t");
                switch (t)
                {
                    case "welcome":
                        Ice = Signaling.ParseIce(e);
                        Features = e.TryGetProperty("features", out var fs) && fs.ValueKind == JsonValueKind.Array
                            ? fs.EnumerateArray().Where(f => f.ValueKind == JsonValueKind.String).Select(f => f.GetString()!).ToArray()
                            : Array.Empty<string>();
                        _welcomed = true;
                        NetLog.Add("sig", "welcome features=" + (Features.Count == 0 ? "none" : string.Join(",", Features)) + " ice=" + IceKinds(Ice));
                        // a resume answered without a seat: the token is unknown or expired (no lobby message follows)
                        if (_op != null && !_op.Sent && _op.Request == null && _op.Build == null && _helloResume != null && !e.TryGetProperty("peerId", out _))
                        {
                            _helloResume = null;
                            FailOp(new OneLobbyException("invalid_token", "resume token unknown or expired"));
                            return;
                        }
                        if (_op != null && !_op.Sent) Send(_op);
                        return;
                    case "ping":
                        SendRaw(Signaling.Pong(Signaling.Int(e, "n")));
                        return;
                    case "pong":
                        return;
                    case "error":
                    {
                        var err = new LobbyError(Signaling.Str(e, "code"), Signaling.Str(e, "msg"));
                        // kick{ban:false}: the host disconnected us, no ban (spec/signaling.md)
                        bool disconnected = e.TryGetProperty("data", out var d) && d.ValueKind == JsonValueKind.Object &&
                                            d.TryGetProperty("ban", out var ban) && ban.ValueKind == JsonValueKind.False;
                        if (err.Code == "version_mismatch" && e.TryGetProperty("data", out var vd) && vd.ValueKind == JsonValueKind.Object)
                        {
                            var theirs = Signaling.Str(vd, "hostNetVersion");
                            var mine = Signaling.Str(vd, "yourNetVersion");
                            _opVersions = theirs.Length > 0 ? (mine.Length > 0 ? mine : Config.NetVersion, theirs) : ((string, string)?)null;
                        }
                        FailOp(new OneLobbyException(err.Code, err.Message));
                        Error?.Invoke(err);
                        _lobby?.OnServerError(err, disconnected, e.TryGetProperty("data", out var edata) ? edata : default);
                        return;
                    }
                }
                if (_op != null && _op.Sent && Array.IndexOf(_op.Expect, t) >= 0)
                {
                    FinishOp(e.Clone());
                    return;
                }
                if (t == "lobby" && _lobby == null)
                {
                    _stashedLobby = e.Clone(); // a resume reply that beat the request
                    return;
                }
                _lobby?.OnSignalingMessage(t, e);
            }
        }

        public async ValueTask DisposeAsync()
        {
            try
            {
                if (_lobby != null) await _lobby.LeaveAsync().ConfigureAwait(false);
                Socket?.Dispose();
            }
            finally
            {
                // a direct host's hub (and its router mapping) goes even when leaving throws
                Socket = null;
                _owned?.Dispose();
                _owned = null;
            }
        }
    }
}
