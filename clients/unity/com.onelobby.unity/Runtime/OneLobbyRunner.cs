#nullable enable
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEngine;

namespace OneLobby.Unity
{
    /// <summary>
    /// Owns one <see cref="LobbyClient"/> on a <see cref="UnityTransport"/> and pumps it every frame from <c>Update</c>, so
    /// every OneLobby event fires on the main thread. Add it to a GameObject (it survives scene loads), set the fields
    /// (the lobby server is a setting, AGENTS.md rule 5) and call <see cref="HostAsync"/> / <see cref="JoinAsync"/>.
    /// All game logic stays in OneLobby.Core: this class is plumbing only.
    /// </summary>
    [DefaultExecutionOrder(-100)] // pump before game scripts read this frame's messages
    public sealed class OneLobbyRunner : MonoBehaviour
    {
        [Tooltip("WebSocket endpoint of the lobby server, ending in /ws. Command line: --lobby-server=ws://127.0.0.1:8080/ws")]
        public string LobbyServer = "ws://127.0.0.1:8080/ws";
        public string GameId = "com.you.yourgame";
        [Tooltip("Bump whenever your message bytes or rules change; peers with a different NetVersion cannot meet.")]
        public string NetVersion = "1";
        public SyncMode Mode = SyncMode.Raw;
        public string DisplayName = "Player";
        public bool KeepAcrossScenes = true;

        private LobbyClient? _client;

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

        public async Task<Lobby> HostAsync(LobbyOptions options) => Adopt(await Client.HostAsync(options));
        public async Task<Lobby> JoinAsync(string code) => Adopt(await Client.JoinAsync(code));
        public async Task<Lobby> RejoinAsync(string resumeToken) => Adopt(await Client.RejoinAsync(resumeToken));
        public Task<IReadOnlyList<LobbySummary>> ListAsync() => Client.ListAsync();

        private Lobby Adopt(Lobby lobby)
        {
            Lobby = lobby;
            lobby.SessionEnded += _ =>
            {
                if (Lobby != lobby) return;
                Lobby = null;
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
            await l.LeaveAsync();
            LobbyChanged?.Invoke(null);
        }

        private void OnDestroy()
        {
            var c = _client;
            _client = null;
            Lobby = null;
            if (c != null) _ = c.DisposeAsync().AsTask();
        }
    }
}
