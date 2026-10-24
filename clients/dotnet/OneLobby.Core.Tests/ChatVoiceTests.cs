using System;
using System.Collections.Generic;
using System.Linq;
using OneLobby.Gridpaint;
using Xunit;

namespace OneLobby.Tests
{
    public class ChatTests
    {
        private static (Rig rig, GridPlayer host, GridPlayer a, GridPlayer b) Trio()
        {
            var rig = new Rig();
            var host = rig.Host();
            var a = rig.Join(host.Lobby.Code, "a");
            var b = rig.Join(host.Lobby.Code, "b");
            Assert.True(rig.Until(rig.AllReady));
            return (rig, host, a, b);
        }

        [Fact]
        public void LineReachesEveryoneIncludingTheSenderWithHostStamps()
        {
            var (rig, host, a, b) = Trio();
            var got = new Dictionary<string, List<ChatLine>> { ["h"] = new(), ["a"] = new(), ["b"] = new() };
            host.Lobby.Chat.Received += l => got["h"].Add(l);
            a.Lobby.Chat.Received += l => got["a"].Add(l);
            b.Lobby.Chat.Received += l => got["b"].Add(l);
            a.Lobby.Chat.Send("hello");
            rig.Step(10);
            host.Lobby.Chat.Send("hi back");
            rig.Step(10);
            foreach (var kv in got)
            {
                Assert.Equal(new[] { "hello", "hi back" }, kv.Value.Select(l => l.Text).ToArray());
                Assert.Equal(new[] { 2, 1 }, kv.Value.Select(l => l.PeerId).ToArray());
                Assert.Equal(new uint[] { 1, 2 }, kv.Value.Select(l => l.Id).ToArray());
                Assert.All(kv.Value, l => Assert.True(l.Ts > 0));
            }
        }

        [Fact]
        public void BurstOfThreeThenRateRejectThenRefill()
        {
            var (rig, host, a, _) = Trio();
            var rejected = new List<(uint, string)>();
            var received = new List<string>();
            a.Lobby.Chat.Rejected += (id, r) => rejected.Add((id, r));
            host.Lobby.Chat.Received += l => received.Add(l.Text);
            for (var i = 1; i <= 5; i++) a.Lobby.Chat.Send("m" + i);
            rig.Step(8);
            Assert.Equal(new[] { "m1", "m2", "m3" }, received.ToArray());
            Assert.Equal(new[] { (4u, "rate"), (5u, "rate") }, rejected.ToArray());
            rig.Step(50); // 1.25 s later one token is back
            a.Lobby.Chat.Send("m6");
            rig.Step(8);
            Assert.Equal("m6", received.Last());
        }

        [Fact]
        public void OverlongLineIsRejectedForLengthAndCountsBytesNotChars()
        {
            var (rig, host, a, _) = Trio();
            var rejected = new List<string>();
            a.Lobby.Chat.Rejected += (_, r) => rejected.Add(r);
            var received = new List<string>();
            host.Lobby.Chat.Received += l => received.Add(l.Text);
            a.Lobby.Chat.Send(new string('x', 256));
            rig.Step(5);
            a.Lobby.Chat.Send(new string('é', 129)); // 258 bytes
            rig.Step(5);
            Assert.Equal(new[] { "length" }, rejected.ToArray());
            Assert.Single(received);
            Assert.Equal(256, received[0].Length);
        }

        [Fact]
        public void HostMuteRejectsWithMutedByHost()
        {
            var (rig, host, a, b) = Trio();
            var rejected = new List<string>();
            a.Lobby.Chat.Rejected += (_, r) => rejected.Add(r);
            var seenByB = new List<string>();
            b.Lobby.Chat.Received += l => seenByB.Add(l.Text);
            host.Lobby.Chat.HostMute(2, true);
            a.Lobby.Chat.Send("blocked");
            rig.Step(5);
            Assert.Equal(new[] { "muted_by_host" }, rejected.ToArray());
            Assert.Empty(seenByB);
            host.Lobby.Chat.HostMute(2, false);
            rig.Step(50);
            a.Lobby.Chat.Send("ok");
            rig.Step(5);
            Assert.Equal(new[] { "ok" }, seenByB.ToArray());
        }

        [Fact]
        public void ControlAndBidiCharactersAreStrippedAndEmptyLinesDropped()
        {
            var (rig, host, a, _) = Trio();
            var received = new List<string>();
            host.Lobby.Chat.Received += l => received.Add(l.Text);
            a.Lobby.Chat.Send("a\u0007b‮c");
            a.Lobby.Chat.Send("\u0001‮");
            rig.Step(5);
            Assert.Equal(new[] { "abc" }, received.ToArray());
        }

        [Fact]
        public void LateJoinerGetsLastHundredLinesAsHistory()
        {
            var rig = new Rig();
            var host = rig.Host();
            for (var i = 1; i <= 130; i++) { host.Lobby.Chat.Send("line " + i); rig.Step(45); }
            Assert.Equal(100, host.Lobby.Chat.History.Count);
            var late = rig.Join(host.Lobby.Code, "late");
            Assert.True(rig.Until(() => late.Lobby.IsReady));
            rig.Step(4);
            Assert.Equal(100, late.Lobby.Chat.History.Count);
            Assert.Equal("line 31", late.Lobby.Chat.History[0].Text);
            Assert.Equal("line 130", late.Lobby.Chat.History[99].Text);
            Assert.Equal(1, late.Lobby.Chat.History[0].PeerId);
        }

        [Fact]
        public void FilterHookAndLocalMuteApplyOnReceive()
        {
            var (rig, host, a, b) = Trio();
            b.Lobby.Chat.Filter = t => t.Replace("darn", "****");
            var seenByB = new List<string>();
            b.Lobby.Chat.Received += l => seenByB.Add(l.Text);
            a.Lobby.Chat.Send("darn it");
            rig.Step(5);
            Assert.Equal(new[] { "**** it" }, seenByB.ToArray());
            b.Lobby.Voice.SetMuted(2, true); // muting a peer drops their chat too
            rig.Step(50);
            a.Lobby.Chat.Send("again");
            rig.Step(5);
            Assert.Single(seenByB);
            Assert.Equal("again", host.Lobby.Chat.History.Last().Text);
        }
    }

    public class VoiceTests
    {
        private static (Rig rig, GridPlayer host, GridPlayer a, GridPlayer b, FakeAudio ha, FakeAudio aa, FakeAudio ba) Trio()
        {
            var rig = new Rig();
            var host = rig.Host();
            var a = rig.Join(host.Lobby.Code, "a");
            var b = rig.Join(host.Lobby.Code, "b");
            Assert.True(rig.Until(rig.AllReady));
            var ha = new FakeAudio(); var aa = new FakeAudio(); var ba = new FakeAudio();
            foreach (var (p, au) in new[] { (host, ha), (a, aa), (b, ba) })
            {
                p.Lobby.Voice.Codec = new FakeCodec();
                p.Lobby.Voice.Audio = au;
                p.Lobby.Voice.Enabled = true;
            }
            return (rig, host, a, b, ha, aa, ba);
        }

        [Fact]
        public void PushToTalkSendsTwoFramesPerPacketAndEndsTheBurst()
        {
            var (rig, host, a, b, _, aa, ba) = Trio();
            var speaking = new List<(int, bool)>();
            b.Lobby.Voice.Speaking += (p, s) => speaking.Add((p, s));
            a.Lobby.Voice.PushToTalk(true);
            aa.Feed(1000, 6); // 6 frames = 3 packets
            rig.Step(1);
            a.Lobby.Voice.PushToTalk(false);
            aa.Feed(5, 1);
            rig.Step(30);
            Assert.True(ba.Played.Count >= 6, "played " + ba.Played.Count);
            Assert.All(ba.Played.Take(6), p => { Assert.Equal(2, p.Peer); Assert.Equal((short)1000, p.First); });
            Assert.Contains((2, true), speaking);
            Assert.Contains((2, false), speaking);
        }

        [Fact]
        public void PacketsAreForwardedByTheHostWithSpeakerRouteAndNotEchoed()
        {
            var (rig, host, a, b, ha, aa, ba) = Trio();
            a.Lobby.Voice.PushToTalk(true);
            aa.Feed(7, 4);
            rig.Step(30);
            Assert.NotEmpty(ha.Played);
            Assert.NotEmpty(ba.Played);
            Assert.Empty(aa.Played);
            Assert.All(ha.Played, p => Assert.Equal(2, p.Peer));
        }

        [Fact]
        public void NothingIsSentWithoutPushToTalkAndMutedMicStaysSilent()
        {
            var (rig, _, a, _, _, aa, ba) = Trio();
            aa.Feed(500, 6);
            rig.Step(20);
            Assert.Empty(ba.Played);
            a.Lobby.Voice.PushToTalk(true);
            a.Lobby.Voice.Muted = true;
            aa.Feed(500, 6);
            rig.Step(20);
            Assert.Empty(ba.Played);
        }

        [Fact]
        public void VoiceActivityGateUsesAThreeHundredMsHangover()
        {
            var (rig, _, a, _, _, aa, ba) = Trio();
            a.Lobby.Voice.Mode = VoiceMode.VoiceActivity;
            aa.Feed(8000, 2);
            rig.Step(1);
            aa.Feed(0, 10); // silence within the 300 ms hangover is still sent
            rig.Step(1);
            Assert.True(a.Lobby.Voice.InputLevel >= 0);
            rig.Step(40);
            Assert.True(ba.Played.Count >= 4);
            Assert.Contains(ba.Played, p => p.First == 0);
        }

        [Fact]
        public void LocalMuteAndVolumeApplyAtThePlayer()
        {
            var (rig, host, a, b, _, aa, ba) = Trio();
            b.Lobby.Voice.SetVolume(2, 5f);
            a.Lobby.Voice.PushToTalk(true);
            aa.Feed(3, 4);
            rig.Step(25);
            Assert.All(ba.Played, p => Assert.Equal(2f, p.Gain));
            var n = ba.Played.Count;
            b.Lobby.Voice.SetMuted(2, true);
            aa.Feed(3, 4);
            rig.Step(25);
            Assert.Equal(n, ba.Played.Count);
        }

        [Fact]
        public void DisabledVoiceDropsIncomingPackets()
        {
            var (rig, _, a, b, _, aa, ba) = Trio();
            b.Lobby.Voice.Enabled = false;
            a.Lobby.Voice.PushToTalk(true);
            aa.Feed(3, 6);
            rig.Step(25);
            Assert.Empty(ba.Played);
        }

        [Fact]
        public void LostPacketIsConcealed()
        {
            var rig = new Rig();
            var host = rig.Host();
            var a = rig.Join(host.Lobby.Code, "a");
            Assert.True(rig.Until(rig.AllReady));
            var ha = new FakeAudio();
            host.Lobby.Voice.Codec = new FakeCodec(); host.Lobby.Voice.Audio = ha; host.Lobby.Voice.Enabled = true;
            a.Lobby.Voice.Codec = new FakeCodec(); a.Lobby.Voice.Audio = new FakeAudio(); a.Lobby.Voice.Enabled = true;
            var drop = 0;
            rig.Net.DropUnreliable = () => ++drop == 2; // lose the second voice packet
            a.Lobby.Voice.PushToTalk(true);
            ((FakeAudio)a.Lobby.Voice.Audio!).Feed(9, 8);
            rig.Step(40);
            Assert.Equal(new short[] { 9, 9, -1, -1, 9, 9, 9, 9 }, ha.Played.Select(p => p.First).ToArray());
        }

        [Fact]
        public void HostAdmissionLimitsSizeRateAndSpeakers()
        {
            var rig = new Rig();
            var host = rig.Host();
            var v = host.Lobby.Voice;
            Assert.False(v.HostAdmit(2, 1025, 0, 0));
            Assert.True(v.HostAdmit(2, 1024, 0, 0));
            var admitted = 0;
            for (var i = 0; i < 100; i++) if (v.HostAdmit(3, 100, 0, 0)) admitted++;
            Assert.InRange(admitted, 29, 31);
            // speakers: peers 10..17 become active, the ninth is dropped, a burst end frees a slot
            for (var p = 10; p < 18; p++) Assert.True(v.HostAdmit(p, 100, 0, 1000));
            Assert.False(v.HostAdmit(18, 100, 0, 1000));
            Assert.True(v.HostAdmit(10, 100, 1, 1050)); // end of burst frees a slot
            Assert.True(v.HostAdmit(18, 100, 0, 1100));
            Assert.False(v.HostAdmit(19, 100, 0, 1100));
            Assert.True(v.HostAdmit(19, 100, 0, 2000)); // others went quiet for 500 ms+
        }

        [Fact]
        public void PacketLayoutMatchesTheSpec()
        {
            var packet = Wire.BuildVoice(3, 9, 0, new List<byte[]> { new byte[] { 0xf8, 0xff, 0xfe }, new byte[] { 0xf8, 0x01 } });
            Assert.Equal("500300090000020300f8fffe0200f801", Spec.ToHex(packet));
        }
    }
}
