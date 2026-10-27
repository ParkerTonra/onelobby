#nullable enable
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using OneLobby.Server;

namespace OneLobby.Direct.Nostr
{
    /// <summary>
    /// The host's side of the Nostr signaling (spec/nostr-signaling.md): answers a joiner's <c>open</c>, connects a hub
    /// <see cref="Session"/> for it with address <c>nostr:&lt;16 hex&gt;</c> and carries the hub's texts both ways in
    /// reliable frames. The hub (single-locked, called from any thread) is never called while the bridge holds its own
    /// lock: hub texts bound for a joiner are queued by the hub's callbacks and moved into the link on the next tick.
    /// </summary>
    internal sealed class NostrHostBridge : IDisposable
    {
        private sealed class Peer
        {
            public string Pub = "";
            public NostrLink Link = null!;
            public Session? Session;
            public readonly ConcurrentQueue<string> FromHub = new ConcurrentQueue<string>();
            public volatile bool HubClosed;
            public readonly List<string> ToHub = new List<string>();
        }

        private readonly object _gate = new object();
        private readonly Hub _hub;
        private readonly NostrChannel _channel;
        private readonly Func<long> _now;
        private readonly Timer? _timer;
        private readonly Dictionary<string, Peer> _peers = new Dictionary<string, Peer>(StringComparer.Ordinal);
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
            List<Peer>? ended = null;
            if (!Monitor.TryEnter(_gate)) return;
            try
            {
                if (_disposed) return;
                while (_channel.TryTake(out var f)) Handle(f);
                foreach (var p in _peers.Values)
                {
                    while (p.FromHub.TryDequeue(out var text)) p.Link.Queue(text);
                    if (p.HubClosed && !p.Link.IsClosed) p.Link.Close("closed");
                    p.Link.Tick();
                    if (p.ToHub.Count > 0)
                    {
                        toHub ??= new List<(Peer, string)>();
                        foreach (var t in p.ToHub) toHub.Add((p, t));
                        p.ToHub.Clear();
                    }
                    if (p.Link.IsClosed) (ended ??= new List<Peer>()).Add(p);
                }
                if (ended != null) foreach (var p in ended) _peers.Remove(p.Pub);
            }
            finally { Monitor.Exit(_gate); }
            if (toHub != null)
                foreach (var (p, text) in toHub)
                    if (p.Session != null && !p.HubClosed) _hub.Receive(p.Session, text);
            if (ended != null)
                foreach (var p in ended) if (p.Session != null) _hub.Disconnect(p.Session);
        }

        private void Handle(NostrFrame f)
        {
            if (f.Type == "open")
            {
                if (f.To.Length != 0) return;
                if (_peers.TryGetValue(f.From, out var existing))
                {
                    if (!existing.Link.IsClosed) Answer(f.From);
                    return;
                }
                Admit(f.From);
                return;
            }
            if (f.To != _channel.Pubkey || !_peers.TryGetValue(f.From, out var p)) return;
            p.Link.Receive(f);
            // any frame from the joiner is activity for the hub's idle timer; an unknown type is ignored by the hub
            if (p.Session != null && !p.HubClosed) p.ToHub.Add("{\"t\":\"nop\"}");
        }

        private void Answer(string joiner) => _channel.Publish(new NostrFrame { Type = "open", To = joiner });

        private void Admit(string joiner)
        {
            var p = new Peer { Pub = joiner };
            p.Link = new NostrLink(_now, fr => _channel.Publish(fr));
            p.Link.Peer = joiner;
            p.Link.Message += m => p.ToHub.Add(m);
            p.Session = _hub.Connect("nostr:" + joiner.Substring(0, Math.Min(16, joiner.Length)),
                send: text => { if (!IsPong(text)) p.FromHub.Enqueue(text); },
                close: () => p.HubClosed = true);
            _peers[joiner] = p;
            Answer(joiner);
            if (p.Session == null) p.HubClosed = true; // full: the hub's server_full text is still sent, then close
        }

        private static bool IsPong(string text)
        {
            if (text.Length > 200 || text.IndexOf("\"pong\"", StringComparison.Ordinal) < 0) return false;
            try
            {
                using var doc = JsonDocument.Parse(text);
                return doc.RootElement.TryGetProperty("t", out var t) && t.GetString() == "pong";
            }
            catch (JsonException) { return false; }
        }

        public void Dispose()
        {
            List<Peer> peers;
            lock (_gate)
            {
                if (_disposed) return;
                _disposed = true;
                peers = new List<Peer>(_peers.Values);
                foreach (var p in peers) p.Link.Close("host_left");
                _peers.Clear();
            }
            _timer?.Dispose();
            var relays = _channel.Relays;
            Task.Delay(500).ContinueWith(_ => { _channel.Dispose(); relays.Dispose(); }); // let the close frames leave
        }
    }
}
