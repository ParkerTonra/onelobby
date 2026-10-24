using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace Keepalive
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
        }

        public const int HostTimeoutMs = 8000;
        public const int PeerTimeoutMs = 10000;
        public const int PingEveryMs = 1000;
        public const int ClaimWaitMs = 6000;
        public const int MigrationGraceMs = 1500;

        private readonly LobbyClient _c;
        private readonly ITransport _t;
        private readonly SortedDictionary<int, PeerRec> _peers = new();
        private readonly int _you;
        private int _hostId;
        private int _epoch;
        private bool _ready;
        private bool _closed;
        private bool _hasState;
        private bool _awaitingClaim;
        private long _awaitDeadlineMs;
        private long _lastPingMs;
        private uint _pingN;
        private uint _chunkId;
        private int _localResyncs;
        private (long Tick, uint Total, byte Flags)? _snap;
        private readonly ChunkAssembler _chunks = new();
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
            Voice = new VoiceChannel(this);
            Chat = new TextChat(this);
            if (Mode == SyncMode.Lockstep) Lockstep = new LockstepSession(this);
        }

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

        /// <summary>True once the data channel to the host is up and welcomed (always true on the host).</summary>
        public bool IsReady => _ready;

        private readonly TaskCompletionSource<bool> _readyTcs = new();

        /// <summary>Completes when <see cref="IsReady"/> first becomes true (immediately for a host).</summary>
        public Task ReadyAsync => _readyTcs.Task;

        public IReadOnlyList<Peer> Peers => _peers.Values.Select(r =>
            new Peer(r.Id, r.Name, r.PingMs, r.Link?.Relayed ?? false)).ToList();

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

        internal long NowMs => _t.NowMs;

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

        public Task KickAsync(int peerId)
        {
            if (!IsHost) throw new InvalidOperationException("only the host kicks");
            _c.SendRaw(Signaling.Kick(peerId));
            if (_peers.TryGetValue(peerId, out var rec)) DropPeer(rec, "kicked");
            return Task.CompletedTask;
        }

        public Task ApproveAsync(int peerId, bool ok)
        {
            if (!IsHost) throw new InvalidOperationException("only the host approves");
            _c.SendRaw(Signaling.Approve(peerId, ok));
            return Task.CompletedTask;
        }

        public Task LeaveAsync()
        {
            if (_closed) return Task.CompletedTask;
            _c.SendRaw(Signaling.Simple("leave"));
            Close();
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync() => new(LeaveAsync());

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
            }
        }

        internal IEnumerable<PeerRec> PeerRecords() => _peers.Values.ToList();
        private IEnumerable<PeerRec> HelloPeers() => _peers.Values.Where(r => r.Id != _you && r.Hello && r.Link != null && r.Link.IsOpen).ToList();
        internal bool IsLocallyMuted(int peerId) => Voice.IsMuted(peerId);

        private void ConnectPeer(PeerRec rec, bool initiator)
        {
            rec.Link?.Dispose();
            rec.OpenHandled = false;
            rec.Hello = false;
            rec.HiSent = false;
            rec.Link = _t.CreatePeerLink(new PeerLinkOptions(rec.Id, initiator, _c.Ice, _c.Config.RelayOnly));
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
            foreach (var rec in _peers.Values.ToList())
            {
                if (rec.Link == null || _closed) continue;
                while (rec.Link.TryTakeSignal(out var sig)) _c.SendRaw(Signaling.Signal(rec.Id, sig));
                if (rec.Link.IsFailed)
                {
                    LinkLost(rec);
                    continue;
                }
                if (rec.Link.IsOpen && !rec.OpenHandled) { rec.OpenHandled = true; rec.OpenedMs = rec.LastRxMs = now; OnLinkOpen(rec); }
                while (rec.Link != null && rec.Link.TryReceive(out var ch, out var data))
                {
                    rec.LastRxMs = now;
                    try { HandleFrame(rec, ch, data); }
                    catch (FormatException) { /* malformed frame: drop */ }
                    if (_closed) return;
                }
            }
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

        private void Timeouts(long now)
        {
            if (IsHost)
            {
                foreach (var r in _peers.Values.ToList())
                    if (r.Id != _you && r.Link != null && r.OpenHandled && now - r.LastRxMs > PeerTimeoutMs) DropPeer(r, "timeout");
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
            if (!_awaitingClaim && _peers.TryGetValue(_hostId, out var h) && h.OpenHandled && now - h.LastRxMs > HostTimeoutMs)
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

        private void HandleFrame(PeerRec rec, PeerChannel ch, byte[] data)
        {
            if (Wire.Validate(data) != null) return;
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
            }
            if (IsHost) HandleAsHost(rec, ch, type, route, body, data);
            else HandleAsJoiner(rec, ch, type, route, body);
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
                    SendLink(rec, PeerChannel.Reliable, Wire.BuildWelcomeDc(Lockstep?.Head ?? 0, TickRate,
                        Mode == SyncMode.Raw ? Wire.ModeRaw : Wire.ModeLockstep, _you));
                    SendLink(rec, PeerChannel.Reliable, Wire.BuildChatHistory(Chat.History));
                    if (Lockstep != null && _phase == LobbyPhase.InGame && (Lockstep.Head > 0 || lastTick >= 0))
                    {
                        if (lastTick >= 0 && Lockstep.LogCovers(lastTick))
                        {
                            foreach (var f in Lockstep.LogAfter(lastTick)) SendLink(rec, PeerChannel.Reliable, Wire.BuildFrame(f.Tick, f.Commands));
                        }
                        else SendSnapshot(rec);
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
                    _chunks.Clear();
                    return;
                }
                case Wire.Chunk:
                {
                    if (!_chunks.TryAdd(body, out _, out var all)) return;
                    if (_snap is not { } s)
                    {
                        // an oversized frame sent in chunks: the bytes are one complete inner frame
                        if (all.Length > 0 && all[0] != Wire.Chunk && Wire.Validate(all) == null) HandleFrame(rec, ch, all);
                        return;
                    }
                    _snap = null;
                    if (s.Total != all.Length) { SendToHost(PeerChannel.Reliable, Wire.BuildSnapshotReq(Lockstep?.Tick ?? -1)); return; }
                    ApplySnapshot(s.Tick, s.Flags, all);
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
                    if (id == _you || _peers.ContainsKey(id)) return;
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
                    if (id == _you) { End(reason == "kicked" ? "kicked" : "server_closed"); return; }
                    if (!_peers.TryGetValue(id, out var rec)) return;
                    if (!IsHost && id == _hostId) { DropPeer(rec, reason); HostLost(true); }
                    else DropPeer(rec, reason);
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

        internal void OnServerError(LobbyError err)
        {
            if (err.Code == "kicked") End("kicked");
        }

        internal void OnSocketClosed()
        {
            if (_closed) return;
            // data channels keep the running game alive (DESIGN s.9); only a joiner without a host link is stranded
            if (!IsHost && !_ready && !_awaitingClaim) End("server_closed");
        }

        private static Peer ToPeer(PeerRec r) => new(r.Id, r.Name, r.PingMs, r.Link?.Relayed ?? false);

        internal void DropPeer(PeerRec rec, string reason)
        {
            if (!_peers.Remove(rec.Id)) return;
            rec.Link?.Dispose();
            rec.Link = null;
            Lockstep?.DropPending(rec.Id);
            Voice.OnPeerGone(rec.Id);
            PeerLeft?.Invoke(ToPeer(rec), reason);
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
            Voice.Enabled = false;
            _c.LobbyClosed(this);
        }
    }
}
