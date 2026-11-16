#nullable enable
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using OneLobby.Direct;
using UnityEngine;

namespace OneLobby.Unity
{
    /// <summary>
    /// Owns one <see cref="LobbyClient"/> on a <see cref="UnityTransport"/> and pumps it every frame from <c>Update</c>, so
    /// every OneLobby event fires on the main thread. Add it to a GameObject (it survives scene loads), set the fields
    /// (the lobby server is a setting, AGENTS.md rule 5) and call <see cref="HostAsync"/> / <see cref="JoinAsync"/>.
    /// For play over the internet with no lobby server, <see cref="HostDirectAsync"/> / <see cref="JoinDirectAsync"/> make
    /// the host's game the server (join code, port 47810; docs/recipes/direct-ip.md). All game logic stays in
    /// OneLobby.Core: this class is plumbing only.
    /// </summary>
    [DefaultExecutionOrder(-100)] // pump before game scripts read this frame's messages
    public sealed class OneLobbyRunner : MonoBehaviour
    {
        [Tooltip("WebSocket endpoint of the lobby server, ending in /ws (unused by HostDirectAsync / JoinDirectAsync). " +
                 "Command line: --lobby-server=ws://127.0.0.1:8080/ws")]
        public string LobbyServer = DefaultLobbyServer;
        private const string DefaultLobbyServer = "ws://127.0.0.1:8080/ws";
        [Tooltip("Optional onelobby.json (the blueprint, docs/design/blueprint.md). When set it supplies GameId, NetVersion, sync mode, " +
                 "timeouts, lobby defaults and the enforcement rules; those fields above are ignored. DisplayName still applies, and a " +
                 "LobbyServer you changed from its default (or --lobby-server=) overrides the file's hosting.lobbyServer.")]
        public TextAsset? Blueprint;
        public string GameId = "com.you.yourgame";
        [Tooltip("Bump whenever your message bytes or rules change; peers with a different NetVersion cannot meet.")]
        public string NetVersion = "1";
        public SyncMode Mode = SyncMode.Raw;
        public string DisplayName = "Player";
        public bool KeepAcrossScenes = true;
        [Tooltip("While hosting or joining, force Application.runInBackground = true so an unfocused window keeps pumping " +
                 "(otherwise the handshake stalls and the joiner waits at ReadyAsync). The previous value is restored when the lobby ends.")]
        public bool KeepRunningInBackground = true;
        [Tooltip("Automated tests only: listen on this one local IPv4 address (127.0.0.1) instead of every interface, so a test " +
                 "build never trips the Windows firewall prompt. Peers on other machines cannot reach it. Empty = every interface " +
                 "(real play). Covers the direct host's TCP + UDP listener and the WebRTC sockets of every lobby. Set before the " +
                 "first Host/Join. Command line: --bind-address=127.0.0.1")]
        public string BindAddress = "";
        [Tooltip("Send and accept only relay (TURN) candidates: hides each player's IP and proves a TURN entry works (pair with " +
                 "JoinDirectOptions.IceServers / DirectHostOptions.IceServers). Same as OneLobbyConfig.RelayOnly; with a Blueprint, " +
                 "this ORs with its hosting.relayOnly. Set before the first Host/Join.")]
        public bool RelayOnly;
        [Tooltip("File that keeps this install's player id for the game (a random id made once; not an account or a hardware id; " +
                 "spec/room.md). Empty = onelobby-player.json under Application.persistentDataPath. It lets a host keep your seat and " +
                 "refuse a banned player. Set before the first Host/Join.")]
        public string PlayerIdFile = "";
        [Tooltip("File that keeps the host's ban list across lobbies and runs (Lobby.Room.Bans). Empty = onelobby-bans.json under " +
                 "Application.persistentDataPath. Set before the first Host/Join.")]
        public string BanFile = "";
        [Tooltip("Where the connection log (why a connection failed) is saved: when the game quits, when it crashes, and on LobbyClient.NetLog.Save(). " +
                 "Empty = onelobby-netlog.txt under Application.persistentDataPath. The log stays on this machine, addresses masked. Set before the first Host/Join.")]
        public string NetLogPath = "";
        [Tooltip("When a join fails, tell the host why (cause and step only: no address, no name, no free text) over the lobby connection already in use. " +
                 "Same as DiagnosticsOptions.ReportToHost. Set before the first Host/Join.")]
        public bool ReportToHost = true;

        private LobbyClient? _client;
        private bool _clientIsDirect;
        private bool _holdingBackground;
        private bool _previousRunInBackground;
        private static bool _loggedBackground;

        public UnityTransport Transport { get; } = new UnityTransport();
        /// <summary>The current lobby, or null. Cleared when the session ends.</summary>
        public Lobby? Lobby { get; private set; }
        public LobbyClient Client => _client ??= CreateClient();
        /// <summary>Raised with each server error (wrong version, lobby full, ...), on the main thread.</summary>
        public event Action<LobbyError>? Error;
        /// <summary>Raised when <see cref="Lobby"/> changes (a lobby was hosted/joined, or the session ended).</summary>
        public event Action<Lobby?>? LobbyChanged;
        /// <summary>Host: a joiner could not connect and told you why (<see cref="PeerDiagnosisInfo.Line"/> is one line for a host screen), on the main thread.</summary>
        public event Action<PeerDiagnosisInfo>? PeerDiagnosis;
        /// <summary>The connection log of the current client: <c>NetLog.Export()</c> is the text a player copies.</summary>
        public NetLog NetLog => Client.NetLog;
        /// <summary>Checks what this network allows (UDP, NAT type, relay login) from a menu; never runs by itself. See <see cref="LobbyClient.CheckConnectionAsync"/>.</summary>
        public Task<CheckResult> CheckConnectionAsync(CheckOptions? options = null) => Client.CheckConnectionAsync(options);

        /// <summary>Extra config applied when the client is created (for OneLobbyConfig fields not exposed above).</summary>
        public Func<OneLobbyConfig, OneLobbyConfig>? ConfigureConfig;

        /// <summary>
        /// Dev builds: make the network worse on purpose (<see cref="NetSimTransport"/>). Set before the first Host/Join,
        /// or pass <c>--fakelag=ms --fakejitter=ms --fakeloss=percent</c> on the command line. Change it while running with
        /// <see cref="Sim"/>.<c>Options</c>.
        /// </summary>
        public NetSimOptions? NetSim;
        /// <summary>The bad-network wrapper when <see cref="NetSim"/> is on, else null.</summary>
        public NetSimTransport? Sim { get; private set; }

        private void Awake()
        {
            if (KeepAcrossScenes) DontDestroyOnLoad(gameObject);
            foreach (var arg in Environment.GetCommandLineArgs())
            {
                if (arg.StartsWith("--lobby-server=", StringComparison.Ordinal)) LobbyServer = arg.Substring("--lobby-server=".Length);
                else if (arg.StartsWith("--bind-address=", StringComparison.Ordinal)) BindAddress = arg.Substring("--bind-address=".Length);
                else if (FlagMs(arg, "--fakelag=", out var v)) NetSim = (NetSim ?? new NetSimOptions()) with { LatencyMs = v };
                else if (FlagMs(arg, "--fakejitter=", out v)) NetSim = (NetSim ?? new NetSimOptions()) with { JitterMs = v };
                else if (FlagMs(arg, "--fakeloss=", out v)) NetSim = (NetSim ?? new NetSimOptions()) with { LossPercent = v };
            }
        }

        private static bool FlagMs(string arg, string name, out double value)
        {
            value = 0;
            return arg.StartsWith(name, StringComparison.Ordinal) && double.TryParse(arg.Substring(name.Length),
                System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out value);
        }

        private OneLobbyConfig ApplyConfig(OneLobbyConfig config)
        {
            if (RelayOnly) config = config with { RelayOnly = true };
            config = config with
            {
                Diagnostics = config.Diagnostics with
                {
                    LogPath = config.Diagnostics.LogPath ?? (string.IsNullOrWhiteSpace(NetLogPath) ? System.IO.Path.Combine(Application.persistentDataPath, "onelobby-netlog.txt") : NetLogPath),
                    ReportToHost = config.Diagnostics.ReportToHost && ReportToHost,
                },
            };
            if (config.PlayerIdStore == null && config.PlayerIdFile == null)
                config = config with { PlayerIdFile = string.IsNullOrWhiteSpace(PlayerIdFile) ? System.IO.Path.Combine(Application.persistentDataPath, "onelobby-player.json") : PlayerIdFile };
            if (config.BanStore == null && config.BanFile == null)
                config = config with { BanFile = string.IsNullOrWhiteSpace(BanFile) ? System.IO.Path.Combine(Application.persistentDataPath, "onelobby-bans.json") : BanFile };
            return ConfigureConfig != null ? ConfigureConfig(config) : config;
        }

        private LobbyClient CreateClient()
        {
            OneLobbyConfig config = null!;
            OneLobby.Blueprint? bp = null;
            if (Blueprint != null)
            {
                bp = OneLobby.Blueprint.Parse(Blueprint.text);
                KeepRunningInBackground = bp.Session.RunInBackground;
            }
            else
            {
                config = new OneLobbyConfig(GameId, NetVersion, new Uri(LobbyServer), Mode, DisplayName: DisplayName);
                config = ApplyConfig(config);
            }
            var bind = Bind();
            Transport.BindAddress = bind?.ToString();
            if (bind != null) Debug.Log("OneLobby: bound to " + bind + " only (BindAddress); other machines cannot connect");
            ITransport transport = Transport;
            if (NetSim != null)
            {
                transport = Sim = new NetSimTransport(Transport, NetSim);
                // one line so a --fakelag run can be confirmed from the player log
                Debug.Log(FormattableString.Invariant($"OneLobby: NetSim on: latency {NetSim.LatencyMs} ms, jitter {NetSim.JitterMs} ms, Fast loss {NetSim.LossPercent}%"));
            }
            var c = bp != null
                ? LobbyClient.FromBlueprint(bp, transport, DisplayName,
                    string.IsNullOrEmpty(LobbyServer) || LobbyServer == DefaultLobbyServer ? null : LobbyServer, ApplyConfig)
                : new LobbyClient(config, transport);
            c.Error += e => Error?.Invoke(e);
            return c;
        }

        private void Update()
        {
            if (Lobby != null) Lobby.Pump();
            else _client?.Pump();
        }

        public Task<Lobby> HostAsync(LobbyOptions options) => Enter(() => ServerClient().HostAsync(options));
        /// <summary>Host a lobby with the lobby.* settings of the <see cref="Blueprint"/> file.</summary>
        public Task<Lobby> HostAsync() => Enter(() => ServerClient().HostAsync());
        public Task<Lobby> JoinAsync(string code) => Enter(() => ServerClient().JoinAsync(code));
        /// <summary>Join with a lobby password, as a spectator and/or with your starting per-player data (<c>lobby.Room</c>, docs/recipes/room.md).</summary>
        public Task<Lobby> JoinAsync(string code, RoomJoinOptions room) => Enter(() => ServerClient().JoinAsync(code, room));
        public Task<Lobby> RejoinAsync(string resumeToken) => Enter(() => ServerClient().RejoinAsync(resumeToken));
        public Task<IReadOnlyList<LobbySummary>> ListAsync() => ServerClient().ListAsync();

        /// <summary>
        /// Host with no lobby server: this game runs the signaling hub and listens on TCP + UDP 47810 (or
        /// <see cref="DirectHostOptions.Port"/>), asks the router to open that port, and the lobby's
        /// <see cref="Lobby.JoinCode"/> (e.g. <c>6B01-RGFE-P2B</c>) is what friends paste. Check <see cref="Lobby.JoinCodeKind"/>:
        /// <c>SameNetwork</c> means the router said no and the code only works on this network. Leaving ends the session for
        /// everyone (no host migration). Windows desktop asks the player to allow the game through the firewall once.
        /// </summary>
        public async Task<Lobby> HostDirectAsync(DirectHostOptions? options = null)
        {
            var bind = Bind();
            if (bind != null && options == null)
            {
                // same options the no-argument call would pick; a blueprint with hosting.direct false keeps its bad_config error
                var bp = DirectClient().Blueprint;
                if (bp == null) options = new DirectHostOptions();
                else if (bp.Hosting.Direct) options = bp.ToDirectHostOptions(null, DisplayName);
            }
            if (bind != null && options != null && options.BindAddress == null) options.BindAddress = bind;
            var lobby = await Enter(() => options == null ? DirectClient().HostDirectAsync() : DirectClient().HostDirectAsync(options));
            Debug.Log(DirectLobby.HostLogLine(lobby)); // bound port (after any busy-port fallback), code, router mapping
            lobby.JoinCodeChanged += (_, _) => Debug.Log(DirectLobby.HostLogLine(lobby)); // the router answered a later retry
            return lobby;
        }

        /// <summary>Join a direct host by its join code (<c>6B01-RGFE-P2B</c>) or address (<c>192.168.1.20</c>, <c>ip:port</c>).</summary>
        public Task<Lobby> JoinDirectAsync(string codeOrAddress, string? password = null) =>
            JoinDirectAsync(codeOrAddress, new JoinDirectOptions { Password = password });

        /// <summary>
        /// As above, with <see cref="JoinDirectOptions"/>: the password, Nostr relays and STUN servers for a version 1 code, and
        /// extra ICE servers (a TURN entry the player pasted: <see cref="JoinDirectOptions.IceServers"/>, with
        /// <see cref="IceServer.RelayOnly"/> to force the relay) for a joiner behind a strict NAT. Goes through the same adopt path
        /// (<see cref="LobbyChanged"/>, background hold) as every other join here.
        /// </summary>
        public Task<Lobby> JoinDirectAsync(string codeOrAddress, JoinDirectOptions options)
        {
            if (options == null) throw new ArgumentNullException(nameof(options));
            return Enter(() => DirectClient().JoinDirectAsync(codeOrAddress, options));
        }

        /// <summary>
        /// Take a direct seat back after a drop or a restart (the host keeps it 60 s): the code joined before and the
        /// lobby's <see cref="Lobby.ResumeToken"/> (save it after every join; it changes on each resume). Fails with
        /// <see cref="LobbyErrorCodes.InvalidToken"/> when the seat is gone: offer <see cref="JoinDirectAsync"/> then.
        /// </summary>
        public Task<Lobby> RejoinDirectAsync(string codeOrAddress, string resumeToken) =>
            Enter(() => DirectClient().RejoinDirectAsync(codeOrAddress, resumeToken));

        /// <summary>As above, with <see cref="JoinDirectOptions"/> (Nostr relays, extra ICE servers such as a TURN relay; its Password is not used).</summary>
        public Task<Lobby> RejoinDirectAsync(string codeOrAddress, string resumeToken, JoinDirectOptions options)
        {
            if (options == null) throw new ArgumentNullException(nameof(options));
            return Enter(() => DirectClient().RejoinDirectAsync(codeOrAddress, resumeToken, options));
        }

        /// <summary>A direct session leaves the client pointed at a direct hub, so going back to a lobby server gets a fresh one.</summary>
        private LobbyClient ServerClient()
        {
            if (_clientIsDirect) DropClient();
            return Client;
        }

        /// <summary><see cref="BindAddress"/> parsed; null when empty. A typo throws rather than silently listening everywhere.</summary>
        private System.Net.IPAddress? Bind()
        {
            if (string.IsNullOrWhiteSpace(BindAddress)) return null;
            if (System.Net.IPAddress.TryParse(BindAddress.Trim(), out var a) && a.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork) return a;
            throw new ArgumentException("OneLobbyRunner.BindAddress must be an IPv4 address such as 127.0.0.1, got '" + BindAddress + "'");
        }

        private LobbyClient DirectClient()
        {
            _clientIsDirect = true;
            return Client;
        }

        private void DropClient(bool wait = false)
        {
            var c = _client;
            _client = null;
            _clientIsDirect = false;
            if (c == null) return;
            var t = c.DisposeAsync().AsTask();
            // On quit the process exits right after OnDestroy: give a direct host's router mapping delete time to go out
            // (PortMapper bounds it to about two seconds; DisposeAsync never needs the main thread, so this cannot deadlock).
            if (wait)
            {
                try { t.Wait(TimeSpan.FromSeconds(3)); }
                catch (Exception e) { Debug.LogWarning("OneLobby: leaving on quit failed: " + e.Message); }
            }
        }

        /// <summary>Runs a Host/Join call with the background hold on from the start; drops the hold if the call fails.</summary>
        private async Task<Lobby> Enter(Func<Task<Lobby>> start)
        {
            HoldBackground();
            try { return Adopt(await start()); }
            catch
            {
                if (Lobby == null) ReleaseBackground();
                throw;
            }
        }

        /// <summary>
        /// Unity's default runInBackground = false stops Update in an unfocused player, so nothing pumps the lobby: the
        /// host stops relaying the handshake and a joiner never gets ready. Keep running while a lobby is held.
        /// </summary>
        private void HoldBackground()
        {
            if (!KeepRunningInBackground || _holdingBackground) return;
            _holdingBackground = true;
            _previousRunInBackground = Application.runInBackground;
            if (_previousRunInBackground) return;
            Application.runInBackground = true;
            if (_loggedBackground) return;
            _loggedBackground = true;
            Debug.Log("OneLobby: set Application.runInBackground = true while in a lobby, so an unfocused window keeps the " +
                      "connection alive (restored when the lobby ends; turn off OneLobbyRunner.KeepRunningInBackground to opt out).");
        }

        private void ReleaseBackground()
        {
            if (!_holdingBackground) return;
            _holdingBackground = false;
            Application.runInBackground = _previousRunInBackground;
        }

        private Lobby Adopt(Lobby lobby)
        {
            Lobby = lobby;
            lobby.PeerDiagnosis += d => PeerDiagnosis?.Invoke(d);
            lobby.SessionEnded += _ =>
            {
                if (Lobby != lobby) return;
                Lobby = null;
                ReleaseBackground();
                LobbyChanged?.Invoke(null);
            };
            LobbyChanged?.Invoke(lobby);
            return lobby;
        }

        /// <summary>Leave the current lobby (no-op without one). The client stays usable for a new Host/Join.</summary>
        public async Task LeaveAsync()
        {
            var l = Lobby;
            if (l == null) return;
            Lobby = null;
            try
            {
                await l.LeaveAsync();
            }
            finally
            {
                // even when leaving throws (socket already dead), the game is solo again
                ReleaseBackground();
                LobbyChanged?.Invoke(null);
            }
        }

        private void OnDestroy()
        {
            Lobby = null;
            ReleaseBackground();
            DropClient(wait: true);
        }
    }
}
