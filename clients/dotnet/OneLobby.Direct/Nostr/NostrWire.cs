#nullable enable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace OneLobby.Direct.Nostr
{
    /// <summary>
    /// Nostr signaling settings (spec/nostr-signaling.md): which relays carry the frames and which STUN servers the peer
    /// links use. Set on <see cref="DirectHostOptions.Nostr"/>, or pass one to <c>JoinDirectAsync</c>.
    /// </summary>
    public sealed class NostrOptions
    {
        /// <summary>Library default relays (anonymous, free, public).</summary>
        public static IReadOnlyList<string> DefaultRelays => Blueprint.DefaultNostrRelays;

        /// <summary>Public STUN servers used by Nostr peers (spec s.5).</summary>
        public static readonly IReadOnlyList<string> DefaultStun = new[]
        {
            "stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478",
        };

        /// <summary>Host: publish a version 1 join code and answer joiners over Nostr. Default on.</summary>
        public bool Enabled { get; set; } = true;
        /// <summary><c>wss://</c> relay URLs; null or empty = <see cref="DefaultRelays"/>. Precedence (hosting and joining alike): this list when set, else the client's blueprint <c>hosting.nostrRelays</c>, else <see cref="DefaultRelays"/>. The startup line's <c>nostr n/m relays</c> shows the count in use.</summary>
        public IReadOnlyList<string>? Relays { get; set; }
        /// <summary>STUN URLs for the peer links; null = <see cref="DefaultStun"/>, an empty list = no ICE servers.</summary>
        public IReadOnlyList<string>? Stun { get; set; }

        internal IReadOnlyList<string> EffectiveRelays => Relays is { Count: > 0 } ? Relays : DefaultRelays;
        internal IReadOnlyList<string> EffectiveStun => Stun ?? DefaultStun;

        /// <summary>Test seam: builds the relay pool for a topic; null = real WebSockets.</summary>
        internal Func<string, INostrRelays>? RelayFactory { get; set; }
        /// <summary>Test seam: milliseconds clock; null = a monotonic stopwatch.</summary>
        internal Func<long>? NowMs { get; set; }
        /// <summary>Test seam: unix seconds; null = the system clock.</summary>
        internal Func<long>? UnixSeconds { get; set; }
        /// <summary>Test seam: false = nobody ticks the sockets/bridge, the test calls Tick() itself.</summary>
        internal bool AutoTick { get; set; } = true;
    }

    /// <summary>The key and topic of a code (spec s.2).</summary>
    internal sealed class NostrRoomKeys
    {
        public byte[] Key { get; }
        public string Topic { get; }

        private NostrRoomKeys(byte[] key, string topic) { Key = key; Topic = topic; }

        /// <summary><paramref name="normalizedCode"/>: the 11 code characters, upper case, no separators.</summary>
        public static NostrRoomKeys Derive(string normalizedCode)
        {
            var ikm = Encoding.ASCII.GetBytes(normalizedCode);
            var salt = Encoding.ASCII.GetBytes("onelobby-nostr-v1");
            var key = NostrCrypto.Hkdf(ikm, salt, Encoding.ASCII.GetBytes("key"));
            var topic = NostrCrypto.Hex(NostrCrypto.Hkdf(ikm, salt, Encoding.ASCII.GetBytes("topic")));
            return new NostrRoomKeys(key, topic);
        }
    }

    /// <summary>A frame (spec s.4).</summary>
    internal sealed class NostrFrame
    {
        public string Type = "";
        public string From = "";
        public string To = "";
        public long Seq;
        public long Ack;
        public List<string>? Msgs;
        public string? Reason;

        private static readonly JsonWriterOptions WriterOptions = new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

        public string ToJson()
        {
            using var ms = new MemoryStream();
            using (var w = new Utf8JsonWriter(ms, WriterOptions))
            {
                w.WriteStartObject();
                w.WriteNumber("v", 1);
                w.WriteString("type", Type);
                w.WriteString("from", From);
                w.WriteString("to", To);
                w.WriteNumber("seq", Seq);
                w.WriteNumber("ack", Ack);
                if (Msgs != null)
                {
                    w.WriteStartArray("msgs");
                    foreach (var m in Msgs) w.WriteStringValue(m);
                    w.WriteEndArray();
                }
                if (Reason != null) w.WriteString("reason", Reason);
                w.WriteEndObject();
            }
            return Encoding.UTF8.GetString(ms.ToArray());
        }

        public static NostrFrame? Parse(string json)
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                var e = doc.RootElement;
                if (e.ValueKind != JsonValueKind.Object) return null;
                if (!e.TryGetProperty("v", out var v) || v.ValueKind != JsonValueKind.Number || v.GetInt32() != 1) return null;
                var to = Str(e, "to");
                if (to == null) return null; // spec s.4: `to` is always present, "" for a broadcast
                var f = new NostrFrame
                {
                    Type = Str(e, "type") ?? "",
                    From = Str(e, "from") ?? "",
                    To = to,
                    Seq = Num(e, "seq"),
                    Ack = Num(e, "ack"),
                    Reason = Str(e, "reason"),
                };
                if (f.Type != "open" && f.Type != "data" && f.Type != "beat" && f.Type != "close") return null;
                if (e.TryGetProperty("msgs", out var m) && m.ValueKind == JsonValueKind.Array)
                {
                    f.Msgs = new List<string>();
                    foreach (var x in m.EnumerateArray())
                        if (x.ValueKind == JsonValueKind.String) f.Msgs.Add(x.GetString()!); // others are dropped, like the JS filter
                }
                return f;
            }
            catch (Exception e) when (e is JsonException || e is InvalidOperationException || e is FormatException) { return null; }
        }

        private static string? Str(JsonElement e, string name) =>
            e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        private static long Num(JsonElement e, string name) =>
            e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : 0;
    }

    /// <summary>A NIP-01 event of kind 25050 built and read the way spec s.3 says.</summary>
    internal static class NostrEvents
    {
        public const int Kind = 25050;

        /// <summary>The signed event as JSON text. <paramref name="content"/> is base64, which needs no escaping.</summary>
        public static string Build(byte[] secretKey, string pubkeyHex, long createdAt, string topic, string content, byte[]? aux = null, byte[]? evenYPublicKey = null)
        {
            var id = NostrCrypto.Sha256(Serialize(pubkeyHex, createdAt, topic, content));
            var sig = Schnorr.Sign(id, secretKey, aux, evenYPublicKey);
            return "{\"id\":\"" + NostrCrypto.Hex(id) + "\",\"pubkey\":\"" + pubkeyHex + "\",\"created_at\":" + createdAt.ToString(CultureInfo.InvariantCulture)
                   + ",\"kind\":" + Kind + ",\"tags\":[[\"t\",\"" + topic + "\"]],\"content\":\"" + content + "\",\"sig\":\"" + NostrCrypto.Hex(sig) + "\"}";
        }

        public static string Serialize(string pubkeyHex, long createdAt, string topic, string content) =>
            "[0,\"" + pubkeyHex + "\"," + createdAt.ToString(CultureInfo.InvariantCulture) + "," + Kind + ",[[\"t\",\"" + topic + "\"]],\"" + content + "\"]";

        public static string EventMessage(string eventJson) => "[\"EVENT\"," + eventJson + "]";

        public static string ReqMessage(string subId, string topic, long since) =>
            "[\"REQ\",\"" + subId + "\",{\"kinds\":[" + Kind + "],\"#t\":[\"" + topic + "\"],\"since\":" + since.ToString(CultureInfo.InvariantCulture) + "}]";

        public static string Seal(NostrRoomKeys keys, string frameJson)
        {
            var iv = NostrCrypto.RandomBytes(12);
            return Convert.ToBase64String(NostrCrypto.GcmSeal(keys.Key, iv, Encoding.UTF8.GetBytes(frameJson)));
        }

        public static string? Open(NostrRoomKeys keys, string content)
        {
            byte[] blob;
            try { blob = Convert.FromBase64String(content); }
            catch (FormatException) { return null; }
            var plain = NostrCrypto.GcmOpen(keys.Key, blob);
            return plain == null ? null : Encoding.UTF8.GetString(plain);
        }
    }
}
