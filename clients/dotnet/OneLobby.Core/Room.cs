using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;

namespace OneLobby
{
    /// <summary>What the lobby hands its room layer (see <see cref="Room"/>).</summary>
    internal sealed class RoomConfig
    {
        /// <summary>The host's settings; a joiner's are replaced by the host's snapshot.</summary>
        public RoomSettings Settings = null!;
        /// <summary>Host: the lobby password ("" = none).</summary>
        public string Password = "";
        /// <summary>This install's player id.</summary>
        public string Pid = "";
        public BanList Bans = null!;
        /// <summary>Joiner: what to send in <c>join</c>.</summary>
        public RoomRole JoinRole = RoomRole.Player;
        public IReadOnlyDictionary<string, string> JoinData = new Dictionary<string, string>();
        public string JoinPassword = "";
    }

    /// <summary>What the client hands a lobby for its room layer.</summary>
    internal sealed class RoomSetup
    {
        /// <summary>Host: settings (blueprint <c>room</c> plus code options).</summary>
        public RoomOptions? Options;
        /// <summary>Host: the lobby password.</summary>
        public string? Password;
        /// <summary>Host: the player count when the hub's capacity is larger (a hub without spectator slots got the sum).</summary>
        public int? MaxPlayers;
        /// <summary>Joiner: role, starting data and password sent in the room <c>join</c>.</summary>
        public RoomJoinOptions? Join;
    }

    /// <summary>A countdown as a replica sees it: <see cref="RemainingMs"/> counts down to the host's start in this peer's clock.</summary>
    public sealed class RoomCountdown
    {
        private readonly Lobby _lobby;
        internal RoomCountdown(Lobby lobby, int seq, int total, long deadline) { _lobby = lobby; Seq = seq; Total = total; DeadlineMs = deadline; }
        public int Seq { get; }
        /// <summary>The length of the countdown in ms.</summary>
        public int Total { get; }
        /// <summary>In this peer's <see cref="Lobby.NowMs"/> base.</summary>
        public long DeadlineMs { get; }
        /// <summary>Milliseconds left now.</summary>
        public int RemainingMs => (int)Math.Max(0, DeadlineMs - _lobby.NowMs);
    }

    /// <summary>
    /// The room layer (spec/room.md): one host-authoritative roster with per-player data, ready, a start countdown, spectators,
    /// seats, a reconnecting state, kick and ban with reasons. The host holds the truth and replicates it over the room frame
    /// (0x80); a joiner's calls are requests the host validates. Every <see cref="Lobby"/> has one as <see cref="Lobby.Room"/>;
    /// a game that never touches it behaves as before. Events fire on the thread that pumps the lobby.
    /// </summary>
    public sealed class Room
    {
        /// <summary>How long a joiner waits for the host's room reply, and a host for a peer's <c>join</c>, before calling the other side old.</summary>
        public const int JoinWaitMs = 3000;
        /// <summary>Host: the <c>cd</c> countdown tick.</summary>
        public const int CountdownTickMs = 1000;
        /// <summary>A replica asks for a fresh snapshot at most this often.</summary>
        public const int ResyncGapMs = 1000;
        /// <summary>Host: per peer, at most this many requests per second.</summary>
        public const int RequestsPerSecond = 10;

        private sealed class Ctx
        {
            public readonly List<(int Id, string Why)> Gone = new();
            public string? Cancel;
            public bool Hold;
        }

        private sealed class View
        {
            public Dictionary<int, string> Entries = new();
            public Dictionary<int, EntryRec> Objs = new();
            public RoomState State;
            public int CdSeq;
            public string Settings = "";
            public bool AllReady;
        }

        private readonly Lobby _l;
        private readonly RoomConfig _cfg;
        private int _rev;
        private RoomState _state = RoomState.Lobby;
        private RoomSettings _settings;
        private SortedDictionary<int, EntryRec> _roster = new();
        private (int Seq, int Total, long Deadline)? _cd;
        private bool _closed, _removedFired;

        // joiner
        private long _supportDeadline = -1;
        private long _lastResync = long.MinValue / 2;

        // host
        private readonly Dictionary<int, string> _pids = new();
        private readonly Dictionary<string, int> _seatMemory = new();
        private readonly HashSet<int> _droppedSeats = new();
        private readonly HashSet<int> _dropFired = new();
        private readonly Dictionary<int, long> _reconnectUntil = new();
        private readonly Dictionary<int, long> _legacyWait = new();
        private readonly Dictionary<int, (long Start, int N)> _requests = new();
        private int _cdSeq;
        private bool _cdAuto, _autoHold, _ticking;
        private long _nextCd;

        internal Room(Lobby lobby, RoomConfig cfg)
        {
            _l = lobby;
            _cfg = cfg;
            _settings = cfg.Settings;
            Bans = cfg.Bans;
            Bans.Changed += () =>
            {
                BansChanged?.Invoke();
                if (_l.IsHost) _l.SendBans(Bans.HubIds());
            };
            if (_l.IsHost) InitHost();
        }

        // ---- reading -----------------------------------------------------------------------------------------------------

        /// <summary>Host only: filters names (<see cref="RoomFilterKind.Name"/>) and chat lines (<see cref="RoomFilterKind.Chat"/>). Nothing is filtered by default.</summary>
        public Func<string, RoomFilterKind, string>? Filter { get; set; }
        /// <summary>Host only: the persistent ban list (spec/room.md s.5.3).</summary>
        public BanList Bans { get; }
        /// <summary>Null until known; true once the host answered (the host itself: always), false when it never did (an older host).</summary>
        public bool? Supported { get; private set; }
        public RoomState State => _state;
        /// <summary>A copy of the settings the room runs with.</summary>
        public RoomSettings Settings => _settings;
        /// <summary>Replica revision (spec/room.md s.1).</summary>
        public int Revision => _rev;

        /// <summary>
        /// Every entry (players, spectators, reconnecting ones), by peer id. Before the host's snapshot, or on an older host, it is
        /// the hub roster (everyone a player, not ready, seat -1).
        /// </summary>
        public IReadOnlyList<RoomEntry> Entries
        {
            get
            {
                if (_l.IsHost || Supported == true) return _roster.Values.Select(e => e.ToPublic()).ToList();
                return _l.RoomPeerIds().OrderBy(i => i).Select(id => new RoomEntry(id, _l.RoomPeerName(id) ?? "Player " + id.ToString(CultureInfo.InvariantCulture),
                    RoomRole.Player, -1, false, RoomStatus.Connected, new Dictionary<string, string>())).ToList();
            }
        }

        /// <summary>Entries with role player, by seat.</summary>
        public IReadOnlyList<RoomEntry> Players => Entries.Where(e => e.Role == RoomRole.Player).OrderBy(e => e.Seat).ThenBy(e => e.Id).ToList();
        public IReadOnlyList<RoomEntry> Spectators => Entries.Where(e => e.Role == RoomRole.Spectator).ToList();
        public RoomEntry? Player(int peerId) => Entries.FirstOrDefault(e => e.Id == peerId);
        /// <summary>This peer's own entry.</summary>
        public RoomEntry? Me => Player(_l.LocalPeerId);
        /// <summary>The countdown now running, or null.</summary>
        public RoomCountdown? Countdown => _cd is { } c ? new RoomCountdown(_l, c.Seq, c.Total, c.Deadline) : null;
        /// <summary>Every non-legacy player is connected and ready, and there is at least one.</summary>
        public bool AllReady
        {
            get
            {
                var ps = _roster.Values.Where(e => e.Role == RoomRole.Player && !e.Legacy).ToList();
                return ps.Count > 0 && ps.All(e => e.Status == RoomStatus.Connected && e.Ready);
            }
        }

        // ---- events ----------------------------------------------------------------------------------------------------

        /// <summary>Anything in the room changed (after the matching specific events).</summary>
        public event Action? Changed;
        public event Action<RoomEntry>? PlayerJoined;
        /// <summary>The entry (status <see cref="RoomStatus.Left"/>) and why: "left", "kicked", "disconnected" or "timeout".</summary>
        public event Action<RoomEntry, string>? PlayerLeft;
        /// <summary>Keys: "name", "role", "seat", "ready", "status", "legacy" and "data.&lt;key&gt;".</summary>
        public event Action<RoomEntry, IReadOnlyList<string>>? PlayerChanged;
        public event Action<RoomState, RoomState>? StateChanged;
        /// <summary>The state became Started (the lobby phase is in game).</summary>
        public event Action? Started;
        public event Action<bool>? AllReadyChanged;
        /// <summary>A countdown began, or the host sent its once-a-second tick.</summary>
        public event Action<RoomCountdown>? CountdownUpdated;
        /// <summary>"host", "too_few" or "condition".</summary>
        public event Action<string>? CountdownCancelled;
        /// <summary>The room went from started or countdown back to lobby (a rematch comes through here too).</summary>
        public event Action? BackedToLobby;
        public event Action<RoomSettings>? SettingsChanged;
        /// <summary>Host only: put a bot in this seat.</summary>
        public event Action<SeatDroppedInfo>? SeatDropped;
        /// <summary>Host only: a player took a dropped seat; take the bot out.</summary>
        public event Action<SeatRestoredInfo>? SeatRestored;
        /// <summary>Host only: a joiner asked for start, back to lobby or a rematch. Nothing changed.</summary>
        public event Action<int, RoomRequest>? Requested;
        /// <summary>This peer was removed from the lobby; <see cref="Lobby.Removal"/> holds the same. Fires once, before <see cref="Lobby.SessionEnded"/>.</summary>
        public event Action<RemovalInfo>? Removed;
        /// <summary>A request of this peer was refused by the host: code, what it was ("set", "ready", "role", "req"), key.</summary>
        public event Action<string, string, string?>? Rejected;
        public event Action? BansChanged;
        /// <summary>The host speaks the room layer (its first snapshot arrived).</summary>
        public event Action? SupportConfirmed;
        /// <summary>The host never answered: it predates the room layer. <see cref="Players"/> lists the hub roster; calls throw <c>room_unsupported</c>.</summary>
        public event Action? Unsupported;

        // ---- player calls ----------------------------------------------------------------------------------------------

        /// <summary>Your own ready flag. Players only; the result is the next <see cref="PlayerChanged"/>, or <see cref="Rejected"/>.</summary>
        public void SetReady(bool ready)
        {
            RequireSupport();
            if (_l.IsHost) { HostReady(_l.LocalPeerId, ready, true); return; }
            SendToHost(RoomWire.Ready(ready));
        }

        /// <summary>Flips your ready flag.</summary>
        public void ToggleReady() => SetReady(!(Me?.Ready ?? false));

        /// <summary>Your own data (colour, avatar index, team, game keys). Atomic; "" unsets a key.</summary>
        public void SetData(IReadOnlyDictionary<string, string> values)
        {
            RequireSupport();
            if (_l.IsHost) { ThrowOn(HostSet(_l.LocalPeerId, Pairs(values), true)); return; }
            SendToHost(RoomWire.Set(values));
        }

        /// <summary>Host: sets any player's data, host-only keys included. A joiner passing someone else's id gets <c>not_allowed</c>.</summary>
        public void SetData(int peerId, IReadOnlyDictionary<string, string> values)
        {
            RequireSupport();
            if (peerId == _l.LocalPeerId) { SetData(values); return; }
            if (!_l.IsHost) throw new OneLobbyException(RoomErrorCodes.NotAllowed, "only the host can set another player's data");
            ThrowOn(HostSet(peerId, Pairs(values), true));
        }

        private static List<KeyValuePair<string, string?>> Pairs(IReadOnlyDictionary<string, string> v) => v.Select(kv => new KeyValuePair<string, string?>(kv.Key, kv.Value)).ToList();

        private static void ThrowOn((string Code, string? Key)? r)
        {
            if (r is { } f) throw new OneLobbyException(f.Code, "data refused: " + f.Code + (f.Key != null ? " (" + f.Key + ")" : ""));
        }

        /// <summary>Become a spectator or a player (your own role). The host answers with <see cref="PlayerChanged"/> or <see cref="Rejected"/>.</summary>
        public void SetRole(RoomRole role)
        {
            RequireSupport();
            if (_l.IsHost)
            {
                var r = HostRole(_l.LocalPeerId, role);
                if (r != null) throw new OneLobbyException(r, "cannot become a " + RoomRules.Name(role) + ": " + r);
                return;
            }
            SendToHost(RoomWire.Role(role));
        }

        /// <summary>Ask the host to start, go back to the lobby or rematch. It raises the host's <see cref="Requested"/> and changes nothing by itself.</summary>
        public void Request(RoomRequest what)
        {
            RequireSupport();
            if (_l.IsHost) { Requested?.Invoke(_l.LocalPeerId, what); return; }
            SendToHost(RoomWire.Req(what));
        }

        // ---- host calls -------------------------------------------------------------------------------------------------

        /// <summary>Host: move a player or spectator to the other role (the capacity rules apply; a failure throws its code).</summary>
        public void MoveTo(int peerId, RoomRole role)
        {
            RequireHost();
            var r = HostRole(peerId, role);
            if (r != null) throw new OneLobbyException(r, "cannot move player " + peerId.ToString(CultureInfo.InvariantCulture) + " to " + RoomRules.Name(role) + ": " + r);
        }

        /// <summary>Host: start the game, after the countdown when <c>CountdownMs</c> is above 0. Throws <c>wrong_state</c> or <c>not_enough_players</c>.</summary>
        public void Start()
        {
            RequireHost();
            if (_state != RoomState.Lobby) throw new OneLobbyException(RoomErrorCodes.WrongState, "the room is " + RoomRules.Name(_state) + ", not in the lobby");
            if (Eligible() < Math.Max(1, _settings.MinPlayers))
                throw new OneLobbyException(RoomErrorCodes.NotEnoughPlayers, "at least " + _settings.MinPlayers.ToString(CultureInfo.InvariantCulture) + " connected player(s) needed");
            BeginStart(false);
        }

        /// <summary>Host: stop a running countdown (a no-op otherwise).</summary>
        public void CancelCountdown()
        {
            RequireHost();
            CancelStart("host");
        }

        /// <summary>Host: back to the lobby (ready flags reset, links and roster untouched). A no-op in the lobby.</summary>
        public void BackToLobby()
        {
            RequireHost();
            if (_state == RoomState.Lobby) return;
            Mutate(c =>
            {
                _state = RoomState.Lobby;
                _cd = null;
                c.Cancel = "host";
                c.Hold = true;
                foreach (var e in _roster.Values) if (e.Role == RoomRole.Player) e.Ready = false;
            });
            _l.EndGame();
        }

        /// <summary>Host: back to the lobby, then start again (the countdown applies). Players keep their seats, data and names.</summary>
        public void Rematch()
        {
            RequireHost();
            BackToLobby();
            Start();
        }

        /// <summary>Host: changes some settings for everyone (see spec/room.md s.9). The player and spectator caps are fixed when the lobby is created.</summary>
        public void Configure(RoomSettingsChange s)
        {
            RequireHost();
            Mutate(_ =>
            {
                _settings = _settings with
                {
                    AutoStart = s.AutoStart ?? _settings.AutoStart,
                    AutoStartPlayers = s.AutoStartPlayers ?? _settings.AutoStartPlayers,
                    MinPlayers = s.MinPlayers ?? _settings.MinPlayers,
                    CountdownMs = s.CountdownMs ?? _settings.CountdownMs,
                    LateJoin = s.LateJoin ?? _settings.LateJoin,
                    SeatDropped = s.SeatDropped ?? _settings.SeatDropped,
                    RejoinWindowMs = s.RejoinWindowMs ?? _settings.RejoinWindowMs,
                };
            });
        }

        /// <summary>Host: remove a player; it may rejoin. <paramref name="code"/> defaults to "kicked"; <paramref name="reason"/> is shown to the player (default sentence of the code).</summary>
        public void Kick(int peerId, string? code = null, string? reason = null)
        {
            RequireHost();
            var c = CheckCode(code ?? RoomErrorCodes.Kicked);
            _l.RemovePeerWith(peerId, false, c, RoomRules.RemovalReason(c, reason));
        }

        /// <summary>Host: remove a player and ban it for good (its player id, and its address when known); see <see cref="Bans"/>, <see cref="Unban"/>.</summary>
        public void Ban(int peerId, string? code = null, string? reason = null)
        {
            RequireHost();
            var c = CheckCode(code ?? RoomErrorCodes.Banned);
            var text = RoomRules.RemovalReason(c, reason);
            _roster.TryGetValue(peerId, out var e);
            _pids.TryGetValue(peerId, out var pid);
            var ip = _l.RoomLinkAddress(peerId);
            if (!string.IsNullOrEmpty(pid) || (ip != null && !RoomRules.IsLoopbackIp(ip))) Bans.Add(pid, ip, e?.Name, text, c);
            // the hub gets ban:false: the persistent list (and `bans` for the hub's id check) is what bans here, so unban can lift it
            _l.RemovePeerWith(peerId, false, c, text);
        }

        /// <summary>Host: lift a ban by player id or address; returns how many entries went.</summary>
        public int Unban(string idOrIp) => Bans.Remove(idOrIp);

        // ---- internals called by Lobby ------------------------------------------------------------------------------

        /// <summary>Test seams: play a host that predates the room layer (ignores its frames) and a joiner that sends no <c>join</c>.</summary>
        internal bool TestIgnoreFrames, TestNoJoin;

        internal void HandleFrame(int from, ReadOnlySpan<byte> body)
        {
            if (_closed || TestIgnoreFrames) return;
            using var doc = RoomWire.Parse(body);
            if (doc == null) return;
            var m = doc.RootElement;
            if (_l.IsHost) HostHandle(from, m);
            else if (from == _l.HostPeerId) JoinerHandle(m);
        }

        /// <summary>Joiner: the link to the host is open and <c>hi</c> went out: introduce ourselves.</summary>
        internal void OnHostLink()
        {
            if (_l.IsHost || _closed || TestNoJoin) return;
            SendToHost(RoomWire.Join(RoomRules.IsPlayerId(_cfg.Pid) ? _cfg.Pid : null, _cfg.JoinRole, _cfg.JoinPassword, _cfg.JoinData));
            if (Supported == null && _supportDeadline < 0) _supportDeadline = _l.NowMs + JoinWaitMs;
        }

        /// <summary>Host: a joiner finished its handshake (<c>hi</c>). It has <see cref="JoinWaitMs"/> to send <c>join</c>.</summary>
        internal void OnPeerHi(int peerId)
        {
            if (!_l.IsHost || _closed) return;
            if (_roster.TryGetValue(peerId, out var e) && e.Status == RoomStatus.Connected) return;
            _legacyWait[peerId] = _l.NowMs + JoinWaitMs;
        }

        /// <summary>A peer left the roster. <paramref name="final"/>: it was removed for good (a kick, a drop), so there is no rejoin window.</summary>
        internal void OnPeerLeft(int peerId, string reason, bool final)
        {
            if (!_l.IsHost || _closed) return;
            _legacyWait.Remove(peerId);
            _requests.Remove(peerId);
            if (!_roster.TryGetValue(peerId, out var e) || peerId == _l.LocalPeerId) return;
            if (!final && reason == "timeout" && _settings.RejoinWindowMs > 0 && !e.Legacy)
            {
                Mutate(_ => e.Status = RoomStatus.Reconnecting);
                _reconnectUntil[peerId] = _l.NowMs + _settings.RejoinWindowMs;
                if (_settings.SeatDropped == SeatDroppedPolicy.Immediate) FireSeatDropped(e, "disconnected", false);
                return;
            }
            RemoveEntry(peerId, reason == "kicked" ? "kicked" : reason == "disconnected" ? "disconnected" : reason == "left" ? "left" : final ? "disconnected" : "timeout");
        }

        /// <summary>Host: the hub renamed a peer.</summary>
        internal void OnRenamed(int peerId, string name)
        {
            if (!_l.IsHost || _closed) return;
            if (!_roster.TryGetValue(peerId, out var e)) return;
            var next = NameFor(name, peerId, peerId);
            if (next != e.Name) Mutate(_ => e.Name = next);
        }

        /// <summary>Host: the lobby phase changed under the room (a game that calls <c>StartAsync</c> directly, or a hub echo).</summary>
        internal void OnPhase(LobbyPhase phase)
        {
            if (!_l.IsHost || _closed) return;
            if (phase == LobbyPhase.InGame && _state != RoomState.Started)
            {
                Mutate(c => { _state = RoomState.Started; _cd = null; c.Cancel = "host"; });
            }
            else if (phase == LobbyPhase.Lobby && _state != RoomState.Lobby)
            {
                Mutate(c =>
                {
                    _state = RoomState.Lobby;
                    _cd = null;
                    c.Cancel = "host";
                    c.Hold = true;
                    foreach (var e in _roster.Values) if (e.Role == RoomRole.Player) e.Ready = false;
                });
            }
        }

        /// <summary>Host: a joiner's link address became known; a banned address is removed.</summary>
        internal void OnLinkAddress(int peerId, string ip)
        {
            if (!_l.IsHost || _closed || peerId == _l.LocalPeerId) return;
            _pids.TryGetValue(peerId, out var pid);
            var hit = Bans.Match(string.IsNullOrEmpty(pid) ? null : pid, ip);
            if (hit == null) return;
            var code = hit.Code != null && RoomRules.IsCode(hit.Code) ? hit.Code : RoomErrorCodes.Banned;
            _l.RemovePeerWith(peerId, false, code, RoomRules.RemovalReason(code, hit.Reason));
        }

        /// <summary>This peer is the host now (migration): the replica becomes the truth.</summary>
        internal void OnBecameHost()
        {
            if (_closed) return;
            _supportDeadline = -1;
            var had = Supported == true;
            Supported = true;
            _pids.Clear();
            _legacyWait.Clear();
            _reconnectUntil.Clear();
            _droppedSeats.Clear();
            _dropFired.Clear();
            if (had)
            {
                var until = _l.NowMs + _settings.RejoinWindowMs;
                var ids = new HashSet<int>(_l.RoomPeerIds());
                foreach (var e in _roster.Values.ToList())
                {
                    if (e.Id == _l.LocalPeerId) continue;
                    if (!ids.Contains(e.Id)) _roster.Remove(e.Id);
                    else { e.Status = RoomStatus.Reconnecting; _reconnectUntil[e.Id] = until; }
                }
                if (_roster.TryGetValue(_l.LocalPeerId, out var me))
                {
                    _pids[me.Id] = _cfg.Pid;
                    if (RoomRules.IsPlayerId(_cfg.Pid) && me.Seat >= 0) _seatMemory[_cfg.Pid] = me.Seat;
                }
                else AddHostEntry();
                if (_state == RoomState.Countdown) { _state = RoomState.Lobby; _cd = null; }
                _rev += 1;
            }
            else
            {
                _roster.Clear();
                _rev = 1;
                _state = _l.Phase == LobbyPhase.InGame ? RoomState.Started : RoomState.Lobby;
                AddHostEntry();
            }
            _l.SendBans(Bans.HubIds());
            SupportConfirmed?.Invoke();
            Changed?.Invoke();
        }

        /// <summary>This peer lost a host claim: it is a joiner again.</summary>
        internal void OnBecameJoiner() { }

        /// <summary>The signaling <c>error{kicked}</c> (or a room <c>deny</c>) reached this peer.</summary>
        internal void OnRemoved(RemovalInfo info)
        {
            if (_removedFired) return;
            _removedFired = true;
            _l.SetRemoval(info);
            Removed?.Invoke(info);
        }

        internal void Close()
        {
            _closed = true;
            _supportDeadline = -1;
        }

        // ---- host: roster ------------------------------------------------------------------------------------------------

        private void InitHost()
        {
            Supported = true;
            _rev = 1;
            AddHostEntry();
        }

        private void AddHostEntry()
        {
            var id = _l.LocalPeerId;
            var pid = _cfg.Pid;
            _pids[id] = pid;
            var seat = RoomRules.ChooseSeat(_settings.MaxPlayers, new HashSet<int>(), _seatMemory, RoomRules.IsPlayerId(pid) ? pid : "").Seat;
            if (RoomRules.IsPlayerId(pid)) _seatMemory[pid] = seat;
            var data = new Dictionary<string, string>();
            foreach (var kv in _cfg.JoinData)
            {
                var r = RoomRules.ApplyData(_settings.Data, data, new[] { new KeyValuePair<string, string?>(kv.Key, kv.Value) }, true);
                if (r.Ok) data = r.Data!;
            }
            _roster[id] = new EntryRec
            {
                Id = id, Name = NameFor(_l.RoomPeerName(id) ?? "", id, id), Role = RoomRole.Player, Seat = seat, Data = RoomRules.DataDefaults(_settings.Data, data),
            };
        }

        /// <summary>Called by the lobby on every pump: timers (rejoin windows, the legacy wait, the countdown, the support wait).</summary>
        internal void Tick(long now)
        {
            if (_closed) return;
            if (_supportDeadline >= 0 && now >= _supportDeadline)
            {
                _supportDeadline = -1;
                if (Supported == null) { Supported = false; Unsupported?.Invoke(); }
            }
            if (_l.IsHost) HostTick(now);
        }

        private string NameFor(string input, int peerId, int selfId) =>
            RoomRules.EffectiveName(input, peerId, _roster.Values.Where(e => e.Id != selfId).Select(e => e.Name).ToList(), _settings.MaxNameLength, Filter);

        private int Eligible() => _roster.Values.Count(e => e.Role == RoomRole.Player && e.Status == RoomStatus.Connected && !e.Legacy);

        private static string CheckCode(string code)
        {
            if (!RoomRules.IsCode(code)) throw new ArgumentException("code must be lower-case letters, digits and underscores, starting with a letter, at most 32");
            return code;
        }

        private void RequireHost()
        {
            if (!_l.IsHost) throw new InvalidOperationException("only the host can do that");
            RequireSupport();
        }

        private void RequireSupport()
        {
            if (Supported == false) throw new OneLobbyException(RoomErrorCodes.RoomUnsupported, "the host's version has no room layer (update the host)");
        }

        private void SendToHost(byte[] frame) => _l.RoomSendToHost(frame);
        private void SendRoom(int peerId, byte[] frame) => _l.RoomSend(peerId, frame);

        /// <summary>Peers that can read room frames and have a link now (the host's own entry excluded).</summary>
        private List<int> Audience(int? except = null)
        {
            var open = new HashSet<int>(_l.RoomOpenPeers());
            return _roster.Values.Where(e => !e.Legacy && e.Id != _l.LocalPeerId && e.Id != except && open.Contains(e.Id)).Select(e => e.Id).ToList();
        }

        private View Snapshot()
        {
            var v = new View { State = _state, CdSeq = _cd?.Seq ?? 0, Settings = RoomWire.SettingsKey(_settings), AllReady = AllReady };
            foreach (var kv in _roster) { v.Entries[kv.Key] = kv.Value.Key(); v.Objs[kv.Key] = kv.Value.Clone(); }
            return v;
        }

        /// <summary>
        /// Host: run <paramref name="fn"/> (which edits the roster, state, countdown or settings), then replicate one <c>upd</c> to
        /// everyone and raise the local events. <paramref name="except"/> is a peer that gets a snapshot instead (a fresh joiner).
        /// </summary>
        private void Mutate(Action<Ctx> fn, int? except = null)
        {
            var before = Snapshot();
            var ctx = new Ctx();
            fn(ctx);
            var changed = _roster.Values.Where(e => !before.Entries.TryGetValue(e.Id, out var k) || k != e.Key()).ToList();
            if (ctx.Hold) _autoHold = true;
            else if (changed.Count > 0 || ctx.Gone.Count > 0) _autoHold = false;
            var settingsChanged = RoomWire.SettingsKey(_settings) != before.Settings;
            var stateChanged = _state != before.State;
            var cdChanged = (_cd?.Seq ?? 0) != before.CdSeq;
            if (changed.Count > 0 || ctx.Gone.Count > 0 || settingsChanged || stateChanged || cdChanged)
            {
                _rev += 1;
                var cd = CdInfo();
                var upd = RoomWire.Frame("upd", w =>
                {
                    w.WriteNumber("rev", _rev);
                    if (changed.Count > 0) { w.WriteStartArray("players"); foreach (var e in changed) RoomWire.WriteEntry(w, e); w.WriteEndArray(); }
                    if (ctx.Gone.Count > 0)
                    {
                        w.WriteStartArray("gone");
                        foreach (var g in ctx.Gone) { w.WriteStartObject(); w.WriteNumber("id", g.Id); w.WriteString("why", g.Why); w.WriteEndObject(); }
                        w.WriteEndArray();
                    }
                    if (stateChanged) w.WriteString("state", RoomRules.Name(_state));
                    if (cdChanged || stateChanged) RoomWire.WriteCountdown(w, "countdown", cd);
                    if (settingsChanged) RoomWire.WriteSettings(w, "settings", _settings);
                    if (ctx.Cancel != null && (stateChanged || cdChanged) && _cd == null) w.WriteString("cancel", ctx.Cancel);
                });
                foreach (var p in Audience(except)) SendRoom(p, upd);
                EmitChanges(before, ctx.Gone, ctx.Cancel);
            }
            Evaluate();
        }

        private CountdownInfo? CdInfo() =>
            _cd is { } c ? new CountdownInfo(c.Seq, c.Total, (int)Math.Max(0, c.Deadline - _l.NowMs)) : null;

        private byte[] SnapMsg()
        {
            var cd = CdInfo();
            return RoomWire.Frame("snap", w =>
            {
                w.WriteNumber("v", 1);
                w.WriteNumber("rev", _rev);
                w.WriteString("state", RoomRules.Name(_state));
                RoomWire.WriteCountdown(w, "countdown", cd);
                RoomWire.WriteSettings(w, "settings", _settings);
                w.WriteStartArray("players");
                foreach (var e in _roster.Values) RoomWire.WriteEntry(w, e);
                w.WriteEndArray();
            });
        }

        // ---- host: requests -----------------------------------------------------------------------------------------------

        private bool AllowRequest(int from)
        {
            var now = _l.NowMs;
            if (!_requests.TryGetValue(from, out var w) || now - w.Start >= 1000) w = (now, 0);
            w.N++;
            _requests[from] = w;
            return w.N <= RequestsPerSecond;
        }

        private void HostHandle(int from, JsonElement m)
        {
            if (from == _l.LocalPeerId) return;
            var t = Signaling.Str(m, "t");
            switch (t)
            {
                case "join": case "set": case "ready": case "role": case "req":
                    if (!AllowRequest(from))
                    {
                        if (t != "join") SendRoom(from, RoomWire.Nack(t, RoomErrorCodes.RateLimited));
                        return;
                    }
                    break;
                case "resync":
                    if (_roster.TryGetValue(from, out var rs) && !rs.Legacy) SendRoom(from, SnapMsg());
                    return;
                default:
                    return;
            }
            if (t == "join") { HostJoin(from, m); return; }
            if (!_roster.TryGetValue(from, out var e) || e.Legacy) return;
            if (t == "set")
            {
                m.TryGetProperty("data", out var d);
                var r = HostSet(from, RoomWire.ParsePairs(d), false);
                if (r is { } f) SendRoom(from, RoomWire.Nack("set", f.Code, f.Key));
            }
            else if (t == "ready")
            {
                HostReady(from, m.TryGetProperty("ready", out var rv) && rv.ValueKind == JsonValueKind.True, false);
            }
            else if (t == "role")
            {
                var r = m.TryGetProperty("role", out var rp) && rp.ValueKind == JsonValueKind.String && RoomRules.TryRole(rp.GetString(), out var role) ? HostRole(from, role) : RoomErrorCodes.BadValue;
                if (r != null) SendRoom(from, RoomWire.Nack("role", r));
            }
            else
            {
                var what = Signaling.Str(m, "what");
                if (what == "start") Requested?.Invoke(from, RoomRequest.Start);
                else if (what == "lobby") Requested?.Invoke(from, RoomRequest.Lobby);
                else if (what == "rematch") Requested?.Invoke(from, RoomRequest.Rematch);
                else SendRoom(from, RoomWire.Nack("req", RoomErrorCodes.BadValue));
            }
        }

        private (string Code, string? Key)? HostSet(int id, IEnumerable<KeyValuePair<string, string?>> values, bool byHost)
        {
            if (!_roster.TryGetValue(id, out var e)) return (RoomErrorCodes.NotAllowed, null);
            var r = RoomRules.ApplyData(_settings.Data, e.Data, values, byHost);
            if (!r.Ok) return (r.Code, r.Key);
            Mutate(_ => e.Data = r.Data!);
            return null;
        }

        private void HostReady(int id, bool ready, bool local)
        {
            void Fail(string code)
            {
                if (local) throw new OneLobbyException(code, "cannot change ready: " + code);
                SendRoom(id, RoomWire.Nack("ready", code));
            }
            if (!_roster.TryGetValue(id, out var e) || e.Role != RoomRole.Player || e.Legacy) { Fail(RoomErrorCodes.NotAllowed); return; }
            if (e.Status != RoomStatus.Connected) { Fail(RoomErrorCodes.NotAllowed); return; }
            if (e.Ready == ready) return;
            Mutate(_ => e.Ready = ready);
        }

        /// <summary>Returns an error code, or null when the move happened.</summary>
        private string? HostRole(int id, RoomRole role)
        {
            if (!_roster.TryGetValue(id, out var e) || e.Legacy) return RoomErrorCodes.NotAllowed;
            if (e.Role == role) return null;
            if (role == RoomRole.Spectator)
            {
                if (_roster.Values.Count(x => x.Role == RoomRole.Spectator) >= _settings.Spectators) return RoomErrorCodes.SpectatorsFull;
            }
            else
            {
                if (_roster.Values.Count(x => x.Role == RoomRole.Player) >= _settings.MaxPlayers) return RoomErrorCodes.LobbyFull;
                if (_state == RoomState.Started && _settings.LateJoin != LateJoinPolicy.Allow)
                    return _settings.LateJoin == LateJoinPolicy.Refuse ? RoomErrorCodes.InGame : RoomErrorCodes.NotAllowed;
            }
            Mutate(_ =>
            {
                e.Role = role;
                e.Ready = false;
                if (role == RoomRole.Spectator) e.Seat = -1;
                else GiveSeat(e, _pids.TryGetValue(id, out var p) ? p : "");
            });
            return null;
        }

        /// <summary>Gives a player entry its seat (4.3); raises <see cref="SeatRestored"/> when it was a dropped one.</summary>
        private void GiveSeat(EntryRec e, string pid)
        {
            var held = new HashSet<int>(_roster.Values.Where(x => x != e && x.Role == RoomRole.Player && x.Seat >= 0).Select(x => x.Seat));
            var r = RoomRules.ChooseSeat(_settings.MaxPlayers, held, _seatMemory, RoomRules.IsPlayerId(pid) ? pid : "");
            e.Seat = r.Seat;
            if (r.TakeOver != null) _seatMemory.Remove(r.TakeOver);
            if (r.Seat >= 0 && RoomRules.IsPlayerId(pid)) _seatMemory[pid] = r.Seat;
            if (r.Seat >= 0 && _droppedSeats.Remove(r.Seat)) SeatRestored?.Invoke(new SeatRestoredInfo(r.Seat, e.Id, e.Name, r.Returning));
        }

        // ---- host: admission ---------------------------------------------------------------------------------------------

        private void HostJoin(int from, JsonElement m)
        {
            _legacyWait.Remove(from);
            var pid = m.TryGetProperty("pid", out _) && RoomRules.IsPlayerId(Signaling.Str(m, "pid")) ? Signaling.Str(m, "pid") : "";
            _roster.TryGetValue(from, out var existing);
            _pids.TryGetValue(from, out var known);
            if (existing != null && !existing.Legacy && (string.IsNullOrEmpty(known) || known == pid))
            {
                // rebind: the same peer again (a new link after a drop, or a new host after migration)
                if (pid.Length > 0) _pids[from] = pid;
                var was = existing.Status;
                Mutate(_ => existing.Status = RoomStatus.Connected, from);
                _reconnectUntil.Remove(from);
                if (was == RoomStatus.Reconnecting && _dropFired.Remove(from) && _droppedSeats.Remove(existing.Seat))
                    SeatRestored?.Invoke(new SeatRestoredInfo(existing.Seat, from, existing.Name, true));
                SendRoom(from, SnapMsg());
                return;
            }
            m.TryGetProperty("data", out var d);
            AdmitPeer(from, pid, Signaling.Str(m, "role") == "spectator" ? RoomRole.Spectator : RoomRole.Player, Signaling.Str(m, "password"),
                RoomWire.ParsePairs(d), false);
        }

        private void AdmitPeer(int from, string pid, RoomRole role, string password, List<KeyValuePair<string, string?>> data, bool legacy)
        {
            var ip = _l.RoomLinkAddress(from);
            var entries = _roster.Values.ToList();
            // a reconnecting entry of the same player id under another peer id: this peer takes its place
            var dup = pid.Length > 0 ? entries.FirstOrDefault(e => e.Id != from && _pids.TryGetValue(e.Id, out var p) && p == pid && e.Status == RoomStatus.Reconnecting) : null;
            var counted = entries.Where(e => e != dup && e.Id != from).ToList();
            var a = RoomRules.Admit(Bans.Match(pid.Length > 0 ? pid : null, ip) != null, _cfg.Password.Length > 0,
                _cfg.Password.Length == 0 || RoomRules.SafeEqual(password, _cfg.Password), _state, _settings.LateJoin, role,
                counted.Count(e => e.Role == RoomRole.Player), _settings.MaxPlayers, counted.Count(e => e.Role == RoomRole.Spectator), _settings.Spectators);
            if (!a.Ok)
            {
                var reason = RoomRules.RemovalReason(a.Code);
                if (!legacy) SendRoom(from, RoomWire.Deny(a.Code, reason));
                _l.RemovePeerWith(from, false, a.Code, reason);
                return;
            }
            Mutate(c =>
            {
                if (dup != null)
                {
                    _roster.Remove(dup.Id);
                    _reconnectUntil.Remove(dup.Id);
                    _dropFired.Remove(dup.Id);
                    _pids.Remove(dup.Id);
                    c.Gone.Add((dup.Id, "left"));
                }
                var e = new EntryRec { Id = from, Name = NameFor(_l.RoomPeerName(from) ?? "", from, from), Role = a.Role, Legacy = legacy };
                var dd = new Dictionary<string, string>();
                foreach (var kv in data)
                {
                    var r = RoomRules.ApplyData(_settings.Data, dd, new[] { kv }, false);
                    if (r.Ok) dd = r.Data!;
                }
                e.Data = RoomRules.DataDefaults(_settings.Data, dd);
                _roster[from] = e;
                if (pid.Length > 0) _pids[from] = pid;
                if (a.Role == RoomRole.Player) GiveSeat(e, pid);
            }, from);
            if (!legacy) SendRoom(from, SnapMsg());
        }

        private void RemoveEntry(int id, string why)
        {
            if (!_roster.TryGetValue(id, out var e)) return;
            _reconnectUntil.Remove(id);
            Mutate(c =>
            {
                _roster.Remove(id);
                c.Gone.Add((id, why));
            });
            if (!_dropFired.Remove(id)) FireSeatDropped(e, why, why == "timeout");
            _pids.Remove(id);
        }

        private void FireSeatDropped(EntryRec e, string reason, bool afterWindow)
        {
            if (e.Role != RoomRole.Player || e.Seat < 0 || e.Legacy) return;
            _droppedSeats.Add(e.Seat);
            _dropFired.Add(e.Id);
            SeatDropped?.Invoke(new SeatDroppedInfo(e.Seat, e.Id, e.Name, new Dictionary<string, string>(e.Data), reason, afterWindow));
        }

        // ---- host: start, countdown, timers --------------------------------------------------------------------------------

        private void BeginStart(bool auto)
        {
            if (_settings.CountdownMs <= 0) { StartNow(); return; }
            _cdSeq += 1;
            _cdAuto = auto;
            _nextCd = _l.NowMs + CountdownTickMs;
            Mutate(_ =>
            {
                _state = RoomState.Countdown;
                _cd = (_cdSeq, _settings.CountdownMs, _l.NowMs + _settings.CountdownMs);
            });
        }

        private void StartNow()
        {
            Mutate(_ => { _state = RoomState.Started; _cd = null; });
            _l.BeginGame();
        }

        private void CancelStart(string reason)
        {
            if (_state != RoomState.Countdown) return;
            Mutate(c => { _state = RoomState.Lobby; _cd = null; c.Cancel = reason; });
        }

        private IReadOnlyList<RoomRules.StartPlayer> StartPlayers() =>
            _roster.Values.Select(e => new RoomRules.StartPlayer(e.Role, e.Status, e.Ready, e.Legacy)).ToList();

        private bool AutoHolds() => RoomRules.AutoStartHolds(_settings.AutoStart, _settings.AutoStartPlayers, _settings.MinPlayers, StartPlayers());

        /// <summary>After every change: auto start, and countdown conditions.</summary>
        private void Evaluate()
        {
            if (!_l.IsHost || _closed) return;
            if (_state == RoomState.Lobby)
            {
                if (!_autoHold && AutoHolds()) BeginStart(true);
            }
            else if (_state == RoomState.Countdown)
            {
                if (Eligible() < Math.Max(1, _settings.MinPlayers)) CancelStart("too_few");
                else if (_cdAuto && !AutoHolds()) CancelStart("condition");
            }
        }

        private void HostTick(long now)
        {
            if (_ticking) return;
            _ticking = true;
            try
            {
                foreach (var kv in _reconnectUntil.ToList())
                {
                    if (now < kv.Value) continue;
                    _reconnectUntil.Remove(kv.Key);
                    if (_roster.TryGetValue(kv.Key, out var e) && e.Status == RoomStatus.Reconnecting) RemoveEntry(kv.Key, "timeout");
                }
                foreach (var kv in _legacyWait.ToList())
                {
                    if (now < kv.Value) continue;
                    _legacyWait.Remove(kv.Key);
                    if (_roster.TryGetValue(kv.Key, out var e))
                    {
                        // a legacy peer that dropped and resumed
                        if (e.Legacy && e.Status != RoomStatus.Connected) Mutate(_ => e.Status = RoomStatus.Connected);
                    }
                    else if (_l.RoomPeerIds().Contains(kv.Key)) AdmitPeer(kv.Key, "", RoomRole.Player, "", new List<KeyValuePair<string, string?>>(), true);
                }
                if (_state == RoomState.Countdown && _cd is { } cd)
                {
                    var left = cd.Deadline - now;
                    if (left <= 0) StartNow();
                    else if (now >= _nextCd)
                    {
                        _nextCd += CountdownTickMs;
                        var frame = RoomWire.Cd(cd.Seq, (int)left);
                        foreach (var p in Audience()) SendRoom(p, frame);
                        CountdownUpdated?.Invoke(new RoomCountdown(_l, cd.Seq, cd.Total, cd.Deadline));
                    }
                }
            }
            finally { _ticking = false; }
        }

        // ---- joiner: replica -----------------------------------------------------------------------------------------------

        private void JoinerHandle(JsonElement m)
        {
            switch (Signaling.Str(m, "t"))
            {
                case "snap": ApplySnap(m); break;
                case "upd": ApplyUpd(m); break;
                case "cd":
                {
                    if (Supported != true || !m.TryGetProperty("seq", out _) || !m.TryGetProperty("left", out _)) break;
                    var seq = Signaling.Int(m, "seq");
                    var rtt = _l.RoomRttMs();
                    var deadline = _l.NowMs + RoomRules.CountdownRemaining(Signaling.Int(m, "left"), rtt > 0 ? rtt : (int?)null);
                    _cd = _cd is { } c && c.Seq == seq ? (seq, c.Total, deadline) : (seq, Signaling.Int(m, "left"), deadline);
                    CountdownUpdated?.Invoke(new RoomCountdown(_l, _cd.Value.Seq, _cd.Value.Total, _cd.Value.Deadline));
                    break;
                }
                case "deny":
                {
                    var code = Signaling.Str(m, "code");
                    if (!RoomRules.IsCode(code)) code = RoomErrorCodes.Kicked;
                    var reason = RoomRules.RemovalReason(code, Signaling.Str(m, "reason"));
                    OnRemoved(new RemovalInfo(code, reason, false));
                    _l.RoomReportError(code, reason);
                    break;
                }
                case "nack":
                    if (m.TryGetProperty("code", out var cp) && cp.ValueKind == JsonValueKind.String)
                        Rejected?.Invoke(cp.GetString()!, Signaling.Str(m, "re"), m.TryGetProperty("key", out var kp) && kp.ValueKind == JsonValueKind.String ? kp.GetString() : null);
                    break;
            }
        }

        private void ApplySnap(JsonElement m)
        {
            if (!m.TryGetProperty("players", out var ps) || ps.ValueKind != JsonValueKind.Array || !m.TryGetProperty("rev", out _) || !m.TryGetProperty("settings", out var sp)) return;
            var settings = RoomWire.ParseSettings(sp);
            if (settings == null) return;
            var before = Snapshot();
            var first = Supported != true;
            _supportDeadline = -1;
            Supported = true;
            _roster = new SortedDictionary<int, EntryRec>();
            foreach (var p in ps.EnumerateArray()) { var e = RoomWire.ParseEntry(p); if (e != null) _roster[e.Id] = e; }
            _state = RoomRules.ParseState(Signaling.Str(m, "state"));
            _settings = settings;
            SetCd(m.TryGetProperty("countdown", out var cp) ? RoomWire.ParseCountdown(cp) : null);
            _rev = Signaling.Int(m, "rev");
            if (first) SupportConfirmed?.Invoke();
            EmitChanges(before, new List<(int, string)>(), null, first);
        }

        private void ApplyUpd(JsonElement m)
        {
            if (Supported != true || !m.TryGetProperty("rev", out var rp) || rp.ValueKind != JsonValueKind.Number) return;
            var rev = Signaling.Int(m, "rev");
            if (rev <= _rev) return;
            if (rev != _rev + 1) { Resync(); return; }
            var before = Snapshot();
            if (m.TryGetProperty("players", out var ps) && ps.ValueKind == JsonValueKind.Array)
                foreach (var p in ps.EnumerateArray()) { var e = RoomWire.ParseEntry(p); if (e != null) _roster[e.Id] = e; }
            var gone = new List<(int, string)>();
            if (m.TryGetProperty("gone", out var gs) && gs.ValueKind == JsonValueKind.Array)
                foreach (var g in gs.EnumerateArray())
                    if (g.ValueKind == JsonValueKind.Object && g.TryGetProperty("id", out var gi) && gi.ValueKind == JsonValueKind.Number)
                    {
                        gone.Add((Signaling.Int(g, "id"), Signaling.Str(g, "why", "left")));
                        _roster.Remove(Signaling.Int(g, "id"));
                    }
            if (m.TryGetProperty("state", out var st) && st.ValueKind == JsonValueKind.String) _state = RoomRules.ParseState(st.GetString());
            if (m.TryGetProperty("settings", out var sp) && RoomWire.ParseSettings(sp) is { } settings) _settings = settings;
            if (m.TryGetProperty("countdown", out var cp)) SetCd(RoomWire.ParseCountdown(cp));
            _rev = rev;
            EmitChanges(before, gone, m.TryGetProperty("cancel", out var cx) && cx.ValueKind == JsonValueKind.String ? cx.GetString() : null);
        }

        private void SetCd(CountdownInfo? c)
        {
            var rtt = _l.RoomRttMs();
            _cd = c == null ? null : (c.Seq, c.Total, _l.NowMs + RoomRules.CountdownRemaining(c.Left, rtt > 0 ? rtt : (int?)null));
        }

        private void Resync()
        {
            var now = _l.NowMs;
            if (now - _lastResync < ResyncGapMs) return;
            _lastResync = now;
            SendToHost(RoomWire.Resync());
        }

        // ---- events from a diff -----------------------------------------------------------------------------------------

        private static List<string> EntryKeys(EntryRec? a, EntryRec b)
        {
            if (a == null) return new List<string> { "name", "role", "seat", "ready", "status" };
            var keys = new List<string>();
            if (a.Name != b.Name) keys.Add("name");
            if (a.Role != b.Role) keys.Add("role");
            if (a.Seat != b.Seat) keys.Add("seat");
            if (a.Ready != b.Ready) keys.Add("ready");
            if (a.Status != b.Status) keys.Add("status");
            if (a.Legacy != b.Legacy) keys.Add("legacy");
            foreach (var k in a.Data.Keys.Union(b.Data.Keys).OrderBy(x => x, StringComparer.Ordinal))
            {
                a.Data.TryGetValue(k, out var x);
                b.Data.TryGetValue(k, out var y);
                if (x != y) keys.Add("data." + k);
            }
            return keys;
        }

        private void EmitChanges(View before, List<(int Id, string Why)> gone, string? cancel, bool quiet = false)
        {
            var after = Snapshot();
            var whys = gone.GroupBy(g => g.Id).ToDictionary(g => g.Key, g => g.Last().Why);
            var any = false;
            foreach (var kv in after.Objs)
            {
                if (!before.Objs.TryGetValue(kv.Key, out var old)) { any = true; PlayerJoined?.Invoke(kv.Value.ToPublic()); }
                else if (before.Entries[kv.Key] != after.Entries[kv.Key]) { any = true; PlayerChanged?.Invoke(kv.Value.ToPublic(), EntryKeys(old, kv.Value)); }
            }
            foreach (var kv in before.Objs)
            {
                if (after.Objs.ContainsKey(kv.Key)) continue;
                any = true;
                PlayerLeft?.Invoke(kv.Value.ToPublic() with { Status = RoomStatus.Left }, whys.TryGetValue(kv.Key, out var w) ? w : "left");
            }
            if (after.Settings != before.Settings) { any = true; SettingsChanged?.Invoke(_settings); }
            if (after.State != before.State)
            {
                any = true;
                StateChanged?.Invoke(after.State, before.State);
                if (after.State == RoomState.Started) Started?.Invoke();
                if (after.State == RoomState.Lobby) BackedToLobby?.Invoke();
            }
            if (after.CdSeq != before.CdSeq)
            {
                any = true;
                if (_cd is { } c) CountdownUpdated?.Invoke(new RoomCountdown(_l, c.Seq, c.Total, c.Deadline));
                else if (before.CdSeq != 0 && after.State != RoomState.Started) CountdownCancelled?.Invoke(cancel ?? "host");
            }
            if (after.AllReady != before.AllReady) { any = true; AllReadyChanged?.Invoke(after.AllReady); }
            if (any || quiet) Changed?.Invoke();
        }
    }
}
