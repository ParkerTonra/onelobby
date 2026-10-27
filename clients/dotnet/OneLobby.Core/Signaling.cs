using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;

namespace OneLobby
{
    internal sealed record LobbyPeerInfo(int PeerId, string Name);

    internal sealed record LobbyMsg(string Code, string GameId, string NetVersion, int HostId, int You, SyncMode Mode,
        int TickRate, bool LateJoin, LobbyPhase Phase, Dictionary<string, string> Meta, List<LobbyPeerInfo> Peers,
        string ResumeToken, string Name = "");

    /// <summary>JSON signaling messages (DESIGN s.7): builders and tolerant parsers.</summary>
    internal static class Signaling
    {
        public const string Proto = "lk1";

        public static string Build(Action<Utf8JsonWriter> body)
        {
            using var ms = new MemoryStream();
            using (var w = new Utf8JsonWriter(ms))
            {
                w.WriteStartObject();
                body(w);
                w.WriteEndObject();
            }
            return Encoding.UTF8.GetString(ms.ToArray());
        }

        public static string Hello(OneLobbyConfig c, string? resumeToken) => Build(w =>
        {
            w.WriteString("t", "hello");
            w.WriteString("proto", Proto);
            w.WriteString("gameId", c.GameId);
            w.WriteString("netVersion", c.NetVersion);
            w.WriteStartObject("client");
            w.WriteString("lib", "onelobby-dotnet");
            w.WriteString("ver", "0.1.0");
            w.WriteString("platform", "dotnet");
            w.WriteEndObject();
            w.WriteString("name", c.DisplayName);
            if (resumeToken != null) w.WriteString("resumeToken", resumeToken);
        });

        public static string VisibilityName(Visibility v) => v switch
        {
            Visibility.Public => "public",
            Visibility.Private => "private",
            _ => "unlisted",
        };

        public static string Create(OneLobbyConfig c, LobbyOptions o) => Build(w =>
        {
            w.WriteString("t", "create");
            w.WriteString("name", o.Name);
            w.WriteNumber("maxPlayers", o.MaxPlayers);
            w.WriteString("visibility", VisibilityName(o.Visibility));
            w.WriteString("mode", c.Mode == SyncMode.Raw ? "raw" : "lockstep");
            w.WriteNumber("tickRate", c.TickRate);
            w.WriteBoolean("lateJoin", o.LateJoin);
            WriteMeta(w, "meta", o.Meta);
            if (c.RelayOnly) w.WriteBoolean("relayOnly", true);
        });

        public static void WriteMeta(Utf8JsonWriter w, string name, IReadOnlyDictionary<string, string>? meta)
        {
            w.WriteStartObject(name);
            if (meta != null) foreach (var kv in meta) w.WriteString(kv.Key, kv.Value);
            w.WriteEndObject();
        }

        public static string Join(string code) => Build(w => { w.WriteString("t", "join"); w.WriteString("code", code); });
        /// <summary>Direct IP: the hub runs one lobby, so no code (docs/design/direct-ip.md s.2).</summary>
        public static string JoinDirect(string? password) => Build(w =>
        {
            w.WriteString("t", "join");
            if (!string.IsNullOrEmpty(password)) w.WriteString("password", password);
        });

        public static string List(IReadOnlyDictionary<string, string>? filter) => Build(w =>
        {
            w.WriteString("t", "list");
            w.WriteString("visibility", "public");
            if (filter != null && filter.Count > 0) WriteMeta(w, "meta", filter);
            w.WriteNumber("limit", 100);
        });

        public static string Simple(string t) => Build(w => w.WriteString("t", t));
        public static string Phase(LobbyPhase p) => Build(w => { w.WriteString("t", "phase"); w.WriteString("phase", p == LobbyPhase.InGame ? "in_game" : "lobby"); });
        public static string Kick(int peerId, bool ban = true, int? closeCode = null, string? closeReason = null) => Build(w =>
        {
            w.WriteString("t", "kick"); w.WriteNumber("peerId", peerId);
            if (!ban) w.WriteBoolean("ban", false);
            if (closeCode is int c) w.WriteNumber("closeCode", c);
            if (closeReason != null) w.WriteString("closeReason", closeReason);
        });
        public static string Approve(int peerId, bool ok) => Build(w => { w.WriteString("t", "approve"); w.WriteNumber("peerId", peerId); w.WriteBoolean("ok", ok); });
        public static string Meta(IReadOnlyDictionary<string, string> m) => Build(w => { w.WriteString("t", "meta"); WriteMeta(w, "meta", m); });
        public static string Ping(int n) => Build(w => { w.WriteString("t", "ping"); w.WriteNumber("n", n); });
        public static string Pong(int n) => Build(w => { w.WriteString("t", "pong"); w.WriteNumber("n", n); });

        public static string Signal(int to, PeerSignal s) => Build(w =>
        {
            w.WriteString("t", "signal");
            w.WriteNumber("to", to);
            if (s.Sdp != null)
            {
                w.WriteStartObject("sdp");
                w.WriteString("type", s.SdpType);
                w.WriteString("sdp", s.Sdp);
                w.WriteEndObject();
            }
            else
            {
                w.WriteStartObject("ice");
                w.WriteString("candidate", s.Candidate);
                w.WriteString("sdpMid", s.SdpMid);
                w.WriteNumber("sdpMLineIndex", s.SdpMLineIndex);
                w.WriteEndObject();
            }
        });

        public static string Str(JsonElement e, string name, string dflt = "") =>
            e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
                ? v.GetString() ?? dflt : dflt;

        public static int Int(JsonElement e, string name, int dflt = 0) =>
            e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i)
                ? i : dflt;

        public static bool Bool(JsonElement e, string name, bool dflt = false) =>
            e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False)
                ? v.GetBoolean() : dflt;

        public static Dictionary<string, string> MetaOf(JsonElement e, string name = "meta")
        {
            var d = new Dictionary<string, string>();
            if (e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var m) && m.ValueKind == JsonValueKind.Object)
                foreach (var p in m.EnumerateObject())
                    d[p.Name] = p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() ?? "" : p.Value.ToString();
            return d;
        }

        public static LobbyPhase PhaseOf(JsonElement e) => Str(e, "phase") == "in_game" ? LobbyPhase.InGame : LobbyPhase.Lobby;

        public static LobbyMsg ParseLobby(JsonElement e)
        {
            var peers = new List<LobbyPeerInfo>();
            if (e.TryGetProperty("peers", out var ps) && ps.ValueKind == JsonValueKind.Array)
                foreach (var p in ps.EnumerateArray()) peers.Add(new LobbyPeerInfo(Int(p, "peerId"), Str(p, "name")));
            return new LobbyMsg(Str(e, "code"), Str(e, "gameId"), Str(e, "netVersion"), Int(e, "hostId", 1), Int(e, "you", 1),
                Str(e, "mode") == "raw" ? SyncMode.Raw : SyncMode.Lockstep, Int(e, "tickRate", 20), Bool(e, "lateJoin", true),
                PhaseOf(e), MetaOf(e), peers, Str(e, "resumeToken"), Str(e, "name"));
        }

        public static LobbySummary ParseSummary(JsonElement e)
        {
            var created = DateTimeOffset.FromUnixTimeSeconds(0);
            if (e.TryGetProperty("createdAt", out var c))
            {
                if (c.ValueKind == JsonValueKind.Number && c.TryGetInt64(out var n))
                    created = n > 100_000_000_000 ? DateTimeOffset.FromUnixTimeMilliseconds(n) : DateTimeOffset.FromUnixTimeSeconds(n);
                else if (c.ValueKind == JsonValueKind.String && DateTimeOffset.TryParse(c.GetString(), out var dt)) created = dt;
            }
            return new LobbySummary(Str(e, "code"), Str(e, "name"), Str(e, "hostName"), Int(e, "players"), Int(e, "maxPlayers"),
                PhaseOf(e), MetaOf(e), Str(e, "region"), created);
        }

        public static List<IceServer> ParseIce(JsonElement welcome)
        {
            var list = new List<IceServer>();
            if (welcome.TryGetProperty("ice", out var ice) && ice.ValueKind == JsonValueKind.Array)
                foreach (var s in ice.EnumerateArray())
                {
                    var urls = new List<string>();
                    if (s.TryGetProperty("urls", out var u))
                    {
                        if (u.ValueKind == JsonValueKind.Array) foreach (var x in u.EnumerateArray()) urls.Add(x.GetString() ?? "");
                        else if (u.ValueKind == JsonValueKind.String) urls.Add(u.GetString() ?? "");
                    }
                    var user = Str(s, "username");
                    var cred = Str(s, "credential");
                    list.Add(new IceServer(urls, user.Length == 0 ? null : user, cred.Length == 0 ? null : cred));
                }
            return list;
        }

        public static PeerSignal? ParseSignal(JsonElement e)
        {
            if (e.TryGetProperty("sdp", out var sdp) && sdp.ValueKind == JsonValueKind.Object)
                return PeerSignal.Description(Str(sdp, "type"), Str(sdp, "sdp"));
            if (e.TryGetProperty("ice", out var ice) && ice.ValueKind == JsonValueKind.Object)
                return PeerSignal.Ice(Str(ice, "candidate"), Str(ice, "sdpMid"), Int(ice, "sdpMLineIndex"));
            return null;
        }
    }
}
