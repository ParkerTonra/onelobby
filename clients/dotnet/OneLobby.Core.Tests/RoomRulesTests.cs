using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace OneLobby.Tests
{
    /// <summary>The pure rules of the room layer against spec/vectors/room.json (the same tables as JS room-rules.test.ts).</summary>
    public class RoomRulesTests
    {
        private static JsonElement V => _doc.RootElement;
        private static readonly JsonDocument _doc = Spec.Load("vectors/room.json");

        private static string? Str(JsonElement e, string n) => e.TryGetProperty(n, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;

        [Fact]
        public void Names()
        {
            var filters = new Dictionary<string, Func<string, RoomFilterKind, string>?>();
            foreach (var f in V.GetProperty("names").GetProperty("filters").EnumerateObject())
            {
                if (f.Value.ValueKind == JsonValueKind.Null) { filters[f.Name] = null; continue; }
                var rep = f.Value.GetProperty("replace").EnumerateArray().Select(x => x.GetString()!).ToArray();
                filters[f.Name] = (t, k) => t.Replace(rep[0], rep[1]);
            }
            foreach (var c in V.GetProperty("names").GetProperty("cases").EnumerateArray())
            {
                var others = c.GetProperty("others").EnumerateArray().Select(x => x.GetString()!).ToList();
                var filter = filters[Str(c, "filter") ?? "none"];
                var got = RoomRules.EffectiveName(c.GetProperty("input").GetString(), c.GetProperty("peerId").GetInt32(), others, c.GetProperty("max").GetInt32(), filter);
                Assert.True(c.GetProperty("expect").GetString() == got, c.GetProperty("name").GetString() + ": " + got);
            }
        }

        private static IReadOnlyDictionary<string, DataDecl> DataSpec()
        {
            var d = new Dictionary<string, DataDecl>();
            foreach (var p in V.GetProperty("data").GetProperty("spec").EnumerateObject()) d[p.Name] = RoomWire.ParseDecl(p.Value);
            return RoomRules.MergeDataSpec(d);
        }

        private static Dictionary<string, string> Strings(JsonElement o) => o.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString()!);

        [Fact]
        public void Data()
        {
            var spec = DataSpec();
            foreach (var c in V.GetProperty("data").GetProperty("cases").EnumerateArray())
            {
                var name = c.GetProperty("name").GetString();
                var set = RoomWire.ParsePairs(c.GetProperty("set"));
                var r = RoomRules.ApplyData(spec, Strings(c.GetProperty("before")), set, c.GetProperty("byHost").GetBoolean());
                var want = c.GetProperty("expect");
                Assert.True(want.GetProperty("ok").GetBoolean() == r.Ok, name + ": ok");
                if (r.Ok) Assert.True(Strings(want.GetProperty("data")).OrderBy(k => k.Key).SequenceEqual(r.Data!.OrderBy(k => k.Key)), name + ": data");
                else
                {
                    Assert.True(want.GetProperty("code").GetString() == r.Code, name + ": code " + r.Code);
                    Assert.True(Str(want, "key") == r.Key, name + ": key");
                }
            }
            foreach (var c in V.GetProperty("data").GetProperty("defaultsAtAdmission").EnumerateArray())
                Assert.Equal(Strings(c.GetProperty("expect")).OrderBy(k => k.Key), RoomRules.DataDefaults(spec, Strings(c.GetProperty("data"))).OrderBy(k => k.Key));
        }

        [Fact]
        public void Seats()
        {
            foreach (var c in V.GetProperty("seats").EnumerateArray())
            {
                var max = c.GetProperty("maxPlayers").GetInt32();
                var memory = new Dictionary<string, int>();
                var held = new Dictionary<string, int>();
                var got = new List<int?>();
                int SeatOf(string pid, string role)
                {
                    if (role == "spectator") return -1;
                    var r = RoomRules.ChooseSeat(max, new HashSet<int>(held.Values), memory, pid);
                    if (r.TakeOver != null) memory.Remove(r.TakeOver);
                    if (r.Seat >= 0)
                    {
                        held[pid] = r.Seat;
                        if (pid.Length > 0) memory[pid] = r.Seat;
                    }
                    return r.Seat;
                }
                foreach (var op in c.GetProperty("ops").EnumerateArray())
                {
                    var a = op.EnumerateArray().Select(x => x.GetString()!).ToArray();
                    if (a[0] == "join") got.Add(SeatOf(a[1], a[2]));
                    else if (a[0] == "drop") { held.Remove(a[1]); got.Add(null); }
                    else { held.Remove(a[1]); got.Add(SeatOf(a[1], a[2])); }
                }
                var want = c.GetProperty("expect").EnumerateArray().Select(x => x.ValueKind == JsonValueKind.Null ? (int?)null : x.GetInt32()).ToList();
                Assert.True(want.SequenceEqual(got), c.GetProperty("name").GetString());
            }
        }

        [Fact]
        public void BansAutoStartCountdownAdmission()
        {
            foreach (var c in V.GetProperty("bans").GetProperty("cases").EnumerateArray())
            {
                var e = c.GetProperty("entry");
                var cand = c.GetProperty("candidate");
                var entry = new BanEntry(Str(e, "id"), Str(e, "ip"), null, null, null, 0);
                Assert.True(c.GetProperty("expect").GetBoolean() == RoomRules.BanMatches(entry, Str(cand, "id"), Str(cand, "ip")), "ban " + c.GetProperty("name").GetString());
            }
            foreach (var c in V.GetProperty("autoStart").GetProperty("cases").EnumerateArray())
            {
                var rule = c.GetProperty("rule");
                var players = c.GetProperty("players").EnumerateArray().Select(t =>
                {
                    var s = t.GetString()!;
                    return new RoomRules.StartPlayer(s[0] == 's' ? RoomRole.Spectator : RoomRole.Player, s[1] == 'x' ? RoomStatus.Reconnecting : RoomStatus.Connected, s[1] == 'r', s[1] == 'l');
                }).ToList();
                var got = RoomRules.AutoStartHolds(RoomRules.ParseAutoStart(rule.GetProperty("mode").GetString()), rule.GetProperty("autoStartPlayers").GetInt32(),
                    rule.GetProperty("minPlayers").GetInt32(), players);
                Assert.True(c.GetProperty("expect").GetBoolean() == got, "autostart " + c.GetProperty("name").GetString());
            }
            foreach (var c in V.GetProperty("countdown").GetProperty("cases").EnumerateArray())
            {
                var rtt = c.GetProperty("rtt");
                Assert.True(c.GetProperty("expect").GetInt32() == RoomRules.CountdownRemaining(c.GetProperty("left").GetInt32(), rtt.ValueKind == JsonValueKind.Null ? (int?)null : rtt.GetInt32()),
                    "countdown " + c.GetProperty("name").GetString());
            }
            var adm = V.GetProperty("admission");
            foreach (var c in adm.GetProperty("cases").EnumerateArray())
            {
                var b = adm.GetProperty("base").EnumerateObject().ToDictionary(p => p.Name, p => p.Value);
                foreach (var p in c.GetProperty("with").EnumerateObject()) b[p.Name] = p.Value;
                var got = RoomRules.Admit(b["banned"].GetBoolean(), b["hasPassword"].GetBoolean(), b["passwordOk"].GetBoolean(), RoomRules.ParseState(b["state"].GetString()),
                    RoomRules.ParseLateJoin(b["lateJoin"].GetString()), RoomRules.ParseRole(b["role"].GetString()), b["players"].GetInt32(), b["maxPlayers"].GetInt32(),
                    b["spectators"].GetInt32(), b["spectatorCap"].GetInt32());
                var want = c.GetProperty("expect");
                Assert.True(want.GetProperty("ok").GetBoolean() == got.Ok, "admission " + c.GetProperty("name").GetString());
                if (got.Ok) Assert.Equal(want.GetProperty("role").GetString(), RoomRules.Name(got.Role));
                else Assert.Equal(want.GetProperty("code").GetString(), got.Code);
            }
        }

        [Fact]
        public void ReasonsAndPlayerIds()
        {
            foreach (var p in V.GetProperty("defaultReasons").EnumerateObject()) Assert.Equal(p.Value.GetString(), RoomRules.RemovalReason(p.Name, ""));
            foreach (var c in V.GetProperty("reasonRules").GetProperty("cases").EnumerateArray())
                Assert.Equal(c.GetProperty("expect").GetString(), RoomRules.RemovalReason(c.GetProperty("code").GetString()!, c.GetProperty("text").GetString()));
            foreach (var s in V.GetProperty("playerId").GetProperty("valid").EnumerateArray()) Assert.True(RoomRules.IsPlayerId(s.GetString()));
            foreach (var s in V.GetProperty("playerId").GetProperty("invalid").EnumerateArray()) Assert.False(RoomRules.IsPlayerId(s.ValueKind == JsonValueKind.String ? s.GetString() : null));
            var a = RoomRules.NewPlayerId();
            Assert.True(RoomRules.IsPlayerId(a));
            Assert.NotEqual(a, RoomRules.NewPlayerId());
        }

        [Fact]
        public void Frames()
        {
            foreach (var f in V.GetProperty("frames").EnumerateArray())
            {
                var name = f.GetProperty("name").GetString();
                var hex = f.GetProperty("hex").GetString()!;
                var json = f.GetProperty("json");
                byte[] built = name switch
                {
                    "join_minimal" => RoomWire.JoinMinimal(),
                    "join_full" => RoomWire.Join(Str(json, "pid"), RoomRole.Spectator, "pw", new Dictionary<string, string> { ["color"] = "#ff8800" }),
                    "ready" => RoomWire.Ready(true),
                    "cd" => RoomWire.Cd(1, 2000),
                    "deny_banned" => RoomWire.Deny("banned", "You are banned from this game."),
                    _ => throw new InvalidOperationException("no builder for frame " + name),
                };
                Assert.True(hex == Spec.ToHex(built), "encode " + name);
                var raw = Spec.Hex(hex);
                Assert.Null(Wire.Validate(raw));
                using var doc = RoomWire.Parse(Wire.Body(raw));
                Assert.NotNull(doc);
                Assert.Equal(JsonSerializer.Serialize(json), JsonSerializer.Serialize(doc!.RootElement));
            }
        }

        [Fact]
        public void BadBodiesAreDropped()
        {
            foreach (var body in new[] { new byte[] { 0xff, 0xfe }, "[1]"u8.ToArray(), "{\"x\":1}"u8.ToArray(), "{"u8.ToArray() })
                Assert.Null(RoomWire.Parse(body));
        }
    }
}
