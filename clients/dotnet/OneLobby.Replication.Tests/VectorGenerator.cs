using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using OneLobby.Replication;
using Xunit;

namespace OneLobby.Replication.Tests
{
    /// <summary>
    /// Builds spec/vectors/replication.json from the C# reference. To regenerate after changing a case or the codec, from
    /// the repository root:
    /// <c>ONELOBBY_WRITE_VECTORS=1 dotnet test clients/dotnet/OneLobby.Replication.Tests --artifacts-path .tmp-art --filter VectorFileTests</c>
    /// Without the variable the test fails when the committed file differs from what the reference produces, so the file
    /// cannot drift from the code.
    /// </summary>
    internal static class VectorBuilder
    {
        private static string Hex(ReadOnlySpan<byte> b) => Convert.ToHexString(b).ToLowerInvariant();
        private static byte[] Unhex(string h) => Convert.FromHexString(h);
        private static string Pattern(int len, int start = 1) => Hex(Enumerable.Range(0, len).Select(i => (byte)(start + i * 7)).ToArray());

        private static readonly JsonSerializerOptions Opts = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

        // ---- snapshots ---------------------------------------------------------------------------------------------

        private static JsonArray WorldJson(IEnumerable<Ent> ents) =>
            new(ents.Select(e => (JsonNode)new JsonArray(e.Id, (int)e.Type, e.Owner, Hex(e.State))).ToArray());

        private static World W(uint tick, params (uint Id, int Type, int Owner, string State)[] e) =>
            new(tick, e.Select(x => new Ent(x.Id, (ushort)x.Type, x.Owner, Unhex(x.State))).ToList());

        private static JsonNode? BaselineJson(World? b) =>
            b == null ? null : new JsonObject { ["tick"] = b.Tick, ["world"] = WorldJson(b.Ents) };

        private static JsonObject Snap(string name, World cur, World? baseline, uint lastInput, Action<JsonObject>? extra = null)
        {
            var bytes = Proto.EncodeSnapshot(cur, baseline, lastInput, new ByteWriter(), new ByteWriter());
            var o = new JsonObject { ["name"] = name, ["tick"] = cur.Tick, ["lastInputSeq"] = lastInput };
            o["baseline"] = BaselineJson(baseline);
            o["world"] = WorldJson(cur.Ents);
            o["hex"] = Hex(bytes);
            extra?.Invoke(o);
            return o;
        }

        private static JsonArray Snapshots()
        {
            var a = new JsonArray();
            var b5 = W(5, (1, 7, 0, "0102"), (3, 1, 2, "aa"));
            var b7 = W(7, (1, 7, 0, "0109"), (4, 7, 0, "ff"));
            a.Add(Snap("full snapshot, two entities", b5, null, 0));
            a.Add(Snap("delta: one changed byte, one despawn, one spawn", b7, b5, 4));
            a.Add(Snap("delta: nothing changed", W(8, (1, 7, 0, "0109"), (4, 7, 0, "ff")), b7, 4));
            a.Add(Snap("full snapshot of an empty world", W(1), null, 0));
            a.Add(Snap("delta: empty world to empty world", W(2), W(1), 0));
            var s20 = Pattern(20);
            var s20b = Hex(Unhex(s20).Select((x, i) => i == 0 || i == 7 || i == 8 || i == 19 ? (byte)(x ^ 0x5a) : x).ToArray());
            a.Add(Snap("delta: 20-byte state, changed bytes 0, 7, 8 and 19 (three mask bytes)",
                W(40, (2, 3, 1, s20b)), W(39, (2, 3, 1, s20)), 9));
            var s9 = Pattern(9);
            a.Add(Snap("delta: 9-byte state, only the last byte changed (mask spills into byte 1)",
                W(41, (2, 3, 1, s9.Substring(0, 16) + "ee")), W(40, (2, 3, 1, s9)), 9));
            var s255 = Pattern(255);
            a.Add(Snap("full snapshot with a 255-byte state", W(10, (1, 2, 0, s255)), null, 0));
            var s255b = Hex(Unhex(s255).Select((x, i) => i % 40 == 0 || i == 254 ? (byte)(x + 1) : x).ToArray());
            a.Add(Snap("delta: 255-byte state, 7 bytes changed (32-byte mask)", W(11, (1, 2, 0, s255b)), W(10, (1, 2, 0, s255)), 1));
            a.Add(Snap("full snapshot with an empty state (len 0)", W(3, (1, 5, 0, "")), null, 0));
            a.Add(Snap("delta: an empty state never changes", W(4, (1, 5, 0, "")), W(3, (1, 5, 0, "")), 0));
            var bs = W(20, (1, 1, 1, "0102"), (2, 1, 2, "03"), (3, 4, 0, "0405"));
            a.Add(Snap("spawn, delta and despawn in one message",
                W(21, (1, 1, 1, "01ff"), (4, 9, 3, "aabb")), bs, 12));
            a.Add(Snap("delta: a changed type, owner or length is sent as a full record",
                W(22, (1, 1, 1, "0102"), (2, 2, 2, "03"), (3, 4, 0, "040506")), bs, 12));
            a.Add(Snap("full snapshot with entity ids above 127 (multi-byte id deltas)",
                W(100, (1, 1, 0, "01"), (200, 2, 0, "02"), (16511, 3, 0, "03"), (70000, 4, 0, "04")), null, 0));
            a.Add(Snap("delta: despawn and spawn across large id gaps",
                W(101, (200, 2, 0, "02"), (70000, 4, 0, "05"), (4000000000, 5, 0, "06")),
                W(100, (1, 1, 0, "01"), (200, 2, 0, "02"), (70000, 4, 0, "04")), 1));
            a.Add(Snap("full snapshot: type 65535 and a large owner id", W(5, (1, 65535, 70000, "01")), null, 0));
            a.Add(Snap("delta against a baseline 64 ticks back, large tick and lastInput",
                W(70000, (1, 1, 1, "0a0b")), W(69936, (1, 1, 1, "0a0c")), 300000));
            a.Add(Snap("a client that does not hold the baseline drops the snapshot (counted, not an error)",
                W(9, (1, 7, 0, "0109")), W(5, (1, 7, 0, "0102")), 0, o => o["clientHoldsBaseline"] = false));
            return a;
        }

        // ---- inputs / events ---------------------------------------------------------------------------------------

        private static JsonObject Inp(string name, uint ack, uint newest, params (ulong View, string Hex)[] list)
        {
            var bytes = Proto.EncodeInput(ack, newest, list.Select(x => (x.View, Unhex(x.Hex))).ToList(), list.Length, new ByteWriter());
            return new JsonObject
            {
                ["name"] = name, ["ack"] = ack, ["newestSeq"] = newest,
                ["inputs"] = new JsonArray(list.Select(x => (JsonNode)new JsonArray(x.View, x.Hex)).ToArray()),
                ["hex"] = Hex(bytes),
            };
        }

        private static JsonArray Inputs() => new()
        {
            Inp("two inputs, newest first, view ticks 5.5 and 5.0", 7, 12, (1408, "01"), (1280, "02")),
            Inp("ack only", 300, 0),
            Inp("n = 0 with a sequence number (the heartbeat a client sends when it has nothing new)", 40, 25),
            Inp("n = 1 (InputRedundancy 1)", 3, 3, (768, "07")),
            Inp("n = 4, the default redundancy window, seq 10 down to 7", 9, 10, (2560, "0a"), (2304, "09"), (2048, "08"), (1792, "07")),
            Inp("n = 4 at the start of a session (newest 4: seq 4 down to 1)", 0, 4, (256, "04"), (256, "03"), (0, "02"), (0, "01")),
            Inp("an empty input and a view tick of 0", 1, 2, (0, ""), (0, "")),
            Inp("a 1024-byte input", 6, 9, (1536, Pattern(1024, 3))),
            Inp("a large view tick (host tick 70000.5) and a large seq", 70000, 1000000, (17920128, "ffee")),
            Inp("n = newest = 2 (every number so far fits the window)", 0, 2, (512, "aa"), (256, "bb")),
        };

        private static JsonObject Ev(string name, uint tick, string payload) => new()
        {
            ["name"] = name, ["tick"] = tick, ["payloadHex"] = payload, ["hex"] = Hex(Proto.EncodeEvent(tick, Unhex(payload), new ByteWriter())),
        };

        private static JsonArray Events() => new()
        {
            Ev("event at tick 300", 300, "6869"),
            Ev("event with an empty payload", 1, ""),
            Ev("event at tick 0 (a client that has no clock estimate yet)", 0, "01"),
            Ev("event at a large tick, 100-byte payload", 4000000000, Pattern(100, 9)),
        };

        private static JsonObject Se(string name, uint tick, byte stream, uint seq, string payload) => new()
        {
            ["name"] = name, ["tick"] = tick, ["stream"] = stream, ["seq"] = seq, ["payloadHex"] = payload,
            ["hex"] = Hex(Proto.EncodeStreamEvent(tick, stream, seq, Unhex(payload), new ByteWriter())),
        };

        private static JsonArray StreamEvents() => new()
        {
            Se("stream 1, first event", 300, 1, 1, "6869"),
            Se("stream 255, seq 128 (two-byte varint)", 1, 255, 128, "ff"),
            Se("empty payload", 5, 3, 2, ""),
            Se("large seq and tick", 70000, 7, 4097, "0102030405"),
            Se("seq 4294967295", 2, 2, 4294967295, "aa"),
        };

        // ---- state bits ---------------------------------------------------------------------------------------------

        private sealed record Op(JsonObject Json, Action<NetWriter> Write, Func<NetReader, JsonNode?> Read);

        private static Op OpBits(uint v, int n) => new(new() { ["op"] = "bits", ["v"] = v, ["n"] = n }, w => w.WriteBits(v, n), r => r.ReadBits(n));
        private static Op OpBool(bool v) => new(new() { ["op"] = "bool", ["v"] = v }, w => w.WriteBool(v), r => r.ReadBool());
        private static Op OpByte(byte v) => new(new() { ["op"] = "byte", ["v"] = v }, w => w.WriteByte(v), r => r.ReadByte());
        private static Op OpU16(ushort v) => new(new() { ["op"] = "u16", ["v"] = v }, w => w.WriteUInt16(v), r => r.ReadUInt16());
        private static Op OpU32(uint v) => new(new() { ["op"] = "u32", ["v"] = v }, w => w.WriteUInt32(v), r => r.ReadUInt32());
        private static Op OpI32(int v) => new(new() { ["op"] = "i32", ["v"] = v }, w => w.WriteInt32(v), r => r.ReadInt32());
        private static Op OpFloat(float v) => new(new() { ["op"] = "float", ["v"] = v }, w => w.WriteFloat(v), r => r.ReadFloat());
        private static Op OpQ(float v, float min, float max, int bits) =>
            new(new() { ["op"] = "q", ["v"] = v, ["min"] = min, ["max"] = max, ["bits"] = bits }, w => w.WriteQuantized(v, min, max, bits), r => r.ReadQuantized(min, max, bits));
        private static Op OpAngle(float v, int bits) => new(new() { ["op"] = "angle", ["v"] = v, ["bits"] = bits }, w => w.WriteAngle(v, bits), r => r.ReadAngle(bits));
        private static Op OpQuat(float x, float y, float z, float wv, int bits = 9) =>
            new(new() { ["op"] = "quat", ["v"] = new JsonArray(x, y, z, wv), ["bits"] = bits }, w => w.WriteQuaternion(x, y, z, wv, bits),
                r => { var q = r.ReadQuaternion(bits); return new JsonArray(q.X, q.Y, q.Z, q.W); });
        private static Op Rep(Op o, int times) { o.Json["repeat"] = times; return o; }

        private static JsonObject Copy(JsonObject o) => JsonNode.Parse(o.ToJsonString())!.AsObject();

        private static JsonObject SB(string name, params Op[] ops)
        {
            var w = new NetWriter();
            foreach (var o in ops) for (var i = 0; i < (o.Json["repeat"]?.GetValue<int>() ?? 1); i++) o.Write(w);
            var bytes = w.ToArray();
            var r = new NetReader(bytes);
            var reads = new JsonArray();
            foreach (var o in ops)
            {
                var j = Copy(o.Json);
                j["read"] = o.Read(r);
                for (var i = 1; i < (o.Json["repeat"]?.GetValue<int>() ?? 1); i++) o.Read(r);
                reads.Add(j);
            }
            return new JsonObject
            {
                ["name"] = name, ["ops"] = new JsonArray(ops.Select(o => (JsonNode)Copy(o.Json)).ToArray()),
                ["bits"] = w.BitCount, ["hex"] = Hex(bytes), ["reads"] = reads, ["overrun"] = r.Overrun,
            };
        }

        private static JsonObject ReadOnly(string name, string hex, params Op[] reads)
        {
            var r = new NetReader(Unhex(hex));
            var arr = new JsonArray();
            foreach (var o in reads) { var j = Copy(o.Json); j["read"] = o.Read(r); arr.Add(j); }
            return new JsonObject { ["name"] = name, ["hex"] = hex, ["reads"] = arr, ["overrun"] = r.Overrun };
        }

        private static JsonArray StateBits() => new()
        {
            SB("WriteBits(5,3) WriteBits(1,1) WriteBits(0xAB,8)", OpBits(5, 3), OpBits(1, 1), OpBits(0xAB, 8)),
            SB("bool x3, true false true", OpBool(true), OpBool(false), OpBool(true)),
            SB("eight bools fill one byte", OpBool(true), OpBool(true), OpBool(false), OpBool(false), OpBool(true), OpBool(false), OpBool(true), OpBool(true)),
            SB("byte after a bool straddles two bytes", OpBool(true), OpByte(0xA5)),
            SB("byte 0 and byte 255", OpByte(0), OpByte(255)),
            SB("u16 0x1234 and 0xFFFF", OpU16(0x1234), OpU16(0xFFFF)),
            SB("u16 after 3 bits", OpBits(7, 3), OpU16(0x8001)),
            SB("u32 0xDEADBEEF", OpU32(0xDEADBEEF)),
            SB("u32 0 and 4294967295 after a bool", OpBool(true), OpU32(0), OpU32(4294967295)),
            SB("i32 -1, 2147483647, -2147483648", OpI32(-1), OpI32(int.MaxValue), OpI32(int.MinValue)),
            SB("i32 -123456 after 5 bits", OpBits(21, 5), OpI32(-123456)),
            SB("float 1.5, -2.25, 0, -0", OpFloat(1.5f), OpFloat(-2.25f), OpFloat(0f), OpFloat(-0f)),
            SB("float after 1 bit: 3.4028235e38 and 1e-45 (smallest subnormal)", OpBool(true), OpFloat(float.MaxValue), OpFloat(float.Epsilon)),
            SB("quantized float 16 bits and 12 bits", OpQ(1.5f, -256, 256, 16), OpQ(-7.25f, -32, 32, 12)),
            SB("quantized float clamps: below min, above max", OpQ(-1000, -256, 256, 16), OpQ(1000, -256, 256, 16)),
            SB("quantized float in 1 and 32 bits", OpQ(0.5f, 0, 1, 1), OpQ(0.5f, 0, 1, 32)),
            SB("angle 90 in 9 bits, 270 in 16 bits", OpAngle(90, 9), OpAngle(270, 16)),
            SB("angle -90 and 720.5 in 12 bits", OpAngle(-90, 12), OpAngle(720.5f, 12)),
            SB("quaternion identity (29 bits)", OpQuat(0, 0, 0, 1)),
            SB("quaternion 0.5 0.5 0.5 0.5 in 10 bits, after a bool", OpBool(true), OpQuat(0.5f, 0.5f, 0.5f, 0.5f, 10)),
            SB("mixed: bool, 3 bits, byte, u16, quantized, angle, bool (a typical state)",
                OpBool(true), OpBits(5, 3), OpByte(200), OpU16(513), OpQ(10, -256, 256, 16), OpAngle(45, 9), OpBool(false)),
            SB("32-bit writes at bit offset 3", OpBits(3, 3), OpBits(0xFFFFFFFF, 32), OpBits(0x12345678, 32)),
            SB("WriteBits masks the value to its width (0x1FF in 4 bits)", OpBits(0x1FF, 4), OpBits(0xFFFF, 1)),
            SB("a 255-byte state: 63 x 32 bits + 24 bits (the limit)", Rep(OpU32(0xA5A5A5A5), 63), OpBits(0xABCDEF, 24)),
            ReadOnly("reading past the end returns zero bits and flags an overrun", "ab", OpBits(0xAB, 8), OpBits(0, 8), OpBool(false)),
            ReadOnly("a read that straddles the end: the missing bits are zero", "ff", OpBits(1, 4), OpBits(0xF, 8)),
            ReadOnly("an empty state reads zeros", "", OpByte(0), OpFloat(0f)),
            ReadOnly("32-bit read of 3 bytes", "010203", OpU32(0x00030201)),
        };

        // ---- quantize -----------------------------------------------------------------------------------------------

        private static JsonNode Num(float v) =>
            float.IsNaN(v) ? "NaN" : float.IsPositiveInfinity(v) ? "Infinity" : float.IsNegativeInfinity(v) ? "-Infinity" : JsonValue.Create(v);

        private static JsonObject QF(string name, float v, float min, float max, int bits)
        {
            var q = Quantize.Float(v, min, max, bits);
            return new JsonObject { ["name"] = name, ["fn"] = "float", ["value"] = Num(v), ["min"] = min, ["max"] = max, ["bits"] = bits, ["q"] = q, ["back"] = Quantize.Dequantize(q, min, max, bits) };
        }

        private static JsonObject QA(string name, float v, int bits)
        {
            var q = Quantize.Angle(v, bits);
            return new JsonObject { ["name"] = name, ["fn"] = "angle", ["value"] = Num(v), ["bits"] = bits, ["q"] = q, ["back"] = Quantize.AngleFrom(q, bits) };
        }

        private static JsonObject QQ(string name, float x, float y, float z, float w, int bits)
        {
            var q = Quantize.SmallestThree(x, y, z, w, bits);
            var back = Quantize.FromSmallestThree(q.Largest, q.A, q.B, q.C, bits);
            return new JsonObject
            {
                ["name"] = name, ["fn"] = "quat", ["value"] = new JsonArray(x, y, z, w), ["bits"] = bits, ["largest"] = q.Largest,
                ["q"] = new JsonArray(q.A, q.B, q.C), ["back"] = new JsonArray(back.X, back.Y, back.Z, back.W),
            };
        }

        private static JsonArray QuantizeCases() => new()
        {
            QF("float 1.5 in [-256, 256], 16 bits", 1.5f, -256, 256, 16),
            QF("float below min clamps to 0", -300, -256, 256, 16),
            QF("float at max", 256, -256, 256, 16),
            QF("float at min", -256, -256, 256, 16),
            QF("float above max clamps", 1e9f, -256, 256, 16),
            QF("float NaN becomes min", float.NaN, -256, 256, 16),
            QF("float +Infinity clamps to max", float.PositiveInfinity, -256, 256, 16),
            QF("float -Infinity clamps to min", float.NegativeInfinity, -256, 256, 16),
            QF("float exact half step rounds away from zero (0.5 in [0,1], 1 bit)", 0.5f, 0, 1, 1),
            QF("float exact half step (1.5 in [0,3], 1 bit)", 1.5f, 0, 3, 1),
            QF("float exact half step (0.75 in [0,1], 2 bits)", 0.75f, 0, 1, 2),
            QF("float exact half step (0.5 in [0,1], 2 bits: 1.5 rounds to 2)", 0.5f, 0, 1, 2),
            QF("float quarter step (0.25 in [0,1], 1 bit)", 0.25f, 0, 1, 1),
            QF("float half step in [0,14], 3 bits (1 / 14 * 7)", 1f, 0, 14, 3),
            QF("float half step in [-1,1], 2 bits (v 0 gives 1.5)", 0f, -1, 1, 2),
            QF("float half step in [-1,1], 4 bits (v 0 gives 7.5)", 0f, -1, 1, 4),
            QF("float 32 bits: 0.5 in [0,1]", 0.5f, 0, 1, 32),
            QF("float 32 bits at max", 1f, 0, 1, 32),
            QF("float 24 bits in [-1000, 1000]", 123.456f, -1000, 1000, 24),
            QF("float 12 bits height in [-32, 32]", -7.25f, -32, 32, 12),
            QF("float -0 in [-1, 1], 8 bits", -0f, -1, 1, 8),
            QF("float with a non-symmetric range [10, 20], 10 bits", 14.7f, 10, 20, 10),
            QF("float 0.1 in [0, 1], 8 bits", 0.1f, 0, 1, 8),
            QF("float 1 bit, value above half", 0.6f, 0, 1, 1),
            QA("angle 90 in 9 bits", 90, 9),
            QA("angle -90 in 9 bits", -90, 9),
            QA("angle 360 wraps to 0", 360, 9),
            QA("angle 0", 0, 9),
            QA("angle -0", -0f, 8),
            QA("angle negative -1 in 8 bits", -1, 8),
            QA("angle -360 in 8 bits", -360, 8),
            QA("angle -450 in 8 bits", -450, 8),
            QA("angle 450 in 8 bits", 450, 8),
            QA("angle 720.5 in 12 bits", 720.5f, 12),
            QA("angle 1e10 in 16 bits", 1e10f, 16),
            QA("angle 359.999 rounds up to the full circle and wraps to 0 in 8 bits", 359.999f, 8),
            QA("angle half step: 0.703125 in 8 bits (0.5 steps rounds up)", 0.703125f, 8),
            QA("angle half step: 0.0439453125 in 12 bits", 0.0439453125f, 12),
            QA("angle 180 in 8 bits", 180, 8),
            QA("angle 179.9 in 12 bits", 179.9f, 12),
            QA("angle -179.9 in 12 bits", -179.9f, 12),
            QA("angle 45 in 16 bits", 45, 16),
            QA("angle -45 in 16 bits", -45, 16),
            QA("angle -0.00001 in 16 bits (wraps up to 360, then to 0)", -0.00001f, 16),
            QA("angle 359.99 in 16 bits", 359.99f, 16),
            QA("angle 1 bit", 200, 1),
            QQ("quaternion identity", 0, 0, 0, 1, 9),
            QQ("quaternion negative identity (largest negative, all negated)", 0, 0, 0, -1, 9),
            QQ("quaternion tie: 0.5 0.5 0.5 0.5 (first on ties)", 0.5f, 0.5f, 0.5f, 0.5f, 9),
            QQ("quaternion tie with a negative first: -0.5 0.5 0.5 0.5", -0.5f, 0.5f, 0.5f, 0.5f, 9),
            QQ("quaternion largest is x and negative", -0.8f, 0.1f, 0.2f, 0.3f, 9),
            QQ("quaternion largest is y", 0.1f, 0.9f, -0.2f, 0.3f, 9),
            QQ("quaternion largest is z and negative", 0.1f, 0.2f, -0.9f, 0.3f, 10),
            QQ("quaternion not normalized (0 0 0 2)", 0, 0, 0, 2, 9),
            QQ("quaternion near zero length becomes identity", 0, 0, 0, 0, 9),
            QQ("quaternion 90 degrees about y, 12 bits", 0f, 0.70710678f, 0f, 0.70710678f, 12),
            QQ("quaternion 16 bits per component", 0.1f, 0.2f, 0.3f, 0.9f, 16),
            QQ("quaternion 4 bits per component", 0.5f, -0.5f, 0.5f, 0.5f, 4),
        };

        // ---- invalid ------------------------------------------------------------------------------------------------

        private static JsonObject Bad(string name, string hex, string error, string kind = "snapshot", World? baseline = null)
        {
            var o = new JsonObject { ["name"] = name, ["kind"] = kind };
            o["baseline"] = BaselineJson(baseline);
            o["hex"] = hex;
            o["error"] = error;
            return o;
        }

        private static JsonArray Invalid()
        {
            var b5 = W(5, (1, 7, 0, "0102"));
            return new JsonArray
            {
                Bad("truncated record", "520101050000010507000201", "too_short"),
                Bad("delta for an id not in the baseline", "52010107020001080100", "delta", baseline: b5),
                Bad("trailing bytes", "52010105000000ff", "trailing"),
                Bad("despawn of an unknown id", "520101060100010a", "despawn", baseline: b5),
                Bad("header cut after the tick", "52010105", "too_short"),
                Bad("a snapshot with only the prefix", "520101", "too_short"),
                Bad("tick above 2^32 - 1", "5201018080808010000000", "range"),
                Bad("lastInput above 2^32 - 1", "520101050080808080100000", "range"),
                Bad("a varint longer than 64 bits (10th byte above 1)", "5201010500ffffffffffffffffff7f", "varint"),
                Bad("a varint that never ends", "5201018080808080808080808080", "varint"),
                Bad("idDelta 0 (the first record, id 0)", "5201010500000101000000", "id"),
                Bad("idDelta 0 (the second record repeats an id)", "52010105000002" + "05000000" + "01000000", "id"),
                Bad("record ids past 2^32 - 1", "52010105000002" + "05000000" + "fdffffff3f" + "000000", "id"),
                Bad("op 3 is reserved", "5201010500000107", "op"),
                Bad("tick 0", "52010100000000", "tick"),
                Bad("baseline tick after the snapshot tick (back > tick)", "520101050600" + "00", "tick"),
                Bad("back 1 but the client gives no baseline", "52010105010000", "baseline"),
                Bad("back 0 (full snapshot) but a baseline is given", "52010105000000", "baseline", baseline: b5),
                Bad("full record with a state length of 256", "520101050000010500008002", "full"),
                Bad("full record with a type above 65535", "52010105000001" + "05" + "808004" + "0000", "full"),
                Bad("full record with an owner above 2^31 - 1", "52010105000001" + "05" + "00" + "8080808008" + "00", "full"),
                Bad("input cut inside an entry", "520102070c0280", "too_short", "input"),
                Bad("input with trailing bytes", "520102070c00ff", "trailing", "input"),
                Bad("input: n larger than newest", "520102000102" + "00000000", "seq", "input"),
                Bad("input: n 1 with newest 0", "52010200000100" + "00", "seq", "input"),
                Bad("input: ack above 2^32 - 1", "52010280808080100000", "range", "input"),
                Bad("input: entry longer than the rest", "520102000101" + "00" + "05" + "aa", "too_short", "input"),
                Bad("event without a tick", "520103", "too_short", "event"),
                Bad("event with a tick above 2^32 - 1", "52010380808080" + "10", "range", "event"),
                Bad("stream event with stream 0", "520104" + "01" + "00" + "01", "stream_0", "streamEvent"),
                Bad("stream event with seq 0", "520104" + "01" + "01" + "00", "seq_0", "streamEvent"),
                Bad("stream event cut after the stream byte", "520104" + "01" + "01", "too_short", "streamEvent"),
                Bad("stream event with a seq above 2^32 - 1", "520104" + "01" + "01" + "8080808010", "range", "streamEvent"),
            };
        }

        // ---- describe -----------------------------------------------------------------------------------------------

        private static JsonObject D(string name, string hex, World? baseline = null)
        {
            var o = new JsonObject { ["name"] = name, ["hex"] = hex };
            o["baseline"] = BaselineJson(baseline);
            o["json"] = JsonNode.Parse(Describe.Json(Unhex(hex), baseline));
            return o;
        }

        private static JsonArray DescribeCases()
        {
            var b5 = W(5, (1, 7, 0, "0102"), (3, 1, 2, "aa"));
            var b7 = W(7, (1, 7, 0, "0109"), (4, 7, 0, "ff"));
            string SnapHex(World c, World? b, uint last) => Hex(Proto.EncodeSnapshot(c, b, last, new ByteWriter(), new ByteWriter()));
            var base39 = W(39, (2, 3, 1, Pattern(20)));
            var base69936 = W(69936, (1, 1, 1, "0a0c"));
            return new JsonArray
            {
                D("full snapshot", SnapHex(b5, null, 0)),
                D("delta snapshot with its baseline: changed bytes, a despawn and a spawn", SnapHex(b7, b5, 4), b5),
                D("delta snapshot without a baseline: records stop at the first delta", SnapHex(b7, b5, 4)),
                D("delta record with a 20-byte state, three mask bytes", SnapHex(W(40, (2, 3, 1, "ff" + Pattern(19, 2))), base39, 9), base39),
                D("a delta snapshot with a large tick and lastInput", SnapHex(W(70000, (1, 1, 1, "0a0b")), base69936, 300000), base69936),
                D("input with two entries", "520102070c02800b0101800a0102"),
                D("input heartbeat (n = 0)", "520102ac020000"),
                D("event", "520103ac026869"),
                D("stream event", "520104ac02" + "03" + "05" + "6869"),
                D("not replication (first byte is not 0x52)", "010203"),
                D("another version is ignored", "52020105"),
                D("an unknown kind", "5201090102"),
                D("malformed: truncated snapshot", "520101050000010507000201"),
                D("malformed: reserved op", "5201010500000107"),
                D("malformed: stream event with stream 0", "520104" + "01" + "00" + "01"),
            };
        }

        // ---- streamReceive: the receive side of numbered stream events ---------------------------------------------
        // One receiver (the host), one sender (a joiner that forges kind 4 frames on the reliable channel), a millisecond
        // clock. An arrival at T is delivered to the host's session while its lobby clock reads T; the session pumps every
        // millisecond, so a hole that opens at S is reported at S + 1000. The expectation is what the C# session did.

        private static JsonObject Arr(int at, int stream, uint seq, int bytes = 4) =>
            new() { ["at"] = at, ["stream"] = stream, ["seq"] = seq, ["bytes"] = bytes };

        private static JsonObject StreamCase(string name, int endAt, params JsonObject[] arrivals)
        {
            var c = new JsonObject { ["name"] = name, ["arrivals"] = new JsonArray(arrivals.Select(a => (JsonNode)a.DeepClone()).ToArray()), ["endAt"] = endAt };
            c["expect"] = ReplayStreamReceive(c);
            return c;
        }

        /// <summary>Plays one streamReceive case through a real session and returns what happened ("expect" of the case).</summary>
        internal static JsonObject ReplayStreamReceive(JsonNode c)
        {
            var rig = new Rig(latencyMs: 0);
            var host = rig.StartHost();
            var a = rig.Join("a");
            rig.Run(0.5);
            rig.FrameMs = 1;
            var start = host.Lobby.NowMs + 1;                            // the first step below reads 0
            var events = new JsonArray();
            host.Session.EventDelivered += e => events.Add(new JsonObject { ["type"] = "deliver", ["at"] = host.Lobby.NowMs - start, ["stream"] = (int)e.Stream, ["seq"] = e.Seq });
            host.Session.EventGap += g => events.Add(new JsonObject
            {
                ["type"] = "gap", ["at"] = host.Lobby.NowMs - start, ["stream"] = (int)g.Stream, ["firstMissing"] = g.FirstMissing, ["nextDelivered"] = g.NextDelivered,
            });
            var s0 = host.Session.Stats;
            long dup0 = s0.EventsDuplicate, ooo0 = s0.EventsOutOfOrder, gap0 = s0.EventsGap, bad0 = s0.Malformed;
            var arrivals = c["arrivals"]!.AsArray();
            var next = 0;
            for (var t = 0; t <= c["endAt"]!.GetValue<int>(); t++)
            {
                while (next < arrivals.Count && arrivals[next]!["at"]!.GetValue<int>() == t)
                {
                    var x = arrivals[next++]!;
                    var frame = Proto.EncodeStreamEvent(1, (byte)x["stream"]!.GetValue<int>(), x["seq"]!.GetValue<uint>(), new byte[x["bytes"]!.GetValue<int>()], new ByteWriter());
                    a.Lobby.Send(host.Lobby.LocalPeerId, frame, Channel.Reliable);
                }
                rig.Step();
            }
            return new JsonObject
            {
                ["events"] = events, ["duplicates"] = s0.EventsDuplicate - dup0, ["outOfOrder"] = s0.EventsOutOfOrder - ooo0,
                ["gaps"] = s0.EventsGap - gap0, ["malformed"] = s0.Malformed - bad0, ["buffered"] = host.Session.BufferedStreamEvents,
            };
        }

        private static JsonArray StreamReceive()
        {
            var a = new JsonArray();
            a.Add(StreamCase("in order", 100, Arr(0, 1, 1), Arr(10, 1, 2), Arr(20, 1, 3), Arr(30, 1, 4), Arr(40, 1, 5)));
            a.Add(StreamCase("a seq already delivered is a duplicate and is dropped", 100, Arr(0, 1, 1), Arr(10, 1, 2), Arr(20, 1, 2), Arr(30, 1, 3), Arr(40, 1, 1)));
            a.Add(StreamCase("one hole, filled later: the waiting events follow it at once", 600, Arr(0, 1, 1), Arr(10, 1, 3), Arr(20, 1, 4), Arr(300, 1, 2)));
            a.Add(StreamCase("a seq already waiting is a duplicate", 100, Arr(0, 1, 1), Arr(10, 1, 3), Arr(20, 1, 3), Arr(30, 1, 2)));
            a.Add(StreamCase("a hole that stays open 1000 ms is reported as a gap and skipped", 1500, Arr(0, 1, 1), Arr(100, 1, 3), Arr(200, 1, 4)));
            a.Add(StreamCase("the first event of a stream is 3: numbers 1 and 2 are a gap", 1500, Arr(50, 1, 3), Arr(60, 1, 4)));
            a.Add(StreamCase("the timer restarts when the hole moves", 2200, Arr(0, 1, 1), Arr(10, 1, 3), Arr(500, 1, 5), Arr(800, 1, 2)));
            a.Add(StreamCase("999 ms is not enough, 1000 ms is", 1200, Arr(0, 1, 2)));
            a.Add(StreamCase("a late arrival of a skipped number is a duplicate", 2000, Arr(0, 1, 1), Arr(10, 1, 3), Arr(1500, 1, 2)));
            a.Add(StreamCase("two holes in a row: two gaps, in order", 3000, Arr(0, 1, 1), Arr(10, 1, 3), Arr(20, 1, 6), Arr(30, 1, 7)));
            a.Add(StreamCase("streams are independent: a hole in stream 1 does not hold stream 2", 1500,
                Arr(0, 1, 1), Arr(10, 1, 3), Arr(20, 2, 1), Arr(30, 2, 2), Arr(40, 2, 3)));
            a.Add(StreamCase("exactly 4096 past the last delivered is buffered", 1200, Arr(0, 1, 1), Arr(10, 1, 4097)));
            a.Add(StreamCase("4097 past the last delivered is malformed and dropped", 1200, Arr(0, 1, 1), Arr(10, 1, 4098), Arr(20, 1, 2)));
            var burst = new List<JsonObject> { Arr(0, 1, 1) };
            for (uint i = 0; i < 65; i++) burst.Add(Arr(10 + (int)i, 1, 3 + 2 * i));
            a.Add(StreamCase("65 waiting events: past the count cap the hole is skipped at once", 200, burst.ToArray()));
            var cap = new List<JsonObject> { Arr(0, 1, 1) };
            for (uint i = 0; i < 5; i++) cap.Add(Arr(10 + (int)i, 1, 3 + 2 * i, 64 * 1024));
            a.Add(StreamCase("more than 256 KiB waiting: past the byte cap the hole is skipped at once", 200, cap.ToArray()));
            var exactly = new List<JsonObject> { Arr(0, 1, 1) };
            for (uint i = 0; i < 64; i++) exactly.Add(Arr(10 + (int)i, 1, 3 + 2 * i));
            a.Add(StreamCase("64 waiting events are still within the cap", 200, exactly.ToArray()));
            return a;
        }

        // ---- the file -----------------------------------------------------------------------------------------------

        public static string Build()
        {
            var groups = new (string Name, JsonArray Cases)[]
            {
                ("snapshots", Snapshots()), ("inputs", Inputs()), ("events", Events()), ("streamEvents", StreamEvents()),
                ("stateBits", StateBits()), ("quantize", QuantizeCases()), ("invalid", Invalid()), ("describe", DescribeCases()), ("streamReceive", StreamReceive()),
            };
            var sb = new StringBuilder();
            sb.Append("{\n  \"description\": ").Append(JsonSerializer.Serialize(
                "Replication payloads (spec/replication.md), version 1. Generated from the C# reference by clients/dotnet/OneLobby.Replication.Tests/VectorGenerator.cs: do not edit by hand, see the header of that file to regenerate. Hex is the raw-mode payload, i.e. after the 3-byte lobby header. World entries: [id, type, owner, stateHex]. Float values may be the strings NaN, Infinity or -Infinity.", Opts));
            foreach (var (name, cases) in groups)
            {
                sb.Append(",\n  \"").Append(name).Append("\": [\n");
                for (var i = 0; i < cases.Count; i++)
                    sb.Append("    ").Append(cases[i]!.ToJsonString(Opts)).Append(i + 1 < cases.Count ? ",\n" : "\n");
                sb.Append("  ]");
            }
            return sb.Append("\n}\n").ToString();
        }
    }

    public class VectorFileTests
    {
        [Fact]
        public void CommittedVectorsMatchTheReference()
        {
            var dir = AppContext.BaseDirectory;
            while (dir != null && !File.Exists(Path.Combine(dir, "spec", "vectors", "replication.json"))) dir = Path.GetDirectoryName(dir);
            Assert.NotNull(dir);
            var path = Path.Combine(dir!, "spec", "vectors", "replication.json");
            var built = VectorBuilder.Build();
            if (Environment.GetEnvironmentVariable("ONELOBBY_WRITE_VECTORS") == "1") File.WriteAllText(path, built, new UTF8Encoding(false));
            Assert.Equal(built.Replace("\r\n", "\n"), File.ReadAllText(path).Replace("\r\n", "\n"));
        }
    }

    public class StreamReceiveVectorTests
    {
        /// <summary>Every committed streamReceive case, replayed through a real session, must give the committed expectation.</summary>
        [Fact]
        public void CommittedStreamReceiveCasesReplayThroughTheSession()
        {
            var dir = AppContext.BaseDirectory;
            while (dir != null && !File.Exists(Path.Combine(dir, "spec", "vectors", "replication.json"))) dir = Path.GetDirectoryName(dir);
            Assert.NotNull(dir);
            var doc = JsonNode.Parse(File.ReadAllText(Path.Combine(dir!, "spec", "vectors", "replication.json")))!;
            var cases = doc["streamReceive"]!.AsArray();
            Assert.True(cases.Count >= 10);
            foreach (var c in cases)
            {
                var got = VectorBuilder.ReplayStreamReceive(c!);
                Assert.Equal(c!["expect"]!.ToJsonString(), got.ToJsonString());
            }
        }
    }
}
