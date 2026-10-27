#nullable enable
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace OneLobby.Direct.Nostr
{
    /// <summary>
    /// The joiner's signaling socket over Nostr relays (spec/nostr-signaling.md), the counterpart of the JS
    /// <c>NostrSocket</c>: the same <see cref="ISignalingSocket"/> the direct joiner uses over TCP. <c>Connecting</c> until the
    /// host answers an <c>open</c>; hub texts then travel in reliable ordered <c>data</c> frames. Work happens on a small
    /// timer thread; texts for the game wait in a queue that <see cref="TryReceive"/> drains on the pumping thread. A failed
    /// connect ends with <see cref="CloseReason"/> <see cref="NoRelayReason"/> or <see cref="NoHostReason"/>.
    /// </summary>
    internal sealed class NostrSignalingSocket : ISignalingSocket
    {
        public const int OpenEveryMs = NostrLimits.OpenEveryMs;
        /// <summary>The host's first <c>open</c> did not arrive within this long (counted from the start).</summary>
        public const int GiveUpMs = NostrLimits.GiveUpMs;
        /// <summary>No relay connected within this long.</summary>
        public const int NoRelayMs = NostrLimits.JoinerFirstRelayMs;
        public const string NoRelayReason = "no Nostr relay reachable";
        public const string NoHostReason = "the host did not answer through the Nostr relays";

        private readonly object _gate = new object();
        private readonly NostrChannel _channel;
        private readonly Func<long> _now;
        private readonly ConcurrentQueue<string> _inbox = new ConcurrentQueue<string>();
        private readonly Timer? _timer;
        private readonly long _startedAt;
        private NostrLink? _link;
        private long _lastOpen;
        private bool _opened;
        private int _relaysSeen;
        private bool _everUp;
        private volatile int _state = (int)SocketState.Connecting;
        private volatile string? _closeReason;
        private bool _disposed;

        public SocketState State => (SocketState)_state;
        public string? CloseReason => _closeReason;
        /// <summary>This side's pubkey (a fresh key pair per socket).</summary>
        public string Pubkey => _channel.Pubkey;
        internal INostrRelays Relays => _channel.Relays;

        public NostrSignalingSocket(string normalizedCode, NostrOptions options)
        {
            var keys = NostrRoomKeys.Derive(normalizedCode);
            var relays = options.RelayFactory != null ? options.RelayFactory(keys.Topic) : new WebSocketRelays(options.EffectiveRelays, keys.Topic, options.UnixSeconds);
            var sw = Stopwatch.StartNew();
            _now = options.NowMs ?? (() => sw.ElapsedMilliseconds);
            _channel = new NostrChannel(relays, keys, options.UnixSeconds ?? (() => DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
            _startedAt = _now();
            _channel.Start();
            if (options.AutoTick) _timer = new Timer(_ => Tick(), null, 10, 10);
        }

        public void Send(string text)
        {
            lock (_gate)
            {
                if (State != SocketState.Open || _link == null) return;
                // The keep-alive ping never crosses Nostr: answer it here (spec s.4)
                if (text.Length < 64 && text.StartsWith("{\"t\":\"ping\"", StringComparison.Ordinal) && TryPong(text, out var pong)) { _inbox.Enqueue(pong); return; }
                _link.Queue(text);
            }
        }

        private static bool TryPong(string text, out string pong)
        {
            pong = "";
            try
            {
                using var doc = JsonDocument.Parse(text);
                var e = doc.RootElement;
                if (e.ValueKind != JsonValueKind.Object) return false;
                pong = e.TryGetProperty("n", out var n) ? "{\"t\":\"pong\",\"n\":" + n.GetRawText() + "}" : "{\"t\":\"pong\"}";
                return true;
            }
            catch (JsonException) { return false; }
        }

        public bool TryReceive(out string text)
        {
            if (_inbox.TryDequeue(out var t)) { text = t; return true; }
            text = "";
            return false;
        }

        /// <summary>Runs the socket's work once. The timer does this by itself unless <c>AutoTick</c> is off (tests).</summary>
        public void Tick()
        {
            if (!Monitor.TryEnter(_gate)) return;
            try
            {
                if (State == SocketState.Closed) return;
                while (_channel.TryTake(out var f)) { Handle(f); if (State == SocketState.Closed) return; }
                var now = _now();
                if (State == SocketState.Connecting)
                {
                    var elapsed = now - _startedAt;
                    if (_channel.Relays.Connected > 0) _everUp = true;
                    if (elapsed >= GiveUpMs) { Fail(NoHostReason); return; }
                    if (!_everUp && elapsed >= NoRelayMs) { Fail(NoRelayReason); return; }
                    // a relay that comes up after the first open gets one at once, not at the next resend (spec s.4)
                    var up = _channel.Relays.Connected;
                    var moreRelays = up > _relaysSeen;
                    _relaysSeen = up;
                    if (_everUp && (!_opened || moreRelays || now - _lastOpen >= OpenEveryMs))
                    {
                        _lastOpen = now;
                        _opened = true;
                        _channel.Publish(new NostrFrame { Type = "open", To = "", Seq = 0, Ack = 0 });
                    }
                }
                else _link?.Tick();
            }
            finally { Monitor.Exit(_gate); }
        }

        private void Handle(NostrFrame f)
        {
            if (State == SocketState.Closed || f.To != _channel.Pubkey) return;
            if (State == SocketState.Connecting)
            {
                if (f.Type != "open") return;
                var link = new NostrLink(_now, f.From, fr => _channel.Publish(fr));
                link.Message += m => _inbox.Enqueue(m);
                link.PeerClosed += reason => Finish(reason.Length > 0 ? reason : "closed");
                link.Dead += reason => Finish(reason);
                _link = link;
                _state = (int)SocketState.Open;
                return;
            }
            if (f.From != _link!.Peer) return;
            if (f.Type == "open") { _link.Heard(); return; }
            _link.Receive(f);
        }

        private void Fail(string why) => Finish(why);

        private void Finish(string reason)
        {
            if (State == SocketState.Closed) return;
            _closeReason = reason;
            _state = (int)SocketState.Closed;
            _link?.Stop();
            _timer?.Dispose();
            var relays = _channel.Relays;
            Task.Delay(500).ContinueWith(_ => relays.Dispose()); // let a close frame leave
        }

        public void Dispose()
        {
            lock (_gate)
            {
                if (_disposed) return;
                _disposed = true;
                if (State != SocketState.Closed)
                {
                    if (State == SocketState.Open) _link?.Close("");
                    Finish("closed locally");
                }
            }
        }
    }
}
