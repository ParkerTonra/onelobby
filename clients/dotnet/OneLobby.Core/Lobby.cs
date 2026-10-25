using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace OneLobby
{
    /// <summary>A joined lobby: roster, data channels to peers, lockstep, voice and chat.</summary>
    public sealed class Lobby : IAsyncDisposable
    {
        internal sealed class PeerRec
        {
            public int Id;
            public string Name = "";
            public IPeerLink? Link;
            public bool OpenHandled, Hello, HiSent, ReadyRaised;
            public readonly List<(PeerChannel Ch, byte[] Data)> Pending = new();
            public long LastRxMs, OpenedMs;
            public int PingMs;
            public int Resyncs;
            public long IgnoreHashUntil = -1;
            public readonly ChunkAssembler Chunks = new(); // per sender: every sender numbers its own chunk ids
            /// <summary>The server said this peer is gone while its link was open: finish when the link closes or at <see cref="DepartAtMs"/>.</summary>
            public Action? Departure;
            public long DepartAtMs;
        }

        public const int HostTimeoutMs = 8000;
        public const int PeerTimeoutMs = 10000;
        /// <summary>The smallest <see cref="OneLobbyConfig.PeerTimeout"/> honoured.</summary>
        public const int MinPeerTimeoutMs = 6000;
        public const int PingEveryMs = 1000;
        public const int ClaimWaitMs = 6000;
        public const int MigrationGraceMs = 1500;
        /// <summary>
        /// A departure the server announces (peer left, direct host gone) waits up to this long for the peer's open link
        /// to close, reading it meanwhile, so the last messages it flushed before leaving still arrive.
        /// </summary>
        public const int LeaveGraceMs = 500;

        private readonly LobbyClient _c;
        private readonly ITransport _t;
        private readonly SortedDictionary<int, PeerRec> _peers = new();
        /// <summary>Host: links of disconnected peers, kept open until a deadline (see <see cref="DisconnectAsync"/>).</summary>
        private readonly List<(IPeerLink Link, long Until)> _lingering = new();
        private readonly List<(TaskCompletionSource<bool> Tcs, long Until)> _flushes = new();
        /// <summary>How long a kicked / disconnected peer's link stays open, so the hub's notice reaches it first.</summary>
        public const int KickLingerMs = 3000;
        private readonly int _you;
        private int _hostId;
        private int _epoch;
        private bool _ready;
        private bool _closed;
        private bool _hasState;
        private bool _awaitingClaim;
        private long _awaitDeadlineMs;
        private long _lastPingMs;
        private readonly int _peerTimeoutMs, _hostTimeoutMs;
        /// <summary>Host: per-peer fixed window for <see cref="RateLimit"/> (window start, count).</summary>
        private readonly Dictionary<int, (long Start, int N)> _rate = new();
        private uint _pingN;
        private uint _chunkId;
        private int _localResyncs;
        private (long Tick, uint Total, byte Flags)? _snap;
        private LobbyPhase _phase;
        private Dictionary<string, string> _meta;

        internal Lobby(LobbyClient client, LobbyMsg msg)
        {
            _c = client;
            _t = client.Transport;
            Code = msg.Code;
            _you = msg.You;
            _hostId = msg.HostId;
            _phase = msg.Phase;
            Mode = msg.Mode;
            TickRate = Math.Max(1, msg.TickRate);
            LateJoin = msg.LateJoin;
            _meta = msg.Meta;
            ResumeToken = msg.ResumeToken;
            foreach (var p in msg.Peers) _peers[p.PeerId] = new PeerRec { Id = p.PeerId, Name = p.Name };
            if (!_peers.ContainsKey(_you)) _peers[_you] = new PeerRec { Id = _you, Name = client.Config.DisplayName };
            if (!_peers.ContainsKey(_hostId)) _peers[_hostId] = new PeerRec { Id = _hostId, Name = "host" };
            var pt = (long)client.Config.PeerTimeout.TotalMilliseconds;
            _peerTimeoutMs = pt > 0 ? (int)Math.Min(int.MaxValue, Math.Max(pt, MinPeerTimeoutMs)) : PeerTimeoutMs;
            _hostTimeoutMs = pt > 0 ? _peerTimeoutMs : HostTimeoutMs;
            Voice = new VoiceChannel(this);
            Chat = new TextChat(this);
            if (Mode == SyncMode.Lockstep) Lockstep = new LockstepSession(this);
        }

        /// <summary>The blueprint of the client that made this lobby, or null for a plain client.</summary>
        internal Blueprint? Blueprint => _c.Blueprint;
        public string Code { get; }
        public int LocalPeerId => _you;
        public int HostPeerId => _hostId;
        public bool IsHost => _hostId == _you;
        public LobbyPhase Phase => _phase;
        public IReadOnlyDictionary<string, string> Meta => _meta;
        public string ResumeToken { get; private set; }
        public SyncMode Mode { get; }
        public int TickRate { get; }
        public bool LateJoin { get; }
        internal int Epoch => _epoch;
        internal int SnapshotChunkSize = Wire.ChunkPayload;
        public LockstepSession? Lockstep { get; }
        public VoiceChannel Voice { get; }
        public TextChat Chat { get; }
        /// <summary>Host: the per-joiner cap on incoming raw messages (<see cref="LobbyOptions.RateLimit"/>); null = none.</summary>
        public RateLimit? RateLimit { get; internal set; }

        /// <summary>
        /// Direct-IP host only (OneLobby.Direct): this machine's addresses with the port, for the "Your address" screen,
        /// e.g. <c>192.168.1.20:47810</c>. Empty otherwise.
        /// </summary>
        public IReadOnlyList<string> DirectAddresses { get; internal set; } = Array.Empty<string>();

        /// <summary>
        /// Direct-IP host only: the code friends paste to join, e.g. <c>6B01-RGFE-P2B</c> (docs/direct-ip.md s.2a). Show it
        /// with <see cref="JoinCodeKind"/>. Empty when this machine has no IPv4 address.
        /// </summary>
        public string JoinCode { get; internal set; } = "";

        /// <summary>Whether <see cref="JoinCode"/> carries the router's public address (internet) or this PC's LAN address.</summary>
        public JoinCodeKind JoinCodeKind { get; internal set; }

        /// <summary>Direct-IP host only: how the router port-open went, for logs ("UPnP", "no UPnP gateway answered; ...").</summary>
        public string PortMapping { get; internal set; } = "";

        /// <summary>Direct-IP host only: one log line with the bound port, the join code and the mapping (OneLobby.Direct sets it).</summary>
        internal string DirectHostLog { get; set; } = "";

        /// <summary>Direct IP has no migration: the hub lives in the host (docs/direct-ip.md s.2).</summary>
        private bool DirectJoiner => _c.Direct && !IsHost;

        /// <summary>True once the data channel to the host is up and welcomed (always true on the host).</summary>
        public bool IsReady => _ready;

        private readonly TaskCompletionSource<bool> _readyTcs = new();

        /// <summary>Completes when <see cref="IsReady"/> first becomes true (immediately for a host).</summary>
        public Task ReadyAsync => _readyTcs.Task;

        public IReadOnlyList<Peer> Peers => _peers.Values.Select(r =>
            new Peer(r.Id, r.Name, r.PingMs, r.Link?.Relayed ?? false)).ToList();

        /// <summary>
        /// Round trip to <paramref name="peerId"/> in ms from OneLobby's own 1 s pings (host: any peer; joiner: the host),
        /// 0 before the first pong or for an unknown peer. Same value as <see cref="Peer.PingMs"/>, without the list.
        /// </summary>
        public int PingMs(int peerId) => _peers.TryGetValue(peerId, out var r) ? r.PingMs : 0;

        /// <summary>
        /// True once <see cref="PeerReady"/> has fired for this peer (its data channels are open and its handshake is
        /// done). Always true for the local player.
        /// </summary>
        public bool IsPeerReady(int peerId) =>
            peerId == _you || (_peers.TryGetValue(peerId, out var r) && r.ReadyRaised && r.Link != null && r.Link.IsOpen);

        public event Action? Ready;
        /// <summary>
        /// A peer's data channels are open and its handshake is done: from here Send/Broadcast reach it at once.
        /// (<see cref="PeerJoined"/> fires earlier, when the server announces the peer; reliable sends made in between are
        /// queued and delivered in order when the link opens.) On a joiner this fires once for the host.
        /// </summary>
        public event Action<Peer>? PeerReady;
        public event Action<Peer>? PeerJoined;
        public event Action<Peer, string>? PeerLeft;
        public event Action<Peer>? JoinRequested;
        public event Action<int>? HostChanged;
        public event Action<LobbyPhase>? PhaseChanged;
        public event Action<int, ReadOnlyMemory<byte>, Channel>? MessageReceived;
        public event Action<string>? SessionEnded;

        /// <summary>The transport's monotonic clock in milliseconds (the same clock the lobby times out and pings with).</summary>
        public long NowMs => _t.NowMs;

        // ---- public commands -----------------------------------------------------------------------------------

        public Task StartAsync()
        {
            if (!IsHost) throw new InvalidOperationException("only the host starts the game");
            SetPhase(LobbyPhase.InGame);
            _c.SendRaw(Signaling.Phase(LobbyPhase.InGame));
            Lockstep?.BeginEmitting(NowMs);
            return Task.CompletedTask;
        }

        public Task SetMetaAsync(IReadOnlyDictionary<string, string> meta)
        {
            if (!IsHost) throw new InvalidOperationException("only the host sets metadata");
            _meta = new Dictionary<string, string>(meta);
            _c.SendRaw(Signaling.Meta(meta));
            return Task.CompletedTask;
        }

        /// <summary>
        /// Host: removes a player and bans its address from this lobby for as long as the lobby lasts (a reload or a new
        /// window included). To end a connection without the ban, use <see cref="DisconnectAsync"/>.
        /// </summary>
        public Task KickAsync(int peerId)
        {
            if (!IsHost) throw new InvalidOperationException("only the host kicks");
            _c.SendRaw(Signaling.Kick(peerId));
            if (_peers.TryGetValue(peerId, out var rec)) DropPeer(rec, "kicked", linger: true);
            return Task.CompletedTask;
        }

        /// <summary>
        /// Host: ends one player's connection without a ban; it may join again. Its lobby ends with
        /// <c>SessionEnded("disconnected")</c>; <paramref name="closeCode"/> (1000 or 3000-4999) and
        /// <paramref name="closeReason"/> (at most 120 characters) reach a JS player's <c>asWebSocket()</c> onclose.
        /// Others see <c>PeerLeft(peer, "disconnected")</c>.
        /// </summary>
        public Task DisconnectAsync(int peerId, int? closeCode = null, string? closeReason = null)
        {
            if (!IsHost) throw new InvalidOperationException("only the host disconnects players");
            if (closeCode is int c && !(c == 1000 || (c >= 3000 && c <= 4999)))
                throw new ArgumentOutOfRangeException(nameof(closeCode), "close code must be 1000 or 3000-4999");
            if (closeReason != null && closeReason.Length > 120)
                throw new ArgumentOutOfRangeException(nameof(closeReason), "close reason must be at most 120 characters");
            _c.SendRaw(Signaling.Kick(peerId, ban: false, closeCode, closeReason));
            if (_peers.TryGetValue(peerId, out var rec)) DropPeer(rec, "disconnected", linger: true);
            return Task.CompletedTask;
        }

        public Task ApproveAsync(int peerId, bool ok)
        {
            if (!IsHost) throw new InvalidOperationException("only the host approves");
            _c.SendRaw(Signaling.Approve(peerId, ok));
            return Task.CompletedTask;
        }

        /// <summary>
        /// Leaves the lobby: tells the server, closes every peer link and turns voice off. Completes at once, never throws,
        /// and a second call does nothing. <see cref="SessionEnded"/> does not fire for your own leave; the other peers see
        /// <see cref="PeerLeft"/>. A direct-IP host leaving stops its listener, which ends the session for every joiner
        /// (<c>SessionEnded("host_left")</c>). Do not use the lobby afterwards: host or join again from the LobbyClient.
        /// </summary>
        public Task LeaveAsync()
        {
            if (_closed) return Task.CompletedTask;
            _c.SendRaw(Signaling.Simple("leave"));
            Close();
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync() => new(LeaveAsync());

        /// <summary>
        /// Waits until every reliable message sent so far has left this machine (each link's send queue is empty), so a
        /// last message (match over, final score) is not cut off by <see cref="LeaveAsync"/>. True when flushed, false
        /// on <paramref name="timeout"/> (<see cref="System.Threading.Timeout.InfiniteTimeSpan"/> = wait forever) or when
        /// the lobby ends first. Completes inside <see cref="Pump"/>, so keep pumping while you await it.
        /// </summary>
        public Task<bool> FlushAsync(TimeSpan timeout)
        {
            if (_closed) return Task.FromResult(false);
            if (ReliableBufferedBytes == 0) return Task.FromResult(true);
            var tcs = new TaskCompletionSource<bool>();
            _flushes.Add((tcs, timeout < TimeSpan.Zero ? long.MaxValue : NowMs + (long)timeout.TotalMilliseconds));
            return tcs.Task;
        }

        /// <summary>Reliable bytes queued on all links and not yet handed to the network (0 for transports that do not say).</summary>
        public long ReliableBufferedBytes
        {
            get
            {
                long n = 0;
                foreach (var r in _peers.Values) if (r.Link is IBufferedPeerLink b) n += b.ReliableBufferedBytes;
                foreach (var (link, _) in _lingering) if (link is IBufferedPeerLink b) n += b.ReliableBufferedBytes;
                return n;
            }
        }

        private void CheckFlushes(long now)
        {
            if (_flushes.Count == 0) return;
            var done = ReliableBufferedBytes == 0;
            for (var i = _flushes.Count - 1; i >= 0; i--)
            {
                var (tcs, until) = _flushes[i];
                if (!done && now < until) continue;
                _flushes.RemoveAt(i);
                tcs.TrySetResult(done);
            }
        }

        public void Send(int peerId, ReadOnlySpan<byte> payload, Channel channel = Channel.Reliable)
        {
            var ch = channel == Channel.Fast ? PeerChannel.Fast : PeerChannel.Reliable;
            if (IsHost) SendToPeer(peerId, ch, Wire.BuildRaw(_you, payload));
            else SendToHost(ch, Wire.BuildRaw(peerId, payload));
        }

        public void Broadcast(ReadOnlySpan<byte> payload, Channel channel = Channel.Reliable)
        {
            var ch = channel == Channel.Fast ? PeerChannel.Fast : PeerChannel.Reliable;
            if (IsHost) { var f = Wire.BuildRaw(_you, payload); foreach (var r in _peers.Values.Where(x => x.Id != _you && x.Link != null).ToList()) SendLink(r, ch, f); }
            else SendToHost(ch, Wire.BuildRaw(0, payload));
        }

        /// <summary>The ONE per-frame call for a game in a lobby: pumps the owning LobbyClient and transport (signaling, peer links), delivers events on the calling thread, advances lockstep, voice and timeouts.</summary>
        public void Pump() => _c.Pump();

        // ---- internal plumbing ---------------------------------------------------------------------------------

        internal void Start()
        {
            if (IsHost)
            {
                _ready = true;
                _readyTcs.TrySetResult(true);
                foreach (var r in _peers.Values.ToList()) if (r.Id != _you) ConnectPeer(r, true);
            }
            else
            {
                if (_peers.TryGetValue(_hostId, out var h)) ConnectPeer(h, false);
                ArmReadyTimer();
            }
        }

        // ---- joiner connect timeout (OneLobbyConfig.ReadyTimeout; same rules as the JS client's readyTimeoutMs) -----

        private long _readyDeadlineMs; // 0 = no timer
        private long _readyRetryBudgetMs; // > 0: the deadline starts a relay-only retry with this budget instead of giving up
        private bool _relayRetried;

        private void ArmReadyTimer()
        {
            var total = (long)Math.Ceiling(_c.Config.ReadyTimeout.TotalMilliseconds);
            if (total <= 0) return;
            var canRelay = !_c.Config.RelayOnly && !_c.Direct && HasRelay(_c.Ice);
            var first = canRelay ? (total + 1) / 2 : total;
            _readyRetryBudgetMs = canRelay ? total - first : 0;
            _readyDeadlineMs = NowMs + first;
        }

        private static bool HasRelay(IReadOnlyList<IceServer> ice) =>
            ice.Any(s => s.Urls.Any(u => u.StartsWith("turn:", StringComparison.OrdinalIgnoreCase)
                || u.StartsWith("turns:", StringComparison.OrdinalIgnoreCase)));

        private void CheckReadyTimer(long now)
        {
            if (_readyDeadlineMs == 0) return;
            if (_readyTcs.Task.IsCompleted || _ready || IsHost) { _readyDeadlineMs = 0; return; } // linked, or became host
            if (now < _readyDeadlineMs) return;
            if (_readyRetryBudgetMs > 0 && _peers.TryGetValue(_hostId, out var h))
            {
                // the direct attempt stalled: dial the host ourselves through the TURN relay (a host answers an offer)
                _relayRetried = true;
                _readyDeadlineMs = now + _readyRetryBudgetMs;
                _readyRetryBudgetMs = 0;
                ConnectPeer(h, true, relayOnly: true);
                return;
            }
            _readyDeadlineMs = 0;
            GiveUpConnecting();
        }

        private void GiveUpConnecting()
        {
            var secs = _c.Config.ReadyTimeout.TotalSeconds.ToString("0.#", System.Globalization.CultureInfo.InvariantCulture);
            var msg = "the link to the host did not open in " + secs + " s" + (_relayRetried ? " (direct or relayed)" : "")
                + ": likely a firewall or strict NAT";
            _readyTcs.TrySetException(new OneLobbyException("ice_failed", msg));
            _c.RaiseError(new LobbyError("ice_failed", msg));
            if (_closed) return;
            _c.SendRaw(Signaling.Simple("leave"));
            End("ice_failed");
        }

        internal IEnumerable<PeerRec> PeerRecords() => _peers.Values.ToList();
        private IEnumerable<PeerRec> HelloPeers() => _peers.Values.Where(r => r.Id != _you && r.Hello && r.Link != null && r.Link.IsOpen).ToList();
        internal bool IsLocallyMuted(int peerId) => Voice.IsMuted(peerId);

        private void ConnectPeer(PeerRec rec, bool initiator, bool relayOnly = false)
        {
            rec.Link?.Dispose();
            rec.OpenHandled = false;
            rec.Hello = false;
            rec.HiSent = false;
            rec.Link = _t.CreatePeerLink(new PeerLinkOptions(rec.Id, initiator, _c.Ice, relayOnly || _c.Config.RelayOnly));
            rec.LastRxMs = NowMs;
            if (initiator) rec.Link.StartOffer();
        }

        internal void SendToHost(PeerChannel ch, byte[] data)
        {
            if (_peers.TryGetValue(_hostId, out var h)) SendLink(h, ch, data);
        }

        internal void SendToPeer(int peerId, PeerChannel ch, byte[] data)
        {
            if (_peers.TryGetValue(peerId, out var r)) SendLink(r, ch, data);
        }

        private uint _bigId = 0x80000000;

        private void SendLink(PeerRec r, PeerChannel ch, byte[] data)
        {
            if (r.Link == null || r.Link.IsFailed) return;
            if (!r.Link.IsOpen)
            {
                // the connection is still being set up: keep reliable sends in order and flush them when it opens
                if (ch == PeerChannel.Reliable && r.Pending.Count < 1024) r.Pending.Add((ch, data));
                return;
            }
            if (data.Length <= Wire.MaxFrame) { r.Link.Send(ch, data); return; }
            foreach (var chunk in Chunker.Split(++_bigId, data)) r.Link.Send(PeerChannel.Reliable, chunk);
        }

        /// <summary>Host: send to every connected peer (the sender of a relayed line included).</summary>
        internal void BroadcastAll(PeerChannel ch, byte[] data)
        {
            foreach (var r in HelloPeers()) SendLink(r, ch, data);
        }

        internal void BroadcastFrame(Frame f)
        {
            var data = Wire.BuildFrame(f.Tick, f.Commands);
            foreach (var r in HelloPeers()) SendLink(r, PeerChannel.Reliable, data);
        }

        internal void SendVoiceFromLocal(byte[] packet)
        {
            if (IsHost) foreach (var r in HelloPeers()) SendLink(r, PeerChannel.Voice, packet);
            else SendToHost(PeerChannel.Voice, Wire.WithRoute(packet, 0));
        }

        private void SetPhase(LobbyPhase p)
        {
            if (_phase == p) return;
            _phase = p;
            PhaseChanged?.Invoke(p);
        }

        // ---- the pump ------------------------------------------------------------------------------------------

        internal void PumpLobby()
        {
            if (_closed) return;
            var now = NowMs;
            for (var i = _lingering.Count - 1; i >= 0; i--)
                if (now >= _lingering[i].Until) { _lingering[i].Link.Dispose(); _lingering.RemoveAt(i); }
            foreach (var rec in _peers.Values.ToList())
            {
                if (rec.Link == null || _closed) continue;
                while (rec.Link.TryTakeSignal(out var sig)) _c.SendRaw(Signaling.Signal(rec.Id, sig));
                if (rec.Link.IsOpen && !rec.OpenHandled) { rec.OpenHandled = true; rec.OpenedMs = rec.LastRxMs = now; OnLinkOpen(rec); }
                // drain before handling a failure: frames that arrived before the close are still the peer's last words
                while (rec.Link != null && rec.Link.TryReceive(out var ch, out var data))
                {
                    rec.LastRxMs = now;
                    try { HandleFrame(rec, ch, data); }
                    catch (FormatException) { /* malformed frame: drop */ }
                    if (_closed) return;
                }
                if (rec.Link != null && rec.Link.IsFailed)
                {
                    if (rec.Departure != null) FinishDeparture(rec);
                    else LinkLost(rec);
                    if (_closed) return;
                }
            }
            if (_closed) return;
            foreach (var rec in _peers.Values.Where(r => r.Departure != null && now >= r.DepartAtMs).ToList())
            {
                FinishDeparture(rec);
                if (_closed) return;
            }
            CheckFlushes(now);
            CheckReadyTimer(now);
            if (_closed) return;
            Timeouts(now);
            if (now - _lastPingMs >= PingEveryMs)
            {
                _lastPingMs = now;
                var ping = Wire.BuildPing(Wire.Ping, ++_pingN, (uint)now);
                foreach (var r in _peers.Values.ToList())
                    if (r.Id != _you && r.Link != null && r.Link.IsOpen && (IsHost || r.Id == _hostId)) r.Link.Send(PeerChannel.Fast, ping);
            }
            if (IsHost && _migrationHold && Lockstep != null)
            {
                // a new host waits for every survivor to say hi (they replay frames it missed), then starts shortly after
                if (_peers.Values.All(r => r.Id == _you || r.Hello))
                {
                    _migrationHold = false;
                    _migrationEmitStartMs = now + 150;
                    Lockstep.ShortenGrace(now + 150);
                }
                else if (now >= _migrationEmitStartMs) _migrationHold = false;
            }
            if (IsHost) Lockstep?.EmitDue(now);
            else CheckSilentFrames(now);
            Voice.Update(now);
        }

        private bool AllowRaw(int from)
        {
            var lim = RateLimit;
            if (lim == null || lim.Messages <= 0 || lim.PerMs <= 0) return true;
            var now = NowMs;
            if (!_rate.TryGetValue(from, out var w) || now - w.Start >= lim.PerMs) w = (now, 0);
            _rate[from] = (w.Start, w.N + 1);
            return w.N + 1 <= lim.Messages;
        }

        private void Timeouts(long now)
        {
            if (IsHost)
            {
                foreach (var r in _peers.Values.ToList())
                    if (r.Id != _you && r.Link != null && r.OpenHandled && now - r.LastRxMs > _peerTimeoutMs) DropPeer(r, "timeout");
                return;
            }
            if (_awaitingClaim && now > _awaitDeadlineMs)
            {
                // the elected host never showed up: it is gone too
                var dead = _hostId;
                _awaitingClaim = false;
                if (_peers.TryGetValue(dead, out var d)) DropPeer(d, "timeout");
                ElectHost();
                return;
            }
            if (!_awaitingClaim && _peers.TryGetValue(_hostId, out var h) && h.OpenHandled && now - h.LastRxMs > _hostTimeoutMs)
                HostLost();
        }

        private long _lastFrameRxMs;

        /// <summary>Spec: a peer with no frames for 3 s while a game runs asks for a snapshot.</summary>
        private void CheckSilentFrames(long now)
        {
            var ls = Lockstep;
            if (ls == null || !_ready || _phase != LobbyPhase.InGame || _awaitingClaim) return;
            if (_lastFrameRxMs == 0) _lastFrameRxMs = now;
            if (now - _lastFrameRxMs > 3000 && ls.ShouldRequestSnapshot(now))
                SendToHost(PeerChannel.Reliable, Wire.BuildSnapshotReq(ls.Tick));
        }

        private void OnLinkOpen(PeerRec rec)
        {
            // telemetry (server counts relayed vs direct): one report per connection once ICE has completed
            var relayed = rec.Link!.Relayed;
            _c.SendRaw(Signaling.Build(w => { w.WriteString("t", "path"); w.WriteString("path", relayed ? "relayed" : "direct"); }));
            if (IsHost)
            {
                if (_epoch > 0) SendLink(rec, PeerChannel.Reliable, Wire.BuildHostClaim(_epoch, _you, Lockstep?.Head ?? 0));
            }
            else if (rec.Id == _hostId)
            {
                SendHi(rec);
            }
            var queued = rec.Pending.ToArray();
            rec.Pending.Clear();
            foreach (var (ch, data) in queued) SendLink(rec, ch, data);
        }

        private void RaiseReady(PeerRec rec)
        {
            if (rec.ReadyRaised) return;
            rec.ReadyRaised = true;
            PeerReady?.Invoke(ToPeer(rec));
        }

        private void SendHi(PeerRec rec)
        {
            rec.HiSent = true;
            var fresh = !_hasState && (Lockstep?.Head ?? 0) == 0;
            SendLink(rec, PeerChannel.Reliable, Wire.BuildHi(_you, fresh ? -1 : Lockstep?.Head ?? 0));
        }

        // ---- inbound frames ------------------------------------------------------------------------------------

        private void HandleFrame(PeerRec rec, PeerChannel ch, byte[] data, bool reassembled = false)
        {
            if (Wire.Validate(data, reassembled ? Wire.MaxReassembled : Wire.MaxFrame) != null) return;
            var type = Wire.Type(data);
            var route = Wire.Route(data);
            var body = Wire.Body(data);
            switch (type)
            {
                case Wire.Ping:
                {
                    var r = new Wire.Reader(body);
                    var n = r.U32(); var t = r.U32();
                    SendLink(rec, ch, Wire.BuildPing(Wire.Pong, n, t));
                    return;
                }
                case Wire.Pong:
                {
                    var r = new Wire.Reader(body);
                    r.U32();
                    var t = r.U32();
                    rec.PingMs = (int)Math.Max(0, (uint)NowMs - t);
                    return;
                }
                case Wire.Chunk:
                    HandleChunk(rec, ch, body);
                    return;
            }
            if (IsHost) HandleAsHost(rec, ch, type, route, body, data);
            else HandleAsJoiner(rec, ch, type, route, body);
        }

        private void HandleChunk(PeerRec rec, PeerChannel ch, ReadOnlySpan<byte> body)
        {
            if (!rec.Chunks.TryAdd(body, out _, out var all)) return;
            if (!IsHost && rec.Id == _hostId && _snap is { } s)
            {
                _snap = null;
                if (s.Total != all.Length) { SendToHost(PeerChannel.Reliable, Wire.BuildSnapshotReq(Lockstep?.Tick ?? -1)); return; }
                ApplySnapshot(s.Tick, s.Flags, all);
                return;
            }
            // an oversized frame sent in chunks: the bytes are one complete inner frame (spec/binary.md "Large non-snapshot frames")
            if (all.Length > 0 && all[0] != Wire.Chunk) HandleFrame(rec, ch, all, reassembled: true);
        }

        private void HandleAsHost(PeerRec rec, PeerChannel ch, byte type, int route, ReadOnlySpan<byte> body, byte[] data)
        {
            switch (type)
            {
                case Wire.Hi:
                {
                    var r = new Wire.Reader(body);
                    var proto = r.U8(); r.U16(); var lastTick = r.I64();
                    if (proto != Wire.ProtoVersion) return;
                    rec.Hello = true;
                    RaiseReady(rec);
                    SendLink(rec, PeerChannel.Reliable, Wire.BuildWelcomeDc(Lockstep?.Tick ?? 0, TickRate,
                        Mode == SyncMode.Raw ? Wire.ModeRaw : Wire.ModeLockstep, _you));
                    SendLink(rec, PeerChannel.Reliable, Wire.BuildChatHistory(Chat.History));
                    if (Lockstep != null && _phase == LobbyPhase.InGame && (Lockstep.Head > 0 || lastTick >= 0))
                    {
                        if (lastTick >= 0 && Lockstep.LogCovers(lastTick))
                        {
                            foreach (var f in Lockstep.LogAfter(lastTick)) SendLink(rec, PeerChannel.Reliable, Wire.BuildFrame(f.Tick, f.Commands));
                        }
                        else if (Lockstep.Tick > 0) SendSnapshot(rec); // snapshot tick == welcome_dc.tick (the applied tick)
                        else foreach (var f in Lockstep.LogAfter(0)) SendLink(rec, PeerChannel.Reliable, Wire.BuildFrame(f.Tick, f.Commands));
                    }
                    return;
                }
                case Wire.Cmd:
                {
                    if (!rec.Hello || Lockstep == null) return;
                    var r = new Wire.Reader(body);
                    r.U32();
                    var len = r.U16();
                    Lockstep.QueueRemote(rec.Id, r.Bytes(len).ToArray());
                    return;
                }
                case Wire.Hash:
                {
                    if (Lockstep == null || !rec.Hello) return;
                    var r = new Wire.Reader(body);
                    var tick = r.I64(); var hash = r.U64();
                    if (Lockstep.TryHostHash(tick, out var mine)) CompareHash(rec, tick, mine, hash);
                    else Lockstep.StorePeerHash(rec.Id, tick, hash);
                    return;
                }
                case Wire.SnapshotReq:
                    if (rec.Hello && Lockstep != null) SendSnapshot(rec);
                    return;
                case Wire.FrameMsg:
                {
                    // migration replay from a peer that is ahead of me
                    if (Lockstep == null || _epoch == 0) return;
                    var f = Wire.ParseFrame(body);
                    if (f.Tick != Lockstep.Head + 1 || Lockstep.Emitting && NowMs >= MigrationEmitStart) return;
                    if (Lockstep.AcceptFrame(f))
                        foreach (var r2 in HelloPeers()) if (r2.Id != rec.Id) SendLink(r2, PeerChannel.Reliable, Wire.BuildFrame(f.Tick, f.Commands));
                    return;
                }
                case Wire.HostClaim:
                {
                    var r = new Wire.Reader(body);
                    var epoch = r.U16(); var hostId = r.U16(); r.I64();
                    if (epoch > _epoch || (epoch == _epoch && hostId < _you)) Demote(hostId, epoch);
                    return;
                }
                case Wire.Raw:
                {
                    if (!AllowRaw(rec.Id)) return;
                    var payload = body.ToArray();
                    if (route == 0 || route == _you)
                        MessageReceived?.Invoke(rec.Id, payload, ch == PeerChannel.Fast ? Channel.Fast : Channel.Reliable);
                    if (route == 0)
                    {
                        var f = Wire.WithRoute(data, rec.Id);
                        foreach (var r2 in HelloPeers()) if (r2.Id != rec.Id) SendLink(r2, ch, f);
                    }
                    else if (route != _you)
                    {
                        if (_peers.TryGetValue(route, out var dest) && dest.Hello) SendLink(dest, ch, Wire.WithRoute(data, rec.Id));
                    }
                    return;
                }
                case Wire.Chat:
                {
                    if (!rec.Hello) return;
                    var r = new Wire.Reader(body);
                    var id = r.U32(); r.I64(); var len = r.U16();
                    var raw = r.Bytes(len);
                    if (len > TextChat.MaxBytes) { SendLink(rec, PeerChannel.Reliable, Wire.BuildChatReject(id, Wire.ChatLength)); return; }
                    Chat.HostHandle(rec.Id, id, Wire.DecodeUtf8(raw));
                    return;
                }
                case Wire.Voice:
                {
                    if (!rec.Hello) return;
                    var flags = body.Length > 2 ? body[2] : (byte)0;
                    if (ch != PeerChannel.Voice || !Voice.HostAdmit(rec.Id, data.Length, flags, NowMs)) return;
                    var fwd = Wire.WithRoute(data, rec.Id);
                    foreach (var r2 in HelloPeers()) if (r2.Id != rec.Id) SendLink(r2, PeerChannel.Voice, fwd);
                    Voice.OnPacket(rec.Id, body, NowMs);
                    return;
                }
            }
        }

        private long MigrationEmitStart => _migrationEmitStartMs;
        private long _migrationEmitStartMs;
        private bool _migrationHold;

        private void HandleAsJoiner(PeerRec rec, PeerChannel ch, byte type, int route, ReadOnlySpan<byte> body)
        {
            if (type == Wire.HostClaim)
            {
                var cr = new Wire.Reader(body);
                var epoch = cr.U16(); var claimant = cr.U16(); var tick = cr.I64();
                if (claimant == rec.Id) AcceptClaim(rec, epoch, claimant, tick);
                return;
            }
            if (rec.Id != _hostId) return; // otherwise joiners only listen to the host
            switch (type)
            {
                case Wire.WelcomeDc:
                {
                    var r = new Wire.Reader(body);
                    var tick = r.I64(); r.U8(); r.U8(); var host = r.U16();
                    if (host != _hostId) return;
                    if (tick > 0) SetPhase(LobbyPhase.InGame);
                    if (!_ready) { _ready = true; Ready?.Invoke(); _readyTcs.TrySetResult(true); }
                    RaiseReady(rec);
                    return;
                }
                case Wire.ChatHistory:
                {
                    var r = new Wire.Reader(body);
                    int n = r.U16();
                    var lines = new List<ChatLine>(n);
                    for (var i = 0; i < n; i++)
                    {
                        var peer = r.U16(); var id = r.U32(); var ts = r.I64(); var len = r.U16();
                        lines.Add(new ChatLine(peer, id, ts, Wire.DecodeUtf8(r.Bytes(len))));
                    }
                    Chat.SetHistory(lines);
                    return;
                }
                case Wire.FrameMsg:
                {
                    if (Lockstep == null) return;
                    var f = Wire.ParseFrame(body);
                    _lastFrameRxMs = NowMs;
                    if (f.Tick > Lockstep.LastReceivedTick + 1)
                    {
                        // a gap: ask for a snapshot instead of guessing
                        if (Lockstep.ShouldRequestSnapshot(NowMs)) SendToHost(PeerChannel.Reliable, Wire.BuildSnapshotReq(Lockstep.Tick));
                        return;
                    }
                    if (Lockstep.AcceptFrame(f))
                    {
                        _hasState = true;
                        if (_phase == LobbyPhase.Lobby) SetPhase(LobbyPhase.InGame);
                    }
                    return;
                }
                case Wire.Desync:
                {
                    var r = new Wire.Reader(body);
                    var tick = r.I64(); var hostHash = r.U64(); var yours = r.U64();
                    Lockstep?.RaiseDesync(new DesyncInfo(tick, hostHash, yours, ++_localResyncs));
                    return;
                }
                case Wire.Snapshot:
                {
                    var r = new Wire.Reader(body);
                    var tick = r.I64(); var total = r.U32(); var flags = r.U8();
                    _snap = (tick, total, flags);
                    rec.Chunks.Clear();
                    return;
                }
                case Wire.Raw:
                    MessageReceived?.Invoke(route, body.ToArray(), ch == PeerChannel.Fast ? Channel.Fast : Channel.Reliable);
                    return;
                case Wire.Chat:
                {
                    var r = new Wire.Reader(body);
                    var id = r.U32(); var ts = r.I64(); var len = r.U16();
                    Chat.Deliver(new ChatLine(route, id, ts, Wire.DecodeUtf8(r.Bytes(len))));
                    return;
                }
                case Wire.ChatReject:
                {
                    var r = new Wire.Reader(body);
                    var id = r.U32(); var reason = r.U8();
                    Chat.OnReject(id, reason);
                    return;
                }
                case Wire.Voice:
                    if (ch == PeerChannel.Voice) Voice.OnPacket(route, body, NowMs);
                    return;
            }
        }

        private void ApplySnapshot(long tick, byte flags, byte[] bytes)
        {
            var ls = Lockstep;
            if (ls == null) return;
            if ((flags & Wire.SnapshotDeflate) != 0) bytes = Zlib.Inflate(bytes);
            if (ls.Restore == null) { _c.RaiseError(new LobbyError("no_restore", "a snapshot arrived but LockstepSession.Restore is not set")); return; }
            ls.Restore(tick, bytes);
            ls.ResetTo(tick);
            _hasState = true;
            if (_phase == LobbyPhase.Lobby) SetPhase(LobbyPhase.InGame);
        }

        // ---- snapshots and hashes (host) -----------------------------------------------------------------------

        private void SendSnapshot(PeerRec rec)
        {
            var ls = Lockstep;
            if (ls == null) return;
            if (ls.Snapshot == null)
            {
                _c.RaiseError(new LobbyError("no_snapshot", "LockstepSession.Snapshot is not set; cannot late-join or resync"));
                return;
            }
            var tick = ls.Tick;
            var bytes = ls.Snapshot();
            byte flags = 0;
            if (bytes.Length >= 1024)
            {
                var z = Zlib.Deflate(bytes);
                if (z.Length < bytes.Length) { bytes = z; flags = Wire.SnapshotDeflate; }
            }
            SendLink(rec, PeerChannel.Reliable, Wire.BuildSnapshot(tick, (uint)bytes.Length, flags));
            var id = ++_chunkId;
            foreach (var chunk in Chunker.Split(id, bytes, SnapshotChunkSize)) SendLink(rec, PeerChannel.Reliable, chunk);
            foreach (var f in ls.LogAfter(tick)) SendLink(rec, PeerChannel.Reliable, Wire.BuildFrame(f.Tick, f.Commands));
        }

        internal void CompareHash(PeerRec rec, long tick, ulong hostHash, ulong theirs)
        {
            if (hostHash == theirs) return;
            rec.Resyncs++;
            if (rec.Resyncs >= 3)
            {
                _c.SendRaw(Signaling.Kick(rec.Id));
                DropPeer(rec, "desync");
                return;
            }
            SendLink(rec, PeerChannel.Reliable, Wire.BuildDesync(tick, hostHash, theirs));
            SendSnapshot(rec);
        }

        // ---- roster / server messages --------------------------------------------------------------------------

        internal void OnSignalingMessage(string t, JsonElement e)
        {
            if (_closed) return;
            switch (t)
            {
                case "peer_joined":
                {
                    if (!e.TryGetProperty("peer", out var p)) return;
                    var id = Signaling.Int(p, "peerId");
                    // a resume that beat the departure grace: the old seat goes now, the new one connects fresh
                    if (_peers.TryGetValue(id, out var leaving) && leaving.Departure != null) FinishDeparture(leaving);
                    if (_closed || id == _you || _peers.ContainsKey(id)) return;
                    var rec = new PeerRec { Id = id, Name = Signaling.Str(p, "name") };
                    _peers[id] = rec;
                    if (IsHost) ConnectPeer(rec, true);
                    PeerJoined?.Invoke(ToPeer(rec));
                    return;
                }
                case "peer_left":
                {
                    var id = Signaling.Int(e, "peerId");
                    var reason = Signaling.Str(e, "reason", "left");
                    if (id == _you) { End(reason is "kicked" or "disconnected" ? reason : "server_closed"); return; }
                    if (!_peers.TryGetValue(id, out var rec) || rec.Departure != null) return;
                    if (!IsHost && id == _hostId) Depart(rec, () => { DropPeer(rec, reason); HostLost(true); });
                    else Depart(rec, () => DropPeer(rec, reason));
                    return;
                }
                case "host_changed":
                {
                    var id = Signaling.Int(e, "hostId");
                    var ep = Signaling.Int(e, "epoch");
                    if (id != _hostId && id != 0) SwitchHost(id);
                    if (ep > _epoch && id == _hostId) _epoch = ep;
                    return;
                }
                case "join_request":
                {
                    if (e.TryGetProperty("peer", out var p)) JoinRequested?.Invoke(new Peer(Signaling.Int(p, "peerId"), Signaling.Str(p, "name"), 0, false));
                    return;
                }
                case "signal":
                {
                    var from = Signaling.Int(e, "from");
                    var sig = Signaling.ParseSignal(e);
                    if (sig == null || !_peers.TryGetValue(from, out var rec)) return;
                    if (rec.Link == null)
                    {
                        if (sig.SdpType != "offer" || IsHost) return;
                        ConnectPeer(rec, false); // a peer is dialing us (a new host, or a rival claimant): its claim decides
                    }
                    else if (IsHost && sig.SdpType == "offer" && _epoch == 0 && !rec.Hello && !rec.Link.IsOpen)
                    {
                        // a joiner whose link never opened dials us itself (its relay-only retry): answer that offer
                        ConnectPeer(rec, false);
                    }
                    rec.Link!.ApplySignal(sig);
                    return;
                }
                case "lobby":
                {
                    var m = Signaling.ParseLobby(e);
                    _meta = m.Meta;
                    if (!string.IsNullOrEmpty(m.ResumeToken)) ResumeToken = m.ResumeToken;
                    SetPhase(m.Phase);
                    foreach (var p in m.Peers)
                        if (!_peers.ContainsKey(p.PeerId))
                        {
                            var rec = new PeerRec { Id = p.PeerId, Name = p.Name };
                            _peers[p.PeerId] = rec;
                            if (IsHost && p.PeerId != _you) ConnectPeer(rec, true);
                            PeerJoined?.Invoke(ToPeer(rec));
                        }
                    if (m.HostId != _hostId) SwitchHost(m.HostId);
                    return;
                }
            }
        }

        internal void OnServerError(LobbyError err, bool disconnected = false)
        {
            if (err.Code == "kicked") End(disconnected ? "disconnected" : "kicked");
        }

        internal void OnSocketClosed()
        {
            if (_closed) return;
            if (DirectJoiner)
            {
                if (_peers.TryGetValue(_hostId, out var host)) Depart(host, () => End("host_left"));
                else End("host_left");
                return;
            }
            // data channels keep the running game alive (DESIGN s.9); only a joiner without a host link is stranded
            if (!IsHost && !_ready && !_awaitingClaim) End("server_closed");
        }

        private static Peer ToPeer(PeerRec r) => new(r.Id, r.Name, r.PingMs, r.Link?.Relayed ?? false);

        /// <summary>
        /// <c>linger</c> (host kick / disconnect): stop using the link now but dispose it only after
        /// <see cref="KickLingerMs"/>. The hub tells the peer over its WebSocket; closing the data link first would look
        /// to it like the host vanished (a migration instead of the host's close).
        /// </summary>
        internal void DropPeer(PeerRec rec, string reason, bool linger = false)
        {
            if (!_peers.Remove(rec.Id)) return;
            if (linger && rec.Link != null) _lingering.Add((rec.Link, NowMs + KickLingerMs));
            else rec.Link?.Dispose();
            rec.Link = null;
            Lockstep?.DropPending(rec.Id);
            Voice.OnPeerGone(rec.Id);
            PeerLeft?.Invoke(ToPeer(rec), reason);
        }

        /// <summary>Run <paramref name="finish"/> now, or once the open link to <paramref name="rec"/> closes (at most <see cref="LeaveGraceMs"/>).</summary>
        private void Depart(PeerRec rec, Action finish)
        {
            if (rec.Departure != null) return;
            if (rec.Link == null) { finish(); return; }
            rec.Departure = finish;
            rec.DepartAtMs = NowMs + LeaveGraceMs;
            if (!rec.Link.IsOpen) FinishDeparture(rec);       // already closed: read what it delivered, then finish
        }

        private void FinishDeparture(PeerRec rec)
        {
            var finish = rec.Departure;
            rec.Departure = null;
            if (rec.Link != null) while (rec.Link.TryReceive(out var ch, out var data))
            {
                try { HandleFrame(rec, ch, data); }
                catch (FormatException) { /* malformed frame: drop */ }
                if (_closed || rec.Link == null) break;
            }
            if (!_closed) finish?.Invoke();
        }

        private void LinkLost(PeerRec rec)
        {
            if (IsHost) { if (rec.Id != _you) DropPeer(rec, "timeout"); return; }
            if (rec.Id == _hostId)
            {
                if (_awaitingClaim) return; // the Timeouts check elects the next one
                _peers.Remove(rec.Id);
                rec.Link?.Dispose();
                rec.Link = null;
                PeerLeft?.Invoke(ToPeer(rec), "timeout");
                HostLost(true);
            }
        }

        // ---- host migration (DESIGN s.9) -----------------------------------------------------------------------

        /// <summary>The host is gone. If <paramref name="alreadyRemoved"/> is false the old host is dropped from the roster first.</summary>
        private void HostLost(bool alreadyRemoved = false)
        {
            if (DirectJoiner) { End("host_left"); return; }
            if (!alreadyRemoved && _peers.TryGetValue(_hostId, out var old)) DropPeer(old, "timeout");
            _ready = false;
            ElectHost();
        }

        private void ElectHost()
        {
            if (_closed) return;
            var next = _peers.Keys.DefaultIfEmpty(_you).Min();
            if (next == _you) BecomeHost();
            else AwaitHost(next);
        }

        /// <summary>The server (or a signal) names the new host.</summary>
        private void SwitchHost(int id)
        {
            if (id == _hostId) return;
            if (DirectJoiner) { End("host_left"); return; }
            if (!IsHost && _peers.TryGetValue(_hostId, out var old) && id != old.Id && _peers.ContainsKey(id)) DropPeer(old, "timeout");
            _ready = false;
            if (id == _you) BecomeHost();
            else AwaitHost(id);
        }

        private void AwaitHost(int id)
        {
            _hostId = id;
            _awaitingClaim = true;
            _awaitDeadlineMs = NowMs + ClaimWaitMs;
            if (!_peers.TryGetValue(id, out var rec)) _peers[id] = rec = new PeerRec { Id = id, Name = "?" };
            if (rec.Link == null || rec.Link.IsFailed) ConnectPeer(rec, false);
        }

        /// <summary>A claim wins on a higher epoch, or an equal epoch with a lower host id than the current one.</summary>
        private void AcceptClaim(PeerRec rec, int epoch, int hostId, long tick)
        {
            if (!(epoch > _epoch || (epoch == _epoch && hostId < _hostId))) return;
            _epoch = epoch;
            var changed = hostId != _hostId || _awaitingClaim;
            _hostId = hostId;
            _awaitingClaim = false;
            _ready = true;
            if (rec.Link != null && rec.Link.IsOpen && !rec.HiSent) SendHi(rec);
            // replay what I hold beyond the new host's last frame
            if (Lockstep != null)
                foreach (var f in Lockstep.LogAfter(tick)) SendLink(rec, PeerChannel.Reliable, Wire.BuildFrame(f.Tick, f.Commands));
            if (changed) HostChanged?.Invoke(hostId);
        }

        private void BecomeHost()
        {
            _epoch++;
            _hostId = _you;
            _awaitingClaim = false;
            _ready = true;
            Chat.AdoptHostCounter();
            foreach (var r in _peers.Values.ToList()) if (r.Id != _you) ConnectPeer(r, true);
            if (Lockstep != null && _phase == LobbyPhase.InGame)
            {
                Lockstep.BeginEmitting(NowMs, MigrationGraceMs);
                _migrationEmitStartMs = NowMs + MigrationGraceMs;
                _migrationHold = true;
            }
            _c.SendRaw(Signaling.Build(w => { w.WriteString("t", "host_changed"); w.WriteNumber("hostId", _you); w.WriteNumber("epoch", _epoch); }));
            HostChanged?.Invoke(_you);
        }

        private void Demote(int newHost, int epoch)
        {
            _epoch = epoch;
            _hostId = newHost;
            Lockstep?.StopEmitting();
            foreach (var r in _peers.Values.ToList())
                if (r.Id != newHost && r.Link != null) { r.Link.Dispose(); r.Link = null; r.Hello = false; }
            _awaitingClaim = false;
            _ready = true;
            if (_peers.TryGetValue(newHost, out var h) && h.Link == null) ConnectPeer(h, false);
            HostChanged?.Invoke(newHost);
        }

        // ---- teardown ------------------------------------------------------------------------------------------

        private void End(string reason)
        {
            if (_closed) return;
            Close();
            SessionEnded?.Invoke(reason);
        }

        private void Close()
        {
            _closed = true;
            foreach (var r in _peers.Values) { r.Link?.Dispose(); r.Link = null; }
            foreach (var (link, _) in _lingering) link.Dispose();
            _lingering.Clear();
            foreach (var (tcs, _) in _flushes) tcs.TrySetResult(false);
            _flushes.Clear();
            Voice.Enabled = false;
            _c.LobbyClosed(this);
        }
    }
}
