using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace OneLobby.Tests
{
    /// <summary>Locates spec/ (stream E) by walking up from the test binary.</summary>
    internal static class Spec
    {
        public static string Root
        {
            get
            {
                var d = new DirectoryInfo(AppContext.BaseDirectory);
                while (d != null)
                {
                    if (Directory.Exists(Path.Combine(d.FullName, "spec", "vectors"))) return Path.Combine(d.FullName, "spec");
                    d = d.Parent;
                }
                throw new DirectoryNotFoundException("spec/ not found above " + AppContext.BaseDirectory);
            }
        }

        public static JsonDocument Load(string relative) => JsonDocument.Parse(File.ReadAllText(Path.Combine(Root, relative)));

        public static byte[] Hex(string hex) => Convert.FromHexString(hex);
        public static string ToHex(byte[] b) => Convert.ToHexString(b).ToLowerInvariant();

        /// <summary>Builds the frame a vector's "msg" describes, using the library's builders.</summary>
        public static byte[] Build(JsonElement m)
        {
            var type = m.GetProperty("type").GetString()!;
            var route = m.GetProperty("route").GetInt32();
            long L(string n) => long.Parse(m.GetProperty(n).GetString()!);
            ulong U(string n) => ulong.Parse(m.GetProperty(n).GetString()!);
            int I(string n) => m.GetProperty(n).GetInt32();
            uint UI(string n) => m.GetProperty(n).GetUInt32();
            byte[] B(JsonElement e, string n) => Hex(e.GetProperty(n).GetString()!);
            switch (type)
            {
                case "hi": return Wire.BuildHi(I("peerId"), L("lastTick"));
                case "welcome_dc": return Wire.BuildWelcomeDc(L("tick"), I("tickRate"), (byte)I("mode"), I("hostId"));
                case "cmd": return Wire.BuildCmd(UI("seq"), B(m, "bytes"));
                case "frame":
                {
                    var cmds = m.GetProperty("cmds").EnumerateArray()
                        .Select(c => (c.GetProperty("peerId").GetInt32(), (ReadOnlyMemory<byte>)B(c, "bytes"))).ToList();
                    return Wire.BuildFrame(L("tick"), cmds);
                }
                case "hash": return Wire.BuildHash(L("tick"), U("hash"));
                case "desync": return Wire.BuildDesync(L("tick"), U("hostHash"), U("yourHash"));
                case "snapshot_req": return Wire.BuildSnapshotReq(L("sinceTick"));
                case "snapshot": return Wire.BuildSnapshot(L("tick"), UI("total"), (byte)I("flags"));
                case "chunk": return Wire.BuildChunk(UI("id"), I("index"), I("count"), B(m, "bytes"));
                case "raw": return Wire.BuildRaw(route, B(m, "bytes"));
                case "ping": return Wire.BuildPing(Wire.Ping, UI("n"), UI("t"));
                case "pong": return Wire.BuildPing(Wire.Pong, UI("n"), UI("t"));
                case "host_claim": return Wire.BuildHostClaim(I("epoch"), I("hostId"), L("tick"));
                case "voice":
                    return Wire.BuildVoice(route, I("seq"), (byte)I("flags"),
                        m.GetProperty("packets").EnumerateArray().Select(p => B(p, "opus")).ToList());
                case "chat": return Wire.BuildChat(route, UI("id"), L("ts"), m.GetProperty("text").GetString()!);
                case "chat_history":
                    return Wire.BuildChatHistory(m.GetProperty("lines").EnumerateArray()
                        .Select(l => new ChatLine(l.GetProperty("peerId").GetInt32(), l.GetProperty("id").GetUInt32(),
                            long.Parse(l.GetProperty("ts").GetString()!), l.GetProperty("text").GetString()!)).ToList());
                case "chat_reject": return Wire.BuildChatReject(UI("id"), (byte)I("reason"));
                default: throw new InvalidOperationException("unknown vector type " + type);
            }
        }
    }
}
