using System;
using System.Collections.Generic;

namespace OneLobby.Replication
{
    /// <summary>Who places a player: its own peer (<see cref="Owner"/>, the default) or the host (<see cref="Host"/>).</summary>
    public enum PlayerAuthority { Owner, Host }

    /// <summary>Which host limit an owner's update broke.</summary>
    public enum LimitKind { Speed, Step, TeleportRate }

    /// <summary>Host mode: one movement step for one player. Runs on the host for everyone and on the owner for prediction; it must be deterministic.</summary>
    public delegate PlayerState PlayerStepFunc(PlayerState state, PlayerInput input, double dt);

    /// <summary>The settings of <see cref="NetPlayers"/>; the first six are <c>blueprint.sync.player</c>.</summary>
    public sealed class NetPlayersOptions
    {
        public PlayerAuthority Authority { get; init; } = PlayerAuthority.Owner;
        /// <summary>"3d" or "2d".</summary>
        public string Space { get; init; } = "3d";
        public double Range { get; init; } = 300;
        public double VelocityRange { get; init; } = 32;
        /// <summary>The host's limits; a limit that is null is not checked.</summary>
        public PlayerLimits Limits { get; init; } = new PlayerLimits(null, null, null, null);
        /// <summary>Preset fields and events left out (see <see cref="PlayerWire.Omittable"/>).</summary>
        public IReadOnlyList<string> Omit { get; init; } = Array.Empty<string>();
        /// <summary>Host mode: the movement step (also settable on <see cref="NetPlayers.Step"/>).</summary>
        public PlayerStepFunc? Step { get; init; }
        /// <summary>Host mode, host side: where a player starts (a full state; default: the default player at the origin).</summary>
        public Func<int, PlayerState>? Spawn { get; init; }
        /// <summary>Settings of the session the layer makes (ignored when you pass your own session).</summary>
        public ReplicationConfig? Session { get; init; }
        /// <summary>Whether a session the layer makes uses the adaptive render delay (default true).</summary>
        public bool AdaptiveDelay { get; init; } = true;
    }

    /// <summary>Numbers of spec/net-player.md; constants of the wire contract.</summary>
    public static class NetPlayer
    {
        /// <summary>An action event is sent on the fast channel in this many consecutive ticks (and once on the reliable one).</summary>
        public const int EventRepeats = 4;
        /// <summary>A player is carried on by its velocity for at most this long past the newest snapshot, then held.</summary>
        public const double CarryOnMaxMs = 250;
        /// <summary>Owner mode: a claimed move may be this much faster than <c>maxSpeed</c> before it counts.</summary>
        public const double SpeedTolerance = 1.25;
        /// <summary>Owner mode with limits: an owner-raised teleport is accepted at most this often.</summary>
        public const long TeleportMinIntervalMs = 1000;
        /// <summary>A rate limit allows this fraction of its interval, less one tick.</summary>
        public const double RateTolerance = 0.9;
        /// <summary>Host mode: a correction is blended over this long.</summary>
        public const float CorrectionBlendMs = 100;
        public const float SnapHorizontal = 2.0f;
        public const float SnapVertical = 0.5f;
        /// <summary>The claimed tick of an event may be at most this many ticks older than the host's tick when it arrives.</summary>
        public const int ClaimMaxAgeTicks = 15;
        /// <summary>The host raises the teleport counter by this much (an owner raises it by 1).</summary>
        public const int HostTeleportStep = 4;
    }

    /// <summary>One action event, as the game sees it.</summary>
    public readonly struct ActionEvent
    {
        public ActionEvent(int player, PlayerAction name, ActionArgs args, uint tick, uint seq, bool late, bool local)
        { Player = player; Name = name; Args = args; Tick = tick; Seq = seq; Late = late; Local = local; }
        /// <summary>Peer id of the player it belongs to.</summary>
        public int Player { get; }
        public PlayerAction Name { get; }
        public ActionArgs Args { get; }
        /// <summary>Host tick it happened.</summary>
        public uint Tick { get; }
        /// <summary>Per-player number (the host's numbering for events that travelled through the host).</summary>
        public uint Seq { get; }
        /// <summary>True when it arrived after the render time had passed its tick and was played at once.</summary>
        public bool Late { get; }
        /// <summary>True for this peer's own events (played at once, never relayed back).</summary>
        public bool Local { get; }
        internal ActionEvent AsLate() => new(Player, Name, Args, Tick, Seq, true, Local);
    }

    public sealed class PlayerStats
    {
        public long ActionsSent { get; internal set; }
        public long ActionsPlayed { get; internal set; }
        /// <summary>Played at once because they arrived after their tick had been rendered.</summary>
        public long ActionsLate { get; internal set; }
        /// <summary>Second copies dropped by sequence number.</summary>
        public long ActionsDuplicate { get; internal set; }
        /// <summary>Dropped by the host's rate limit and not relayed.</summary>
        public long ActionsRateLimited { get; internal set; }
        /// <summary>Dropped as not allowed (wrong sender, host-only event, left out, bad arguments).</summary>
        public long ActionsRejected { get; internal set; }
        /// <summary>Owner states that did not decode.</summary>
        public long StatesRejected { get; internal set; }
        /// <summary>Owner updates the host refused (a limit), each answered with a raised teleport counter.</summary>
        public long LimitViolations { get; internal set; }
        /// <summary>The host raised the teleport counter and this owner took the host's state (host mode: a correction that snapped).</summary>
        public long Corrections { get; internal set; }
    }

    /// <summary>
    /// The networked player layer over one <see cref="ReplicationSession"/> (spec/net-player.md): players in the world with no
    /// player sync of your own. One replicated entity of type <see cref="PlayerWire.PlayerTypeId"/> per seated peer, action
    /// events that arrive exactly once and play at the right moment, the host's limits, prediction and hit rewind.
    /// No engine type is used: the Unity component and the Godot node (a later lane) wrap this class.
    /// Call <see cref="Pump"/> every frame instead of <see cref="ReplicationSession.Pump"/>.
    /// </summary>
    public sealed class NetPlayers : IDisposable
    {
        private sealed class HostPlayer : IReplicatedEntity
        {
            public int Peer;
            public PlayerCodec Codec = null!;
            public NetId EntityId;
            public PlayerState State;
            public bool Spawned;
            /// <summary>Owner mode: ignore owner states until the owner shows the raised teleport counter.</summary>
            public bool Awaiting;
            public long LastAcceptTick, LastTeleportMs, LastShotTick, LastMeleeTick;
            public uint RelaySeq;
            public void Write(NetWriter w) => Codec.WriteState(w, State);
        }

        private sealed class Dedupe { public uint Floor; public readonly HashSet<uint> Seen = new(); }
        private sealed class OutEntry { public WireEvent Ev; public int Left; }
        private struct Sample { public long At, Sent, Received; }

        private readonly Lobby _lobby;
        private readonly Func<int, PlayerState> _spawnFn;
        private readonly Dictionary<int, HostPlayer> _hostPlayers = new();
        private readonly HistoryRing<PlayerState> _history;
        private readonly Dictionary<int, NetId> _known = new();
        private readonly Dictionary<int, Dedupe> _inDedupe = new();
        private readonly Dictionary<int, Dedupe> _relayDedupe = new();
        private readonly Dictionary<int, List<OutEntry>> _outboxes = new();
        private readonly List<(ActionEvent Ev, uint At)> _queue = new();
        private readonly Dictionary<uint, int> _sentTeleport = new();
        private readonly Dictionary<int, List<Sample>> _samples = new();
        private readonly Dictionary<int, NetId> _present = new();
        private readonly HashSet<int> _spectators = new();
        private readonly HashSet<int> _want = new();
        private readonly List<int> _scratchPeers = new();
        private readonly List<WireEvent> _decoded = new();
        private readonly List<WireEvent> _batch = new();
        private readonly List<WireEvent> _one = new();
        private readonly ByteWriter _bw = new();
        private long _lastSampleMs = -1_000_000_000;
        private uint _mySeq;
        private long _lastPumpMs;
        private bool _disposed;

        // local player
        private PlayerState _localState = new();
        private bool _haveLocal;
        private PlayerInput _localInput;
        private Reconciler<PlayerInput, PlayerState>? _predictor;
        private uint _lastCorrectTick;
        private uint _lastSentSeq;
        private uint _ignoreUntilSeq;

        /// <summary>The layer over a session you made (give it <c>AdaptiveDelay: true</c> for smooth remote players).</summary>
        public NetPlayers(ReplicationSession session, NetPlayersOptions? options = null)
        {
            var opts = options ?? new NetPlayersOptions();
            Session = session ?? throw new ArgumentNullException(nameof(session));
            _lobby = session.Lobby;
            Authority = opts.Authority;
            Codec = new PlayerCodec(new PlayerWireConfig(opts.Space, opts.Range, opts.VelocityRange, opts.Omit));
            Limits = opts.Limits ?? new PlayerLimits(null, null, null, null);
            Step = opts.Step;
            _spawnFn = opts.Spawn ?? (_ => new PlayerState());
            Smoother = new PredictionSmoother(NetPlayer.CorrectionBlendMs, NetPlayer.SnapHorizontal, NetPlayer.SnapVertical);
            _history = new HistoryRing<PlayerState>(session.Config.HistoryTicks, (a, b, t) => Codec.Lerp(a, b, t));
            _lastPumpMs = _lobby.NowMs;
            _localInput = default;
            session.RegisterKind(PlayerWire.KindPlayerEvents, OnEvents);
            _lobby.PeerLeft += OnPeerLeft;
        }

        /// <summary>The layer over a raw-mode lobby: it makes the session (with the adaptive render delay on unless <see cref="NetPlayersOptions.AdaptiveDelay"/> is false).</summary>
        public NetPlayers(Lobby lobby, NetPlayersOptions? options = null)
            : this(new ReplicationSession(lobby, (options?.Session ?? new ReplicationConfig()) with { AdaptiveDelay = options?.AdaptiveDelay ?? true }), options)
        { }

        /// <summary>The layer from a lobby and the loaded blueprint: <c>sync.player</c> and <c>sync.tickRate</c>. <paramref name="extra"/> adds <see cref="NetPlayersOptions.Step"/> and <see cref="NetPlayersOptions.Spawn"/>.</summary>
        public static NetPlayers FromConfig(Lobby lobby, Blueprint blueprint, NetPlayersOptions? extra = null)
        {
            var p = blueprint.Sync.Player;
            var opts = new NetPlayersOptions
            {
                Authority = p.Authority == "host" ? PlayerAuthority.Host : PlayerAuthority.Owner,
                Space = p.Space, Range = p.Range, VelocityRange = p.VelocityRange, Limits = p.Limits, Omit = p.Omit,
                Step = extra?.Step, Spawn = extra?.Spawn, AdaptiveDelay = extra?.AdaptiveDelay ?? true,
                Session = (extra?.Session ?? new ReplicationConfig()) with { TickRate = blueprint.Sync.TickRate },
            };
            return new NetPlayers(lobby, opts);
        }

        public ReplicationSession Session { get; }
        public PlayerAuthority Authority { get; }
        public PlayerCodec Codec { get; }
        public PlayerLimits Limits { get; }
        public PlayerStats Stats { get; } = new();
        /// <summary>Host mode: the movement step (also settable here after construction).</summary>
        public PlayerStepFunc? Step { get; set; }
        /// <summary>Smooths host-mode corrections of the local player (draw at <see cref="Local"/> + <c>Smoother.Offset</c>).</summary>
        public PredictionSmoother Smoother { get; }

        public bool IsHost => Session.IsHost;
        public int LocalPeerId => Session.LocalPeerId;
        private double TickMs => Session.Clock.TickMs;
        private double Dt => 1.0 / Session.Config.TickRate;

        /// <summary>A player appeared (every peer sees every player, the local one included).</summary>
        public event Action<int>? PlayerJoined;
        /// <summary>A player is gone (its peer left, or it became a spectator).</summary>
        public event Action<int>? PlayerLeft;
        /// <summary>Every action event, for every player (the local one included). Filter on <see cref="ActionEvent.Name"/>.</summary>
        public event Action<ActionEvent>? OnAction;
        /// <summary>Host: one local tick is about to run (step your own world here, before the snapshot). Client: one input tick.</summary>
        public event Action<uint>? Tick;
        /// <summary>Owner mode: the host put this player back (a limit, or a teleport by the host); take the state as yours.</summary>
        public event Action<PlayerState>? Corrected;
        /// <summary>Host: an owner's update broke a limit (peer id, which limit).</summary>
        public event Action<int, LimitKind>? LimitViolation;

        // ================================================================== public API ==================================

        /// <summary>Peers whose player is in the world right now (as this peer sees it, the local one included). A live view.</summary>
        public IReadOnlyCollection<int> Players => _known.Keys;

        /// <summary>
        /// Owner mode: give the layer your player's state. Sent every tick; call as often as you like. The teleport counter in
        /// <paramref name="state"/> is ignored: it is the layer's to keep (use <see cref="Teleport(PlayerState)"/>).
        /// </summary>
        public void SetLocalState(in PlayerState state)
        {
            if (Authority != PlayerAuthority.Owner) throw new InvalidOperationException("SetLocalState is for authority Owner; hand over input with SetLocalInput");
            var keep = _haveLocal ? _localState.Teleport : 0;
            _localState = state;
            _localState.Teleport = keep;
            _haveLocal = true;
        }

        /// <summary>Host mode: the input of the current tick; sent and stepped once per tick.</summary>
        public void SetLocalInput(in PlayerInput input)
        {
            if (Authority != PlayerAuthority.Host) throw new InvalidOperationException("SetLocalInput is for authority Host; give your state with SetLocalState");
            _localInput = input;
        }

        /// <summary>
        /// The local player's state: yours in owner mode, the predicted one in host mode (draw it at <c>Local</c> + <c>Smoother.Offset</c>).
        /// Authority Host on a client: null until the host's first state of this player has arrived (the player starts where the
        /// host spawned it, never at the origin); inputs before that are neither sent nor stepped.
        /// </summary>
        public PlayerState? Local
        {
            get
            {
                if (Authority == PlayerAuthority.Owner) return _localState;
                if (IsHost) return _hostPlayers.TryGetValue(LocalPeerId, out var hp) ? hp.State : null;
                return _predictor?.Current;
            }
        }

        /// <summary>
        /// One player's state to draw now. The local player: <see cref="Local"/>. A remote player: its state at render time (about 100 ms behind,
        /// more on a jittery link), turning on the shortest arc, carried on by its velocity for at most 250 ms past the newest snapshot,
        /// then held. On the host a remote player is the host's own record one tick behind, interpolated through the hit-rewind history;
        /// one record alone, or a teleport between two records, is held, never blended. False while the player is not in the world.
        /// </summary>
        public bool TryGet(int peerId, out PlayerState state)
        {
            state = default;
            if (peerId == LocalPeerId)
            {
                if (!(_known.ContainsKey(peerId) || _haveLocal || Authority == PlayerAuthority.Host)) return false;
                var l = Local;
                if (l == null) return false;
                state = l.Value;
                return true;
            }
            if (IsHost)
            {
                if (!_hostPlayers.TryGetValue(peerId, out var hp) || !hp.Spawned) return false;
                if (!_history.TrySample(new NetId((uint)peerId), (double)Session.Clock.Tick - 1 + Session.Clock.Alpha, out state)) state = hp.State;
                return true;
            }
            if (!_known.TryGetValue(peerId, out var id)) return false;
            if (!Session.TrySampleAt(id, Session.RenderTick, Codec, out var s)) return false;
            var overMs = (Session.RenderTick - Session.LatestTick) * TickMs;
            if (overMs > 0 && Codec.Has("velocity"))
            {
                var k = Math.Min(overMs, NetPlayer.CarryOnMaxMs) / 1000;
                var R = Codec.Config.Range;
                s.X = Clamp(s.X + s.Vx * k, R); s.Y = Clamp(s.Y + s.Vy * k, R);
                if (Codec.Is3D) s.Z = Clamp(s.Z + s.Vz * k, R);
            }
            state = s;
            return true;
        }

        /// <summary><see cref="TryGet"/> as a nullable.</summary>
        public PlayerState? Get(int peerId) => TryGet(peerId, out var s) ? s : null;

        private static double Clamp(double v, double r) => Math.Max(-r, Math.Min(r, v));

        /// <summary>The authoritative state of a player in the newest snapshot (not smoothed). Host: its own record.</summary>
        public bool TryGetLatest(int peerId, out PlayerState state)
        {
            state = default;
            if (IsHost)
            {
                if (!_hostPlayers.TryGetValue(peerId, out var hp)) return false;
                state = hp.State;
                return true;
            }
            return _known.TryGetValue(peerId, out var id) && Session.TryGetLatest(id, Codec, out state, out _);
        }

        public PlayerState? Latest(int peerId) => TryGetLatest(peerId, out var s) ? s : null;

        /// <summary>Send an action event for the local player. It plays here at once. A shoot with <c>View</c> 0 gets the render tick x 256.</summary>
        public void Action(PlayerAction name, ActionArgs args = default)
        {
            if (!Codec.HasEvent(name)) throw new InvalidOperationException("action \"" + PlayerWire.Name(name) + "\" is left out in this game's blueprint");
            if (PlayerWire.IsHostOrigin(name) && !IsHost) throw new InvalidOperationException("\"" + PlayerWire.Name(name) + "\" is raised by the host");
            EmitFrom(LocalPeerId, name, args);
        }

        /// <summary>Host: raise an action event for any player (<c>Hit</c> and <c>Death</c> come from here).</summary>
        public void HostAction(int peerId, PlayerAction name, ActionArgs args = default)
        {
            RequireHost();
            if (!Codec.HasEvent(name)) throw new InvalidOperationException("action \"" + PlayerWire.Name(name) + "\" is left out in this game's blueprint");
            EmitFrom(peerId, name, args);
        }

        /// <summary>
        /// Owner mode: put the local player somewhere else without sliding (the counter is raised by 1). On the host: the same for the
        /// host's own player. For another player use <see cref="TeleportPlayer"/>. <paramref name="to"/> is the whole new state.
        /// </summary>
        public void Teleport(PlayerState to)
        {
            if (IsHost) { TeleportPlayer(LocalPeerId, to); return; }
            if (Authority != PlayerAuthority.Owner) throw new InvalidOperationException("on a client only authority Owner can teleport itself; the host places a Host player");
            var counter = (_localState.Teleport + 1) % PlayerWire.TeleportModulo;
            _localState = to;
            _localState.Teleport = counter;
            _haveLocal = true;
        }

        /// <summary>Teleport to a position, keeping the rest of the local state.</summary>
        public void Teleport(double x, double y, double z = 0)
        {
            var s = Local ?? new PlayerState();
            s.X = x; s.Y = y; s.Z = z;
            Teleport(s);
        }

        /// <summary>Host: place any player (respawn point, portal) without sliding. In owner mode the owner is told to take the host's state.</summary>
        public void TeleportPlayer(int peerId, PlayerState to)
        {
            RequireHost();
            if (!_hostPlayers.TryGetValue(peerId, out var p)) return;
            to.Teleport = (p.State.Teleport + NetPlayer.HostTeleportStep) % PlayerWire.TeleportModulo;
            p.State = Codec.QuantizeState(to);
            if (peerId == LocalPeerId) { _localState = p.State; _haveLocal = true; }
            else if (Authority == PlayerAuthority.Owner) p.Awaiting = true;
            p.LastTeleportMs = _lobby.NowMs;
            p.LastAcceptTick = Session.Clock.Tick;
            if (!p.Spawned) SpawnEntity(p);
        }

        /// <summary>Owner mode (and the host's own player): a teleport that also makes the player alive with full health, then the <c>Respawn</c> event.</summary>
        public void Respawn(PlayerState at)
        {
            if (IsHost) { RespawnPlayer(LocalPeerId, at); return; }
            at.Alive = true; at.Health = 100;
            Teleport(at);
            if (Codec.HasEvent(PlayerAction.Respawn)) Action(PlayerAction.Respawn);
        }

        /// <summary>Respawn where the local player is.</summary>
        public void Respawn() => Respawn(Local ?? new PlayerState());

        /// <summary>Host: respawn any player (a teleport, alive, full health, and the <c>Respawn</c> event).</summary>
        public void RespawnPlayer(int peerId, PlayerState at)
        {
            RequireHost();
            at.Alive = true; at.Health = 100;
            TeleportPlayer(peerId, at);
            if (Codec.HasEvent(PlayerAction.Respawn)) EmitFrom(peerId, PlayerAction.Respawn, default);
        }

        /// <summary>Where a player was at a host tick (hit rewind). Host only; false when not recorded (too old, or never there).</summary>
        public bool TryStateAt(int peerId, double tick, out PlayerState state)
        {
            RequireHost();
            return _history.TrySample(new NetId((uint)peerId), tick, out state);
        }

        /// <summary>Host: where a player was when a shooter saw the world at <paramref name="view"/> (a shoot's <c>View</c>, in 1/256 ticks), clamped by the session's rewind limit.</summary>
        public bool TryRewound(int peerId, uint view, out PlayerState state)
        {
            RequireHost();
            return _history.TrySample(new NetId((uint)peerId), RewindTickFor(view), out state);
        }

        /// <summary>The host tick a shooter was seeing, clamped to the session's <c>MaxRewindMs</c>.</summary>
        public double RewindTick(uint view)
        {
            RequireHost();
            return RewindTickFor(view);
        }

        private double RewindTickFor(uint view)
        {
            var now = (double)Session.Clock.Tick;
            var earliest = now - Session.Config.MaxRewindMs / Session.Config.TickMs;
            return Math.Min(now, Math.Max(earliest, view / 256.0));
        }

        /// <summary>Replication bytes per second to and from one peer over about the last second. Host: any client. Client: the host.</summary>
        public (double Sent, double Received) BytesPerSecond(int peerId)
        {
            if (!_samples.TryGetValue(peerId, out var list) || list.Count < 2) return (0, 0);
            var a = list[0];
            var b = list[list.Count - 1];
            var secs = (b.At - a.At) / 1000.0;
            return secs > 0 ? ((b.Sent - a.Sent) / secs, (b.Received - a.Received) / secs) : (0, 0);
        }

        /// <summary>Advance everything: call every frame instead of <see cref="ReplicationSession.Pump"/>. Runs the due ticks, snapshots, events and corrections.</summary>
        public void Pump()
        {
            if (_disposed) return;
            var now = _lobby.NowMs;
            var elapsed = now - _lastPumpMs;
            _lastPumpMs = now;
            Session.Pump();
            if (IsHost) HostRoster(); else ClientRoster();
            while (Session.Clock.TryAdvance())
            {
                var tick = Session.Clock.Tick;
                Tick?.Invoke(tick);
                if (IsHost) HostTick(tick); else ClientTick();
                FlushOutboxes();
            }
            if (!IsHost)
            {
                ClientCorrections();
                Smoother.Update(elapsed);
            }
            PlayQueue();
            SampleTraffic(now);
        }

        /// <summary>Stop listening. The session stays yours.</summary>
        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _lobby.PeerLeft -= OnPeerLeft;
        }

        // ================================================================== internals ==================================

        private void RequireHost()
        {
            if (!IsHost) throw new InvalidOperationException("host only");
        }

        private void OnPeerLeft(Peer p, string reason)
        {
            _inDedupe.Remove(p.PeerId);
            _outboxes.Remove(p.PeerId);
            _samples.Remove(p.PeerId);
        }

        private void SampleTraffic(long now)
        {
            if (now - _lastSampleMs < 100) return;
            _lastSampleMs = now;
            if (IsHost) { foreach (var peer in Session.Clients) AddSample(peer, now); }
            else AddSample(Session.HostPeerId, now);
        }

        private void AddSample(int peer, long now)
        {
            var t = Session.TrafficWith(peer);
            if (!_samples.TryGetValue(peer, out var list)) _samples[peer] = list = new List<Sample>();
            list.Add(new Sample { At = now, Sent = t.Sent, Received = t.Received });
            while (list.Count > 2 && now - list[1].At >= 1000) list.RemoveAt(0);
        }

        // ---- roster --------------------------------------------------------------------------------------------------

        private void HostRoster()
        {
            _spectators.Clear();
            foreach (var e in _lobby.Room.Entries) if (e.Role == RoomRole.Spectator) _spectators.Add(e.Id);
            _want.Clear();
            if (!_spectators.Contains(LocalPeerId)) _want.Add(LocalPeerId);
            foreach (var peer in Session.Clients) if (!_spectators.Contains(peer)) _want.Add(peer);
            foreach (var peer in _want) if (!_hostPlayers.ContainsKey(peer)) AddHostPlayer(peer);
            _scratchPeers.Clear();
            foreach (var peer in _hostPlayers.Keys) if (!_want.Contains(peer)) _scratchPeers.Add(peer);
            foreach (var peer in _scratchPeers)
            {
                var p = _hostPlayers[peer];
                if (p.Spawned) Session.Despawn(p.EntityId);
                _history.Forget(new NetId((uint)peer));
                _hostPlayers.Remove(peer);
                _relayDedupe.Remove(peer);
                if (_known.Remove(peer)) PlayerLeft?.Invoke(peer);
            }
        }

        private void AddHostPlayer(int peer)
        {
            var p = new HostPlayer
            {
                Peer = peer, Codec = Codec, State = Codec.QuantizeState(_spawnFn(peer)), LastAcceptTick = Session.Clock.Tick,
                LastTeleportMs = -1_000_000_000, LastShotTick = -1_000_000_000, LastMeleeTick = -1_000_000_000,
            };
            _hostPlayers[peer] = p;
            // host mode: the host places the player at once; owner mode: it appears with its first state
            if (Authority == PlayerAuthority.Host) SpawnEntity(p);
        }

        private void SpawnEntity(HostPlayer p)
        {
            p.EntityId = Session.Spawn(PlayerWire.PlayerTypeId, p.Peer, p);
            p.Spawned = true;
            _known[p.Peer] = p.EntityId;
            PlayerJoined?.Invoke(p.Peer);
        }

        private void ClientRoster()
        {
            _present.Clear();
            foreach (var e in Session.Entities) if (e.TypeId == PlayerWire.PlayerTypeId) _present[e.Owner] = e.Id;
            foreach (var kv in _present)
            {
                if (_known.TryGetValue(kv.Key, out var cur) && cur == kv.Value) continue;
                var fresh = !_known.ContainsKey(kv.Key);
                _known[kv.Key] = kv.Value;
                if (fresh) PlayerJoined?.Invoke(kv.Key);
            }
            _scratchPeers.Clear();
            foreach (var peer in _known.Keys) if (!_present.ContainsKey(peer)) _scratchPeers.Add(peer);
            foreach (var peer in _scratchPeers)
            {
                _known.Remove(peer);
                _relayDedupe.Remove(peer);
                if (peer == LocalPeerId) _predictor = null;
                PlayerLeft?.Invoke(peer);
            }
        }

        // ---- host tick -----------------------------------------------------------------------------------------------

        private void HostTick(uint tick)
        {
            var now = _lobby.NowMs;
            foreach (var kv in _hostPlayers)
            {
                var p = kv.Value;
                if (kv.Key == LocalPeerId) HostLocal(p);
                else if (Session.TryGetInput(kv.Key, out var f) && !f.Repeated)
                {
                    if (Authority == PlayerAuthority.Owner) AcceptOwnerState(p, f.Bytes.Span, tick, now);
                    else StepRemote(p, f.Bytes.Span);
                }
                if (p.Spawned) _history.Record(tick, new NetId((uint)kv.Key), p.State);
            }
            Session.SendSnapshot();
        }

        private void HostLocal(HostPlayer p)
        {
            if (Authority == PlayerAuthority.Owner)
            {
                if (!_haveLocal) return;
                p.State = Codec.QuantizeState(_localState);
                _localState = p.State;
            }
            else
            {
                var input = Codec.QuantizeInput(_localInput);
                p.State = RunStep(p.State, input);
                _localState = p.State;
            }
            p.LastAcceptTick = Session.Clock.Tick;
            if (!p.Spawned) SpawnEntity(p);
        }

        private PlayerState RunStep(PlayerState s, PlayerInput input)
        {
            if (Step == null) throw new InvalidOperationException("authority Host needs a step function: new NetPlayers(lobby, new NetPlayersOptions { Authority = PlayerAuthority.Host, Step = ... })");
            return Codec.QuantizeState(Step(s, input, Dt));
        }

        private void StepRemote(HostPlayer p, ReadOnlySpan<byte> bytes)
        {
            if (!Codec.DecodeInput(bytes, out var input)) { Stats.StatesRejected++; return; }
            p.State = RunStep(p.State, input);
            p.LastAcceptTick = Session.Clock.Tick;
        }

        private void AcceptOwnerState(HostPlayer p, ReadOnlySpan<byte> bytes, uint tick, long now)
        {
            if (!Codec.DecodeState(bytes, out var s)) { Stats.StatesRejected++; return; }
            if (!p.Spawned)
            {
                p.State = s;
                p.LastAcceptTick = tick;
                SpawnEntity(p);
                return;
            }
            if (p.Awaiting)
            {
                if (s.Teleport != p.State.Teleport) return; // still the old counter: this state is from before the correction
                p.Awaiting = false;
            }
            var prev = p.State;
            var raised = s.Teleport != prev.Teleport;
            LimitKind? violation = null;
            if (raised)
            {
                if (AnyMoveLimit() && now - p.LastTeleportMs < NetPlayer.TeleportMinIntervalMs) violation = LimitKind.TeleportRate;
                else p.LastTeleportMs = now;
            }
            else
            {
                var dist = Distance(prev, s);
                if (Limits.MaxStep is int maxStep && dist > maxStep) violation = LimitKind.Step;
                else if (Limits.MaxSpeed is int maxSpeed)
                {
                    var secs = Math.Max(1, tick - p.LastAcceptTick) * TickMs / 1000;
                    var posStep = 2 * Codec.Config.Range / (Math.Pow(2, Codec.PosBits) - 1);
                    if (dist > maxSpeed * secs * NetPlayer.SpeedTolerance + 2 * posStep) violation = LimitKind.Speed;
                }
            }
            if (violation is LimitKind kind)
            {
                Stats.LimitViolations++;
                p.State = prev;
                p.State.Teleport = (prev.Teleport + NetPlayer.HostTeleportStep) % PlayerWire.TeleportModulo;
                p.Awaiting = true;
                p.LastAcceptTick = tick;
                LimitViolation?.Invoke(p.Peer, kind);
                return;
            }
            p.State = s;
            p.LastAcceptTick = tick;
        }

        private bool AnyMoveLimit() => Limits.MaxSpeed != null || Limits.MaxStep != null;

        private double Distance(in PlayerState a, in PlayerState b)
        {
            var dx = b.X - a.X;
            var dy = b.Y - a.Y;
            var dz = Codec.Is3D ? b.Z - a.Z : 0;
            return Math.Sqrt(dx * dx + dy * dy + dz * dz);
        }

        // ---- client tick ---------------------------------------------------------------------------------------------

        private void ClientTick()
        {
            if (Authority == PlayerAuthority.Owner)
            {
                if (!_haveLocal) return;
                var seq = Session.SubmitInput(Codec.EncodeStateSpan(_localState));
                _lastSentSeq = seq;
                _sentTeleport[seq] = _localState.Teleport;
                _sentTeleport.Remove(seq - 256);
                return;
            }
            // host mode: start from the host's first state of this player (where it spawned it), send the input, predict the step at once
            if (_predictor == null)
            {
                if (!_known.TryGetValue(LocalPeerId, out var id) || !Session.TryGetLatest(id, Codec, out var first, out var firstTick)) return; // no state yet: this input is neither sent nor stepped
                var r = new Reconciler<PlayerInput, PlayerState>(first, (s, i) => RunStep(s, i));
                r.Equal = (a, b) => Distance(a, b) <= 0.05;
                _predictor = r;
                _lastCorrectTick = firstTick;                     // the predictor already is this state: no correction, no snap
                Smoother.Correct(0, 0, 0, first.Teleport);        // only records the counter
            }
            var input = Codec.QuantizeInput(_localInput);
            var iseq = Session.SubmitInput(Codec.EncodeInputSpan(input));
            _predictor.Predict(iseq, input);
        }

        private void ClientCorrections()
        {
            if (!_known.TryGetValue(LocalPeerId, out var id)) return;
            if (!Session.TryGetLatest(id, Codec, out var auth, out var latestTick) || latestTick <= _lastCorrectTick) return;
            _lastCorrectTick = latestTick;
            if (Authority == PlayerAuthority.Owner)
            {
                // the host put me back when the snapshot shows another teleport counter than the one I sent in the input it applied
                var processed = Session.LastProcessedInput;
                if (_sentTeleport.TryGetValue(processed, out var sent) && processed > _ignoreUntilSeq && auth.Teleport != sent)
                {
                    _ignoreUntilSeq = _lastSentSeq; // inputs already on their way still carry the old counter
                    _localState = auth;
                    _haveLocal = true;
                    Stats.Corrections++;
                    Corrected?.Invoke(auth);
                }
                return;
            }
            if (_predictor == null) return;
            var before = _predictor.Current;
            var after = _predictor.Reconcile(auth, Session.LastProcessedInput);
            var dz = Codec.Is3D ? after.Z - before.Z : after.Y - before.Y;
            var snapped = Smoother.Correct((float)(after.X - before.X), Codec.Is3D ? (float)(after.Y - before.Y) : 0f, (float)dz, auth.Teleport);
            if (snapped) Stats.Corrections++;
        }

        // ---- action events -------------------------------------------------------------------------------------------

        private void EmitFrom(int player, PlayerAction name, ActionArgs args)
        {
            if (name == PlayerAction.Shoot && args.View == 0) args.View = (uint)Math.Max(0, Math.Floor(Session.RenderTick * 256 + 0.5));
            // what the others see is what the wire carries: quantised
            var bytes = Codec.EncodeArgs(name, args);
            Codec.DecodeArgs(name, bytes, out var wire);
            var tick = IsHost ? Session.Clock.Tick : (uint)Math.Max(0, Math.Floor(Session.ServerTick));
            Stats.ActionsSent++;
            var id = (byte)name;
            if (IsHost)
            {
                uint seq;
                if (_hostPlayers.TryGetValue(player, out var p)) seq = ++p.RelaySeq; else seq = ++_mySeq;
                Play(new ActionEvent(player, name, wire, tick, seq, false, player == LocalPeerId));
                var ev = new WireEvent((uint)player, seq, id, tick, bytes);
                _scratchPeers.Clear();
                foreach (var c in Session.Clients) _scratchPeers.Add(c);
                foreach (var c in _scratchPeers) Enqueue(c, ev);
            }
            else
            {
                var seq = ++_mySeq;
                Play(new ActionEvent(player, name, wire, tick, seq, false, true));
                Enqueue(Session.HostPeerId, new WireEvent((uint)player, seq, id, tick, bytes));
            }
        }

        /// <summary>Queue an event for a peer: one copy on the reliable channel now, and the next few ticks on the fast one.</summary>
        private void Enqueue(int peer, in WireEvent ev)
        {
            _one.Clear();
            _one.Add(ev);
            Session.SendExtension(peer, PlayerWire.Encode(_one, 1, _bw), Channel.Reliable);
            if (!_outboxes.TryGetValue(peer, out var box)) _outboxes[peer] = box = new List<OutEntry>();
            box.Add(new OutEntry { Ev = ev, Left = NetPlayer.EventRepeats });
        }

        private void FlushOutboxes()
        {
            foreach (var kv in _outboxes)
            {
                var box = kv.Value;
                if (box.Count == 0) continue;
                _batch.Clear();
                var size = 8;
                foreach (var e in box)
                {
                    var n = 12 + e.Ev.Args.Length;
                    if (_batch.Count > 0 && size + n > PlayerWire.MaxEventMessageBytes) break;
                    _batch.Add(e.Ev);
                    size += n;
                }
                Session.SendExtension(kv.Key, PlayerWire.Encode(_batch, _batch.Count, _bw), Channel.Fast);
                for (var i = 0; i < _batch.Count; i++) box[i].Left--;
                while (box.Count > 0 && box[0].Left <= 0) box.RemoveAt(0);
            }
        }

        private static bool Dedup(Dictionary<int, Dedupe> map, int key, uint seq)
        {
            if (!map.TryGetValue(key, out var d)) map[key] = d = new Dedupe();
            if (seq <= d.Floor || d.Seen.Contains(seq)) return false;
            d.Seen.Add(seq);
            while (d.Seen.Contains(d.Floor + 1)) d.Seen.Remove(++d.Floor);
            if (d.Seen.Count > 512)
            {
                var lowest = uint.MaxValue;
                foreach (var s in d.Seen) if (s < lowest) lowest = s;
                d.Floor = lowest - 1;
                while (d.Seen.Contains(d.Floor + 1)) d.Seen.Remove(++d.Floor);
            }
            return true;
        }

        private void OnEvents(int from, ReadOnlyMemory<byte> payload, Channel channel)
        {
            if (!IsHost && from != Session.HostPeerId) return;
            var err = PlayerWire.TryDecodePlayerEvents(payload.Span, _decoded);
            if (err != null) { Session.CountMalformed(); return; }
            foreach (var w in _decoded)
            {
                if (IsHost) HostReceive(from, w); else ClientReceive(w);
            }
        }

        private void HostReceive(int from, in WireEvent w)
        {
            var known = PlayerWire.IsKnown(w.Id);
            var def = (PlayerAction)w.Id;
            _hostPlayers.TryGetValue(from, out var p);
            if (!known || w.Player != (uint)from || PlayerWire.IsHostOrigin(def) || !Codec.HasEvent(def) || p == null)
            {
                if (Dedup(_inDedupe, from, w.Seq)) Stats.ActionsRejected++; else Stats.ActionsDuplicate++;
                return;
            }
            if (!Dedup(_inDedupe, from, w.Seq)) { Stats.ActionsDuplicate++; return; }
            if (!Codec.DecodeArgs(def, w.Args, out var args)) { Stats.ActionsRejected++; return; }
            var tick = Session.Clock.Tick;
            var claimed = Math.Min((long)tick + 1, Math.Max((long)tick - NetPlayer.ClaimMaxAgeTicks, w.Tick));
            if (!WithinRate(p, def, claimed)) { Stats.ActionsRateLimited++; return; }
            var seq = ++p.RelaySeq;
            Play(new ActionEvent(from, def, args, tick, seq, false, false));
            var ev = new WireEvent((uint)from, seq, w.Id, tick, w.Args);
            _scratchPeers.Clear();
            foreach (var c in Session.Clients) if (c != from) _scratchPeers.Add(c);
            foreach (var c in _scratchPeers) Enqueue(c, ev);
        }

        private bool WithinRate(HostPlayer p, PlayerAction name, long claimedTick)
        {
            int? min = name == PlayerAction.Shoot ? Limits.MinShotIntervalMs : name == PlayerAction.Melee ? Limits.MinMeleeIntervalMs : null;
            if (min == null) return true;
            var last = name == PlayerAction.Shoot ? p.LastShotTick : p.LastMeleeTick;
            var gapMs = (claimedTick - last) * TickMs;
            if (gapMs < min.Value * NetPlayer.RateTolerance - TickMs) return false;
            if (name == PlayerAction.Shoot) p.LastShotTick = claimedTick; else p.LastMeleeTick = claimedTick;
            return true;
        }

        private void ClientReceive(in WireEvent w)
        {
            var known = PlayerWire.IsKnown(w.Id);
            var def = (PlayerAction)w.Id;
            ActionArgs args = default;
            if (!known || !Codec.DecodeArgs(def, w.Args, out args) || !Codec.HasEvent(def)) { Stats.ActionsRejected++; return; }
            if (!Dedup(_relayDedupe, (int)w.Player, w.Seq)) { Stats.ActionsDuplicate++; return; }
            var ev = new ActionEvent((int)w.Player, def, args, w.Tick, w.Seq, false, false);
            var render = Session.RenderTick;
            if (w.Player == (uint)LocalPeerId || render <= 0) { Play(ev); return; }
            if (w.Tick <= render)
            {
                Stats.ActionsLate++;
                Play(ev.AsLate());
                return;
            }
            _queue.Add((ev, w.Tick));
        }

        private void PlayQueue()
        {
            if (_queue.Count == 0) return;
            var render = Session.RenderTick;
            // stable insertion sort by (tick, seq): the queue is short
            for (var i = 1; i < _queue.Count; i++)
            {
                var x = _queue[i];
                var j = i - 1;
                while (j >= 0 && (_queue[j].At > x.At || (_queue[j].At == x.At && _queue[j].Ev.Seq > x.Ev.Seq))) { _queue[j + 1] = _queue[j]; j--; }
                _queue[j + 1] = x;
            }
            while (_queue.Count > 0 && _queue[0].At <= render)
            {
                var e = _queue[0].Ev;
                _queue.RemoveAt(0);
                Play(e);
            }
        }

        private void Play(in ActionEvent e)
        {
            Stats.ActionsPlayed++;
            OnAction?.Invoke(e);
        }
    }
}
