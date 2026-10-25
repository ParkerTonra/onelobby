using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace OneLobby.Tests
{
    public class VoiceOptionTests
    {
        private static FakeAudio Voice(GridPlayer p)
        {
            var au = new FakeAudio();
            p.Lobby.Voice.Codec = new FakeCodec();
            p.Lobby.Voice.Audio = au;
            p.Lobby.Voice.Enabled = true;
            return au;
        }

        private static (Rig rig, GridPlayer host, GridPlayer a, GridPlayer b, FakeAudio aa, FakeAudio ba) Trio()
        {
            var rig = new Rig();
            var host = rig.Host();
            var a = rig.Join(host.Lobby.Code, "a");
            var b = rig.Join(host.Lobby.Code, "b");
            Assert.True(rig.Until(rig.AllReady));
            Voice(host);
            return (rig, host, a, b, Voice(a), Voice(b));
        }

        [Theory]
        [InlineData(0, false)]
        [InlineData(150, true)]
        public void ReleaseHangKeepsSendingBrieflyAfterPushToTalkIsReleased(int hangMs, bool tailSent)
        {
            var (rig, _, a, _, aa, ba) = Trio();
            a.Lobby.Voice.ReleaseHangMs = hangMs;
            a.Lobby.Voice.PushToTalk(true);
            aa.Feed(1000, 4);
            rig.Step(1);
            a.Lobby.Voice.PushToTalk(false);
            aa.Feed(77, 4); // the last syllable, captured right after the key came up
            rig.Step(30);
            Assert.Equal(tailSent, ba.Played.Any(p => p.First == 77));
            Assert.False(a.Lobby.Voice.IsTransmitting);
        }

        [Fact]
        public void SpeakingStaysTrueAcrossAShortPauseThenEndsOnce()
        {
            var (rig, _, a, b, aa, _) = Trio();
            var speaking = new List<bool>();
            b.Lobby.Voice.Speaking += (_, s) => speaking.Add(s);
            void Burst()
            {
                a.Lobby.Voice.PushToTalk(true);
                aa.Feed(1000, 4);
                rig.Step(1);
                a.Lobby.Voice.PushToTalk(false);
                aa.Feed(0, 1);
                rig.Step(1);
            }
            Burst();
            rig.Step(6);   // first word played out; ~100 ms of quiet
            Burst();
            rig.Step(6);
            Assert.Equal(new[] { true }, speaking.ToArray());
            rig.Step(30);
            Assert.Equal(new[] { true, false }, speaking.ToArray());
        }

        [Fact]
        public void MuteAllCoversPeersWhoJoinLaterAndKeepsPerPeerChoices()
        {
            var (rig, host, a, b, aa, ba) = Trio();
            b.Lobby.Voice.SetMuted(a.Lobby.LocalPeerId, true);
            b.Lobby.Voice.MuteAll(true);
            var c = rig.Join(host.Lobby.Code, "c");
            Assert.True(rig.Until(rig.AllReady));
            var ca = Voice(c);
            Assert.True(b.Lobby.Voice.AllMuted);
            Assert.True(b.Lobby.Voice.IsMuted(c.Lobby.LocalPeerId));
            c.Lobby.Voice.PushToTalk(true);
            ca.Feed(5, 4);
            rig.Step(20);
            Assert.Empty(ba.Played);

            b.Lobby.Voice.MuteAll(false);
            Assert.False(b.Lobby.Voice.IsMuted(c.Lobby.LocalPeerId));
            Assert.True(b.Lobby.Voice.IsMuted(a.Lobby.LocalPeerId));
            ca.Feed(5, 4);
            a.Lobby.Voice.PushToTalk(true);
            aa.Feed(6, 4);
            rig.Step(20);
            Assert.Contains(ba.Played, p => p.Peer == c.Lobby.LocalPeerId);
            Assert.DoesNotContain(ba.Played, p => p.Peer == a.Lobby.LocalPeerId);
        }

        [Fact]
        public void InputLevelMetersTheMicWhileNotTransmitting()
        {
            var (rig, _, a, _, aa, ba) = Trio();
            aa.Feed(8000, 3);                                  // push-to-talk up
            rig.Step(1);
            Assert.True(a.Lobby.Voice.InputLevel > 0.5f, "level " + a.Lobby.Voice.InputLevel);
            Assert.False(a.Lobby.Voice.IsTransmitting);
            a.Lobby.Voice.Muted = true;
            a.Lobby.Voice.PushToTalk(true);
            aa.Feed(0, 3);
            rig.Step(1);
            aa.Feed(4000, 3);
            rig.Step(1);
            Assert.True(a.Lobby.Voice.InputLevel > 0.3f);
            rig.Step(20);
            Assert.Empty(ba.Played);
        }
    }
}
