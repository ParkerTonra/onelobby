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

        [Fact]
        public void SnapshotVectorsEncodeAndDecodeByteExact()
        {
            foreach (var v in Vectors().GetProperty("snapshots").EnumerateArray())
            {
                var tick = v.GetProperty("tick").GetUInt32();
                var cur = WorldOf(tick, v.GetProperty("world"));
                var b = v.GetProperty("baseline");
                World? baseline = b.ValueKind == JsonValueKind.Null ? null : WorldOf(b.GetProperty("tick").GetUInt32(), b.GetProperty("world"));
                var bytes = Proto.EncodeSnapshot(cur, baseline, v.GetProperty("lastInputSeq").GetUInt32(), new ByteWriter(), new ByteWriter());
                Assert.Equal(v.GetProperty("hex").GetString(), Hex(bytes));
                var h = Proto.PeekSnapshot(bytes);
                Assert.Equal(tick, h.Tick);
                Assert.Equal(baseline?.Tick ?? 0, h.BaselineTick);
                SameWorld(cur, Proto.DecodeSnapshot(bytes, baseline));
            }
        }

        [Fact]
        public void InputAndEventVectors()
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
        }

        [Fact]
        public void InvalidSnapshotsAreRejectedWithTheNamedError()
        {
            foreach (var v in Vectors().GetProperty("invalid").EnumerateArray())
            {
                var b = v.GetProperty("baseline");
                World? baseline = b.ValueKind == JsonValueKind.Null ? null : WorldOf(b.GetProperty("tick").GetUInt32(), b.GetProperty("world"));
                var ex = Assert.Throws<MalformedException>(() => Proto.DecodeSnapshot(Hex(v.GetProperty("hex").GetString()!), baseline));
                Assert.Equal(v.GetProperty("error").GetString(), ex.Message);
            }
        }

        [Fact]
        public void StateBitsAndQuantizeVectors()
        {
            var root = Vectors();
            var w = new NetWriter();
            w.WriteBits(5, 3); w.WriteBits(1, 1); w.WriteBits(0xAB, 8);
            Assert.Equal(root.GetProperty("stateBits")[0].GetProperty("hex").GetString(), Hex(w.ToArray()));
            var r = new NetReader(w.ToArray());
            Assert.Equal(5u, r.ReadBits(3)); Assert.Equal(1u, r.ReadBits(1)); Assert.Equal(0xABu, r.ReadBits(8));
            Assert.False(r.Overrun);
            r.ReadBits(8);
            Assert.True(r.Overrun);
            foreach (var v in root.GetProperty("quantize").EnumerateArray())
            {
                var bits = v.GetProperty("bits").GetInt32();
                var value = v.GetProperty("value").GetSingle();
                var q = v.GetProperty("fn").GetString() == "angle"
                    ? Quantize.Angle(value, bits)
                    : Quantize.Float(value, v.GetProperty("min").GetSingle(), v.GetProperty("max").GetSingle(), bits);
                Assert.Equal(v.GetProperty("q").GetUInt32(), q);
            }
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
