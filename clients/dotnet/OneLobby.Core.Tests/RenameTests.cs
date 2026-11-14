using System.Collections.Generic;
using System.Linq;
using OneLobby;
using Xunit;

namespace OneLobby.Tests
{
    public class RenameTests
    {
        [Fact]
        public void RenameAsyncChangesTheNameForEveryMemberAndRaisesPeerRenamedOnEach()
        {
            var rig = new Rig();
            var h = rig.Await(rig.NewClient("Host", SyncMode.Raw).HostAsync(new LobbyOptions("raw", 4)));
            var j = rig.Await(rig.NewClient("Joe", SyncMode.Raw).JoinAsync(h.Code));
            Assert.True(rig.Until(() => j.ReadyAsync.IsCompleted));
            var onHost = new List<(int, string, string)>();
            var onJoiner = new List<(int, string, string)>();
            h.PeerRenamed += (p, old) => onHost.Add((p.PeerId, p.Name, old));
            j.PeerRenamed += (p, old) => onJoiner.Add((p.PeerId, p.Name, old));

            _ = j.RenameAsync("Joanna");
            Assert.True(rig.Until(() => onHost.Count == 1 && onJoiner.Count == 1));
            Assert.Equal((j.LocalPeerId, "Joanna", "Joe"), onHost[0]);
            Assert.Equal((j.LocalPeerId, "Joanna", "Joe"), onJoiner[0]);
            Assert.Equal("Joanna", h.Peers.Single(p => p.PeerId == j.LocalPeerId).Name);

            _ = j.RenameAsync("Joanna"); // same name: nothing happens
            rig.Step(10);
            Assert.Single(onHost);
        }

        [Fact]
        public void RenameAsyncOnAHubWithoutTheFeatureThrowsUnsupported()
        {
            var rig = new Rig();
            var h = rig.Await(rig.NewClient("Host", SyncMode.Raw).HostAsync(new LobbyOptions("raw", 4)));
            rig.Net.Features = System.Array.Empty<string>();
            var j = rig.Await(rig.NewClient("Joe", SyncMode.Raw).JoinAsync(h.Code));
            var e = Assert.Throws<OneLobbyException>(() => { _ = j.RenameAsync("Joanna"); });
            Assert.Equal(LobbyErrorCodes.Unsupported, e.Code);
        }
    }
}
