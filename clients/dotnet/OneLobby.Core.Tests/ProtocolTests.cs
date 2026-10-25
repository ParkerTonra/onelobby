using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using OneLobby.Gridpaint;
using Xunit;

namespace OneLobby.Tests
{
    public class CrockfordTests
    {
        [Fact]
        public void SpecValidCodesNormalise()
        {
            using var doc = Spec.Load("codes.json");
            foreach (var v in doc.RootElement.GetProperty("valid").EnumerateArray())
                Assert.Equal(v.GetProperty("canonical").GetString(), Crockford.Normalize(v.GetProperty("input").GetString()));
        }

        [Fact]
        public void SpecInvalidCodesAreRejected()
        {
            using var doc = Spec.Load("codes.json");
            foreach (var v in doc.RootElement.GetProperty("invalid").EnumerateArray())
                Assert.Null(Crockford.Normalize(v.GetProperty("input").GetString()));
        }

        [Fact]
        public void FormatAndValueRoundTrip()
        {
            Assert.Equal("7HQ 4K2", Crockford.Format("7hq4k2"));
            Assert.Equal("7HQ4K2", Crockford.FromValue(Crockford.ToValue("7HQ4K2")));
            Assert.Equal(0u, Crockford.ToValue("oOo0O0"));
        }
    }

    public class WireVectorTests
    {
        [Fact]
        public void EveryFrameVectorEncodesToTheSpecBytesAndValidates()
        {
            using var doc = Spec.Load("vectors/frames.json");
            var n = 0;
            foreach (var v in doc.RootElement.GetProperty("vectors").EnumerateArray())
            {
                var name = v.GetProperty("name").GetString();
                var hex = v.GetProperty("hex").GetString()!;
                var msg = v.GetProperty("msg");
                if (name == "raw_max_frame") { Assert.Null(Wire.Validate(Spec.Hex(hex))); n++; continue; }
                Assert.True(hex == Spec.ToHex(Spec.Build(msg)), "encode mismatch: " + name);
                Assert.Null(Wire.Validate(Spec.Hex(hex)));
                n++;
            }
            Assert.True(n >= 30);
        }

        [Fact]
        public void FrameVectorsDecode()
        {
            using var doc = Spec.Load("vectors/frames.json");
            foreach (var v in doc.RootElement.GetProperty("vectors").EnumerateArray())
            {
                if (v.GetProperty("msg").GetProperty("type").GetString() != "frame") continue;
                var bytes = Spec.Hex(v.GetProperty("hex").GetString()!);
                var f = Wire.ParseFrame(Wire.Body(bytes));
                Assert.Equal(long.Parse(v.GetProperty("msg").GetProperty("tick").GetString()!), f.Tick);
                Assert.Equal(v.GetProperty("msg").GetProperty("cmds").GetArrayLength(), f.Commands.Count);
            }
        }

        [Fact]
        public void InvalidVectorsAreRejectedWithTheNamedError()
        {
            using var doc = Spec.Load("vectors/invalid.json");
            foreach (var v in doc.RootElement.GetProperty("vectors").EnumerateArray())
                Assert.Equal(v.GetProperty("error").GetString(), Wire.Validate(Spec.Hex(v.GetProperty("hex").GetString()!)));
        }

        [Fact]
        public void UnknownTypesAreIgnoredNotErrors()
        {
            Assert.Null(Wire.Validate(new byte[] { 0x99, 0, 0, 1, 2, 3 }));
        }

        [Fact]
        public void ChatSanitiserStripsControlAndBidi()
        {
            Assert.Equal("hi there", Wire.SanitizeChat("hi\u0001 ‮there\u0085"));
        }
    }

    public class ChunkingTests
    {
        [Fact]
        public void SmallVectorSplitsToTheSpecBytes()
        {
            using var doc = Spec.Load("vectors/chunking.json");
            var v = doc.RootElement.GetProperty("vectors")[0];
            var payload = Spec.Hex(v.GetProperty("payload").GetString()!);
            var chunks = Chunker.Split(v.GetProperty("id").GetUInt32(), payload, v.GetProperty("chunkSize").GetInt32()).Select(Spec.ToHex).ToList();
            Assert.Equal(v.GetProperty("chunks").EnumerateArray().Select(e => e.GetString()!).ToList(), chunks);
        }

        [Fact]
        public void FortyKbSplitsAndReassemblesInAnyOrderWithDuplicates()
        {
            var payload = Enumerable.Range(0, 40000).Select(i => (byte)((i * 7 + 3) & 0xff)).ToArray();
            using var doc = Spec.Load("vectors/chunking.json");
            var v = doc.RootElement.GetProperty("vectors")[1];
            var chunks = Chunker.Split(v.GetProperty("id").GetUInt32(), payload, 16000).ToList();
            Assert.Equal(v.GetProperty("chunk_count").GetInt32(), chunks.Count);
            Assert.Equal(v.GetProperty("chunk_lengths").EnumerateArray().Select(e => e.GetInt32()).ToList(), chunks.Select(c => c.Length).ToList());
            Assert.Equal(v.GetProperty("chunk_hex_prefix_16")[0].GetString(), Spec.ToHex(chunks[0]).Substring(0, 32));
            var asm = new ChunkAssembler();
            byte[]? result = null;
            foreach (var i in new[] { 2, 0, 0, 1 })
                if (asm.TryAdd(Wire.Body(chunks[i]), out _, out var all)) result = all;
            Assert.Equal(payload, result);
            Assert.Equal(ulong.Parse(v.GetProperty("payload_fnv1a64").GetString()!), Fnv64(payload));
        }

        [Fact]
        public void InflateRefusesOutputOverTheCapAndAcceptsOutputAtIt()
        {
            var z = Zlib.Deflate(new byte[1_000_000]);   // ~1 KB of zlib for 1 MB of zeros
            Assert.True(z.Length < 2000);
            Assert.Throws<FormatException>(() => Zlib.Inflate(z, 100_000));
            Assert.Equal(1_000_000, Zlib.Inflate(z, 1_000_000).Length);
        }

        [Fact]
        public void EmptyPayloadIsOneEmptyChunk()
        {
            var chunks = Chunker.Split(1, ReadOnlyMemory<byte>.Empty, 16000).ToList();
            Assert.Single(chunks);
            Assert.Equal("1600000100000000000100", Spec.ToHex(chunks[0]));
            Assert.True(new ChunkAssembler().TryAdd(Wire.Body(chunks[0]), out _, out var all));
            Assert.Empty(all);
        }

        [Fact]
        public void ChunkBodyAtMaxKeepsFrameWithin16K()
        {
            var chunks = Chunker.Split(9, new byte[40000], 16373).ToList();
            Assert.All(chunks, c => Assert.True(c.Length <= Wire.MaxFrame));
        }

        [Fact]
        public void SnapshotDeflateVectorInflates()
        {
            using var doc = Spec.Load("vectors/chunking.json");
            var v = doc.RootElement.GetProperty("vectors").EnumerateArray().First(e => e.GetProperty("name").GetString() == "snapshot_deflate");
            var inflated = Zlib.Inflate(Spec.Hex(v.GetProperty("payload").GetString()!));
            Assert.Equal(v.GetProperty("inflated_len").GetInt32(), inflated.Length);
            Assert.Equal(inflated, Zlib.Inflate(Zlib.Deflate(inflated)));
        }

        private static ulong Fnv64(byte[] b)
        {
            ulong h = 0xcbf29ce484222325UL;
            foreach (var x in b) { h ^= x; h = unchecked(h * 0x100000001b3UL); }
            return h;
        }
    }

    public class GridpaintGoldenTests
    {
        [Fact]
        public void RngAnchor()
        {
            // xorshift32 from state 1: 270369, 67634689, 2647435461 (checked through a game seeded with state 1)
            var g = new GridpaintGame("000000");
            Assert.Equal(1758877277u, GridpaintGame.Seed("000000"));
            Assert.True(g.Hash() == 15567473145155401509UL);
        }

        [Fact]
        public void GoldenHashesReproduce()
        {
            using var doc = Spec.Load("vectors/gridpaint.json");
            var log = doc.RootElement.GetProperty("commandLog").EnumerateArray()
                .Select(c => (Tick: c.GetProperty("tick").GetInt64(), Peer: c.GetProperty("peerId").GetInt32(),
                    X: c.GetProperty("x").GetInt32(), Y: c.GetProperty("y").GetInt32())).ToList();
            foreach (var gold in doc.RootElement.GetProperty("golden").EnumerateArray())
            {
                var code = gold.GetProperty("code").GetString()!;
                Assert.Equal(gold.GetProperty("seed").GetUInt32(), GridpaintGame.Seed(code));
                var want = gold.GetProperty("hashes").EnumerateObject().ToDictionary(p => long.Parse(p.Name), p => ulong.Parse(p.Value.GetString()!));
                var g = new GridpaintGame(code);
                Assert.Equal(want[0], g.Hash());
                for (long t = 1; t <= want.Keys.Max(); t++)
                {
                    var cmds = log.Where(c => c.Tick == t).Select(c => (c.Peer, (ReadOnlyMemory<byte>)GridpaintGame.PaintCommand(c.X, c.Y))).ToList();
                    g.Apply(t, cmds);
                    if (want.TryGetValue(t, out var h)) Assert.Equal(h, g.Hash());
                }
            }
        }

        [Fact]
        public void SnapshotAtTick100RestoresToTheTick400Hash()
        {
            using var doc = Spec.Load("vectors/gridpaint.json");
            var snap = doc.RootElement.GetProperty("snapshotAtTick100_code_7HQ4K2");
            var g = new GridpaintGame("7HQ4K2");
            g.Restore(snap.GetProperty("tick").GetInt64(), Spec.Hex(snap.GetProperty("bytes").GetString()!));
            var log = doc.RootElement.GetProperty("commandLog").EnumerateArray().ToList();
            for (long t = 101; t <= 400; t++)
            {
                var cmds = log.Where(c => c.GetProperty("tick").GetInt64() == t)
                    .Select(c => (c.GetProperty("peerId").GetInt32(), (ReadOnlyMemory<byte>)GridpaintGame.PaintCommand(c.GetProperty("x").GetInt32(), c.GetProperty("y").GetInt32()))).ToList();
                g.Apply(t, cmds);
            }
            var want = doc.RootElement.GetProperty("golden").EnumerateArray().First(e => e.GetProperty("code").GetString() == "7HQ4K2")
                .GetProperty("hashes").GetProperty("400").GetString()!;
            Assert.Equal(ulong.Parse(want), g.Hash());
        }

        [Fact]
        public void GapIsRefused()
        {
            var g = new GridpaintGame("7HQ4K2");
            Assert.Throws<InvalidOperationException>(() => g.Apply(2, Array.Empty<(int, ReadOnlyMemory<byte>)>()));
        }
    }
}
