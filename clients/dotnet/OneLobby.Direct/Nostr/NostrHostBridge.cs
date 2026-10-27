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
        /// <summary>
        /// New joiner pubkeys are a token bucket: a burst of <see cref="SessionBurstFor"/>(maxPlayers) at once (a party joining
        /// together), then one more per <see cref="NewSessionRefillMs"/>. Refused pubkeys wait in a list (up to
        /// <see cref="WaitingMax"/>, oldest first) and are answered on the tick a token refills; a waiting pubkey whose
        /// <c>open</c> (repeated every 2 s) has not been heard for <see cref="WaitingStaleMs"/> has given up and is dropped.
        /// </summary>
        public const int NewSessionBurst = NostrLimits.NewSessionBurst;
        public const int MaxSessionBurst = NostrLimits.MaxSessionBurst;
        public const int NewSessionRefillMs = NostrLimits.NewSessionRefillMs;
        public const int WaitingMax = NostrLimits.WaitingMax;
        public const int WaitingStaleMs = NostrLimits.WaitingStaleMs;

        /// <summary>A lobby sized for more than <see cref="NewSessionBurst"/> players gets a burst that fits it (up to <see cref="MaxSessionBurst"/>).</summary>
        public static int SessionBurstFor(int maxPlayers) => Math.Max(NewSessionBurst, Math.Min(MaxSessionBurst, maxPlayers));
        /// <summary>Banned IPs remembered for the session (a kick adds one).</summary>
        public const int MaxBannedIps = 256;
        private const int AddressCheckMs = 250;
        private const string Ping = "{\"t\":\"ping\",\"n\":0}";
        private const string PongPrefix = "{\"t\":\"pong\"";

        private sealed class Peer
        {
            public string Pub = "";
            public NostrLink Link = null!;
            public Session? Session;
            public readonly ConcurrentQueue<string> FromHub = new ConcurrentQueue<string>();
            public volatile bool HubClosed;
            public bool AddressChecked;
            public long NextAddressCheck;
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
        private readonly int _burst;
        private double _newTokens;
        private long? _newTokensAt;
        /// <summary>Refused new pubkeys, oldest first, with when their last <c>open</c> was heard.</summary>
        private readonly List<string> _waitingOrder = new List<string>();
        private readonly Dictionary<string, long> _waiting = new Dictionary<string, long>(StringComparer.Ordinal);
        private readonly object _banGate = new object();
        private readonly HashSet<string> _bannedIps = new HashSet<string>(StringComparer.Ordinal);
        private readonly Queue<string> _bannedOrder = new Queue<string>();
        private bool _disposed;

        /// <summary>
        /// The remote IP of the WebRTC link to the hub peer with this id, once known (null: unknown, relayed or an mDNS name).
        /// Set by the direct host; called from the bridge's timer thread and from the hub's lock, so it must not block.
        /// </summary>
        public Func<int, string?>? RemoteAddressOf { get; set; }

        public INostrRelays Relays => _channel.Relays;
        public string Pubkey => _channel.Pubkey;
        /// <summary>Joiners currently linked.</summary>
        public int PeerCount { get { lock (_gate) return _peers.Count; } }

        public NostrHostBridge(Hub hub, string normalizedCode, NostrOptions options, int maxPlayers = 0)
        {
            _hub = hub;
            _burst = SessionBurstFor(maxPlayers);
            _newTokens = _burst;
            var keys = NostrRoomKeys.Derive(normalizedCode);
            var relays = options.RelayFactory != null ? options.RelayFactory(keys.Topic) : new WebSocketRelays(options.EffectiveRelays, keys.Topic, options.UnixSeconds);
            var sw = Stopwatch.StartNew();
            _now = options.NowMs ?? (() => sw.ElapsedMilliseconds);
            _channel = new NostrChannel(relays, keys, options.UnixSeconds ?? (() => DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
            _channel.Start();
            _hub.MemberBanned += OnBanned;
            if (options.AutoTick) _timer = new Timer(_ => Tick(), null, 10, 10);
        }

        public void Tick()
        {
            List<(Peer Peer, string Text)>? toHub = null;
            List<Peer>? detached = null;
            List<Peer>? banned = null;
            if (!Monitor.TryEnter(_gate)) return;
            try
            {
                if (_disposed) return;
                while (_channel.TryTake(out var f)) Handle(f);
                AdmitWaiting();
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
                    if (!p.AddressChecked && p.Session != null && !p.HubClosed && _now() >= p.NextAddressCheck && CheckAddress(p))
                        (banned ??= new List<Peer>()).Add(p);
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
            if (banned != null)
                foreach (var p in banned) if (p.Session != null) _hub.KickSession(p.Session); // a link from a banned IP: removed as kicked
        }

        /// <summary>True when the peer's link resolved to a banned IP. Unknown addresses are asked again every 250 ms.</summary>
        private bool CheckAddress(Peer p)
        {
            p.NextAddressCheck = _now() + AddressCheckMs;
            var id = p.Session?.Member?.PeerId ?? 0;
            var ip = id == 0 ? null : RemoteAddressOf?.Invoke(id);
            if (ip == null) return false;
            p.AddressChecked = true;
            lock (_banGate) return _bannedIps.Contains(ip);
        }

        /// <summary>A host kick with a ban: remember the link's remote IP of a Nostr joiner (its pubkey is kept out when its session closes).</summary>
        private void OnBanned(Session? session, int peerId, string address)
        {
            if (!address.StartsWith("nostr:", StringComparison.Ordinal)) return;
            string? ip = null;
            try { ip = RemoteAddressOf?.Invoke(peerId); } catch (Exception) { }
            if (string.IsNullOrEmpty(ip)) return;
            lock (_banGate)
            {
                if (!_bannedIps.Add(ip!)) return;
                _bannedOrder.Enqueue(ip!);
                if (_bannedIps.Count > MaxBannedIps) _bannedIps.Remove(_bannedOrder.Dequeue());
            }
        }

        /// <summary>The IPs banned so far (tests).</summary>
        public bool IsIpBanned(string ip) { lock (_banGate) return _bannedIps.Contains(ip); }


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
                else if (_waiting.ContainsKey(f.From)) _waiting[f.From] = _now(); // still trying: keep its place in the queue
                else if (_waiting.Count == 0 && TakeToken()) Admit(f.From);
                else if (_waiting.Count < WaitingMax)
                {
                    _waiting[f.From] = _now(); // over the cap: answered on the tick a token refills
                    _waitingOrder.Add(f.From);
                } // waiting list full too: not answered, the joiner's next open retries
                return;
            }
            if (known == null) return;
            known.Link.Receive(f);
            // a joiner's beat is its keep-alive: the hub counts it as activity (its pong is dropped below)
            if (f.Type == "beat" && known.Session != null && !known.HubClosed && !known.Link.IsClosed) _toHub.Add((known, Ping));
        }

        private void Answer(string joiner) => _channel.Publish(new NostrFrame { Type = "open", To = joiner, Seq = 0, Ack = 0 });

        /// <summary>Answers waiting pubkeys, oldest first, while tokens last; drops the ones that gave up.</summary>
        private void AdmitWaiting()
        {
            if (_waitingOrder.Count == 0) return;
            var now = _now();
            while (_waitingOrder.Count > 0)
            {
                var pub = _waitingOrder[0];
                if (now - _waiting[pub] > WaitingStaleMs || _peers.ContainsKey(pub) || _gone.Contains(pub))
                {
                    _waitingOrder.RemoveAt(0);
                    _waiting.Remove(pub);
                    continue;
                }
                if (!TakeToken()) break;
                _waitingOrder.RemoveAt(0);
                _waiting.Remove(pub);
                Admit(pub);
            }
        }

        /// <summary>Spends one token of the new-session bucket, or false when it is empty.</summary>
        private bool TakeToken()
        {
            var now = _now();
            if (_newTokensAt is long last) _newTokens = Math.Min(_burst, _newTokens + (now - last) / (double)NewSessionRefillMs);
            _newTokensAt = now;
            if (_newTokens < 1 - 1e-6) return false; // tolerance: summed refills can leave a full token at 0.999...
            _newTokens = Math.Max(0, _newTokens - 1);
            return true;
        }

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
            _hub.MemberBanned -= OnBanned;
            _timer?.Dispose();
            var relays = _channel.Relays;
            Task.Delay(500).ContinueWith(_ => { _channel.Dispose(); relays.Dispose(); }); // let the close frames leave
        }
    }
}
