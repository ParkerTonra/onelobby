#nullable enable
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using OneLobby.Server;

namespace OneLobby.Direct.Nostr
{
    /// <summary>
    /// The host's side of the Nostr signaling (spec/nostr-signaling.md), the counterpart of the JS <c>NostrHostBridge</c>:
    /// answers a joiner's <c>open</c>, connects a hub <see cref="Session"/> for it with address <c>nostr:&lt;16 hex&gt;</c> and
    /// carries the hub's texts both ways in reliable frames. The hub (single-locked, called from any thread) is never called
    /// while the bridge holds its own lock: hub texts bound for a joiner are queued by the hub's callbacks and moved into the
    /// link on the next tick, and texts for the hub are collected under the lock and handed over after it.
    /// </summary>
    internal sealed class NostrHostBridge : IDisposable
    {
        /// <summary>A pubkey that closed is ignored for the rest of the session; this many are remembered.</summary>
        public const int ClosedMemory = 512;
        private const string Ping = "{\"t\":\"ping\",\"n\":0}";
        private const string PongPrefix = "{\"t\":\"pong\"";

        private sealed class Peer
        {
            public string Pub = "";
            public NostrLink Link = null!;
            public Session? Session;
            public readonly ConcurrentQueue<string> FromHub = new ConcurrentQueue<string>();
            public volatile bool HubClosed;
        }

        private readonly object _gate = new object();
        private readonly Hub _hub;
        private readonly NostrChannel _channel;
        private readonly Func<long> _now;
        private readonly Timer? _timer;
        private readonly Dictionary<string, Peer> _peers = new Dictionary<string, Peer>(StringComparer.Ordinal);
        private readonly HashSet<string> _gone = new HashSet<string>(StringComparer.Ordinal);
        private readonly Queue<string> _goneOrder = new Queue<string>();
        private readonly List<Peer> _detached = new List<Peer>();
        private readonly List<(Peer Peer, string Text)> _toHub = new List<(Peer, string)>();
        private bool _disposed;

        public INostrRelays Relays => _channel.Relays;
        public string Pubkey => _channel.Pubkey;
        /// <summary>Joiners currently linked.</summary>
        public int PeerCount { get { lock (_gate) return _peers.Count; } }

        public NostrHostBridge(Hub hub, string normalizedCode, NostrOptions options)
        {
            _hub = hub;
            var keys = NostrRoomKeys.Derive(normalizedCode);
            var relays = options.RelayFactory != null ? options.RelayFactory(keys.Topic) : new WebSocketRelays(options.EffectiveRelays, keys.Topic, options.UnixSeconds);
            var sw = Stopwatch.StartNew();
            _now = options.NowMs ?? (() => sw.ElapsedMilliseconds);
            _channel = new NostrChannel(relays, keys, options.UnixSeconds ?? (() => DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
            _channel.Start();
            if (options.AutoTick) _timer = new Timer(_ => Tick(), null, 10, 10);
        }

        public void Tick()
        {
            List<(Peer Peer, string Text)>? toHub = null;
            List<Peer>? detached = null;
            if (!Monitor.TryEnter(_gate)) return;
            try
            {
                if (_disposed) return;
                while (_channel.TryTake(out var f)) Handle(f);
                foreach (var p in new List<Peer>(_peers.Values))
                {
                    while (p.FromHub.TryDequeue(out var text)) p.Link.Queue(text);
                    if (p.HubClosed && !p.Link.IsClosed)
                    {
                        // the hub closed this session: say so, keep the pubkey out for the rest of the session
                        p.Link.Close();
                        Forget(p);
                        continue;
                    }
                    p.Link.Tick();
                }
                if (_toHub.Count > 0)
                {
                    toHub = new List<(Peer, string)>(_toHub);
                    _toHub.Clear();
                }
                if (_detached.Count > 0)
                {
                    detached = new List<Peer>(_detached);
                    _detached.Clear();
                }
            }
            finally { Monitor.Exit(_gate); }
            if (toHub != null)
                foreach (var (p, text) in toHub)
                    if (p.Session != null && !p.HubClosed) _hub.Receive(p.Session, text);
            if (detached != null)
                foreach (var p in detached) if (p.Session != null) _hub.Disconnect(p.Session);
        }


        private void Handle(NostrFrame f)
        {
            _peers.TryGetValue(f.From, out var known);
            if (f.Type == "open")
            {
                if (_gone.Contains(f.From)) return;
                if (known != null)
                {
                    known.Link.Heard();
                    Answer(f.From);
                }
                else Admit(f.From);
                return;
            }
            if (known == null) return;
            known.Link.Receive(f);
            // a joiner's beat is its keep-alive: the hub counts it as activity (its pong is dropped below)
            if (f.Type == "beat" && known.Session != null && !known.HubClosed && !known.Link.IsClosed) _toHub.Add((known, Ping));
        }

        private void Answer(string joiner) => _channel.Publish(new NostrFrame { Type = "open", To = joiner, Seq = 0, Ack = 0 });

        private void Admit(string joiner)
        {
            var p = new Peer { Pub = joiner };
            p.Link = new NostrLink(_now, joiner, fr => _channel.Publish(fr));
            p.Link.Message += m => _toHub.Add((p, m));
            p.Link.PeerClosed += _ => Detach(p);
            p.Link.Dead += _ => Detach(p);
            _peers[joiner] = p;
            Answer(joiner);
            p.Session = _hub.Connect("nostr:" + joiner.Substring(0, Math.Min(16, joiner.Length)),
                send: text => { if (!text.StartsWith(PongPrefix, StringComparison.Ordinal)) p.FromHub.Enqueue(text); }, // keep-alive pongs never cross Nostr
                close: () => p.HubClosed = true);
            if (p.Session == null) p.HubClosed = true; // full: the hub's server_full text is still sent, then close
        }

        /// <summary>The peer closed or died: stop its link, drop the hub session, keep the pubkey out.</summary>
        private void Detach(Peer p)
        {
            p.Link.Stop();
            _detached.Add(p);
            Forget(p);
        }

        private void Forget(Peer p)
        {
            if (_peers.TryGetValue(p.Pub, out var cur) && cur == p) _peers.Remove(p.Pub);
            if (_gone.Add(p.Pub))
            {
                _goneOrder.Enqueue(p.Pub);
                if (_gone.Count > ClosedMemory) _gone.Remove(_goneOrder.Dequeue());
            }
        }

        public void Dispose()
        {
            List<Peer> peers;
            lock (_gate)
            {
                if (_disposed) return;
                _disposed = true;
                peers = new List<Peer>(_peers.Values);
                foreach (var p in peers) p.Link.Close("host left");
                _peers.Clear();
            }
            _timer?.Dispose();
            var relays = _channel.Relays;
            Task.Delay(500).ContinueWith(_ => { _channel.Dispose(); relays.Dispose(); }); // let the close frames leave
        }
    }
}
