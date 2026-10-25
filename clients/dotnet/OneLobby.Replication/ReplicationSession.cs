using System;
using System.Collections.Generic;
using System.Linq;

namespace OneLobby.Replication
{
    /// <summary>
    /// Host-authoritative state replication over a raw-mode <see cref="Lobby"/> (DESIGN s.18, spec/replication.md).
    /// <para>Host: <see cref="Spawn"/> entities, run one sim step per <see cref="NetworkClock.TryAdvance"/>, read each client's
    /// input with <see cref="TryGetInput"/>, then <see cref="SendSnapshot"/>. Each client gets a delta against the last
    /// snapshot it acknowledged, on the fast channel.</para>
    /// <para>Client: <see cref="SubmitInput"/> once per <see cref="Clock"/> tick, render remote entities with
    /// <see cref="TrySample{T}"/> at <see cref="RenderTick"/> (100 ms behind the host), and reconcile the local player with
    /// <see cref="TryGetLatest{T}"/> + <see cref="LastProcessedInput"/>.</para>
    /// Call <see cref="Pump"/> once per frame instead of <c>lobby.Pump()</c>; events fire inside it.
    /// </summary>
    public sealed class ReplicationSession : IDisposable
    {
        private sealed class HostEnt
        {
            public ushort Type;
            public int Owner;
            public IReplicatedEntity Source = null!;
            public byte[] Last = Array.Empty<byte>();
        }

        private sealed class ClientRec
        {
            public int Peer;
            public uint Ack;
            public readonly SortedDictionary<uint, (ulong View256, byte[] Bytes)> Inputs = new();
            public uint LastConsumed;
            public InputFrame Last;
            public bool HasLast;
            public long BytesSent;
        }

        private readonly Lobby _lobby;
        private readonly ByteWriter _w = new(), _recs = new();
        private readonly NetWriter _nw = new();
        private readonly NetReader _nr = new();
        private bool _disposed;

        // host
        private readonly SortedDictionary<uint, HostEnt> _hostEnts = new();
        private readonly Dictionary<int, ClientRec> _clients = new();
        private readonly HashSet<int> _joining = new(); // announced by the server, link not open yet
        private readonly Dictionary<uint, World> _sent = new();
        private readonly Queue<uint> _sentOrder = new();
        private uint _nextId = 1;

        // client
        private readonly SortedList<uint, World> _ring = new();
        private readonly Dictionary<uint, EntityInfo> _reported = new();
        private readonly List<(ulong View256, byte[] Bytes)> _recentInputs = new();
        private uint _ack;
        private uint _inputSeq;
        private uint _lastProcessed;
        private uint _newestTick;
        private double _offsetMs;
        private bool _haveOffset;
        private long _lastSampleMs;
        private double _renderTick;
        private bool _haveRender;
        private long _lastPumpMs;
        private long _lastInputSendMs = long.MinValue / 2;

        public ReplicationSession(Lobby lobby, ReplicationConfig? config = null)
        {
            _lobby = lobby ?? throw new ArgumentNullException(nameof(lobby));
            if (lobby.Mode != SyncMode.Raw) throw new InvalidOperationException("replication runs on a raw-mode lobby (SyncMode.Raw)");
            Config = config ?? new ReplicationConfig();
            IsHost = lobby.IsHost;
            Clock = new NetworkClock(Config.TickRate, () => _lobby.NowMs);
            _lobby.MessageReceived += OnMessage;
            _lobby.HostChanged += OnHostChanged;
            _lobby.PeerJoined += OnPeerJoined;
            _lobby.PeerReady += OnPeerReady;
            _lobby.PeerLeft += OnPeerLeft;
            if (IsHost)
                foreach (var p in lobby.Peers)
                    if (p.PeerId != lobby.LocalPeerId)
                    {
                        if (lobby.IsPeerReady(p.PeerId)) AddClient(p.PeerId);
                        else _joining.Add(p.PeerId);
                    }
            _lastPumpMs = lobby.NowMs;
        }

        public ReplicationConfig Config { get; }
        public bool IsHost { get; }
        public Lobby Lobby => _lobby;
        public int LocalPeerId => _lobby.LocalPeerId;
        /// <summary>Host: the authoritative sim tick. Client: the local input tick (same rate, its own count).</summary>
        public NetworkClock Clock { get; }
        public ReplicationStats Stats { get; } = new();

        /// <summary>Client: a reliable or fast event from the host; host: from a client. (from peerId, tick, payload).</summary>
        public event Action<int, uint, ReadOnlyMemory<byte>>? EventReceived;
        /// <summary>Client: an entity became visible at <see cref="RenderTick"/> (create the game object here).</summary>
        public event Action<EntityInfo>? EntitySpawned;
        /// <summary>Client: an entity is gone as of <see cref="RenderTick"/> (destroy the game object here).</summary>
        public event Action<EntityInfo>? EntityDespawned;
        /// <summary>Raw-mode payloads that are not replication messages (first byte other than 0x52), for the game's own use.</summary>
        public event Action<int, ReadOnlyMemory<byte>, Channel>? OtherMessage;
        /// <summary>Client: the host left. Host migration is not supported for replicated sessions (DESIGN s.18): end the match.</summary>
        public event Action? HostLost;

        /// <summary>True for payloads this session owns (first byte 0x52). Keep your own raw messages off that first byte.</summary>
        public static bool IsReplicationPayload(ReadOnlySpan<byte> payload) => Proto.IsReplication(payload);

        /// <summary>Pumps the lobby, then advances render time, raises spawn/despawn events and keeps acks flowing.</summary>
        public void Pump()
        {
            if (_disposed) return;
            _lobby.Pump();
            var now = _lobby.NowMs;
            var elapsed = now - _lastPumpMs;
            _lastPumpMs = now;
            if (IsHost) return;
            UpdateRenderTick(elapsed);
            ReportVisibility();
            if (_newestTick > 0 && now - _lastInputSendMs >= Config.TickMs) SendInputMessage(0); // ack-only keepalive
        }

        // ================================================================== host ====================================

        /// <summary>Host: register an entity. <paramref name="owner"/> is the controlling peerId, 0 = host-owned (AI, doors).</summary>
        public NetId Spawn(ushort typeId, int owner, IReplicatedEntity entity)
        {
            RequireHost();
            var id = _nextId++;
            _hostEnts[id] = new HostEnt { Type = typeId, Owner = owner, Source = entity ?? throw new ArgumentNullException(nameof(entity)) };
            return new NetId(id);
        }

        /// <summary>Host: remove an entity; clients see it disappear at the snapshot tick it was last absent from.</summary>
        public bool Despawn(NetId id)
        {
            RequireHost();
            return _hostEnts.Remove(id.Value);
        }

        public void SetOwner(NetId id, int owner)
        {
            RequireHost();
            if (_hostEnts.TryGetValue(id.Value, out var e)) e.Owner = owner;
        }

        /// <summary>
        /// Host: the entities spawned with <see cref="Spawn"/> and not yet despawned, as (id, type id, owner peer id).
        /// A live view: to despawn while looping, copy it first (<c>HostEntities.ToList()</c>). Empty on a client:
        /// clients learn entities from <see cref="EntitySpawned"/> / <see cref="EntityDespawned"/>.
        /// </summary>
        public IEnumerable<EntityInfo> HostEntities => _hostEnts.Select(kv => new EntityInfo(new NetId(kv.Key), kv.Value.Type, kv.Value.Owner));

        /// <summary>
        /// Host: peers receiving snapshots. A peer is added when its link is up (<see cref="Lobby.PeerReady"/>), not when
        /// the server announces it, and its first snapshot is a full one; it is removed on <see cref="Lobby.PeerLeft"/>.
        /// </summary>
        public IReadOnlyCollection<int> Clients => _clients.Keys;

        /// <summary>Host: true when <paramref name="peerId"/> is in <see cref="Clients"/> (its link is up and it gets snapshots).</summary>
        public bool IsClientReady(int peerId) => _clients.ContainsKey(peerId);

        /// <summary>Host: a peer's link is up and it joined <see cref="Clients"/> (spawn its avatar here). Fires on the pumping thread.</summary>
        public event Action<int>? ClientReady;

        /// <summary>Host: newest snapshot tick this client acknowledged (0 = none yet: it gets full snapshots).</summary>
        public uint AckedTick(int peerId) => _clients.TryGetValue(peerId, out var c) ? c.Ack : 0;

        /// <summary>Host: replication bytes sent to one client (payloads, no lobby header).</summary>
        public long BytesSentTo(int peerId) => _clients.TryGetValue(peerId, out var c) ? c.BytesSent : 0;

        /// <summary>
        /// Host: this tick's input from a client. One call per client per tick. Returns the next input in sequence; when
        /// none has arrived the previous one is repeated (<see cref="InputFrame.Repeated"/>); false only before the first.
        /// </summary>
        public bool TryGetInput(int peerId, out InputFrame input)
        {
            RequireHost();
            input = default;
            if (!_clients.TryGetValue(peerId, out var c)) return false;
            // latency cap: a client that got ahead (a burst after a stall) skips its oldest inputs
            while (c.Inputs.Count > Math.Max(1, Config.MaxInputBuffer))
            {
                var k = c.Inputs.Keys.First();
                c.Inputs.Remove(k);
                c.LastConsumed = k;
                Stats.InputsSkipped++;
            }
            if (c.Inputs.Count > 0)
            {
                var first = c.Inputs.First();
                c.Inputs.Remove(first.Key);
                if (first.Key > c.LastConsumed + 1) Stats.InputsLost += first.Key - c.LastConsumed - 1;
                c.LastConsumed = first.Key;
                c.Last = new InputFrame(first.Key, first.Value.View256 / 256.0, first.Value.Bytes, false);
                c.HasLast = true;
                input = c.Last;
                return true;
            }
            if (!c.HasLast) return false;
            Stats.InputsRepeated++;
            input = new InputFrame(c.Last.Seq, c.Last.ViewTick, c.Last.Bytes, true);
            return true;
        }

        /// <summary>Host: the tick to rewind hit volumes to for a shot in <paramref name="input"/>, clamped to MaxRewindMs.</summary>
        public double RewindTick(in InputFrame input)
        {
            var now = (double)Clock.Tick;
            var earliest = now - Config.MaxRewindMs / Config.TickMs;
            return Math.Min(now, Math.Max(earliest, input.ViewTick));
        }

        /// <summary>
        /// Host: capture every entity's state at <see cref="NetworkClock.Tick"/> and send each client its delta. Call once at
        /// the end of each sim tick; ticks not on <see cref="ReplicationConfig.SnapshotEveryTicks"/> are skipped.
        /// </summary>
        public void SendSnapshot()
        {
            RequireHost();
            var tick = Clock.Tick;
            if (tick == 0) throw new InvalidOperationException("advance the clock (Clock.TryAdvance) before the first snapshot");
            if (tick % (uint)Math.Max(1, Config.SnapshotEveryTicks) != 0 || _sent.ContainsKey(tick)) return;
            var list = new List<Ent>(_hostEnts.Count);
            foreach (var kv in _hostEnts)
            {
                var e = kv.Value;
                _nw.Reset();
                e.Source.Write(_nw);
                if (_nw.ByteCount > Proto.MaxStateBytes) throw new InvalidOperationException("entity state over " + Proto.MaxStateBytes + " bytes: " + kv.Key);
                if (!_nw.Span.SequenceEqual(e.Last)) e.Last = _nw.ToArray(); // unchanged state keeps the same array
                list.Add(new Ent(kv.Key, e.Type, e.Owner, e.Last));
            }
            var world = new World(tick, list);
            _sent[tick] = world;
            _sentOrder.Enqueue(tick);
            while (_sentOrder.Count > 0 && _sentOrder.Peek() + (uint)Config.HistoryTicks < tick) _sent.Remove(_sentOrder.Dequeue());

            foreach (var c in _clients.Values)
            {
                World? baseline = null;
                if (c.Ack != 0 && _sent.TryGetValue(c.Ack, out var b)) baseline = b;
                var bytes = Proto.EncodeSnapshot(world, baseline, c.LastConsumed, _w, _recs);
                _lobby.Send(c.Peer, bytes, Channel.Fast);
                c.BytesSent += bytes.Length;
                Stats.SnapshotsSent++;
                if (baseline == null) Stats.FullSnapshotsSent++;
                Stats.SnapshotBytesSent += bytes.Length;
                if (bytes.Length > Stats.LargestSnapshot) Stats.LargestSnapshot = bytes.Length;
                if (bytes.Length > Config.SnapshotWarnBytes) Stats.OversizeSnapshots++;
            }
        }

        /// <summary>
        /// Host: event to one client (<paramref name="toPeer"/>) or all (0). Client: event to the host (toPeer ignored).
        /// Reliable by default (ordered, never lost); Fast for cosmetic one-offs. Stamped with the current tick.
        /// </summary>
        public void SendEvent(ReadOnlySpan<byte> payload, int toPeer = 0, Channel channel = Channel.Reliable)
        {
            var tick = IsHost ? Clock.Tick : (uint)Math.Max(0, Math.Floor(ServerTick));
            var bytes = Proto.EncodeEvent(tick, payload, _w);
            Stats.EventsSent++;
            if (!IsHost) { _lobby.Send(_lobby.HostPeerId, bytes, channel); return; }
            if (toPeer != 0) { _lobby.Send(toPeer, bytes, channel); return; }
            foreach (var c in _clients.Keys) _lobby.Send(c, bytes, channel);
            foreach (var c in _joining) _lobby.Send(c, bytes, channel); // reliable ones are queued until the link opens
        }

        private void AddClient(int peer)
        {
            _joining.Remove(peer);
            if (_clients.ContainsKey(peer)) return;
            _clients[peer] = new ClientRec { Peer = peer }; // Ack 0: the first snapshot it gets is a full one
            ClientReady?.Invoke(peer);
        }

        private void OnPeerJoined(Peer p) { if (IsHost && p.PeerId != LocalPeerId && !_clients.ContainsKey(p.PeerId)) _joining.Add(p.PeerId); }
        private void OnPeerReady(Peer p) { if (IsHost && p.PeerId != LocalPeerId) AddClient(p.PeerId); }
        private void OnPeerLeft(Peer p, string reason) { _clients.Remove(p.PeerId); _joining.Remove(p.PeerId); }

        private void HostReceiveInput(int from, ReadOnlySpan<byte> payload)
        {
            if (!_clients.TryGetValue(from, out var c)) return;
            var (ack, _, inputs) = Proto.DecodeInput(payload);
            if (ack <= Clock.Tick && ack > c.Ack && _sent.ContainsKey(ack)) c.Ack = ack;
            foreach (var (seq, view, bytes) in inputs)
            {
                if (seq == 0 || seq <= c.LastConsumed || c.Inputs.ContainsKey(seq)) continue;
                c.Inputs[seq] = (view, bytes);
                Stats.InputsReceived++;
            }
        }

        // ================================================================== client ==================================

        /// <summary>Client: estimated current host tick (fractional).</summary>
        public double ServerTick => _haveOffset ? (_lobby.NowMs + _offsetMs) / Config.TickMs : 0;

        /// <summary>Client: the host tick being rendered: <see cref="ServerTick"/> minus the interpolation delay, smoothed.</summary>
        public double RenderTick => _renderTick;

        /// <summary>Client: newest snapshot tick received.</summary>
        public uint LatestTick => _newestTick;

        /// <summary>Client: the last of my inputs the host had applied in the newest snapshot (for <see cref="Reconciler{TInput,TState}"/>).</summary>
        public uint LastProcessedInput => _lastProcessed;

        /// <summary>Client: entities visible at <see cref="RenderTick"/>.</summary>
        public IReadOnlyCollection<EntityInfo> Entities => _reported.Values;

        public bool IsMine(EntityInfo e) => e.Owner == LocalPeerId;

        /// <summary>
        /// Client: queue one input for the host and send it with the previous <see cref="ReplicationConfig.InputRedundancy"/>-1
        /// inputs on the fast channel. Call once per <see cref="Clock"/> tick. Returns the input's sequence number.
        /// </summary>
        public uint SubmitInput(ReadOnlySpan<byte> input)
        {
            if (IsHost) throw new InvalidOperationException("the host applies its own input directly");
            if (input.Length > 1024) throw new ArgumentException("input over 1024 bytes");
            _inputSeq++;
            _recentInputs.Insert(0, ((ulong)Math.Max(0, Math.Round(_renderTick * 256)), input.ToArray()));
            var keep = Math.Max(1, Math.Min(255, Config.InputRedundancy));
            if (_recentInputs.Count > keep) _recentInputs.RemoveRange(keep, _recentInputs.Count - keep);
            SendInputMessage(_recentInputs.Count);
            return _inputSeq;
        }

        private void SendInputMessage(int count)
        {
            // keep the datagram small: drop redundant copies past ~1000 bytes
            var size = 0;
            var n = 0;
            for (; n < count; n++) { size += _recentInputs[n].Bytes.Length + 6; if (n > 0 && size > 1000) break; }
            var bytes = Proto.EncodeInput(_ack, _inputSeq, _recentInputs, n, _w);
            _lobby.Send(_lobby.HostPeerId, bytes, Channel.Fast);
            _lastInputSendMs = _lobby.NowMs;
            Stats.InputsSent += n > 0 ? 1 : 0;
            Stats.InputBytesSent += bytes.Length;
        }

        /// <summary>Client: an entity's state interpolated at <see cref="RenderTick"/>. False if it is not visible then.</summary>
        public bool TrySample<T>(NetId id, out T state) where T : IReplicatedState<T>, new() => TrySampleAt(id, _renderTick, out state);

        /// <summary>Client: an entity's state interpolated at any tick still in the snapshot buffer.</summary>
        public bool TrySampleAt<T>(NetId id, double tick, out T state) where T : IReplicatedState<T>, new()
        {
            state = default!;
            if (_ring.Count == 0) return false;
            var keys = _ring.Keys;
            var ai = FloorIndex(tick);
            if (ai < 0) return false;
            var a = _ring.Values[ai];
            var ia = a.IndexOf(id.Value);
            if (ia < 0) return false;
            var sa = Decode<T>(a.Ents[ia].State);
            if (ai + 1 < _ring.Count && tick > keys[ai])
            {
                var b = _ring.Values[ai + 1];
                var ib = b.IndexOf(id.Value);
                if (ib >= 0 && b.Ents[ib].Type == a.Ents[ia].Type)
                {
                    var sb = Decode<T>(b.Ents[ib].State);
                    var t = (float)((tick - keys[ai]) / ((double)keys[ai + 1] - keys[ai]));
                    state = sa.Interpolate(sb, t);
                    return true;
                }
            }
            state = sa; // newest known (or despawning next): hold, never extrapolate
            return true;
        }

        /// <summary>Client: the entity's state in the newest snapshot (not interpolated), e.g. the local player's authoritative state.</summary>
        public bool TryGetLatest<T>(NetId id, out T state, out uint tick) where T : IReplicatedState<T>, new()
        {
            state = default!; tick = 0;
            if (_ring.Count == 0) return false;
            var w = _ring.Values[_ring.Count - 1];
            var i = w.IndexOf(id.Value);
            if (i < 0) return false;
            state = Decode<T>(w.Ents[i].State);
            tick = w.Tick;
            return true;
        }

        /// <summary>Client: info for an entity in the newest snapshot (owner, type), even before it is visible.</summary>
        public EntityInfo? Find(NetId id)
        {
            if (_ring.Count == 0) return null;
            var w = _ring.Values[_ring.Count - 1];
            var i = w.IndexOf(id.Value);
            return i < 0 ? null : new EntityInfo(id, w.Ents[i].Type, w.Ents[i].Owner);
        }

        private T Decode<T>(byte[] bytes) where T : IReplicatedState<T>, new()
        {
            var s = new T();
            _nr.Reset(bytes, bytes.Length);
            s.Read(_nr);
            return s;
        }

        private int FloorIndex(double tick)
        {
            var keys = _ring.Keys;
            int lo = 0, hi = keys.Count - 1, best = -1;
            while (lo <= hi)
            {
                var mid = (lo + hi) >> 1;
                if (keys[mid] <= tick) { best = mid; lo = mid + 1; } else hi = mid - 1;
            }
            return best;
        }

        private void ClientReceiveSnapshot(ReadOnlySpan<byte> payload)
        {
            var h = Proto.PeekSnapshot(payload);
            if (_ring.ContainsKey(h.Tick) || (_newestTick > (uint)Config.HistoryTicks && h.Tick < _newestTick - (uint)Config.HistoryTicks)) return;
            World? baseline = null;
            if (h.BaselineTick != 0 && !_ring.TryGetValue(h.BaselineTick, out baseline)) { Stats.SnapshotsDropped++; return; }
            var world = Proto.DecodeSnapshot(payload, baseline);
            _ring[h.Tick] = world;
            Stats.SnapshotsReceived++;
            var now = _lobby.NowMs;
            if (h.Tick > _newestTick)
            {
                _newestTick = h.Tick;
                _ack = h.Tick;
                _lastProcessed = h.LastInputSeq;
            }
            while (_ring.Count > 0 && _ring.Keys[0] + (uint)Config.HistoryTicks < _newestTick) _ring.RemoveAt(0);
            // clock: the least-delayed packet shows the host's clock best; let the estimate decay slowly towards later ones
            var sample = h.Tick * Config.TickMs - now;
            if (!_haveOffset || sample > _offsetMs) _offsetMs = sample;
            else _offsetMs = Math.Max(sample, _offsetMs - (now - _lastSampleMs) * 0.05);
            _haveOffset = true;
            _lastSampleMs = now;
        }

        private void UpdateRenderTick(long elapsedMs)
        {
            if (!_haveOffset) return;
            var target = ServerTick - Config.InterpolationDelayMs / Config.TickMs;
            if (!_haveRender || Math.Abs(target - _renderTick) > 10) { _renderTick = target; _haveRender = true; return; }
            // advance with the local clock and close 10% of the error per pump; never run backwards
            var next = _renderTick + elapsedMs / Config.TickMs;
            next += (target - next) * 0.1;
            if (next > _renderTick) _renderTick = next;
        }

        private void ReportVisibility()
        {
            var ai = FloorIndex(_renderTick);
            if (ai < 0) return;
            var w = _ring.Values[ai];
            List<EntityInfo>? gone = null;
            foreach (var kv in _reported)
            {
                var i = w.IndexOf(kv.Key);
                if (i < 0 || w.Ents[i].Type != kv.Value.TypeId) (gone ??= new()).Add(kv.Value);
            }
            if (gone != null) foreach (var g in gone) { _reported.Remove(g.Id.Value); EntityDespawned?.Invoke(g); }
            foreach (var e in w.Ents)
            {
                if (_reported.TryGetValue(e.Id, out var info))
                {
                    if (info.Owner != e.Owner) _reported[e.Id] = info with { Owner = e.Owner };
                    continue;
                }
                var ni = new EntityInfo(new NetId(e.Id), e.Type, e.Owner);
                _reported[e.Id] = ni;
                EntitySpawned?.Invoke(ni);
            }
        }

        // ================================================================== shared ==================================

        private void OnMessage(int from, ReadOnlyMemory<byte> payload, Channel channel)
        {
            var span = payload.Span;
            if (!Proto.IsReplication(span)) { OtherMessage?.Invoke(from, payload, channel); return; }
            if (span[1] != Proto.Version) { Stats.Malformed++; return; }
            try
            {
                switch (span[2])
                {
                    case Proto.KindSnapshot:
                        if (!IsHost && from == _lobby.HostPeerId) ClientReceiveSnapshot(span);
                        break;
                    case Proto.KindInput:
                        if (IsHost) HostReceiveInput(from, span);
                        break;
                    case Proto.KindEvent:
                    {
                        if (!IsHost && from != _lobby.HostPeerId) return;
                        var (tick, body) = Proto.DecodeEvent(span);
                        Stats.EventsReceived++;
                        EventReceived?.Invoke(from, tick, body);
                        break;
                    }
                }
            }
            catch (MalformedException) { Stats.Malformed++; }
        }

        private void OnHostChanged(int newHost)
        {
            if (!IsHost) HostLost?.Invoke();
        }

        // test seams (InternalsVisibleTo OneLobby.Replication.Tests)
        internal World? HostWorld(uint tick) => _sent.TryGetValue(tick, out var w) ? w : null;
        internal IEnumerable<World> ClientWorlds => _ring.Values;

        private void RequireHost()
        {
            if (!IsHost) throw new InvalidOperationException("host only");
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _lobby.MessageReceived -= OnMessage;
            _lobby.HostChanged -= OnHostChanged;
            _lobby.PeerJoined -= OnPeerJoined;
            _lobby.PeerReady -= OnPeerReady;
            _lobby.PeerLeft -= OnPeerLeft;
        }
    }
}
