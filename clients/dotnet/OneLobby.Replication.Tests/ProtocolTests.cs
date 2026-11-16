using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using OneLobby.Replication;
using Xunit;

namespace OneLobby.Replication.Tests
{
    /// <summary>Byte-exact checks against spec/vectors/replication.json, so a JS port can test against the same file.</summary>
    public class ProtocolTests
    {
        private static JsonElement Vectors()
        {
            var dir = AppContext.BaseDirectory;
            while (dir != null && !File.Exists(Path.Combine(dir, "spec", "vectors", "replication.json"))) dir = Path.GetDirectoryName(dir);
            Assert.NotNull(dir);
            return JsonDocument.Parse(File.ReadAllText(Path.Combine(dir!, "spec", "vectors", "replication.json"))).RootElement;
        }

        private static byte[] Hex(string h) => Convert.FromHexString(h);
        private static string Hex(byte[] b) => Convert.ToHexString(b).ToLowerInvariant();

        private static World WorldOf(uint tick, JsonElement arr) => new(tick, arr.EnumerateArray().Select(e =>
            new Ent(e[0].GetUInt32(), (ushort)e[1].GetUInt32(), e[2].GetInt32(), Hex(e[3].GetString()!))).ToList());

        private static void SameWorld(World a, World b)
        {
            Assert.Equal(a.Tick, b.Tick);
            Assert.Equal(a.Ents.Count, b.Ents.Count);
            for (var i = 0; i < a.Ents.Count; i++)
            {
                Assert.Equal(a.Ents[i].Id, b.Ents[i].Id);
                Assert.Equal(a.Ents[i].Type, b.Ents[i].Type);
                Assert.Equal(a.Ents[i].Owner, b.Ents[i].Owner);
                Assert.Equal(a.Ents[i].State, b.Ents[i].State);
            }
        }

        private static float F(JsonElement e) => e.ValueKind == JsonValueKind.String
            ? e.GetString() switch { "NaN" => float.NaN, "Infinity" => float.PositiveInfinity, _ => float.NegativeInfinity }
            : e.GetSingle();

        private static World? BaselineOf(JsonElement b) =>
            b.ValueKind == JsonValueKind.Null ? null : WorldOf(b.GetProperty("tick").GetUInt32(), b.GetProperty("world"));

        [Fact]
        public void SnapshotVectorsEncodeAndDecodeByteExact()
        {
            var n = 0;
            foreach (var v in Vectors().GetProperty("snapshots").EnumerateArray())
            {
                n++;
                var tick = v.GetProperty("tick").GetUInt32();
                var cur = WorldOf(tick, v.GetProperty("world"));
                var baseline = BaselineOf(v.GetProperty("baseline"));
                var bytes = Proto.EncodeSnapshot(cur, baseline, v.GetProperty("lastInputSeq").GetUInt32(), new ByteWriter(), new ByteWriter());
                Assert.Equal(v.GetProperty("hex").GetString(), Hex(bytes));
                var h = Proto.PeekSnapshot(bytes);
                Assert.Equal(tick, h.Tick);
                Assert.Equal(baseline?.Tick ?? 0, h.BaselineTick);
                Assert.Equal(v.GetProperty("lastInputSeq").GetUInt32(), h.LastInputSeq);
                SameWorld(cur, Proto.DecodeSnapshot(bytes, baseline));
            }
            Assert.True(n >= 15);
        }

        [Fact]
        public void InputEventAndStreamEventVectors()
        {
            var root = Vectors();
            foreach (var v in root.GetProperty("inputs").EnumerateArray())
            {
                var list = v.GetProperty("inputs").EnumerateArray().Select(e => (e[0].GetUInt64(), Hex(e[1].GetString()!))).ToList();
                var bytes = Proto.EncodeInput(v.GetProperty("ack").GetUInt32(), v.GetProperty("newestSeq").GetUInt32(), list, list.Count, new ByteWriter());
                Assert.Equal(v.GetProperty("hex").GetString(), Hex(bytes));
                var (ack, newest, inputs) = Proto.DecodeInput(bytes);
                Assert.Equal(v.GetProperty("ack").GetUInt32(), ack);
                Assert.Equal(v.GetProperty("newestSeq").GetUInt32(), newest);
                Assert.Equal(list.Select(x => x.Item1), inputs.Select(x => x.View256));
                Assert.Equal(list.Select(x => Hex(x.Item2)), inputs.Select(x => Hex(x.Bytes)));
                Assert.Equal(Enumerable.Range(0, list.Count).Select(i => newest - (uint)i), inputs.Select(x => x.Seq));
            }
            foreach (var v in root.GetProperty("events").EnumerateArray())
            {
                var bytes = Proto.EncodeEvent(v.GetProperty("tick").GetUInt32(), Hex(v.GetProperty("payloadHex").GetString()!), new ByteWriter());
                Assert.Equal(v.GetProperty("hex").GetString(), Hex(bytes));
                var (tick, payload) = Proto.DecodeEvent(bytes);
                Assert.Equal(v.GetProperty("tick").GetUInt32(), tick);
                Assert.Equal(v.GetProperty("payloadHex").GetString(), Hex(payload));
            }
            foreach (var v in root.GetProperty("streamEvents").EnumerateArray())
            {
                var stream = (byte)v.GetProperty("stream").GetUInt32();
                var bytes = Proto.EncodeStreamEvent(v.GetProperty("tick").GetUInt32(), stream, v.GetProperty("seq").GetUInt32(), Hex(v.GetProperty("payloadHex").GetString()!), new ByteWriter());
                Assert.Equal(v.GetProperty("hex").GetString(), Hex(bytes));
                var (tick, st, seq, payload) = Proto.DecodeStreamEvent(bytes);
                Assert.Equal(v.GetProperty("tick").GetUInt32(), tick);
                Assert.Equal(stream, st);
                Assert.Equal(v.GetProperty("seq").GetUInt32(), seq);
                Assert.Equal(v.GetProperty("payloadHex").GetString(), Hex(payload));
            }
        }

        [Fact]
        public void InvalidMessagesAreRejectedWithTheNamedError()
        {
            var seen = new HashSet<string>();
            foreach (var v in Vectors().GetProperty("invalid").EnumerateArray())
            {
                var bytes = Hex(v.GetProperty("hex").GetString()!);
                var baseline = BaselineOf(v.GetProperty("baseline"));
                var kind = v.TryGetProperty("kind", out var k) ? k.GetString() : "snapshot";
                Action act = kind switch
                {
                    "input" => () => Proto.DecodeInput(bytes),
                    "event" => () => Proto.DecodeEvent(bytes),
                    "streamEvent" => () => Proto.DecodeStreamEvent(bytes),
                    _ => () => Proto.DecodeSnapshot(bytes, baseline),
                };
                var ex = Assert.Throws<MalformedException>(act);
                Assert.Equal(v.GetProperty("error").GetString(), ex.Message);
                seen.Add(ex.Message);
            }
            foreach (var name in new[] { "too_short", "trailing", "range", "varint", "id", "delta", "despawn", "op", "tick", "baseline", "full", "seq", "stream_0", "seq_0" })
                Assert.Contains(name, seen);
        }

        [Fact]
        public void StateBitsVectors()
        {
            foreach (var v in Vectors().GetProperty("stateBits").EnumerateArray())
            {
                var name = v.GetProperty("name").GetString()!;
                if (v.TryGetProperty("ops", out var ops))
                {
                    var w = new NetWriter();
                    foreach (var o in ops.EnumerateArray()) for (var i = 0; i < (o.TryGetProperty("repeat", out var rp) ? rp.GetInt32() : 1); i++) Write(w, o);
                    Assert.Equal(v.GetProperty("hex").GetString(), Hex(w.ToArray()));
                    Assert.Equal(v.GetProperty("bits").GetInt32(), w.BitCount);
                }
                var r = new NetReader(Hex(v.GetProperty("hex").GetString()!));
                foreach (var o in v.GetProperty("reads").EnumerateArray())
                    for (var i = 0; i < (o.TryGetProperty("repeat", out var rp) ? rp.GetInt32() : 1); i++) CheckRead(r, o, name);
                Assert.Equal(v.GetProperty("overrun").GetBoolean(), r.Overrun);
            }
        }

        private static void Write(NetWriter w, JsonElement o)
        {
            var v = o.GetProperty("v");
            switch (o.GetProperty("op").GetString())
            {
                case "bits": w.WriteBits(v.GetUInt32(), o.GetProperty("n").GetInt32()); break;
                case "bool": w.WriteBool(v.GetBoolean()); break;
                case "byte": w.WriteByte((byte)v.GetUInt32()); break;
                case "u16": w.WriteUInt16((ushort)v.GetUInt32()); break;
                case "u32": w.WriteUInt32(v.GetUInt32()); break;
                case "i32": w.WriteInt32(v.GetInt32()); break;
                case "float": w.WriteFloat(v.GetSingle()); break;
                case "q": w.WriteQuantized(v.GetSingle(), o.GetProperty("min").GetSingle(), o.GetProperty("max").GetSingle(), o.GetProperty("bits").GetInt32()); break;
                case "angle": w.WriteAngle(v.GetSingle(), o.GetProperty("bits").GetInt32()); break;
                case "quat": w.WriteQuaternion(v[0].GetSingle(), v[1].GetSingle(), v[2].GetSingle(), v[3].GetSingle(), o.GetProperty("bits").GetInt32()); break;
                default: throw new InvalidOperationException("op");
            }
        }

        private static void CheckRead(NetReader r, JsonElement o, string name)
        {
            var want = o.GetProperty("read");
            switch (o.GetProperty("op").GetString())
            {
                case "bits": Assert.Equal(want.GetUInt32(), r.ReadBits(o.GetProperty("n").GetInt32())); break;
                case "bool": Assert.Equal(want.GetBoolean(), r.ReadBool()); break;
                case "byte": Assert.Equal(want.GetUInt32(), (uint)r.ReadByte()); break;
                case "u16": Assert.Equal(want.GetUInt32(), (uint)r.ReadUInt16()); break;
                case "u32": Assert.Equal(want.GetUInt32(), r.ReadUInt32()); break;
                case "i32": Assert.Equal(want.GetInt32(), r.ReadInt32()); break;
                case "float": Assert.Equal(want.GetSingle(), r.ReadFloat()); break;
                case "q": Assert.Equal(want.GetSingle(), r.ReadQuantized(o.GetProperty("min").GetSingle(), o.GetProperty("max").GetSingle(), o.GetProperty("bits").GetInt32())); break;
                case "angle": Assert.Equal(want.GetSingle(), r.ReadAngle(o.GetProperty("bits").GetInt32())); break;
                case "quat":
                {
                    var q = r.ReadQuaternion(o.GetProperty("bits").GetInt32());
                    Assert.Equal(new[] { want[0].GetSingle(), want[1].GetSingle(), want[2].GetSingle(), want[3].GetSingle() }, new[] { q.X, q.Y, q.Z, q.W });
                    break;
                }
                default: throw new InvalidOperationException("op " + name);
            }
        }

        [Fact]
        public void QuantizeVectors()
        {
            var n = 0;
            foreach (var v in Vectors().GetProperty("quantize").EnumerateArray())
            {
                n++;
                var bits = v.GetProperty("bits").GetInt32();
                switch (v.GetProperty("fn").GetString())
                {
                    case "angle":
                    {
                        var q = Quantize.Angle(F(v.GetProperty("value")), bits);
                        Assert.Equal(v.GetProperty("q").GetUInt32(), q);
                        Assert.Equal(v.GetProperty("back").GetSingle(), Quantize.AngleFrom(q, bits));
                        break;
                    }
                    case "float":
                    {
                        float min = v.GetProperty("min").GetSingle(), max = v.GetProperty("max").GetSingle();
                        var q = Quantize.Float(F(v.GetProperty("value")), min, max, bits);
                        Assert.Equal(v.GetProperty("q").GetUInt32(), q);
                        Assert.Equal(v.GetProperty("back").GetSingle(), Quantize.Dequantize(q, min, max, bits));
                        break;
                    }
                    default:
                    {
                        var x = v.GetProperty("value");
                        var q = Quantize.SmallestThree(x[0].GetSingle(), x[1].GetSingle(), x[2].GetSingle(), x[3].GetSingle(), bits);
                        Assert.Equal(v.GetProperty("largest").GetUInt32(), q.Largest);
                        var qs = v.GetProperty("q");
                        Assert.Equal(new[] { qs[0].GetUInt32(), qs[1].GetUInt32(), qs[2].GetUInt32() }, new[] { q.A, q.B, q.C });
                        var b = Quantize.FromSmallestThree(q.Largest, q.A, q.B, q.C, bits);
                        var bk = v.GetProperty("back");
                        Assert.Equal(new[] { bk[0].GetSingle(), bk[1].GetSingle(), bk[2].GetSingle(), bk[3].GetSingle() }, new[] { b.X, b.Y, b.Z, b.W });
                        break;
                    }
                }
            }
            Assert.True(n >= 50);
        }

        [Fact]
        public void DescribeVectors()
        {
            foreach (var v in Vectors().GetProperty("describe").EnumerateArray())
            {
                var json = Describe.Json(Hex(v.GetProperty("hex").GetString()!), BaselineOf(v.GetProperty("baseline")));
                Assert.True(System.Text.Json.Nodes.JsonNode.DeepEquals(System.Text.Json.Nodes.JsonNode.Parse(json), System.Text.Json.Nodes.JsonNode.Parse(v.GetProperty("json").GetRawText())), v.GetProperty("name").GetString() + ": " + json);
            }
        }

        [Fact]
        public void AClientWithoutTheBaselineDropsTheSnapshotQuietly()
        {
            var v = Vectors().GetProperty("snapshots").EnumerateArray().Single(e => e.TryGetProperty("clientHoldsBaseline", out _));
            var rig = new Rig();
            var host = rig.StartHost();
            rig.Run(1);                  // the host is past tick 5 when the client joins, so the client never holds it
            var a = rig.Join("a");
            rig.Run(0.2);
            var before = a.Session.Stats.SnapshotsDropped;
            host.Lobby.Send(a.Lobby.LocalPeerId, Hex(v.GetProperty("hex").GetString()!), Channel.Fast);
            rig.Run(0.2);
            Assert.Equal(before + 1, a.Session.Stats.SnapshotsDropped);
            Assert.Equal(0, a.Session.Stats.Malformed);
        }

        [Fact]
        public void QuantizeRoundTripsWithinHalfAStep()
        {
            var rng = new Random(5);
            for (var i = 0; i < 1000; i++)
            {
                var v = (float)(rng.NextDouble() * 512 - 256);
                var back = Quantize.Dequantize(Quantize.Float(v, -256, 256, 16), -256, 256, 16);
                Assert.InRange(Math.Abs(back - v), 0, 512.0 / 65535 / 2 + 1e-4);
                var a = (float)(rng.NextDouble() * 720 - 360);
                var ab = Quantize.AngleFrom(Quantize.Angle(a, 10), 10);
                var d = Math.Abs(((ab - a) % 360 + 540) % 360 - 180);
                Assert.InRange(d, 0, 360.0 / 1024 / 2 + 1e-3);
            }
            Assert.Equal(17, Quantize.BitsFor(-256, 256, 0.005f));
            Assert.Equal(10, Quantize.BitsFor(0, 1023, 1));
        }

        [Fact]
        public void SmallestThreeQuaternionIsWithinGaffersPrecision()
        {
            var rng = new Random(9);
            for (var i = 0; i < 500; i++)
            {
                double x = rng.NextDouble() * 2 - 1, y = rng.NextDouble() * 2 - 1, z = rng.NextDouble() * 2 - 1, wv = rng.NextDouble() * 2 - 1;
                var len = Math.Sqrt(x * x + y * y + z * z + wv * wv);
                var q = ((float)(x / len), (float)(y / len), (float)(z / len), (float)(wv / len));
                var w = new NetWriter();
                w.WriteQuaternion(q.Item1, q.Item2, q.Item3, q.Item4);
                Assert.Equal(29, w.BitCount);
                var b = new NetReader(w.ToArray()).ReadQuaternion();
                var dot = Math.Abs(q.Item1 * b.X + q.Item2 * b.Y + q.Item3 * b.Z + q.Item4 * b.W);
                Assert.True(dot > 0.999, "dot " + dot); // same rotation up to sign, ~2.5 degrees worst case
            }
        }

        [Fact]
        public void DeltaRoundTripsRandomWorlds()
        {
            var rng = new Random(21);
            var w = new ByteWriter(); var recs = new ByteWriter();
            World? prev = null;
            uint nextId = 1;
            var live = new List<Ent>();
            for (uint tick = 1; tick < 300; tick++)
            {
                if (rng.Next(3) == 0) live.Add(new Ent(nextId++, (ushort)rng.Next(4), rng.Next(5), RandomBytes(rng)));
                if (live.Count > 0 && rng.Next(5) == 0) live.RemoveAt(rng.Next(live.Count));
                for (var i = 0; i < live.Count; i++)
                    if (rng.Next(2) == 0)
                    {
                        var s = (byte[])live[i].State.Clone();
                        if (rng.Next(10) == 0) s = RandomBytes(rng); else s[rng.Next(s.Length)] ^= (byte)(1 + rng.Next(255));
                        live[i] = new Ent(live[i].Id, rng.Next(20) == 0 ? (ushort)9 : live[i].Type, live[i].Owner, s);
                    }
                var cur = new World(tick, live.ToList());
                var bytes = Proto.EncodeSnapshot(cur, prev, tick, w, recs);
                SameWorld(cur, Proto.DecodeSnapshot(bytes, prev));
                prev = rng.Next(4) == 0 ? null : cur;
            }
        }

        private static byte[] RandomBytes(Random rng)
        {
            var b = new byte[1 + rng.Next(40)];
            rng.NextBytes(b);
            return b;
        }

        [Fact]
        public void HistoryRingInterpolatesAndForgets()
        {
            var h = new HistoryRing<float>(8, (a, b, t) => a + (b - a) * t);
            var id = new NetId(3);
            for (uint t = 1; t <= 20; t++) h.Record(t, id, t * 10);
            Assert.True(h.TrySample(id, 15.5, out var v)); Assert.Equal(155, v, 3);
            Assert.True(h.TrySample(id, 20, out v)); Assert.Equal(200, v, 3);
            Assert.False(h.TrySample(id, 5, out _)); // overwritten by the ring
            Assert.False(h.TrySample(id, 25, out _));
            h.Forget(id);
            Assert.False(h.TrySample(id, 15, out _));
        }

        [Fact]
        public void ClockRunsFixedStepsAndDropsALongStall()
        {
            long now = 0;
            var c = new NetworkClock(30, () => now);
            var ticks = 0;
            for (var f = 0; f < 60; f++) { now += 16; while (c.TryAdvance()) ticks++; }
            Assert.InRange(ticks, 29, 31); // ~1 s of 16 ms frames at 30 Hz
            now += 5000;
            var burst = 0;
            while (c.TryAdvance()) burst++;
            Assert.Equal(c.MaxCatchUp, burst);
        }
    }
}
