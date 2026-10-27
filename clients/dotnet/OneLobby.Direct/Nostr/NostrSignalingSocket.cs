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
    /// The joiner's signaling socket over Nostr relays (spec/nostr-signaling.md): the same <see cref="ISignalingSocket"/> the
    /// direct joiner uses over TCP. <c>Connecting</c> until the host answers an <c>open</c>; hub texts then travel in
    /// reliable ordered <c>data</c> frames. Work happens on a small timer thread; texts for the game wait in a queue that
    /// <see cref="TryReceive"/> drains on the pumping thread.
    /// </summary>
    internal sealed class NostrSignalingSocket : ISignalingSocket
    {
        public const int OpenEveryMs = 2000;
        public const int GiveUpMs = 15_000;
        public const int NoRelayMs = 10_000;

        private readonly object _gate = new object();
        private readonly NostrChannel _channel;
        private readonly NostrLink _link;
        private readonly Func<long> _now;
        private readonly ConcurrentQueue<string> _inbox = new ConcurrentQueue<string>();
        private readonly Timer? _timer;
        private readonly long _startedAt;
        private long _lastOpen;
        private bool _opened;
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
            _link = new NostrLink(_now, f => _channel.Publish(f));
            _link.Message += m => _inbox.Enqueue(m);
            _link.Ended += (reason, local) => EndLocked(reason);
            _startedAt = _now();
            _channel.Start();
            if (options.AutoTick) _timer = new Timer(_ => Tick(), null, 10, 10);
        }

        public void Send(string text)
        {
            lock (_gate)
            {
                if (State == SocketState.Closed) return;
                if (IsPing(text, out var n)) { _inbox.Enqueue("{\"t\":\"pong\",\"n\":" + n + "}"); return; } // never crosses Nostr
                _link.Queue(text);
            }
        }

        private static bool IsPing(string text, out long n)
        {
            n = 0;
            if (text.IndexOf("\"ping\"", StringComparison.Ordinal) < 0 || text.Length > 200) return false;
            try
            {
                using var doc = JsonDocument.Parse(text);
                var e = doc.RootElement;
                return e.TryGetProperty("t", out var t) && t.GetString() == "ping" && e.TryGetProperty("n", out var nn) && nn.TryGetInt64(out n);
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
                while (_channel.TryTake(out var f)) Handle(f);
                if (State == SocketState.Closed) return;
                var now = _now();
                if (State == SocketState.Connecting)
                {
                    var elapsed = now - _startedAt;
                    if (elapsed >= GiveUpMs || (elapsed >= NoRelayMs && _channel.Relays.Connected == 0)) { EndLocked("connect_failed"); return; }
                    if (_channel.Relays.Connected > 0 && (!_opened || now - _lastOpen >= OpenEveryMs))
                    {
                        _lastOpen = now;
                        _opened = true;
                        _channel.Publish(new NostrFrame { Type = "open", To = "" });
                    }
                }
                _link.Tick();
            }
            finally { Monitor.Exit(_gate); }
        }

        private void Handle(NostrFrame f)
        {
            if (State == SocketState.Connecting)
            {
                if (f.Type != "open" || f.To != _channel.Pubkey) return;
                _link.Peer = f.From;
                _state = (int)SocketState.Open;
                return;
            }
            if (f.From != _link.Peer || f.To != _channel.Pubkey) return;
            _link.Receive(f);
        }

        private void EndLocked(string reason)
        {
            if (State == SocketState.Closed) return;
            _closeReason = reason;
            _state = (int)SocketState.Closed;
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
                    _link.Close("closed locally");
                    EndLocked("closed locally");
                }
            }
        }
    }
}
