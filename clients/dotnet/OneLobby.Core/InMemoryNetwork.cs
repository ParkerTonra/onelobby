using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace OneLobby
{
    /// <summary>Per-channel byte and frame counters (see <see cref="InMemoryNetwork.Traffic"/>).</summary>
    public sealed class TrafficCounter
    {
        private readonly long[] _bytes = new long[3];
        private readonly long[] _frames = new long[3];
        public long Bytes(PeerChannel channel) => _bytes[(int)channel];
        public long Frames(PeerChannel channel) => _frames[(int)channel];
        public void Reset() { Array.Clear(_bytes, 0, 3); Array.Clear(_frames, 0, 3); }
        internal void Count(PeerChannel channel, int bytes) { _bytes[(int)channel] += bytes; _frames[(int)channel]++; }
    }

    /// <summary>
    /// A whole OneLobby world in memory: a fake lobby server speaking the lk1 signaling protocol plus loopback "WebRTC"
    /// links, with a manual clock. Lets games and tests run lobbies, lockstep, chat and voice offline and deterministically.
    /// Make one network, call <see cref="CreateTransport"/> per client, and drive time with <see cref="Advance"/>/<see cref="Step"/>.
    /// </summary>
    public sealed class InMemoryNetwork
    {
        private sealed class Sock : ISignalingSocket
        {
            public readonly InMemoryNetwork Net;
            public readonly Queue<string> Inbox = new();
            public SocketState State { get; set; } = SocketState.Open;
            public string? CloseReason { get; set; }
            public string GameId = "", NetVersion = "", Name = "";
            public int PeerId;
            public SrvLobby? Lobby;
            public Sock(InMemoryNetwork n) { Net = n; }
            public void Send(string text) { if (State == SocketState.Open) Net.ServerReceive(this, text); }
            public bool TryReceive(out string text)
            {
                if (Inbox.Count > 0) { text = Inbox.Dequeue(); return true; }
                text = "";
                return false;
            }
            public void Dispose() { if (State != SocketState.Closed) { State = SocketState.Closed; Net.ServerDisconnect(this); } }
        }

        private sealed class SrvLobby
        {
            public string Code = "", Name = "", GameId = "", NetVersion = "", Mode = "lockstep";
            public int TickRate = 20, MaxPlayers = 4, HostId = 1, NextPeer = 2;
            public Visibility Visibility;
            public bool LateJoin = true;
            public string Phase = "lobby";
            public Dictionary<string, string> Meta = new();
            public SortedDictionary<int, Sock> Members = new();
            public Dictionary<int, Sock> Pending = new();
            public DateTimeOffset Created;
        }

        private sealed class Link : IPeerLink
        {
            public readonly InMemoryTransport Owner;
            public readonly InMemoryNetwork Net;
            public readonly bool Initiator;
            public readonly string Token;
            public Link? Other;
            public bool Open, Failed;
            public readonly Queue<PeerSignal> Out = new();
            public readonly List<(long At, PeerChannel Ch, byte[] Data)> Inbox = new();
            private long _lastReliableAt;
            public Link(InMemoryTransport owner, bool initiator, string token) { Owner = owner; Net = owner.Net; Initiator = initiator; Token = token; }
            public bool IsOpen => Open && !Failed;
            public bool IsFailed => Failed;
            public int PingMs => (int)(Net.LatencyMs * 2);
            public bool Relayed => false;
            public void StartOffer()
            {
                Net.Offers[Token] = this;
                Out.Enqueue(PeerSignal.Description("offer", "offer:" + Token));
            }
            public void ApplySignal(PeerSignal s)
            {
                if (s.Sdp == null) return;
                if (s.SdpType == "offer" && !Initiator)
                {
                    var token = s.Sdp.Substring("offer:".Length);
                    if (!Net.Offers.TryGetValue(token, out var offerer) || offerer.Failed) return;
                    Other = offerer; offerer.Other = this;
                    Out.Enqueue(PeerSignal.Description("answer", "answer:" + token));
                }
                else if (s.SdpType == "answer" && Initiator && Other != null)
                {
                    Open = true; Other.Open = true;
                    Net.Offers.Remove(Token);
                }
            }
            public bool TryTakeSignal(out PeerSignal signal)
            {
                if (Out.Count > 0) { signal = Out.Dequeue(); return true; }
                signal = null!;
                return false;
            }
            public void Send(PeerChannel channel, ReadOnlySpan<byte> frame)
            {
                if (!IsOpen || Other == null || Other.Failed) return;
                Owner.Traffic.Count(channel, frame.Length);
                if (channel != PeerChannel.Reliable && Net.DropUnreliable != null && Net.DropUnreliable()) return;
                var at = Net.NowMs + (long)Net.LatencyMs + (long)Math.Max(0, Net.ExtraDelayMs?.Invoke(channel) ?? 0);
                if (channel == PeerChannel.Reliable)
                {
                    // ordered channel: jitter delays, never reorders
                    if (at < _lastReliableAt) at = _lastReliableAt;
                    _lastReliableAt = at;
                }
                Other.Inbox.Add((at, channel, frame.ToArray()));
            }
            public bool TryReceive(out PeerChannel channel, out byte[] frame)
            {
                for (var i = 0; i < Inbox.Count; i++)
                {
                    if (Inbox[i].At > Net.NowMs) continue;
                    (_, channel, frame) = Inbox[i];
                    Inbox.RemoveAt(i);
                    return true;
                }
                channel = PeerChannel.Reliable; frame = Array.Empty<byte>();
                return false;
            }
            public void Dispose()
            {
                if (Failed) return;
                Failed = true; Open = false;
                if (Other != null) { Other.Failed = true; Other.Open = false; }
                Net.Offers.Remove(Token);
            }
        }

        private sealed class InMemoryTransport : ITransport
        {
            public readonly InMemoryNetwork Net;
            public readonly List<Sock> Sockets = new();
            public readonly List<Link> Links = new();
            public readonly TrafficCounter Traffic = new();
            public InMemoryTransport(InMemoryNetwork n) { Net = n; }
            public long NowMs => Net.NowMs;
            public ISignalingSocket ConnectSignaling(Uri url)
            {
                var s = new Sock(Net);
                Sockets.Add(s);
                return s;
            }
            public IPeerLink CreatePeerLink(PeerLinkOptions options)
            {
                var token = options.Initiator ? "L" + (++Net._tokenCounter) : "";
                var l = new Link(this, options.Initiator, token);
                Links.Add(l);
                return l;
            }
            public void Poll() { }
            public void Kill()
            {
                foreach (var s in Sockets.ToList()) s.Dispose();
                foreach (var l in Links.ToList()) l.Dispose();
            }
            public void CutPeers() { foreach (var l in Links.ToList()) l.Dispose(); }
        }

        private readonly Dictionary<string, SrvLobby> _lobbies = new();
        private readonly List<InMemoryTransport> _transports = new();
        private readonly Dictionary<InMemoryTransport, string> _names = new();
        private readonly Dictionary<string, Link> Offers = new();
        private int _tokenCounter;
        private uint _codeCounter;

        /// <summary>The manual clock shared by every transport of this network.</summary>
        public long NowMs { get; private set; }
        /// <summary>One-way delivery delay for data channel frames.</summary>
        public double LatencyMs { get; set; }
        /// <summary>When set, called for every fast/voice frame; return true to lose it.</summary>
        public Func<bool>? DropUnreliable { get; set; }
        /// <summary>When set, extra one-way delay in ms per frame (jitter). Reliable frames stay in order.</summary>
        public Func<PeerChannel, double>? ExtraDelayMs { get; set; }

        /// <summary>Bytes and frames this transport has sent on its peer links (whole frames, lobby header included), counted before loss.</summary>
        public TrafficCounter Traffic(ITransport transport) => ((InMemoryTransport)transport).Traffic;

        /// <summary>Allowed (gameId) values; empty means any.</summary>
        public ISet<string> AllowedGames { get; } = new HashSet<string>();

        public void Advance(long ms) => NowMs += ms;

        public ITransport CreateTransport()
        {
            var t = new InMemoryTransport(this);
            _transports.Add(t);
            return t;
        }

        /// <summary>Simulates a crash: closes the transport's signaling socket and every peer link, without a goodbye.</summary>
        public void Crash(ITransport transport) => ((InMemoryTransport)transport).Kill();

        /// <summary>Drops only the signaling socket (the lobby server goes away for that client); data channels live on.</summary>
        public void DropServerConnection(ITransport transport)
        {
            foreach (var s in ((InMemoryTransport)transport).Sockets.ToList()) s.Dispose();
        }

        /// <summary>Kills the lobby server for everyone; data channels live on.</summary>
        public void ShutdownServer()
        {
            foreach (var t in _transports)
                foreach (var s in t.Sockets) { s.State = SocketState.Closed; s.Lobby = null; }
            _lobbies.Clear();
        }

        /// <summary>Pumps every client once and advances the clock by <paramref name="ms"/>. Test helper.</summary>
        public void Step(IEnumerable<LobbyClient> clients, long ms = 25)
        {
            Advance(ms);
            foreach (var c in clients.ToList()) c.Pump();
        }

        // ---- fake lobby server ---------------------------------------------------------------------------------

        private static void Reply(Sock s, string json) { if (s.State == SocketState.Open) s.Inbox.Enqueue(json); }

        private static void Error(Sock s, string code, string msg) => Reply(s, Signaling.Build(w =>
        {
            w.WriteString("t", "error"); w.WriteString("code", code); w.WriteString("msg", msg);
        }));

        private void ServerReceive(Sock s, string text)
        {
            JsonDocument doc;
            try { doc = JsonDocument.Parse(text); } catch (JsonException) { Error(s, "bad_request", "not json"); return; }
            using (doc)
            {
                var e = doc.RootElement;
                var t = Signaling.Str(e, "t");
                if (t != "hello" && s.GameId.Length == 0) { Error(s, "bad_request", "hello first"); return; }
                switch (t)
                {
                    case "hello":
                        s.GameId = Signaling.Str(e, "gameId");
                        s.NetVersion = Signaling.Str(e, "netVersion");
                        s.Name = Signaling.Str(e, "name");
                        if (AllowedGames.Count > 0 && !AllowedGames.Contains(s.GameId)) { Error(s, "game_not_allowed", s.GameId); return; }
                        Reply(s, Signaling.Build(w =>
                        {
                            w.WriteString("t", "welcome");
                            w.WriteStartArray("ice"); w.WriteEndArray();
                            w.WriteNumber("serverTime", NowMs);
                            w.WriteStartObject("limits"); w.WriteNumber("maxMsg", 16384); w.WriteNumber("maxPlayers", 250); w.WriteEndObject();
                        }));
                        if (e.TryGetProperty("resumeToken", out var rt) && rt.ValueKind == JsonValueKind.String) Resume(s, rt.GetString() ?? "");
                        break;
                    case "create": Create(s, e); break;
                    case "join": Join(s, Signaling.Str(e, "code")); break;
                    case "list": List(s, e); break;
                    case "leave": Leave(s, "left"); break;
                    case "signal":
                    {
                        var l = s.Lobby;
                        if (l == null) return;
                        var to = Signaling.Int(e, "to");
                        if (!l.Members.TryGetValue(to, out var dest)) return;
                        var sig = Signaling.ParseSignal(e);
                        if (sig == null) return;
                        Reply(dest, ForwardSignal(s.PeerId, sig));
                        break;
                    }
                    case "meta": if (s.Lobby != null && s.Lobby.HostId == s.PeerId) { s.Lobby.Meta = Signaling.MetaOf(e); BroadcastLobby(s.Lobby); } break;
                    case "phase": if (s.Lobby != null && s.Lobby.HostId == s.PeerId) { s.Lobby.Phase = Signaling.Str(e, "phase"); BroadcastLobby(s.Lobby); } break;
                    case "kick":
                    {
                        var l = s.Lobby;
                        if (l == null || l.HostId != s.PeerId) { Error(s, "not_host", "only the host kicks"); return; }
                        if (l.Members.TryGetValue(Signaling.Int(e, "peerId"), out var victim)) { Remove(victim, "kicked"); Error(victim, "kicked", "kicked by host"); }
                        break;
                    }
                    case "approve":
                    {
                        var l = s.Lobby;
                        if (l == null || l.HostId != s.PeerId) return;
                        var id = Signaling.Int(e, "peerId");
                        if (!l.Pending.TryGetValue(id, out var p)) return;
                        l.Pending.Remove(id);
                        if (Signaling.Bool(e, "ok")) Admit(l, p, id); else Error(p, "kicked", "host declined");
                        break;
                    }
                    case "ping": Reply(s, Signaling.Pong(Signaling.Int(e, "n"))); break;
                }
            }
        }

        private static string ForwardSignal(int from, PeerSignal sig) => Signaling.Build(w =>
        {
            w.WriteString("t", "signal"); w.WriteNumber("from", from);
            if (sig.Sdp != null) { w.WriteStartObject("sdp"); w.WriteString("type", sig.SdpType); w.WriteString("sdp", sig.Sdp); w.WriteEndObject(); }
            else { w.WriteStartObject("ice"); w.WriteString("candidate", sig.Candidate); w.WriteString("sdpMid", sig.SdpMid); w.WriteNumber("sdpMLineIndex", sig.SdpMLineIndex); w.WriteEndObject(); }
        });

        private void Create(Sock s, JsonElement e)
        {
            if (s.Lobby != null) { Error(s, "bad_request", "already in a lobby"); return; }
            var l = new SrvLobby
            {
                Code = Crockford.FromValue(unchecked(++_codeCounter * 2654435761u) & 0x3FFFFFFF),
                Name = Signaling.Str(e, "name"), GameId = s.GameId, NetVersion = s.NetVersion,
                Mode = Signaling.Str(e, "mode", "lockstep"), TickRate = Signaling.Int(e, "tickRate", 20),
                MaxPlayers = Math.Max(2, Math.Min(250, Signaling.Int(e, "maxPlayers", 4))),
                LateJoin = Signaling.Bool(e, "lateJoin", true), Meta = Signaling.MetaOf(e),
                Visibility = Signaling.Str(e, "visibility") switch { "public" => Visibility.Public, "private" => Visibility.Private, _ => Visibility.Unlisted },
                Created = DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_000 + NowMs),
            };
            _lobbies[l.Code] = l;
            s.Lobby = l; s.PeerId = 1; l.Members[1] = s;
            Reply(s, LobbyJson(l, 1));
        }

        private void Join(Sock s, string code)
        {
            var norm = Crockford.Normalize(code);
            if (norm == null || !_lobbies.TryGetValue(norm, out var l)) { Error(s, "unknown_code", code); return; }
            if (l.GameId != s.GameId) { Error(s, "unknown_code", code); return; }
            if (l.NetVersion != s.NetVersion) { Error(s, "version_mismatch", "host is on " + l.NetVersion); return; }
            if (l.Members.Count >= l.MaxPlayers) { Error(s, "lobby_full", "full"); return; }
            if (l.Phase == "in_game" && !l.LateJoin) { Error(s, "in_game", "game in progress"); return; }
            var id = l.NextPeer++;
            if (l.Visibility == Visibility.Private)
            {
                l.Pending[id] = s;
                Reply(l.Members[l.HostId], Signaling.Build(w => { w.WriteString("t", "join_request"); w.WriteStartObject("peer"); w.WriteNumber("peerId", id); w.WriteString("name", s.Name); w.WriteEndObject(); }));
                return;
            }
            Admit(l, s, id);
        }

        private void Admit(SrvLobby l, Sock s, int id)
        {
            s.Lobby = l; s.PeerId = id;
            foreach (var m in l.Members.Values)
                Reply(m, Signaling.Build(w => { w.WriteString("t", "peer_joined"); w.WriteStartObject("peer"); w.WriteNumber("peerId", id); w.WriteString("name", s.Name); w.WriteEndObject(); }));
            l.Members[id] = s;
            Reply(s, LobbyJson(l, id));
        }

        private void Resume(Sock s, string token) { Error(s, "bad_request", "in-memory server does not support resume tokens"); }

        private void List(Sock s, JsonElement e)
        {
            var filter = Signaling.MetaOf(e);
            var items = _lobbies.Values.Where(l => l.Visibility == Visibility.Public && l.GameId == s.GameId && l.NetVersion == s.NetVersion
                && (l.Phase == "lobby" || l.LateJoin) && filter.All(kv => l.Meta.TryGetValue(kv.Key, out var v) && v == kv.Value))
                .OrderBy(l => l.Code, StringComparer.Ordinal).ToList();
            Reply(s, Signaling.Build(w =>
            {
                w.WriteString("t", "lobbies");
                w.WriteStartArray("items");
                foreach (var l in items)
                {
                    w.WriteStartObject();
                    w.WriteString("code", l.Code); w.WriteString("gameId", l.GameId); w.WriteString("netVersion", l.NetVersion);
                    w.WriteString("name", l.Name); w.WriteString("hostName", l.Members[l.HostId].Name);
                    w.WriteNumber("players", l.Members.Count); w.WriteNumber("maxPlayers", l.MaxPlayers);
                    w.WriteString("phase", l.Phase); Signaling.WriteMeta(w, "meta", l.Meta);
                    w.WriteString("region", "mem"); w.WriteNumber("createdAt", l.Created.ToUnixTimeMilliseconds());
                    w.WriteEndObject();
                }
                w.WriteEndArray();
            }));
        }

        private static string LobbyJson(SrvLobby l, int you) => Signaling.Build(w =>
        {
            w.WriteString("t", "lobby"); w.WriteString("code", l.Code); w.WriteString("gameId", l.GameId); w.WriteString("netVersion", l.NetVersion);
            w.WriteNumber("hostId", l.HostId); w.WriteNumber("you", you); w.WriteString("mode", l.Mode); w.WriteNumber("tickRate", l.TickRate);
            w.WriteBoolean("lateJoin", l.LateJoin); w.WriteString("phase", l.Phase); Signaling.WriteMeta(w, "meta", l.Meta);
            w.WriteStartArray("peers");
            foreach (var m in l.Members) { w.WriteStartObject(); w.WriteNumber("peerId", m.Key); w.WriteString("name", m.Value.Name); w.WriteNumber("joinedAt", 0); w.WriteEndObject(); }
            w.WriteEndArray();
            w.WriteString("resumeToken", "tok-" + l.Code + "-" + you);
        });

        private void BroadcastLobby(SrvLobby l)
        {
            foreach (var m in l.Members) Reply(m.Value, LobbyJson(l, m.Key));
        }

        private void Leave(Sock s, string reason)
        {
            if (s.Lobby != null) Remove(s, reason);
        }

        private void Remove(Sock s, string reason)
        {
            var l = s.Lobby;
            if (l == null) return;
            var id = s.PeerId;
            l.Members.Remove(id);
            s.Lobby = null;
            if (l.Members.Count == 0) { _lobbies.Remove(l.Code); return; }
            var msg = Signaling.Build(w => { w.WriteString("t", "peer_left"); w.WriteNumber("peerId", id); w.WriteString("reason", reason); });
            Reply(s, msg);
            foreach (var m in l.Members.Values) Reply(m, msg);
            if (l.HostId == id)
            {
                l.HostId = l.Members.Keys.Min();
                var hc = Signaling.Build(w => { w.WriteString("t", "host_changed"); w.WriteNumber("hostId", l.HostId); });
                foreach (var m in l.Members.Values) Reply(m, hc);
            }
        }

        private void ServerDisconnect(Sock s)
        {
            if (s.Lobby != null) Remove(s, "timeout");
        }
    }
}
