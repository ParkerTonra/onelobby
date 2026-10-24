using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Keepalive
{
    /// <summary>
    /// Entry point: talks to keepalive-server over the transport's signaling socket and hands out <see cref="Lobby"/>s.
    /// Call <see cref="Pump"/> (or the lobby's) once per frame: that is when requests complete and events fire.
    /// </summary>
    /// <remarks>The async calls throw <see cref="KeepaliveException"/> (with a server error <c>Code</c> such as lobby_full, unknown_code, version_mismatch, timeout, server_closed).</remarks>
    public sealed class LobbyClient : IAsyncDisposable
    {
        private const long RequestTimeoutMs = 10_000;

        private sealed class Pending
        {
            public readonly TaskCompletionSource<JsonElement> Tcs = new();
            public string[] Expect = Array.Empty<string>();
            public long DeadlineMs;
            public CancellationTokenRegistration Reg;
        }

        internal KeepaliveConfig Config { get; }
        internal ITransport Transport { get; }
        internal IReadOnlyList<IceServer> Ice { get; private set; } = Array.Empty<IceServer>();
        internal ISignalingSocket? Socket { get; private set; }

        private Pending? _pending;
        private Lobby? _lobby;
        private bool _helloSent;
        private bool _welcomed;
        private string? _resumeToken;
        private long _lastPingMs;
        private int _pingN;
        private TaskCompletionSource<bool>? _welcomeTcs;

        public event Action<LobbyError>? Error;

        public LobbyClient(KeepaliveConfig config, ITransport transport)
        {
            Config = config ?? throw new ArgumentNullException(nameof(config));
            Transport = transport ?? throw new ArgumentNullException(nameof(transport));
        }

        public Task<Lobby> HostAsync(LobbyOptions options, CancellationToken ct = default) =>
            EnterAsync(null, Signaling.Create(Config, options), ct);

        public Task<Lobby> JoinAsync(string code, CancellationToken ct = default)
        {
            var norm = Crockford.Normalize(code);
            if (norm == null) return Task.FromException<Lobby>(new KeepaliveException("unknown_code", "not a valid join code"));
            return EnterAsync(null, Signaling.Join(norm), ct);
        }

        public Task<Lobby> RejoinAsync(string resumeToken, CancellationToken ct = default) =>
            EnterAsync(resumeToken, null, ct);

        public async Task<IReadOnlyList<LobbySummary>> ListAsync(IReadOnlyDictionary<string, string>? metaFilter = null,
            CancellationToken ct = default)
        {
            await EnsureHello(null, ct).ConfigureAwait(false);
            var reply = await Request(Signaling.List(metaFilter), new[] { "lobbies" }, ct).ConfigureAwait(false);
            var items = new List<LobbySummary>();
            if (reply.TryGetProperty("items", out var arr) && arr.ValueKind == JsonValueKind.Array)
                foreach (var it in arr.EnumerateArray()) items.Add(Signaling.ParseSummary(it));
            return items;
        }

        private async Task<Lobby> EnterAsync(string? resume, string? request, CancellationToken ct)
        {
            if (_lobby != null) throw new InvalidOperationException("already in a lobby; leave it first");
            await EnsureHello(resume, ct).ConfigureAwait(false);
            JsonElement reply;
            if (request == null)
            {
                // rejoin: the server answers hello(resumeToken) with a lobby message right after welcome
                if (_stashedLobby is { } s) { reply = s; _stashedLobby = null; }
                else reply = await Request(null, new[] { "lobby" }, ct).ConfigureAwait(false);
            }
            else reply = await Request(request, new[] { "lobby" }, ct).ConfigureAwait(false);
            var msg = Signaling.ParseLobby(reply);
            _resumeToken = msg.ResumeToken;
            var lobby = new Lobby(this, msg);
            _lobby = lobby;
            lobby.Start();
            return lobby;
        }

        private JsonElement? _stashedLobby;

        private async Task EnsureHello(string? resumeToken, CancellationToken ct)
        {
            if (Socket == null || Socket.State == SocketState.Closed)
            {
                Socket?.Dispose();
                Socket = Transport.ConnectSignaling(Config.LobbyServer);
                _helloSent = false;
                _welcomed = false;
            }
            if (_welcomed) return;
            if (!_helloSent)
            {
                _welcomeTcs = new TaskCompletionSource<bool>();
                _helloSent = true;
                _helloPendingSince = Transport.NowMs;
                _helloResume = resumeToken;
                _helloSentWire = false;
            }
            using (ct.Register(() => _welcomeTcs?.TrySetCanceled()))
                await _welcomeTcs!.Task.ConfigureAwait(false);
        }

        private long _helloPendingSince;
        private string? _helloResume;
        private bool _helloSentWire;

        private Task<JsonElement> Request(string? json, string[] expect, CancellationToken ct)
        {
            if (_pending != null) throw new InvalidOperationException("another request is in flight");
            var p = new Pending { Expect = expect, DeadlineMs = Transport.NowMs + RequestTimeoutMs };
            if (ct.CanBeCanceled) p.Reg = ct.Register(() => p.Tcs.TrySetCanceled());
            _pending = p;
            if (json != null) Socket!.Send(json);
            return p.Tcs.Task;
        }

        internal void SendRaw(string json) { if (Socket != null && Socket.State == SocketState.Open) Socket.Send(json); }

        internal void LobbyClosed(Lobby l) { if (_lobby == l) _lobby = null; }

        internal void RaiseError(LobbyError e) => Error?.Invoke(e);

        /// <summary>Polls the transport and signaling socket. Needed only before a lobby exists (to complete HostAsync/JoinAsync/ListAsync); once you hold a <see cref="Lobby"/>, call <see cref="Lobby.Pump"/> instead, which does this too. Calling both is harmless.</summary>
        public void Pump()
        {
            Transport.Poll();
            var now = Transport.NowMs;
            var sock = Socket;
            if (sock != null)
            {
                if (sock.State == SocketState.Open && _helloSent && !_helloSentWire)
                {
                    _helloSentWire = true;
                    sock.Send(Signaling.Hello(Config, _helloResume));
                }
                while (sock.TryReceive(out var text)) Dispatch(text);
                if (sock.State == SocketState.Closed)
                {
                    if (_welcomeTcs != null && !_welcomed) { _welcomeTcs.TrySetException(new KeepaliveException("server_closed", sock.CloseReason ?? "closed")); _welcomeTcs = null; _helloSent = false; }
                    if (_pending != null) { var p = _pending; _pending = null; p.Reg.Dispose(); p.Tcs.TrySetException(new KeepaliveException("server_closed", sock.CloseReason ?? "closed")); }
                    _lobby?.OnSocketClosed();
                }
                else if (sock.State == SocketState.Open && _welcomed && now - _lastPingMs >= 10_000)
                {
                    _lastPingMs = now;
                    sock.Send(Signaling.Ping(++_pingN));
                }
            }
            if (_pending != null && now > _pending.DeadlineMs)
            {
                var p = _pending; _pending = null; p.Reg.Dispose();
                p.Tcs.TrySetException(new KeepaliveException("timeout", "no answer from the lobby server"));
            }
            if (_welcomeTcs != null && !_welcomed && _helloSent && now - _helloPendingSince > RequestTimeoutMs)
            {
                var t = _welcomeTcs; _welcomeTcs = null; _helloSent = false;
                t.TrySetException(new KeepaliveException("timeout", "no welcome from the lobby server"));
            }
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
                        _welcomeTcs?.TrySetResult(true);
                        _welcomeTcs = null;
                        return;
                    case "ping":
                        SendRaw(Signaling.Pong(Signaling.Int(e, "n")));
                        return;
                    case "pong":
                        return;
                    case "error":
                    {
                        var err = new LobbyError(Signaling.Str(e, "code"), Signaling.Str(e, "msg"));
                        if (_welcomeTcs != null && !_welcomed)
                        {
                            _welcomeTcs.TrySetException(new KeepaliveException(err.Code, err.Message));
                            _welcomeTcs = null; _helloSent = false;
                        }
                        else if (_pending != null)
                        {
                            var p = _pending; _pending = null; p.Reg.Dispose();
                            p.Tcs.TrySetException(new KeepaliveException(err.Code, err.Message));
                        }
                        Error?.Invoke(err);
                        _lobby?.OnServerError(err);
                        return;
                    }
                }
                if (_pending != null && Array.IndexOf(_pending.Expect, t) >= 0)
                {
                    var p = _pending; _pending = null; p.Reg.Dispose();
                    p.Tcs.TrySetResult(e.Clone());
                    return;
                }
                if (t == "lobby" && _lobby == null)
                {
                    _stashedLobby = e.Clone();
                    return;
                }
                _lobby?.OnSignalingMessage(t, e);
            }
        }

        public async ValueTask DisposeAsync()
        {
            if (_lobby != null) await _lobby.LeaveAsync().ConfigureAwait(false);
            Socket?.Dispose();
            Socket = null;
        }
    }
}
