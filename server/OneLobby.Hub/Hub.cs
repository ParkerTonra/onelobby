using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace OneLobby.Server;

/// <summary>
/// All signaling state and rules (DESIGN s.6, s.7, s.9, s.10, s.12; spec/signaling.md). Transport-agnostic and
/// single-locked: feed it text frames via <see cref="Receive"/>, advance time via <see cref="Tick"/>. Time comes from
/// <see cref="IClock"/>, so tests are deterministic.
/// </summary>
public sealed class Hub
{
    public const string Proto = "lk1";
    public const int NameMax = 24;
    public const int LobbyNameMax = 48;
    public const int MetaKeysMax = 16;
    public const int MetaLenMax = 64;
    public const int PendingMax = 8;

    private static readonly Regex GameIdRx = new("^[A-Za-z0-9._-]{1,64}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private readonly object _gate = new();
    private readonly HubOptions _o;
    private readonly IClock _clock;
    private readonly ILogger _log;
    private readonly Func<int, int> _rand;
    public Metrics Metrics { get; } = new();

    private readonly Dictionary<string, Lobby> _lobbies = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _retired = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (Lobby Lobby, Member Member)> _tokens = new(StringComparer.Ordinal);
    private readonly Dictionary<long, Session> _sessions = new();
    private readonly Dictionary<string, int> _gameLobbies = new(StringComparer.Ordinal);
    private readonly Dictionary<string, IpState> _ips = new(StringComparer.Ordinal);
    private long _nextSession;
    private int _members;
    private readonly string _logSalt = Compat.Hex(Compat.RandomBytes(8));

    private int Scale => Math.Max(1, _o.RateScale);

    private sealed class IpState
    {
        public RateWindow Create = null!;
        public RateWindow Join = null!;
        public int Open;
        public int Sockets;
    }

    public Hub(HubOptions options, IClock? clock = null, ILogger? logger = null, Func<int, int>? randomInt = null)
    {
        _o = options;
        _clock = clock ?? new SystemClock();
        _log = logger ?? Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance;
        _rand = randomInt ?? RandomNumberGenerator.GetInt32;
        Metrics.Gauge("onelobby_lobbies", "Live lobbies.", () => LobbyCount);
        Metrics.Gauge("onelobby_sockets", "Open signaling sockets.", () => SocketCount);
        Metrics.Gauge("onelobby_lobbies_retired", "Join codes held back from reuse.", () => { lock (_gate) return _retired.Count; });
        Metrics.Describe("onelobby_messages_total", "Client messages received, by type.");
        Metrics.Describe("onelobby_errors_total", "Error replies sent, by code.");
        Metrics.Describe("onelobby_path_total", "ICE path reports from peers: direct vs relayed (DESIGN s.10).");
        Metrics.Describe("onelobby_connections_total", "Sockets accepted since start.");
        Metrics.Describe("onelobby_lobbies_created_total", "Lobbies created since start.");
        Metrics.Describe("onelobby_rate_limit_hits_total", "Requests refused by a rate limit, by kind.");
    }

    public int LobbyCount { get { lock (_gate) return _lobbies.Count; } }
    public int SocketCount { get { lock (_gate) return _sessions.Count; } }

    // ---------------------------------------------------------------- connection lifecycle

    /// <summary>Registers a socket. Returns null (after sending server_full and closing) when over maxPeers.</summary>
    public Session? Connect(string ip, Action<string> send, Action close)
    {
        lock (_gate)
        {
            var s = new Session
            {
                Id = ++_nextSession,
                Ip = ip,
                ConnId = Compat.Hex(Compat.RandomBytes(6)).ToLowerInvariant(),
                Send = send,
                Close = close,
                LastSeen = _clock.NowMs,
                SignalRate = new RateWindow(_o.SignalPerSec * Scale, 1000),
            };
            Metrics.Inc("onelobby_connections_total");
            if (_sessions.Count >= _o.MaxPeers)
            {
                Error(s, "server_full", "server is at its peer limit");
                s.Close();
                return null;
            }
            _sessions[s.Id] = s;
            IpOf(ip).Sockets++;
            return s;
        }
    }

    public void Disconnect(Session s)
    {
        lock (_gate)
        {
            if (!_sessions.Remove(s.Id)) return;
            s.Closed = true;
            if (_ips.TryGetValue(s.Ip, out var ipst)) ipst.Sockets--;
            if (s.PendingIn is { } pl)
            {
                pl.Pending.Remove(s.PendingMember!);
                s.PendingIn = null; s.PendingMember = null;
            }
            if (s.Member is { } m && s.Lobby is { } lobby)
            {
                // The slot and token stay reserved for the resume window (Tick expires them); others hear peer_left{timeout} now.
                m.Session = null;
                m.DetachedAt = _clock.NowMs;
                s.Member = null; s.Lobby = null;
                Log("detach", lobby, s);
                Broadcast(lobby, new JsonObject { ["t"] = "peer_left", ["peerId"] = m.PeerId, ["reason"] = "timeout" });
                Metrics.Inc("onelobby_peers_left_total", "reason", "timeout");
                if (lobby.HostId == m.PeerId) PromoteHost(lobby, m.PeerId);
            }
        }
    }

    private void CloseSession(Session s)
    {
        s.Close();
        Disconnect(s);
    }

    // ---------------------------------------------------------------- time

    /// <summary>Call about once a second: idle timeouts, resume-window expiry, code retirement.</summary>
    public void Tick()
    {
        lock (_gate)
        {
            long now = _clock.NowMs;
            foreach (var s in _sessions.Values.ToList())
                if (now - s.LastSeen > _o.IdleTimeoutMs)
                {
                    Metrics.Inc("onelobby_idle_timeouts_total");
                    CloseSession(s);
                }
            foreach (var lobby in _lobbies.Values.ToList())
                foreach (var m in lobby.Members.ToList())
                    if (m.DetachedAt > 0 && now - m.DetachedAt >= _o.ResumeWindowMs)
                        RemoveMember(lobby, m, "timeout");
            foreach (var code in _retired.Where(kv => now - kv.Value >= _o.CodeReuseMs).Select(kv => kv.Key).ToList())
                _retired.Remove(code);
            foreach (var key in _ips.Where(kv => kv.Value.Sockets <= 0 && kv.Value.Open <= 0 && kv.Value.Create.IsIdle(now) && kv.Value.Join.IsIdle(now)).Select(kv => kv.Key).ToList())
                _ips.Remove(key);
        }
    }

    // ---------------------------------------------------------------- inbound

    private static readonly HashSet<string> KnownTypes = new(StringComparer.Ordinal)
    {
        "hello", "create", "join", "list", "leave", "signal", "meta", "phase", "kick", "approve", "ping", "host_changed", "path",
    };

    public void Receive(Session s, string text)
    {
        lock (_gate)
        {
            if (s.Closed) return;
            s.LastSeen = _clock.NowMs;
            if (text.Length > _o.MaxMessageBytes)
            {
                Error(s, "bad_request", "message too large");
                CloseSession(s);
                return;
            }
            JsonObject? msg;
            try { msg = JsonNode.Parse(text) as JsonObject; }
            catch (JsonException) { msg = null; }
            string? t = msg is null ? null : Str(msg, "t");
            if (msg is null || t is null) { Error(s, "bad_request", "expected a JSON object with a string t", Field("t")); return; }
            Metrics.Inc("onelobby_messages_total", "type", KnownTypes.Contains(t) ? t : "unknown");

            if (t == "hello") { Hello(s, msg); return; }
            if (!s.HelloDone)
            {
                if (KnownTypes.Contains(t)) Error(s, "bad_request", "send hello first");
                return;
            }
            switch (t)
            {
                case "create": Create(s, msg); break;
                case "join": Join(s, msg); break;
                case "list": List(s, msg); break;
                case "leave": Leave(s); break;
                case "signal": Signal(s, msg); break;
                case "meta": HostMeta(s, msg); break;
                case "phase": HostPhase(s, msg); break;
                case "kick": Kick(s, msg); break;
                case "approve": Approve(s, msg); break;
                case "ping":
                    if (Int(msg, "n") is not { } n || n < 0) { Error(s, "bad_request", "ping needs an integer n", Field("n")); break; }
                    Send(s, new JsonObject { ["t"] = "pong", ["n"] = n });
                    break;
                case "host_changed": ClaimHost(s, msg); break;
                case "path": PathReport(s, msg); break;
                default: break; // unknown types are ignored
            }
        }
    }

    // ---------------------------------------------------------------- hello / welcome

    private void Hello(Session s, JsonObject m)
    {
        if (s.HelloDone) { Error(s, "bad_request", "hello already sent"); return; }
        if (Str(m, "proto") != Proto)
        {
            Error(s, "bad_request", "unsupported proto, expected lk1",
                new JsonObject { ["supported"] = new JsonArray(JsonValue.Create(Proto)) });
            CloseSession(s);
            return;
        }
        if (m["name"] is not null && Str(m, "name") is null) { Error(s, "bad_request", "name must be a string", Field("name")); return; }
        if (m["client"] is not null && m["client"] is not JsonObject) { Error(s, "bad_request", "client must be an object", Field("client")); return; }
        string? gameId = Str(m, "gameId");
        string? netVersion = Str(m, "netVersion");
        if (gameId is null || !GameIdRx.IsMatch(gameId)) { Error(s, "bad_request", "gameId must match [A-Za-z0-9._-]{1,64}", Field("gameId")); return; }
        if (string.IsNullOrEmpty(netVersion) || netVersion.Length > 32) { Error(s, "bad_request", "netVersion must be 1-32 characters", Field("netVersion")); return; }
        if (_o.AllowedGames.Count > 0 && !_o.AllowedGames.Contains(gameId))
        {
            Error(s, "game_not_allowed", "this server does not host that game");
            CloseSession(s);
            return;
        }
        s.GameId = gameId; s.NetVersion = netVersion;
        s.Name = Text.Sanitize(Str(m, "name"), NameMax, "Player");
        s.HelloDone = true;

        Member? resumed = null; Lobby? rl = null;
        string? token = Str(m, "resumeToken");
        if (token is not null && _tokens.TryGetValue(token, out var entry)
            && entry.Lobby.GameId == gameId && entry.Lobby.NetVersion == netVersion)
        {
            // A token whose old socket is still open is a take-over: drop the old socket first (it detaches normally).
            if (entry.Member.Session is { } old && old != s) CloseSession(old);
            if (entry.Member.DetachedAt > 0 && _clock.NowMs - entry.Member.DetachedAt < _o.ResumeWindowMs)
            { resumed = entry.Member; rl = entry.Lobby; }
        }

        var w = new JsonObject
        {
            ["t"] = "welcome",
            ["ice"] = IceList(s),
            ["serverTime"] = _clock.NowMs,
            ["limits"] = new JsonObject { ["maxMsg"] = _o.MaxMessageBytes, ["maxPlayers"] = _o.HardMaxPlayers },
        };
        if (resumed is not null) w["peerId"] = resumed.PeerId;
        Send(s, w);

        if (resumed is not null && rl is not null)
        {
            _tokens.Remove(resumed.Token);
            resumed.Token = NewToken();
            _tokens[resumed.Token] = (rl, resumed);
            resumed.Session = s; resumed.DetachedAt = 0;
            s.Lobby = rl; s.Member = resumed;
            Log("resume", rl, s);
            Metrics.Inc("onelobby_resumes_total");
            foreach (var other in rl.Members)
                if (other != resumed) SendTo(other, new JsonObject { ["t"] = "peer_joined", ["peer"] = PeerObj(resumed) });
            Send(s, LobbyMsg(rl, resumed));
        }
    }

    private JsonArray IceList(Session s)
    {
        var ice = new JsonArray();
        if (_o.StunUrls.Count > 0)
            ice.Add(new JsonObject { ["urls"] = new JsonArray(_o.StunUrls.Select(u => (JsonNode?)JsonValue.Create(u)).ToArray()) });
        if (_o.TurnUrls.Count > 0 && _o.TurnSecret.Length > 0)
        {
            long expiry = _clock.NowMs / 1000 + _o.TurnTtlSeconds;
            var (user, cred) = TurnCredentials.Mint(_o.TurnSecret, expiry, s.ConnId);
            ice.Add(new JsonObject
            {
                ["urls"] = new JsonArray(_o.TurnUrls.Select(u => (JsonNode?)JsonValue.Create(u)).ToArray()),
                ["username"] = user,
                ["credential"] = cred,
                ["ttl"] = _o.TurnTtlSeconds,
            });
        }
        return ice;
    }

    // ---------------------------------------------------------------- create / join / list / leave

    private IpState IpOf(string ip)
    {
        if (!_ips.TryGetValue(ip, out var st))
        {
            st = new IpState { Create = new RateWindow(_o.CreatePerMin * Scale, 60_000), Join = new RateWindow(_o.JoinPerMin * Scale, 60_000) };
            _ips[ip] = st;
        }
        return st;
    }

    private void Create(Session s, JsonObject m)
    {
        if (s.Lobby is not null || s.PendingIn is not null) { Error(s, "bad_request", "already in a lobby"); return; }
        var ip = IpOf(s.Ip);
        long now = _clock.NowMs;
        if (!_o.DisableIpLimits)
        {
            if (!ip.Create.TryHit(now)) { RateLimited(s, "create", ip.Create.RetryAfterMs(now), null); return; }
            if (ip.Open >= _o.OpenLobbiesPerIp * Scale) { RateLimited(s, "open_lobbies", 5000, "max_lobbies"); return; }
        }
        if (_lobbies.Count >= _o.MaxLobbies || _members >= _o.MaxPeers) { Error(s, "server_full", "server is at its lobby limit"); return; }
        if (_o.GameQuotas.TryGetValue(s.GameId, out int quota) && _gameLobbies.GetValueOrDefault(s.GameId) >= quota)
        { Error(s, "server_full", "lobby quota for this game is reached"); return; }

        if (m["name"] is not null && Str(m, "name") is null) { Error(s, "bad_request", "name must be a string", Field("name")); return; }
        string vis = Str(m, "visibility") ?? "public";
        string mode = Str(m, "mode") ?? "lockstep";
        if (vis is not ("public" or "unlisted" or "private")) { Error(s, "bad_request", "visibility must be public, unlisted or private", Field("visibility")); return; }
        if (mode is not ("lockstep" or "raw")) { Error(s, "bad_request", "mode must be lockstep or raw", Field("mode")); return; }
        if (m["maxPlayers"] is not null && Int(m, "maxPlayers") is null) { Error(s, "bad_request", "maxPlayers must be an integer", Field("maxPlayers")); return; }
        int maxPlayers = Int(m, "maxPlayers") ?? 8;
        if (maxPlayers < 2 || maxPlayers > _o.HardMaxPlayers) { Error(s, "bad_request", $"maxPlayers must be 2-{_o.HardMaxPlayers}", Field("maxPlayers")); return; }
        if (m["tickRate"] is not null && Int(m, "tickRate") is null) { Error(s, "bad_request", "tickRate must be an integer", Field("tickRate")); return; }
        int tick = Int(m, "tickRate") ?? 20;
        if (tick < 1 || tick > 255) { Error(s, "bad_request", "tickRate must be 1-255", Field("tickRate")); return; }
        if (m["lateJoin"] is not null && Bool(m, "lateJoin") is null) { Error(s, "bad_request", "lateJoin must be a boolean", Field("lateJoin")); return; }
        if (m["relayOnly"] is not null && Bool(m, "relayOnly") is null) { Error(s, "bad_request", "relayOnly must be a boolean", Field("relayOnly")); return; }
        if (!ReadMeta(m["meta"], out var meta, out string? metaErr)) { Error(s, "bad_request", metaErr!, Field("meta")); return; }

        string? code = NewCode();
        if (code is null) { Error(s, "server_full", "could not allocate a join code"); return; }

        var lobby = new Lobby
        {
            Code = code, GameId = s.GameId, NetVersion = s.NetVersion,
            Name = Text.Sanitize(Str(m, "name"), LobbyNameMax, s.Name + "'s lobby"),
            Visibility = vis, Mode = mode, TickRate = tick, LateJoin = Bool(m, "lateJoin") ?? false,
            RelayOnly = Bool(m, "relayOnly") ?? false,
            MaxPlayers = maxPlayers, CreatedAt = now, OwnerIp = s.Ip, Meta = meta!,
        };
        _lobbies[code] = lobby;
        _gameLobbies[s.GameId] = _gameLobbies.GetValueOrDefault(s.GameId) + 1;
        ip.Open++;
        Metrics.Inc("onelobby_lobbies_created_total");
        var host = AddMember(lobby, s, null);
        lobby.HostId = host.PeerId;
        Log("create", lobby, s);
        Send(s, LobbyMsg(lobby, host));
    }

    private void Join(Session s, JsonObject m)
    {
        if (s.Lobby is not null || s.PendingIn is not null) { Error(s, "bad_request", "already in a lobby"); return; }
        var ip = IpOf(s.Ip);
        long now = _clock.NowMs;
        if (!_o.DisableIpLimits && !ip.Join.TryHit(now)) { RateLimited(s, "join", ip.Join.RetryAfterMs(now), null); return; }
        string? code = Crockford.Normalize(Str(m, "code"));
        if (code is null) { Error(s, "bad_request", "malformed join code", Field("code")); return; }
        if (!_lobbies.TryGetValue(code, out var lobby) || lobby.GameId != s.GameId)
        { Error(s, "unknown_code", "no lobby with that code"); return; }
        if (lobby.NetVersion != s.NetVersion)
        {
            Error(s, "version_mismatch", $"host is on {lobby.NetVersion}, you are on {s.NetVersion}",
                new JsonObject { ["hostNetVersion"] = lobby.NetVersion, ["yourNetVersion"] = s.NetVersion });
            return;
        }
        if (lobby.Kicked.Contains(s.Ip)) { Error(s, "kicked", "you were removed from this lobby"); return; }
        if (lobby.Phase == "in_game" && !lobby.LateJoin) { Error(s, "in_game", "the game has already started"); return; }
        if (lobby.Members.Count >= lobby.MaxPlayers) { Error(s, "lobby_full", "lobby is full"); return; }
        if (_members >= _o.MaxPeers) { Error(s, "server_full", "server is at its peer limit"); return; }

        if (lobby.Visibility == "private")
        {
            if (lobby.Pending.Count >= PendingMax) { Error(s, "lobby_full", "too many pending requests"); return; }
            var pm = new Member { PeerId = lobby.NextPeerId++, Name = s.Name, Session = s, Ip = s.Ip };
            lobby.Pending.Add(pm);
            s.PendingIn = lobby; s.PendingMember = pm;
            if (lobby.Find(lobby.HostId) is { Session: { } hs })
                Send(hs, new JsonObject { ["t"] = "join_request", ["peer"] = PeerObj(pm) });
            Log("join_request", lobby, s);
            return;
        }
        Admit(lobby, s, null);
    }

    private void Admit(Lobby lobby, Session s, Member? pending)
    {
        var joiner = AddMember(lobby, s, pending);
        Log("join", lobby, s);
        foreach (var other in lobby.Members)
            if (other != joiner) SendTo(other, new JsonObject { ["t"] = "peer_joined", ["peer"] = PeerObj(joiner) });
        // A lobby whose host slot is only reserved (host dropped, nobody was connected) hands over to the first newcomer.
        if (lobby.Find(lobby.HostId) is not { Session: not null }) PromoteHost(lobby, lobby.HostId);
        Send(s, LobbyMsg(lobby, joiner));
    }

    private Member AddMember(Lobby lobby, Session s, Member? reuse)
    {
        var mem = reuse ?? new Member { PeerId = lobby.NextPeerId++ };
        mem.Name = s.Name; mem.Session = s; mem.Ip = s.Ip; mem.JoinedAt = _clock.NowMs; mem.DetachedAt = 0;
        mem.Token = NewToken();
        lobby.Members.Add(mem);
        _members++;
        _tokens[mem.Token] = (lobby, mem);
        s.Lobby = lobby; s.Member = mem; s.PendingIn = null; s.PendingMember = null;
        return mem;
    }

    private void List(Session s, JsonObject m)
    {
        string? vis = Str(m, "visibility");
        if (vis != "public") { Error(s, "bad_request", "only public lobbies can be listed", Field("visibility")); return; }
        int limit = 50;
        if (m["limit"] is not null)
        {
            if (Int(m, "limit") is not { } l || l < 1 || l > _o.ListLimitMax) { Error(s, "bad_request", $"limit must be 1-{_o.ListLimitMax}", Field("limit")); return; }
            limit = l;
        }
        int offset = 0;
        if (m["cursor"] is not null && (Str(m, "cursor") is not { } c || !int.TryParse(c, NumberStyles.None, CultureInfo.InvariantCulture, out offset)))
        { Error(s, "bad_request", "bad cursor", Field("cursor")); return; }
        Dictionary<string, string>? filter = null;
        if (m["meta"] is not null)
        {
            if (m["meta"] is not JsonObject fm) { Error(s, "bad_request", "meta must be an object", Field("meta")); return; }
            filter = new();
            foreach (var kv in fm)
            {
                if (kv.Value is not JsonValue v || !v.TryGetValue<string>(out var sv)) { Error(s, "bad_request", "meta values must be strings", Field("meta")); return; }
                filter[kv.Key] = sv;
            }
        }
        var all = _lobbies.Values
            .Where(l => l.GameId == s.GameId && l.NetVersion == s.NetVersion && l.Visibility == "public"
                        && (l.Phase != "in_game" || l.LateJoin)
                        && (filter is null || filter.All(f => l.Meta.TryGetValue(f.Key, out var mv) && mv == f.Value)))
            .OrderBy(l => l.CreatedAt).ThenBy(l => l.Code, StringComparer.Ordinal)
            .ToList();
        var page = all.Skip(offset).Take(limit).ToList();
        var items = new JsonArray();
        foreach (var l in page)
        {
            var host = l.Find(l.HostId);
            items.Add(new JsonObject
            {
                ["code"] = l.Code, ["gameId"] = l.GameId, ["netVersion"] = l.NetVersion, ["name"] = l.Name,
                ["hostName"] = host?.Name ?? "", ["players"] = l.Members.Count, ["maxPlayers"] = l.MaxPlayers,
                ["phase"] = l.Phase, ["meta"] = MetaObj(l), ["region"] = _o.Region, ["createdAt"] = l.CreatedAt,
            });
        }
        var reply = new JsonObject { ["t"] = "lobbies", ["items"] = items };
        if (offset + page.Count < all.Count) reply["cursor"] = (offset + page.Count).ToString(CultureInfo.InvariantCulture);
        Send(s, reply);
    }

    private void Leave(Session s)
    {
        if (s.PendingIn is { } pl) { pl.Pending.Remove(s.PendingMember!); s.PendingIn = null; s.PendingMember = null; return; }
        if (s.Lobby is not { } lobby || s.Member is not { } mem) return;
        RemoveMember(lobby, mem, "left");
    }

    // ---------------------------------------------------------------- relay + host-only

    private void Signal(Session s, JsonObject m)
    {
        if (s.Lobby is not { } lobby || s.Member is not { } me) { Error(s, "bad_request", "not in a lobby"); return; }
        long now = _clock.NowMs;
        if (!_o.DisableIpLimits && !s.SignalRate!.TryHit(now)) { RateLimited(s, "signal", s.SignalRate.RetryAfterMs(now), null); return; }
        int? to = Int(m, "to");
        if (to is null || lobby.Find(to.Value) is not { Session: not null } target || target == me)
        { Error(s, "bad_request", "unknown signal target", Field("to")); return; }
        if (m["sdp"] is null && m["ice"] is null) { Error(s, "bad_request", "signal needs sdp or ice", Field("sdp")); return; }
        var o = new JsonObject { ["t"] = "signal", ["from"] = me.PeerId };
        if (m["sdp"] is { } sdp) o["sdp"] = sdp.DeepClone();
        if (m["ice"] is { } ice) o["ice"] = ice.DeepClone();
        Send(target.Session!, o);
        Metrics.Inc("onelobby_signals_relayed_total");
    }

    private bool RequireHost(Session s, out Lobby lobby)
    {
        lobby = s.Lobby!;
        if (s.Lobby is null || s.Member is null) { Error(s, "bad_request", "not in a lobby"); return false; }
        if (lobby.HostId != s.Member.PeerId) { Error(s, "not_host", "only the host can do that"); return false; }
        return true;
    }

    private void HostMeta(Session s, JsonObject m)
    {
        if (!RequireHost(s, out var lobby)) return;
        if (!ReadMeta(m["meta"], out var meta, out string? err) || m["meta"] is null) { Error(s, "bad_request", err ?? "meta is required", Field("meta")); return; }
        lobby.Meta = meta!;
        BroadcastLobby(lobby);
    }

    private void HostPhase(Session s, JsonObject m)
    {
        if (!RequireHost(s, out var lobby)) return;
        string? ph = Str(m, "phase");
        if (ph is not ("in_game" or "lobby")) { Error(s, "bad_request", "phase must be in_game or lobby", Field("phase")); return; }
        lobby.Phase = ph;
        Log("phase:" + ph, lobby, s);
        BroadcastLobby(lobby);
    }

    private void Kick(Session s, JsonObject m)
    {
        if (!RequireHost(s, out var lobby)) return;
        int? id = Int(m, "peerId");
        if (id is null || id == s.Member!.PeerId || lobby.Find(id.Value) is not { } target) { Error(s, "bad_request", "unknown peerId", Field("peerId")); return; }
        lobby.Kicked.Add(target.Ip);
        RemoveMember(lobby, target, "kicked");
    }

    private void Approve(Session s, JsonObject m)
    {
        if (!RequireHost(s, out var lobby)) return;
        int? id = Int(m, "peerId");
        var pm = id is null ? null : lobby.Pending.FirstOrDefault(p => p.PeerId == id);
        if (pm is null || pm.Session is not { } js) { Error(s, "bad_request", "no such pending request", Field("peerId")); return; }
        if (m["ok"] is not null && Bool(m, "ok") is null) { Error(s, "bad_request", "ok must be a boolean", Field("ok")); return; }
        lobby.Pending.Remove(pm);
        js.PendingIn = null; js.PendingMember = null;
        if (Bool(m, "ok") != true)
        {
            Error(js, "kicked", "the host declined your request", new JsonObject { ["reason"] = "denied" });
            return;
        }
        if (lobby.Members.Count >= lobby.MaxPlayers) { Error(js, "lobby_full", "lobby is full"); return; }
        if (lobby.Phase == "in_game" && !lobby.LateJoin) { Error(js, "in_game", "the game has already started"); return; }
        Admit(lobby, js, pm);
    }

    /// <summary>Peer-side migration (s.9) tells the server: the new host announces itself with a higher epoch.</summary>
    private void ClaimHost(Session s, JsonObject m)
    {
        if (s.Lobby is not { } lobby || s.Member is not { } me) return;
        int? host = Int(m, "hostId"); int? epoch = Int(m, "epoch");
        if (host != me.PeerId || epoch is null || epoch <= lobby.Epoch) return;
        lobby.HostId = me.PeerId;
        lobby.Epoch = epoch.Value;
        Broadcast(lobby, new JsonObject { ["t"] = "host_changed", ["hostId"] = lobby.HostId, ["epoch"] = lobby.Epoch });
        Metrics.Inc("onelobby_host_changes_total");
        Log("host_claim", lobby, s);
    }

    private void PathReport(Session s, JsonObject m)
    {
        string? p = Str(m, "path");
        if (p is "relayed" or "direct") Metrics.Inc("onelobby_path_total", "path", p);
        else Error(s, "bad_request", "path must be relayed or direct", Field("path"));
    }

    // ---------------------------------------------------------------- membership changes

    /// <summary>Removes a member for good. A member that is already detached was announced as left, so nothing is sent for it.</summary>
    private void RemoveMember(Lobby lobby, Member mem, string reason)
    {
        if (!lobby.Members.Remove(mem)) return;
        _members--;
        _tokens.Remove(mem.Token);
        var ms = mem.Session;
        bool wasConnected = mem.DetachedAt == 0;
        if (ms is not null) { ms.Lobby = null; ms.Member = null; }
        if (wasConnected)
        {
            var gone = new JsonObject { ["t"] = "peer_left", ["peerId"] = mem.PeerId, ["reason"] = reason };
            Broadcast(lobby, gone);
            Metrics.Inc("onelobby_peers_left_total", "reason", reason);
            if (reason == "kicked" && ms is not null)
                Error(ms, "kicked", "the host removed you from the lobby");
        }
        Log(reason, lobby, ms);

        if (lobby.Members.Count == 0) { CloseLobby(lobby); return; }
        if (lobby.HostId == mem.PeerId) PromoteHost(lobby, mem.PeerId);
    }

    /// <summary>Server mirror of the peer-side rule (s.9): new host is the lowest peerId still connected; epoch +1.</summary>
    private void PromoteHost(Lobby lobby, int leavingId)
    {
        Member? next = lobby.Members.Where(x => x.Session is not null && x.PeerId != leavingId).OrderBy(x => x.PeerId).FirstOrDefault();
        if (next is null)
        {
            // Nobody connected. Keep a reserved host slot (it may resume); otherwise fall back to the lowest slot.
            if (lobby.Find(leavingId) is not null) return;
            next = lobby.Members.OrderBy(x => x.PeerId).FirstOrDefault();
            if (next is null) return;
        }
        lobby.HostId = next.PeerId;
        lobby.Epoch++;
        Broadcast(lobby, new JsonObject { ["t"] = "host_changed", ["hostId"] = next.PeerId, ["epoch"] = lobby.Epoch });
        Metrics.Inc("onelobby_host_changes_total");
        if (next.Session is { } hs)
            foreach (var pm in lobby.Pending) // the new host inherits the pending requests
                Send(hs, new JsonObject { ["t"] = "join_request", ["peer"] = PeerObj(pm) });
        Log("host_changed", lobby, next.Session);
    }

    private void CloseLobby(Lobby lobby)
    {
        _lobbies.Remove(lobby.Code);
        _retired[lobby.Code] = _clock.NowMs;
        if (_gameLobbies.TryGetValue(lobby.GameId, out int n))
        { if (n <= 1) _gameLobbies.Remove(lobby.GameId); else _gameLobbies[lobby.GameId] = n - 1; }
        if (_ips.TryGetValue(lobby.OwnerIp, out var ip) && ip.Open > 0) ip.Open--;
        foreach (var pm in lobby.Pending.ToList())
            if (pm.Session is { } ps)
            {
                ps.PendingIn = null; ps.PendingMember = null;
                Error(ps, "unknown_code", "the lobby closed");
            }
        lobby.Pending.Clear();
        Log("close", lobby, null);
    }

    private string? NewCode()
    {
        for (int i = 0; i < 100; i++)
        {
            string c = Crockford.Generate(_rand);
            if (!_lobbies.ContainsKey(c) && !_retired.ContainsKey(c)) return c;
        }
        return null;
    }

    private static string NewToken() => Compat.Hex(Compat.RandomBytes(16)).ToLowerInvariant();

    // ---------------------------------------------------------------- output helpers

    private static JsonObject MetaObj(Lobby l)
    {
        var meta = new JsonObject();
        foreach (var kv in l.Meta) meta[kv.Key] = kv.Value;
        return meta;
    }

    private JsonObject LobbyMsg(Lobby l, Member you)
    {
        var peers = new JsonArray();
        foreach (var p in l.Members.Where(x => x.DetachedAt == 0).OrderBy(x => x.PeerId))
            peers.Add(new JsonObject { ["peerId"] = p.PeerId, ["name"] = p.Name, ["joinedAt"] = p.JoinedAt });
        return new JsonObject
        {
            ["t"] = "lobby", ["code"] = l.Code, ["gameId"] = l.GameId, ["netVersion"] = l.NetVersion,
            ["hostId"] = l.HostId, ["you"] = you.PeerId, ["mode"] = l.Mode, ["tickRate"] = l.TickRate,
            ["lateJoin"] = l.LateJoin, ["phase"] = l.Phase, ["meta"] = MetaObj(l), ["peers"] = peers,
            ["resumeToken"] = you.Token, ["name"] = l.Name, ["maxPlayers"] = l.MaxPlayers,
            ["visibility"] = l.Visibility, ["relayOnly"] = l.RelayOnly,
        };
    }

    private void BroadcastLobby(Lobby l)
    {
        foreach (var m in l.Members) if (m.Session is not null) SendTo(m, LobbyMsg(l, m));
    }

    private void Broadcast(Lobby l, JsonObject o)
    {
        foreach (var m in l.Members) SendTo(m, o);
    }

    private static JsonObject PeerObj(Member m) => new() { ["peerId"] = m.PeerId, ["name"] = m.Name };

    private void Send(Session s, JsonNode o)
    {
        if (!s.Closed) s.Send(o.ToJsonString());
    }

    private void SendTo(Member m, JsonNode o)
    {
        if (m.Session is { } s) Send(s, o);
    }

    private static JsonObject Field(string name) => new() { ["field"] = name };

    private void Error(Session s, string code, string msg, JsonNode? data = null)
    {
        Metrics.Inc("onelobby_errors_total", "code", code);
        var o = new JsonObject { ["t"] = "error", ["code"] = code, ["msg"] = msg };
        if (data is not null) o["data"] = data;
        s.Send(o.ToJsonString());
    }

    private void RateLimited(Session s, string kind, long retryAfterMs, string? reason)
    {
        Metrics.Inc("onelobby_rate_limit_hits_total", "kind", kind);
        _log.LogInformation("rate_limit kind={Kind} ip={Ip}", kind, HashIp(s.Ip));
        var data = new JsonObject { ["retryAfterMs"] = retryAfterMs };
        if (reason is not null) data["reason"] = reason;
        Error(s, "rate_limited", $"too many {kind} requests", data);
    }

    private void Log(string ev, Lobby l, Session? s) =>
        _log.LogInformation("lobby {Event} code={Code} game={Game} players={Players} ip={Ip}", ev, l.Code, l.GameId, l.Members.Count, s is null ? "-" : HashIp(s.Ip));

    private string HashIp(string ip) =>
        Compat.Hex(Compat.Sha256(System.Text.Encoding.UTF8.GetBytes(_logSalt + ip)), 0, 4).ToLowerInvariant();

    // ---------------------------------------------------------------- tolerant JSON readers

    private static string? Str(JsonObject o, string k) =>
        o[k] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static int? Int(JsonObject o, string k)
    {
        if (o[k] is not JsonValue v) return null;
        if (v.TryGetValue<int>(out var i)) return i;
        if (v.TryGetValue<double>(out var d) && d == Math.Floor(d) && Math.Abs(d) < int.MaxValue) return (int)d;
        return null;
    }

    private static bool? Bool(JsonObject o, string k) =>
        o[k] is JsonValue v && v.TryGetValue<bool>(out var b) ? b : null;

    /// <summary>Not sanitised (spec/signaling.md): over the limits or non-string values are rejected.</summary>
    private static bool ReadMeta(JsonNode? node, out SortedDictionary<string, string>? meta, out string? err)
    {
        meta = new SortedDictionary<string, string>(StringComparer.Ordinal); err = null;
        if (node is null) return true;
        if (node is not JsonObject o) { meta = null; err = "meta must be an object of strings"; return false; }
        if (o.Count > MetaKeysMax) { meta = null; err = $"meta allows at most {MetaKeysMax} keys"; return false; }
        foreach (var kv in o)
        {
            if (kv.Value is not JsonValue v || !v.TryGetValue<string>(out var sv)) { meta = null; err = "meta values must be strings"; return false; }
            if (kv.Key.Length > MetaLenMax || sv.Length > MetaLenMax) { meta = null; err = $"meta keys and values are limited to {MetaLenMax} chars"; return false; }
            meta[kv.Key] = sv;
        }
        return true;
    }
}
