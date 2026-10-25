using System.Collections.Generic;
using Xunit;

namespace OneLobby.Tests
{
    // Raw mode has the same phase machine as lockstep: StartAsync moves the lobby to InGame, and with LateJoin a joiner
    // links up and gets ready straight into the running game.
    public class RawPhaseTests
    {
        [Fact]
        public void StartAsyncMovesARawLobbyInGameAndALateJoinerGetsReadyIntoIt()
        {
            var rig = new Rig();
            var hc = rig.NewClient("h", SyncMode.Raw);
            var h = rig.Await(hc.HostAsync(new LobbyOptions("raw", 4, LateJoin: true)));
            var early = rig.Await(rig.NewClient("early", SyncMode.Raw).JoinAsync(h.Code));
            var phases = new List<LobbyPhase>();
            early.PhaseChanged += p => phases.Add(p);
            Assert.True(rig.Until(() => early.ReadyAsync.IsCompleted));

            _ = h.StartAsync();
            Assert.Equal(LobbyPhase.InGame, h.Phase);
            Assert.True(rig.Until(() => early.Phase == LobbyPhase.InGame));
            Assert.Equal(new[] { LobbyPhase.InGame }, phases.ToArray());

            var late = rig.Await(rig.NewClient("late", SyncMode.Raw).JoinAsync(h.Code));
            Assert.Equal(LobbyPhase.InGame, late.Phase);
            Assert.True(rig.Until(() => late.ReadyAsync.IsCompleted));
            Assert.True(late.ReadyAsync.IsCompletedSuccessfully);
            Assert.True(late.IsReady);
            Assert.Equal(LobbyPhase.InGame, late.Phase);
        }

        [Fact]
        public void WithoutLateJoinARunningRawLobbyRefusesJoiners()
        {
            var rig = new Rig();
            var h = rig.Await(rig.NewClient("h", SyncMode.Raw).HostAsync(new LobbyOptions("raw", 4, LateJoin: false)));
            _ = h.StartAsync();
            rig.Step(4);
            var e = Assert.Throws<OneLobbyException>(() => rig.Await(rig.NewClient("late", SyncMode.Raw).JoinAsync(h.Code)));
            Assert.Equal("in_game", e.Code);
        }
    }
}
