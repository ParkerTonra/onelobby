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
        public string LobbyServer = "ws://127.0.0.1:8080/ws";
        public string GameId = "com.you.yourgame";
        [Tooltip("Bump whenever your message bytes or rules change; peers with a different NetVersion cannot meet.")]
        public string NetVersion = "1";
        public SyncMode Mode = SyncMode.Raw;
        public string DisplayName = "Player";
        public bool KeepAcrossScenes = true;
        [Tooltip("While hosting or joining, force Application.runInBackground = true so an unfocused window keeps pumping " +
                 "(otherwise the handshake stalls and the joiner waits at ReadyAsync). The previous value is restored when the lobby ends.")]
        public bool KeepRunningInBackground = true;

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

        /// <summary>Extra config applied when the client is created (for OneLobbyConfig fields not exposed above).</summary>
        public Func<OneLobbyConfig, OneLobbyConfig>? ConfigureConfig;

        private void Awake()
        {
            if (KeepAcrossScenes) DontDestroyOnLoad(gameObject);
            foreach (var arg in Environment.GetCommandLineArgs())
                if (arg.StartsWith("--lobby-server=", StringComparison.Ordinal)) LobbyServer = arg.Substring("--lobby-server=".Length);
        }

        private LobbyClient CreateClient()
        {
            var config = new OneLobbyConfig(GameId, NetVersion, new Uri(LobbyServer), Mode, DisplayName: DisplayName);
            if (ConfigureConfig != null) config = ConfigureConfig(config);
            var c = new LobbyClient(config, Transport);
            c.Error += e => Error?.Invoke(e);
            return c;
        }

        private void Update()
        {
            if (Lobby != null) Lobby.Pump();
            else _client?.Pump();
        }

        public Task<Lobby> HostAsync(LobbyOptions options) => Enter(() => ServerClient().HostAsync(options));
        public Task<Lobby> JoinAsync(string code) => Enter(() => ServerClient().JoinAsync(code));
        public Task<Lobby> RejoinAsync(string resumeToken) => Enter(() => ServerClient().RejoinAsync(resumeToken));
        public Task<IReadOnlyList<LobbySummary>> ListAsync() => ServerClient().ListAsync();

        /// <summary>
        /// Host with no lobby server: this game runs the signaling hub and listens on TCP + UDP 47810 (or
        /// <see cref="DirectHostOptions.Port"/>), asks the router to open that port, and the lobby's
        /// <see cref="Lobby.JoinCode"/> (e.g. <c>6B01-RGFE-P2B</c>) is what friends paste. Check <see cref="Lobby.JoinCodeKind"/>:
        /// <c>SameNetwork</c> means the router said no and the code only works on this network. Leaving ends the session for
        /// everyone (no host migration). Windows desktop asks the player to allow the game through the firewall once.
        /// </summary>
        public Task<Lobby> HostDirectAsync(DirectHostOptions? options = null) => Enter(() => DirectClient().HostDirectAsync(options));

        /// <summary>Join a direct host by its join code (<c>6B01-RGFE-P2B</c>) or address (<c>192.168.1.20</c>, <c>ip:port</c>).</summary>
        public Task<Lobby> JoinDirectAsync(string codeOrAddress, string? password = null) =>
            Enter(() => DirectClient().JoinDirectAsync(codeOrAddress, password));

        /// <summary>A direct session leaves the client pointed at a direct hub, so going back to a lobby server gets a fresh one.</summary>
        private LobbyClient ServerClient()
        {
            if (_clientIsDirect) DropClient();
            return Client;
        }

        private LobbyClient DirectClient()
        {
            _clientIsDirect = true;
            return Client;
        }

        private void DropClient()
        {
            var c = _client;
            _client = null;
            _clientIsDirect = false;
            if (c != null) _ = c.DisposeAsync().AsTask();
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
            DropClient();
        }
    }
}
