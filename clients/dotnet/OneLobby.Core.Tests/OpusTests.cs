using System;
using System.Collections.Generic;
using System.Linq;
using OneLobby.Opus;
using Xunit;

namespace OneLobby.Tests
{
    public class OpusTests
    {
        private static short[] Tone(int frame, double hz = 440) =>
            Enumerable.Range(0, 960).Select(i => (short)(12000 * Math.Sin(2 * Math.PI * hz * (frame * 960 + i) / 48000.0))).ToArray();

        [Fact]
        public void ToneSurvivesEncodeDecodeAtAbout24kbit()
        {
            using var codec = new OpusVoiceCodec();
            var buf = new byte[1500];
            var pcm = new short[960];
            var sizes = new List<int>();
            double energyIn = 0, energyOut = 0;
            for (var f = 0; f < 25; f++)
            {
                var input = Tone(f);
                var n = codec.Encode(input, buf);
                sizes.Add(n);
                codec.Decode(1, buf.AsSpan(0, n), pcm);
                if (f >= 5) { energyIn += input.Sum(x => (double)x * x); energyOut += pcm.Sum(x => (double)x * x); }
            }
            Assert.InRange(sizes.Skip(5).Average(), 20, 120);
            Assert.InRange(energyOut / energyIn, 0.5, 1.6);
        }

        [Fact]
        public void EmptyPacketIsConcealed()
        {
            using var codec = new OpusVoiceCodec();
            var buf = new byte[1500];
            var pcm = new short[960];
            for (var f = 0; f < 5; f++) { var n = codec.Encode(Tone(f), buf); codec.Decode(1, buf.AsSpan(0, n), pcm); }
            var got = codec.Decode(1, ReadOnlySpan<byte>.Empty, pcm);
            Assert.Equal(960, got);
            Assert.Contains(pcm, s => s != 0);
        }

        [Fact]
        public void ToneCrossesTheLobbyThroughRealOpus()
        {
            var rig = new Rig();
            var host = rig.Host();
            var a = rig.Join(host.Lobby.Code, "a");
            Assert.True(rig.Until(rig.AllReady));
            var ha = new FakeAudio(); var aa = new FakeAudio();
            host.Lobby.Voice.Codec = new OpusVoiceCodec(); host.Lobby.Voice.Audio = ha; host.Lobby.Voice.Enabled = true;
            a.Lobby.Voice.Codec = new OpusVoiceCodec(); a.Lobby.Voice.Audio = aa; a.Lobby.Voice.Enabled = true;
            a.Lobby.Voice.PushToTalk(true);
            rig.Step(1);
            // FakeAudio frames are constant-valued; a constant 6000 decodes to a DC-ish signal, enough to prove the path
            aa.Feed(6000, 20);
            rig.Step(40);
            Assert.True(ha.Played.Count >= 16, "played " + ha.Played.Count);
        }
    }
}
