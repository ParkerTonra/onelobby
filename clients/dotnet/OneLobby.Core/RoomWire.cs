using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace OneLobby
{
    /// <summary>One roster row on the host (mutable); <see cref="ToPublic"/> is what games see.</summary>
    internal sealed class EntryRec
    {
        public int Id;
        public string Name = "";
        public RoomRole Role;
        public int Seat = -1;
        public bool Ready, Legacy;
        public RoomStatus Status = RoomStatus.Connected;
        public Dictionary<string, string> Data = new();

        public EntryRec Clone() => new() { Id = Id, Name = Name, Role = Role, Seat = Seat, Ready = Ready, Legacy = Legacy, Status = Status, Data = new Dictionary<string, string>(Data) };
        public RoomEntry ToPublic() => new(Id, Name, Role, Seat, Ready, Status, new Dictionary<string, string>(Data), Legacy);
        public string Key() => RoomWire.Text(w => RoomWire.WriteEntry(w, this));
    }

    internal sealed record CountdownInfo(int Seq, int Total, int Left);

    /// <summary>Room frames (spec/room.md s.2-3): type 0x80, route 0, then one UTF-8 JSON object.</summary>
    internal static class RoomWire
    {
        private static readonly JsonWriterOptions Opts = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

        public static string Text(Action<Utf8JsonWriter> body)
        {
            using var ms = new MemoryStream();
            using (var w = new Utf8JsonWriter(ms, Opts)) body(w);
            return Encoding.UTF8.GetString(ms.ToArray());
        }

        /// <summary>The bytes of one room frame for a JSON object written by <paramref name="body"/> (between its braces).</summary>
        public static byte[] Frame(string t, Action<Utf8JsonWriter>? body = null)
        {
            var json = Text(w =>
            {
                w.WriteStartObject();
                w.WriteString("t", t);
                body?.Invoke(w);
                w.WriteEndObject();
            });
            return Wire.BuildRoom(json);
        }

        // ---- encoders -----------------------------------------------------------------------------------------------------

        public static void WriteData(Utf8JsonWriter w, string name, IReadOnlyDictionary<string, string> data)
        {
            w.WriteStartObject(name);
            foreach (var kv in data.OrderBy(k => k.Key, StringComparer.Ordinal)) w.WriteString(kv.Key, kv.Value);
            w.WriteEndObject();
        }

        public static void WriteEntry(Utf8JsonWriter w, EntryRec e)
        {
            w.WriteStartObject();
            w.WriteNumber("id", e.Id);
            w.WriteString("name", e.Name);
            w.WriteString("role", RoomRules.Name(e.Role));
            w.WriteNumber("seat", e.Seat);
            w.WriteBoolean("ready", e.Ready);
            w.WriteString("status", RoomRules.Name(e.Status));
            WriteData(w, "data", e.Data);
            if (e.Legacy) w.WriteBoolean("legacy", true);
            w.WriteEndObject();
        }

        public static void WriteDecl(Utf8JsonWriter w, DataDecl d)
        {
            w.WriteStartObject();
            w.WriteString("type", RoomRules.Name(d.Type));
            if (d.Min is int mn) w.WriteNumber("min", mn);
            if (d.Max is int mx) w.WriteNumber("max", mx);
            if (d.MaxLength is int ml) w.WriteNumber("maxLength", ml);
            if (d.Values != null) { w.WriteStartArray("values"); foreach (var v in d.Values) w.WriteStringValue(v); w.WriteEndArray(); }
            if (d.Default != null) w.WriteString("default", d.Default);
            if (d.HostOnly) w.WriteBoolean("hostOnly", true);
            w.WriteEndObject();
        }

        public static void WriteSettings(Utf8JsonWriter w, string name, RoomSettings s)
        {
            w.WriteStartObject(name);
            w.WriteNumber("maxPlayers", s.MaxPlayers);
            w.WriteNumber("spectators", s.Spectators);
            w.WriteNumber("minPlayers", s.MinPlayers);
            w.WriteString("autoStart", RoomRules.Name(s.AutoStart));
            w.WriteNumber("autoStartPlayers", s.AutoStartPlayers);
            w.WriteNumber("countdownMs", s.CountdownMs);
            w.WriteString("lateJoin", RoomRules.Name(s.LateJoin));
            w.WriteString("seatDropped", RoomRules.Name(s.SeatDropped));
            w.WriteNumber("rejoinWindowMs", s.RejoinWindowMs);
            w.WriteNumber("maxNameLength", s.MaxNameLength);
            w.WriteStartObject("data");
            foreach (var kv in s.Data.OrderBy(k => k.Key, StringComparer.Ordinal)) { w.WritePropertyName(kv.Key); WriteDecl(w, kv.Value); }
            w.WriteEndObject();
            w.WriteEndObject();
        }

        public static string SettingsKey(RoomSettings s) => Text(w => { w.WriteStartObject(); WriteSettings(w, "s", s); w.WriteEndObject(); });

        public static void WriteCountdown(Utf8JsonWriter w, string name, CountdownInfo? c)
        {
            if (c == null) { w.WriteNull(name); return; }
            w.WriteStartObject(name);
            w.WriteNumber("seq", c.Seq);
            w.WriteNumber("total", c.Total);
            w.WriteNumber("left", c.Left);
            w.WriteEndObject();
        }

        public static byte[] Join(string? pid, RoomRole role, string? password, IReadOnlyDictionary<string, string>? data) => Frame("join", w =>
        {
            w.WriteNumber("v", 1);
            if (!string.IsNullOrEmpty(pid)) w.WriteString("pid", pid);
            w.WriteString("role", RoomRules.Name(role));
            if (!string.IsNullOrEmpty(password)) w.WriteString("password", password);
            if (data != null && data.Count > 0) { w.WriteStartObject("data"); foreach (var kv in data) w.WriteString(kv.Key, kv.Value); w.WriteEndObject(); }
        });
        public static byte[] JoinMinimal() => Frame("join", w => w.WriteNumber("v", 1));
        public static byte[] Set(IReadOnlyDictionary<string, string> data) => Frame("set", w => { w.WriteStartObject("data"); foreach (var kv in data) w.WriteString(kv.Key, kv.Value); w.WriteEndObject(); });
        public static byte[] Ready(bool ready) => Frame("ready", w => w.WriteBoolean("ready", ready));
        public static byte[] Role(RoomRole role) => Frame("role", w => w.WriteString("role", RoomRules.Name(role)));
        public static byte[] Req(RoomRequest what) => Frame("req", w => w.WriteString("what", RoomRules.Name(what)));
        public static byte[] Resync() => Frame("resync");
        public static byte[] Cd(int seq, int left) => Frame("cd", w => { w.WriteNumber("seq", seq); w.WriteNumber("left", left); });
        public static byte[] Deny(string code, string reason) => Frame("deny", w => { w.WriteString("code", code); w.WriteString("reason", reason); });
        public static byte[] Nack(string re, string code, string? key = null) => Frame("nack", w =>
        {
            w.WriteString("re", re);
            w.WriteString("code", code);
            if (key != null) w.WriteString("key", key);
        });

        // ---- decoders -----------------------------------------------------------------------------------------------------

        /// <summary>The JSON object of a room <c>body</c>, or null when it is not UTF-8, not an object or has no string <c>t</c>. Dispose the document.</summary>
        public static JsonDocument? Parse(ReadOnlySpan<byte> body)
        {
            try
            {
                var text = Wire.DecodeUtf8(body);
                var doc = JsonDocument.Parse(text);
                if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("t", out var t) || t.ValueKind != JsonValueKind.String)
                {
                    doc.Dispose();
                    return null;
                }
                return doc;
            }
            catch (Exception) { return null; }
        }

        public static EntryRec? ParseEntry(JsonElement e)
        {
            if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty("id", out var idp) || idp.ValueKind != JsonValueKind.Number || !idp.TryGetInt32(out var id)) return null;
            var rec = new EntryRec
            {
                Id = id, Name = Signaling.Str(e, "name"), Role = RoomRules.ParseRole(Signaling.Str(e, "role")),
                Seat = Signaling.Int(e, "seat", -1), Ready = Signaling.Bool(e, "ready"), Status = RoomRules.ParseStatus(Signaling.Str(e, "status")),
                Legacy = Signaling.Bool(e, "legacy"),
            };
            if (e.TryGetProperty("data", out var d) && d.ValueKind == JsonValueKind.Object)
                foreach (var p in d.EnumerateObject()) if (p.Value.ValueKind == JsonValueKind.String) rec.Data[p.Name] = p.Value.GetString()!;
            return rec;
        }

        public static DataDecl ParseDecl(JsonElement e)
        {
            var d = new DataDecl(RoomRules.ParseDataType(Signaling.Str(e, "type")))
            {
                Min = e.TryGetProperty("min", out _) ? Signaling.Int(e, "min") : (int?)null,
                Max = e.TryGetProperty("max", out _) ? Signaling.Int(e, "max") : (int?)null,
                MaxLength = e.TryGetProperty("maxLength", out _) ? Signaling.Int(e, "maxLength") : (int?)null,
                Default = e.TryGetProperty("default", out var df) && df.ValueKind == JsonValueKind.String ? df.GetString() : null,
                HostOnly = Signaling.Bool(e, "hostOnly"),
            };
            if (e.TryGetProperty("values", out var vs) && vs.ValueKind == JsonValueKind.Array)
                d = d with { Values = vs.EnumerateArray().Where(v => v.ValueKind == JsonValueKind.String).Select(v => v.GetString()!).ToArray() };
            return d;
        }

        public static RoomSettings? ParseSettings(JsonElement e)
        {
            if (e.ValueKind != JsonValueKind.Object) return null;
            var data = new Dictionary<string, DataDecl>();
            if (e.TryGetProperty("data", out var d) && d.ValueKind == JsonValueKind.Object)
                foreach (var p in d.EnumerateObject()) if (p.Value.ValueKind == JsonValueKind.Object) data[p.Name] = ParseDecl(p.Value);
            return new RoomSettings(Signaling.Int(e, "maxPlayers", 4), Signaling.Int(e, "spectators"), Signaling.Int(e, "minPlayers", 1),
                RoomRules.ParseAutoStart(Signaling.Str(e, "autoStart")), Signaling.Int(e, "autoStartPlayers", 2), Signaling.Int(e, "countdownMs", 3000),
                RoomRules.ParseLateJoin(Signaling.Str(e, "lateJoin")), RoomRules.ParseSeatDropped(Signaling.Str(e, "seatDropped")),
                Signaling.Int(e, "rejoinWindowMs", 60000), Signaling.Int(e, "maxNameLength", 24), data);
        }

        public static CountdownInfo? ParseCountdown(JsonElement e) =>
            e.ValueKind == JsonValueKind.Object ? new CountdownInfo(Signaling.Int(e, "seq"), Signaling.Int(e, "total"), Signaling.Int(e, "left")) : null;

        /// <summary>The string pairs of a <c>data</c> object; a value that is not a string is null (the host answers bad_value).</summary>
        public static List<KeyValuePair<string, string?>> ParsePairs(JsonElement e)
        {
            var l = new List<KeyValuePair<string, string?>>();
            if (e.ValueKind == JsonValueKind.Object)
                foreach (var p in e.EnumerateObject()) l.Add(new KeyValuePair<string, string?>(p.Name, p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() : null));
            return l;
        }
    }
}
