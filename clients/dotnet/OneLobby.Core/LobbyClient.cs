using System;
using System.Collections.Generic;
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
            public string[] Expect = Array.Empty<string>();
            public Action<JsonElement> Complete = _ => { };
            public Action<Exception> Fail = _ => { };
            public bool Sent;
            public long DeadlineMs;
            public long ConnectDeadlineMs;
            public CancellationTokenRegistration Reg;
        }

        internal OneLobbyConfig Config { get; }
        internal ITransport Transport { get; private set; }
        private readonly ITransport _baseTransport;
        /// <summary>Where the hub is: the config's lobby server, or a direct-IP host (docs/direct-ip.md).</summary>
        private Uri _hubUri;
        /// <summary>Direct IP: the hub lives in the host, so the host leaving ends the session (no migration).</summary>
        internal bool Direct { get; private set; }
        /// <summary>Disposed when the lobby closes (a direct host's embedded hub and listener).</summary>
        private IDisposable? _owned;
        /// <summary>Direct-IP joiner: no WebSocket answer within this long means direct_unreachable (0 = off).</summary>
        internal const long DirectConnectTimeoutMs = 5000;

        /// <summary>The wait above for a Nostr joiner (spec/nostr-signaling.md s.4: the socket gives up itself after 15 s).</summary>
        internal long DirectConnectTimeout { get; set; } = DirectConnectTimeoutMs;
        internal IReadOnlyList<IceServer> Ice { get; private set; } = Array.Empty<IceServer>();
        internal ISignalingSocket? Socket { get; private set; }

        private Op? _op;
        private Lobby? _lobby;
        private bool _welcomed;
        private bool _helloWired;
        private string? _helloResume;
        private JsonElement? _stashedLobby;
        private long _lastPingMs;
        private int _pingN;

        public event Action<LobbyError>? Error;

        public LobbyClient(OneLobbyConfig config, ITransport transport)
        {
            Config = config ?? throw new ArgumentNullException(nameof(config));
            Transport = _baseTransport = transport ?? throw new ArgumentNullException(nameof(transport));
            _hubUri = config.LobbyServer;
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
        internal Task<Lobby> JoinSingleLobbyAsync(string? password, CancellationToken ct = default) =>
            Run(null, Signaling.JoinDirect(password), new[] { "lobby" }, EnterLobby, ct);

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

        public Task<Lobby> HostAsync(LobbyOptions options, CancellationToken ct = default) =>
            Run(null, Signaling.Create(Config, options), new[] { "lobby" }, e =>
            {
                var lobby = EnterLobby(e);
                lobby.RateLimit = options.RateLimit;
                return lobby;
            }, ct);

        public Task<Lobby> JoinAsync(string code, CancellationToken ct = default)
        {
            var norm = Crockford.Normalize(code);
            if (norm == null) return Task.FromException<Lobby>(new OneLobbyException("unknown_code", "not a valid join code"));
            return Run(null, Signaling.Join(norm), new[] { "lobby" }, EnterLobby, ct);
        }

        public Task<Lobby> RejoinAsync(string resumeToken, CancellationToken ct = default) =>
            Run(resumeToken, null, new[] { "lobby" }, EnterLobby, ct);

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

        private Lobby EnterLobby(JsonElement reply)
        {
            var lobby = new Lobby(this, Signaling.ParseLobby(reply));
            if (Blueprint != null) lobby.Voice.Mode = Blueprint.Chat.VoiceMode == "voiceActivity" ? VoiceMode.VoiceActivity : VoiceMode.PushToTalk;
            _lobby = lobby;
            lobby.Start();
            return lobby;
        }

        private Task<T> Run<T>(string? resume, string? request, string[] expect, Func<JsonElement, T> finish, CancellationToken ct)
        {
            if (_op != null) return Task.FromException<T>(new InvalidOperationException("another request is in flight"));
            if (!Direct && ReferenceEquals(Config.LobbyServer, OneLobby.Blueprint.NoServer))
                return Task.FromException<T>(new OneLobbyException(LobbyErrorCodes.NoServer,
                    "no lobby server address (set hosting.lobbyServer in onelobby.json or pass lobbyServerOverride; direct-only games use HostDirectAsync)"));
            if (_lobby != null && expect[0] == "lobby") return Task.FromException<T>(new InvalidOperationException("already in a lobby; leave it first"));
            var tcs = new TaskCompletionSource<T>();
            var op = new Op { Request = request, Expect = expect, DeadlineMs = Transport.NowMs + RequestTimeoutMs };
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
                Socket = Transport.ConnectSignaling(_hubUri);
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
            if (op.Request != null) Socket!.Send(op.Request);
            else if (_stashedLobby is { } s) { _stashedLobby = null; FinishOp(s); }
        }

        private void FinishOp(JsonElement e)
        {
            var op = _op!;
            _op = null;
            op.Reg.Dispose();
            op.Complete(e);
        }

        private void FailOp(Exception ex)
        {
            var op = _op;
            if (op == null) return;
            _op = null;
            op.Reg.Dispose();
            op.Fail(ex);
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
                    sock.Send(Signaling.Hello(Config, _helloResume));
                }
                while (sock.TryReceive(out var text)) Dispatch(text);
                if (Direct && _op != null && !_welcomed && (sock.State == SocketState.Closed
                    || (sock.State == SocketState.Connecting && _op.ConnectDeadlineMs > 0 && now > _op.ConnectDeadlineMs)))
                {
                    // docs/direct-ip.md s.3: no answer on the host's TCP port
                    FailOp(new OneLobbyException("direct_unreachable",
                        (_hubUri.Scheme == "onelobby-nostr" ? "no answer from the host over Nostr" : "no answer from the host at " + _hubUri.Host + ":" + _hubUri.Port) + " (" + (sock.CloseReason ?? "timed out") + ")"));
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
                        _welcomed = true;
                        // a resume answered without a seat: the token is unknown or expired (no lobby message follows)
                        if (_op != null && !_op.Sent && _op.Request == null && _helloResume != null && !e.TryGetProperty("peerId", out _))
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
                        FailOp(new OneLobbyException(err.Code, err.Message));
                        Error?.Invoke(err);
                        _lobby?.OnServerError(err, disconnected);
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
