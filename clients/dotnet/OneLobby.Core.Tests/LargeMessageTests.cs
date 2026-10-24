using System;
using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace OneLobby.Tests
{
    /// <summary>Raw sends over 16 KiB go out as chunks and arrive whole (spec/binary.md "Large non-snapshot frames").</summary>
    public class LargeMessageTests
    {
        private static (Rig rig, GridPlayer host, GridPlayer a, GridPlayer b, Dictionary<string, List<(int From, byte[] Bytes)>> got) Trio()
        {
            var rig = new Rig();
            var host = rig.Host();
            var a = rig.Join(host.Lobby.Code, "a");
            var b = rig.Join(host.Lobby.Code, "b");
            Assert.True(rig.Until(rig.AllReady));
            var got = new Dictionary<string, List<(int, byte[])>> { ["h"] = new(), ["a"] = new(), ["b"] = new() };
            host.Lobby.MessageReceived += (p, m, _) => got["h"].Add((p, m.ToArray()));
            a.Lobby.MessageReceived += (p, m, _) => got["a"].Add((p, m.ToArray()));
            b.Lobby.MessageReceived += (p, m, _) => got["b"].Add((p, m.ToArray()));
            return (rig, host, a, b, got);
        }

        private static byte[] Payload(int n, int seed) => Enumerable.Range(0, n).Select(i => (byte)(i * 31 + seed)).ToArray();

        [Fact]
        public void HostToJoiner()
        {
            var (rig, host, a, _, got) = Trio();
            var p = Payload(40000, 1);
            host.Lobby.Send(a.Lobby.LocalPeerId, p);
            rig.Step(10);
            Assert.Single(got["a"]);
            Assert.Equal(host.Lobby.LocalPeerId, got["a"][0].From);
            Assert.Equal(p, got["a"][0].Bytes);
        }

        [Fact]
        public void JoinerToHost()
        {
            var (rig, host, a, _, got) = Trio();
            var p = Payload(100_000, 2);
            a.Lobby.Send(host.Lobby.LocalPeerId, p);
            rig.Step(10);
            Assert.Single(got["h"]);
            Assert.Equal(a.Lobby.LocalPeerId, got["h"][0].From);
            Assert.Equal(p, got["h"][0].Bytes);
        }

        [Fact]
        public void JoinerToJoinerThroughTheHost()
        {
            var (rig, _, a, b, got) = Trio();
            var p = Payload(20000, 3);
            a.Lobby.Send(b.Lobby.LocalPeerId, p);
            rig.Step(10);
            Assert.Empty(got["h"]);
            Assert.Single(got["b"]);
            Assert.Equal(a.Lobby.LocalPeerId, got["b"][0].From);
            Assert.Equal(p, got["b"][0].Bytes);
        }

        [Fact]
        public void JoinerBroadcastReachesEveryoneElse()
        {
            var (rig, _, a, _, got) = Trio();
            var p = Payload(50000, 4);
            a.Lobby.Broadcast(p);
            rig.Step(10);
            Assert.Empty(got["a"]);
            foreach (var k in new[] { "h", "b" })
            {
                Assert.Single(got[k]);
                Assert.Equal(a.Lobby.LocalPeerId, got[k][0].From);
                Assert.Equal(p, got[k][0].Bytes);
            }
        }

        [Fact]
        public void TwoJoinersSendingAtOnceDoNotMix()
        {
            // both senders number chunk ids from the same start, so the host must reassemble per sender
            var (rig, host, a, b, got) = Trio();
            var pa = Payload(40000, 5);
            var pb = Payload(40000, 6);
            a.Lobby.Send(host.Lobby.LocalPeerId, pa);
            b.Lobby.Send(host.Lobby.LocalPeerId, pb);
            rig.Step(10);
            Assert.Equal(2, got["h"].Count);
            Assert.Equal(pa, got["h"].Single(m => m.From == a.Lobby.LocalPeerId).Bytes);
            Assert.Equal(pb, got["h"].Single(m => m.From == b.Lobby.LocalPeerId).Bytes);
        }

        [Fact]
        public void ReassemblyOver64MiBIsRefused()
        {
            var half = new byte[Wire.MaxReassembled / 2 + 1];
            var asm = new ChunkAssembler();
            Assert.False(asm.TryAdd(Wire.Body(Wire.BuildChunk(1, 0, 2, half)), out _, out _));
            Assert.Throws<FormatException>(() => asm.TryAdd(Wire.Body(Wire.BuildChunk(1, 1, 2, half)), out _, out _));
        }

        [Fact]
        public void ReassembledFramesUseTheBiggerCap()
        {
            var big = Wire.BuildRaw(0, new byte[Wire.MaxFrame]);
            Assert.Equal("too_long", Wire.Validate(big));
            Assert.Null(Wire.Validate(big, Wire.MaxReassembled));
        }
    }
}
