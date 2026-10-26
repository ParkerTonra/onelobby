using System;
using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace OneLobby.Tests
{
    /// <summary>The shared co-op pause (Lobby.Pause): policy, rate limit, phases, hand-off, late join, Clear, lockstep.</summary>
    public class PauseTests
    {
        private sealed class Watch
        {
            public readonly List<PauseState> Changed = new();
            public readonly List<string> Refused = new();
            public Watch(Lobby l) { l.Pause.Changed += s => Changed.Add(s); l.Pause.Refused += r => Refused.Add(r); }
        }

        /// <summary>A raw-mode host (peer 1) and <paramref name="joiners"/> joiners (peers 2..), all linked and in game unless told otherwise.</summary>
        private static (Rig rig, Lobby host, Lobby[] others) Room(int joiners, bool start = true) => Room(joiners, start, out _);

        private static (Rig rig, Lobby host, Lobby[] others) Room(int joiners, bool start, out LobbyClient hostClient)
        {
            var rig = new Rig();
            hostClient = rig.NewClient("host", SyncMode.Raw);
            var host = rig.Await(hostClient.HostAsync(new LobbyOptions("room", 6, LateJoin: true)));
            var others = new List<Lobby>();
            for (var i = 0; i < joiners; i++) others.Add(rig.Await(rig.NewClient("p" + (i + 2), SyncMode.Raw).JoinAsync(host.Code)));
            Assert.True(rig.Until(() => others.All(o => o.IsReady) && host.Peers.Count == joiners + 1));
            rig.Step(10);
            if (start)
            {
                _ = host.StartAsync();
                Assert.True(rig.Until(() => others.All(o => o.Phase == LobbyPhase.InGame)));
            }
            return (rig, host, others.ToArray());
        }

        [Fact]
        public void AnyPlayerPausesThePauserResumesEveryoneSeesBoth()
        {
            var (rig, host, o) = Room(2);
            var (bob, cara) = (o[0], o[1]);
            var hw = new Watch(host); var cw = new Watch(cara);
            Assert.Equal(new PauseState(false, 0, false), host.Pause.State);
            bob.Pause.Request(true);
            rig.Step(10);
            foreach (var l in new[] { host, bob, cara }) Assert.Equal(new PauseState(true, 2, false), l.Pause.State);
            Assert.True(bob.Pause.CanResume);
            Assert.True(host.Pause.CanResume);
            Assert.False(cara.Pause.CanResume);
            rig.Step(20);
            bob.Pause.Request(false);
            rig.Step(10);
            foreach (var l in new[] { host, bob, cara }) Assert.Equal(new PauseState(false, 2, false), l.Pause.State);
            Assert.Equal(new[] { true, false }, hw.Changed.Select(s => s.Paused).ToArray());
            Assert.Equal(new[] { true, false }, cw.Changed.Select(s => s.Paused).ToArray());
        }

        [Fact]
        public void ANonPauserJoinerCannotResumeButTheHostCan()
        {
            var (rig, host, o) = Room(2);
            var (bob, cara) = (o[0], o[1]);
            var cw = new Watch(cara);
            bob.Pause.Request(true);
            rig.Step(10);
            cara.Pause.Request(false);
            rig.Step(10);
            Assert.Equal(new[] { LobbyErrorCodes.NotAllowed }, cw.Refused.ToArray());
            Assert.True(host.Pause.State.Paused && cara.Pause.State.Paused);
            host.Pause.Request(false);
            rig.Step(10);
            foreach (var l in new[] { host, bob, cara }) Assert.False(l.Pause.State.Paused);
        }

        [Fact]
        public void WhenThePauserLeavesTheHostHoldsThePauseAndSaysSo()
        {
            var (rig, host, o) = Room(2);
            var (bob, cara) = (o[0], o[1]);
            var cw = new Watch(cara);
            bob.Pause.Request(true);
            rig.Step(10);
            _ = bob.LeaveAsync();
            Assert.True(rig.Until(() => cara.Pause.State.PauserLeft));
            foreach (var l in new[] { host, cara }) Assert.Equal(new PauseState(true, 1, true), l.Pause.State);
            Assert.Equal(new PauseState(true, 1, true), cw.Changed.Last());
            Assert.False(cara.Pause.CanResume);
            Assert.True(host.Pause.CanResume);
            host.Pause.Request(false);
            rig.Step(10);
            Assert.False(cara.Pause.State.Paused);
        }

        [Fact]
        public void ALateJoinerLearnsTheStateOnceItsLinkIsUp()
        {
            var (rig, host, o) = Room(1);
            o[0].Pause.Request(true);
            rig.Step(10);
            var dan = rig.Await(rig.NewClient("dan", SyncMode.Raw).JoinAsync(host.Code));
            Assert.True(rig.Until(() => dan.IsReady && dan.Pause.State.Paused));
            Assert.Equal(new PauseState(true, 2, false), dan.Pause.State);
            Assert.False(dan.Pause.CanResume);
        }

        [Fact]
        public void RequestsAreLimitedToOneAcceptedPerHalfSecondPerPeer()
        {
            var (rig, host, o) = Room(1);
            var bob = o[0];
            var bw = new Watch(bob);
            bob.Pause.Request(true);
            rig.Step(4);
            bob.Pause.Request(false); // too soon
            rig.Step(4);
            Assert.Equal(new[] { LobbyErrorCodes.RateLimited }, bw.Refused.ToArray());
            Assert.True(host.Pause.State.Paused);
            rig.Step(20);
            bob.Pause.Request(false);
            rig.Step(6);
            Assert.False(host.Pause.State.Paused);
        }

        [Fact]
        public void OutsideTheGamePhaseARequestIsRefusedNotInGame()
        {
            var (rig, host, o) = Room(1, start: false);
            var bw = new Watch(o[0]); var hw = new Watch(host);
            o[0].Pause.Request(true);
            host.Pause.Request(true);
            rig.Step(10);
            Assert.Equal(new[] { LobbyErrorCodes.NotInGame }, bw.Refused.ToArray());
            Assert.Equal(new[] { LobbyErrorCodes.NotInGame }, hw.Refused.ToArray());
            Assert.Equal("not_in_game", LobbyErrorCodes.NotInGame);
            Assert.False(host.Pause.State.Paused);
        }

        [Fact]
        public void TheStateClearsWhenThePhaseGoesBackToTheLobby()
        {
            var (rig, host, o) = Room(1, true, out var hostClient);
            var bw = new Watch(o[0]);
            o[0].Pause.Request(true);
            rig.Step(10);
            hostClient.SendRaw(Signaling.Phase(LobbyPhase.Lobby));
            Assert.True(rig.Until(() => host.Phase == LobbyPhase.Lobby && o[0].Phase == LobbyPhase.Lobby));
            rig.Step(10);
            Assert.False(host.Pause.State.Paused);
            Assert.False(o[0].Pause.State.Paused);
            Assert.Equal(new[] { true, false }, bw.Changed.Select(s => s.Paused).ToArray());
        }

        [Fact]
        public void ClearUnpausesAtOnceSkippingPolicyAndRateLimitAndIsHostOnly()
        {
            var (rig, host, o) = Room(1);
            var bob = o[0];
            host.Pause.Policy = (_, _) => false;
            bob.Pause.Request(true); // the policy refuses
            rig.Step(10);
            Assert.False(host.Pause.State.Paused);
            host.Pause.Policy = null;
            bob.Pause.Request(true);
            rig.Step(10);
            host.Pause.Clear(); // well inside the rate window of the pause
            rig.Step(10);
            Assert.False(host.Pause.State.Paused);
            Assert.False(bob.Pause.State.Paused);
            Assert.Throws<InvalidOperationException>(() => bob.Pause.Clear());
            host.Pause.Clear(); // not paused: nothing
        }

        [Fact]
        public void AHostPolicyCanMakePausingHostOnly()
        {
            var (rig, host, o) = Room(1);
            var bw = new Watch(o[0]);
            host.Pause.Policy = (peer, _) => peer == host.LocalPeerId;
            o[0].Pause.Request(true);
            rig.Step(10);
            Assert.Equal(new[] { LobbyErrorCodes.NotAllowed }, bw.Refused.ToArray());
            host.Pause.Request(true);
            rig.Step(10);
            Assert.True(o[0].Pause.State.Paused);
        }

        [Fact]
        public void AHostOnlyBlueprintMakesTheDefaultPolicyHostOnlyAndOffThrows()
        {
            var bp = Blueprint.Parse("{\"game\":{\"id\":\"g\"},\"engine\":\"dotnet\",\"hosting\":{\"lobbyServer\":\"ws://mem/ws\"},\"sync\":{\"mode\":\"raw\"},\"session\":{\"pause\":\"host\"}}");
            var off = Blueprint.Parse("{\"game\":{\"id\":\"g\"},\"engine\":\"dotnet\",\"hosting\":{\"lobbyServer\":\"ws://mem/ws\"},\"sync\":{\"mode\":\"raw\"}}");
            var rig = new Rig();
            var hc = LobbyClient.FromBlueprint(bp, rig.Net.CreateTransport());
            rig.Clients.Add(hc);
            var host = rig.Await(hc.HostAsync());
            var jc = LobbyClient.FromBlueprint(bp, rig.Net.CreateTransport());
            rig.Clients.Add(jc);
            var join = rig.Await(jc.JoinAsync(host.Code));
            Assert.True(rig.Until(() => join.IsReady));
            rig.Step(10);
            _ = host.StartAsync();
            Assert.True(rig.Until(() => join.Phase == LobbyPhase.InGame));
            var jw = new Watch(join);
            join.Pause.Request(true);
            rig.Step(10);
            Assert.Equal(new[] { LobbyErrorCodes.NotAllowed }, jw.Refused.ToArray());
            host.Pause.Request(true);
            rig.Step(10);
            Assert.True(join.Pause.State.Paused);
            Assert.False(join.Pause.CanResume);

            var offClient = LobbyClient.FromBlueprint(off, rig.Net.CreateTransport());
            rig.Clients.Add(offClient);
            var offLobby = rig.Await(offClient.HostAsync());
            var e = Assert.Throws<OneLobbyException>(() => offLobby.Pause.Request(true));
            Assert.Equal(LobbyErrorCodes.PauseDisabled, e.Code);
            Assert.Equal("pause_disabled", LobbyErrorCodes.PauseDisabled);
        }

        // ---- lockstep ----

        private static (Rig rig, GridPlayer host, GridPlayer a, GridPlayer b) Trio()
        {
            var rig = new Rig();
            var host = rig.Host();
            var a = rig.Join(host.Lobby.Code, "a");
            var b = rig.Join(host.Lobby.Code, "b");
            Assert.True(rig.Until(rig.AllReady));
            _ = host.Lobby.StartAsync();
            rig.Step(60);
            return (rig, host, a, b);
        }

        [Fact]
        public void LockstepFramesStopWhilePausedAndResumeAtTickPlusOneWithEqualHashes()
        {
            var (rig, host, a, b) = Trio();
            a.Lobby.Pause.Request(true);
            rig.Step(10); // frames already in flight drain
            var frozen = new[] { host.Game.Tick, a.Game.Tick, b.Game.Tick };
            Assert.Single(frozen.Distinct());
            rig.Step(600); // 15 s: longer than every silence limit
            Assert.Equal(frozen, new[] { host.Game.Tick, a.Game.Tick, b.Game.Tick });
            Assert.False(a.Lobby.Lockstep!.TryNextFrame(out _));
            Assert.Equal(0, b.Lobby.Lockstep!.FramesBuffered);
            Assert.Empty(a.Ended);
            Assert.Equal(3, host.Lobby.Peers.Count);
            b.Paint(5, 5); // a command made while paused rides the first frame after
            rig.Step(10);
            Assert.Equal(frozen[0], host.Game.Tick);
            rig.Step(10);
            host.Lobby.Pause.Request(false);
            rig.Step(80);
            Assert.InRange(host.Game.Tick - frozen[0], 30, 50); // about 2 s of ticks, not the paused 15 s
            Assert.True(Rig.CompareHashes(host, a, b) > 30);
            Assert.NotEqual(0, host.Game.Grid[5 * 16 + 5]);
            Assert.Empty(a.Desyncs);
            Assert.Empty(b.Desyncs);
            Assert.Equal(3, host.Lobby.Peers.Count);
        }

        [Fact]
        public void HostMigrationWhilePausedKeepsThePauseAndResumesTheFrames()
        {
            var (rig, host, a, b) = Trio();
            host.Lobby.Pause.Request(true);
            rig.Step(20);
            var frozen = a.Game.Tick;
            _ = host.Lobby.LeaveAsync();
            rig.Players.Remove(host);
            Assert.True(rig.Until(() => a.Lobby.IsHost && b.Lobby.HostPeerId == 2 && b.Lobby.IsReady, 1200));
            rig.Step(120);
            Assert.Equal(new PauseState(true, 2, true), a.Lobby.Pause.State);
            Assert.Equal(new PauseState(true, 2, true), b.Lobby.Pause.State);
            Assert.Equal(frozen, a.Game.Tick);
            a.Lobby.Pause.Request(false);
            Assert.True(rig.Until(() => a.Game.Tick > frozen + 40 && b.Game.Tick > frozen + 40, 2000));
            Assert.True(Rig.CompareHashes(a, b) > 30);
            Assert.Empty(a.Desyncs);
        }
    }
}
