using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using OneLobby.Gridpaint;
using Xunit;

namespace OneLobby.Tests
{
    public class LobbyTests
    {
        [Fact]
        public void HostCreatesLobbyAndJoinerFindsItByCodeWithSpaces()
        {
            var rig = new Rig();
            var host = rig.Host();
            Assert.True(host.Lobby.IsHost);
            Assert.Equal(1, host.Lobby.LocalPeerId);
            Assert.Equal(6, host.Lobby.Code.Length);
            var guest = rig.Join(Crockford.Format(host.Lobby.Code).ToLowerInvariant(), "guest");
            Assert.False(guest.Lobby.IsHost);
            Assert.Equal(2, guest.Lobby.LocalPeerId);
            Assert.True(rig.Until(rig.AllReady));
            Assert.Equal(2, host.Lobby.Peers.Count);
            Assert.Equal(new[] { "host", "guest" }, guest.Lobby.Peers.Select(p => p.Name).ToArray());
        }

        [Fact]
        public void ErrorsSurfaceAsOneLobbyException()
        {
            var rig = new Rig();
            var host = rig.Host();
            var wrong = rig.NewPlayer("old", netVersion: "0");
            var ex = Assert.Throws<OneLobbyException>(() => rig.Await(wrong.Client.JoinAsync(host.Lobby.Code)));
            Assert.Equal("version_mismatch", ex.Code);
            var other = rig.NewPlayer("x");
            var ex2 = Assert.Throws<OneLobbyException>(() => rig.Await(other.Client.JoinAsync("ZZZZZZ")));
            Assert.Equal("unknown_code", ex2.Code);
            var ex3 = Assert.Throws<OneLobbyException>(() => rig.Await(other.Client.JoinAsync("7HQ4KU")));
            Assert.Equal("unknown_code", ex3.Code);
        }

        [Fact]
        public void LobbyFullIsReported()
        {
            var rig = new Rig();
            var host = rig.Host("h", new LobbyOptions("tiny", 2, Visibility.Unlisted));
            rig.Join(host.Lobby.Code, "a");
            var late = rig.NewPlayer("b");
            var ex = Assert.Throws<OneLobbyException>(() => rig.Await(late.Client.JoinAsync(host.Lobby.Code)));
            Assert.Equal("lobby_full", ex.Code);
        }

        [Fact]
        public void ListFiltersPublicLobbiesByMeta()
        {
            var rig = new Rig();
            rig.Host("a", new LobbyOptions("A", 4, Visibility.Public, true, new Dictionary<string, string> { ["map"] = "x" }));
            rig.Host("b", new LobbyOptions("B", 4, Visibility.Public, true, new Dictionary<string, string> { ["map"] = "y" }));
            rig.Host("c", new LobbyOptions("C", 4, Visibility.Unlisted));
            var browser = rig.NewPlayer("browser");
            var all = rig.Await(browser.Client.ListAsync());
            Assert.Equal(new[] { "A", "B" }, all.Select(l => l.Name).OrderBy(n => n).ToArray());
            var only = rig.Await(browser.Client.ListAsync(new Dictionary<string, string> { ["map"] = "y" }));
            Assert.Equal("B", Assert.Single(only).Name);
            Assert.Equal("b", only[0].HostName);
        }

        [Fact]
        public void PrivateLobbyNeedsHostApproval()
        {
            var rig = new Rig();
            var host = rig.Host("h", new LobbyOptions("priv", 4, Visibility.Private));
            Peer? asked = null;
            host.Lobby.JoinRequested += p => { asked = p; _ = host.Lobby.ApproveAsync(p.PeerId, true); };
            var guest = rig.NewPlayer("g");
            var task = guest.Client.JoinAsync(host.Lobby.Code);
            guest.Attach(rig.Await(task));
            Assert.Equal("g", asked!.Name);
            Assert.True(rig.Until(rig.AllReady));
        }

        [Fact]
        public void KickRemovesPeerAndEndsItsSession()
        {
            var rig = new Rig();
            var host = rig.Host();
            var guest = rig.Join(host.Lobby.Code, "g");
            rig.Until(rig.AllReady);
            _ = host.Lobby.KickAsync(2);
            Assert.True(rig.Until(() => guest.Ended.Count > 0));
            Assert.Equal("kicked", guest.Ended[0]);
            Assert.Contains(host.Left, l => l.Item1.PeerId == 2 && l.Item2 == "kicked");
        }

        [Fact]
        public void DisconnectRemovesPeerWithoutBanAndEndsItsSessionAsDisconnected()
        {
            var rig = new Rig();
            var host = rig.Host();
            var guest = rig.Join(host.Lobby.Code, "g");
            rig.Until(rig.AllReady);
            _ = host.Lobby.DisconnectAsync(2, 4000, "replaced");
            Assert.True(rig.Until(() => guest.Ended.Count > 0));
            Assert.Equal("disconnected", guest.Ended[0]);
            Assert.Contains(host.Left, l => l.Item1.PeerId == 2 && l.Item2 == "disconnected");
            Assert.Throws<ArgumentOutOfRangeException>(() => { _ = host.Lobby.DisconnectAsync(3, 1006); });
        }

        [Fact]
        public void RawModeSendsDirectAndBroadcastWithSourceRoute()
        {
            var rig = new Rig();
            var hc = rig.NewClient("h", SyncMode.Raw);
            var h = rig.Await(hc.HostAsync(new LobbyOptions("raw", 4)));
            var a = rig.Await(rig.NewClient("a", SyncMode.Raw).JoinAsync(h.Code));
            var b = rig.Await(rig.NewClient("b", SyncMode.Raw).JoinAsync(h.Code));
            Assert.Null(h.Lockstep);
            var got = new List<(string, int, string, Channel)>();
            h.MessageReceived += (f, p, c) => got.Add(("h", f, System.Text.Encoding.UTF8.GetString(p.Span), c));
            a.MessageReceived += (f, p, c) => got.Add(("a", f, System.Text.Encoding.UTF8.GetString(p.Span), c));
            b.MessageReceived += (f, p, c) => got.Add(("b", f, System.Text.Encoding.UTF8.GetString(p.Span), c));
            Assert.True(rig.Until(() => h.IsReady && a.IsReady && b.IsReady));
            a.Send(3, System.Text.Encoding.UTF8.GetBytes("to-b"));
            a.Broadcast(System.Text.Encoding.UTF8.GetBytes("all"), Channel.Fast);
            h.Send(2, System.Text.Encoding.UTF8.GetBytes("from-host"));
            rig.Step(10);
            Assert.Contains(("b", 2, "to-b", Channel.Reliable), got);
            Assert.Contains(("h", 2, "all", Channel.Fast), got);
            Assert.Contains(("b", 2, "all", Channel.Fast), got);
            Assert.Contains(("a", 1, "from-host", Channel.Reliable), got);
            Assert.DoesNotContain(got, g => g.Item1 == "a" && g.Item3 == "all");
        }

        [Fact]
        public void RunningGameSurvivesTheLobbyServerGoingAway()
        {
            var rig = new Rig();
            var host = rig.Host();
            var guest = rig.Join(host.Lobby.Code, "g");
            rig.Until(rig.AllReady);
            _ = host.Lobby.StartAsync();
            rig.Step(40);
            rig.Net.ShutdownServer();
            var before = guest.Game.Tick;
            rig.Step(60);
            Assert.True(guest.Game.Tick >= before + 20);
            Assert.Empty(guest.Ended);
            Assert.True(Rig.CompareHashes(host, guest) > 30);
        }
    }

    public class LockstepTests
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
        public void ThreePeersPlayWithEqualHashes()
        {
            var (rig, host, a, b) = Trio();
            _ = host.Lobby.StartAsync();
            for (var i = 0; i < 10; i++)
            {
                host.Paint(i, 0); a.Paint(i, 5); b.Paint(i, 10);
                rig.Step(8);
            }
            Assert.True(rig.Until(() => new[] { host, a, b }.All(p => p.Game.Tick >= 150), 3000));
            Assert.True(Rig.CompareHashes(host, a, b) >= 100);
            Assert.Equal(host.Game.Grid.ToArray().Count(x => x != 0), a.Game.Grid.ToArray().Count(x => x != 0));
            Assert.Empty(a.Desyncs);
        }

        [Fact]
        public void FramesHoldCommandsSortedByPeerIdThenArrival()
        {
            var (rig, host, a, b) = Trio();
            _ = host.Lobby.StartAsync();
            rig.Step(4);
            var frames = new List<Frame>();
            // consume manually on b
            b.Paused = true;
            b.Paint(1, 1); a.Paint(2, 2); a.Paint(3, 3); host.Paint(4, 4);
            rig.Step(10);
            var ls = b.Lobby.Lockstep!;
            while (ls.TryNextFrame(out var f)) frames.Add(f);
            var withCmds = frames.Where(f => f.Commands.Count > 0).SelectMany(f => f.Commands).ToList();
            Assert.Equal(new[] { 1, 2, 2, 3 }, withCmds.Select(c => c.PeerId).ToArray());
            Assert.Equal(new byte[] { 2, 3 }, withCmds.Where(c => c.PeerId == 2).Select(c => c.Command.Span[1]).ToArray());
            // frames are strictly consecutive
            for (var i = 1; i < frames.Count; i++) Assert.Equal(frames[i - 1].Tick + 1, frames[i].Tick);
        }

        [Fact]
        public void HostEmitsTwentyFramesPerSecondOfClockTime()
        {
            var (rig, host, a, _) = Trio();
            _ = host.Lobby.StartAsync();
            rig.Step(4);
            var t0 = a.Game.Tick;
            rig.Step(80); // 2 s
            Assert.InRange(a.Game.Tick - t0, 38, 42);
        }

        [Fact]
        public void LateJoinerGetsSnapshotThenCatchesUpWithEqualHashes()
        {
            var (rig, host, a, _) = Trio();
            _ = host.Lobby.StartAsync();
            for (var i = 0; i < 6; i++) { host.Paint(i, i); rig.Step(15); }
            Assert.True(host.Game.Tick > 40);
            var late = rig.Join(host.Lobby.Code, "late");
            Assert.True(rig.Until(() => late.Game.Tick > 0 && late.Game.Tick >= host.Game.Tick - 2));
            rig.Step(80);
            Assert.True(Rig.CompareHashes(host, a, late) > 40);
            Assert.True(late.Hashes.Count > 40);
            Assert.NotEqual(0, late.Game.Grid.ToArray().Count(x => x != 0));
        }

        [Fact]
        public void BigSnapshotIsChunkedAndInflated()
        {
            var rig = new Rig();
            var host = rig.Host();
            var big = new byte[100_000];
            new Random(5).NextBytes(big.AsSpan(0, 20_000)); // compressible tail
            host.Lobby.Lockstep!.Snapshot = () => big;
            _ = host.Lobby.StartAsync();
            rig.Step(10);
            var joiner = rig.NewPlayer("j");
            joiner.Paused = true;
            joiner.Lobby = rig.Await(joiner.Client.JoinAsync(host.Lobby.Code));
            byte[]? received = null;
            long at = -1;
            joiner.Lobby.Lockstep!.Restore = (t, b) => { received = b.ToArray(); at = t; };
            Assert.True(rig.Until(() => received != null));
            Assert.Equal(big, received);
            Assert.True(at >= 0);
        }

        [Fact]
        public void DesyncResyncsThroughSnapshotAndThirdOneDropsThePeer()
        {
            var (rig, host, a, b) = Trio();
            _ = host.Lobby.StartAsync();
            host.Paint(3, 3);
            rig.Step(10);
            void Busy()
            {
                for (var i = 0; i < 8; i++) { a.Paint(i * 2, i); b.Paint(15 - i, i * 2); host.Paint(i, 15 - i); rig.Step(10); }
            }
            void Corrupt()
            {
                var s = b.Game.Snapshot();
                s[0] ^= 0x01;
                b.Game.Restore(b.Game.Tick, s);
            }
            Busy();
            Corrupt();
            Assert.True(rig.Until(() => b.Desyncs.Count == 1));
            Assert.Equal(1, b.Desyncs[0].ResyncCount);
            Assert.NotEqual(b.Desyncs[0].HostHash, b.Desyncs[0].LocalHash);
            Busy(); rig.Step(40);
            Assert.True(Rig.CompareHashes(host, a, b) > 20, "desyncs=" + b.Desyncs.Count + " common=" + Rig.CompareHashes(host, a, b));
            // resync once more; agreement again
            Busy();
            Corrupt();
            Assert.True(rig.Until(() => b.Desyncs.Count == 2));
            Busy(); rig.Step(40);
            Busy();
            Corrupt();
            rig.Until(() => host.Left.Any(l => l.Item1.PeerId == 3 && l.Item2 == "desync"));
            Assert.Contains(host.Left, l => l.Item1.PeerId == 3 && l.Item2 == "desync");
            Assert.DoesNotContain(host.Lobby.Peers, p => p.PeerId == 3);
        }

        [Fact]
        public void HostMigratesToLowestPeerWithEqualHashesAfterwards()
        {
            var (rig, host, a, b) = Trio();
            _ = host.Lobby.StartAsync();
            for (var i = 0; i < 4; i++) { a.Paint(i, 1); b.Paint(i, 2); rig.Step(10); }
            rig.Net.Crash(host.Transport);
            host.Paused = true;
            rig.Clients.Remove(host.Client);
            rig.Players.Remove(host);
            Assert.True(rig.Until(() => a.Lobby.IsHost && b.Lobby.HostPeerId == 2 && b.Lobby.IsReady, 1200));
            Assert.Equal(new[] { 2 }, a.HostChanges.ToArray());
            Assert.Equal(new[] { 2 }, b.HostChanges.ToArray());
            var t0 = Math.Max(a.Game.Tick, b.Game.Tick);
            a.Paint(9, 9); b.Paint(8, 8);
            Assert.True(rig.Until(() => a.Game.Tick > t0 + 60 && b.Game.Tick > t0 + 60, 2000));
            rig.Step(20);
            Assert.True(Rig.CompareHashes(a, b) > 60);
            Assert.Equal(a.Game.Grid.ToArray(), b.Game.Grid.ToArray());
        }

        [Fact]
        public void MigrationAfterHostLeavesCleanlyToo()
        {
            var (rig, host, a, b) = Trio();
            _ = host.Lobby.StartAsync();
            rig.Step(30);
            _ = host.Lobby.LeaveAsync();
            rig.Players.Remove(host);
            Assert.True(rig.Until(() => a.Lobby.IsHost && b.Lobby.HostPeerId == 2 && b.Lobby.IsReady, 1200));
            var t0 = b.Game.Tick;
            Assert.True(rig.Until(() => b.Game.Tick > t0 + 40, 2000));
            Assert.True(Rig.CompareHashes(a, b) > 30);
        }

        [Fact]
        public void AFloodingPeerIsCappedAt256PendingCommandsAndOthersAreUnaffected()
        {
            var (rig, host, a, b) = Trio();
            var ls = host.Lobby.Lockstep!;
            for (var i = 0; i < 300; i++) ls.QueueRemote(a.Lobby.LocalPeerId, new byte[] { 1, (byte)i });
            Assert.Equal(300 - LockstepSession.MaxPendingPerPeer, ls.DroppedCommands);
            ls.QueueRemote(b.Lobby.LocalPeerId, new byte[] { 2, 0 });   // another peer still gets in
            Assert.Equal(300 - LockstepSession.MaxPendingPerPeer, ls.DroppedCommands);
            host.Paused = true;
            _ = host.Lobby.StartAsync();
            rig.Step(10);
            var got = new List<(int PeerId, ReadOnlyMemory<byte> Command)>();
            while (ls.TryNextFrame(out var f)) got.AddRange(f.Commands);
            Assert.Equal(LockstepSession.MaxPendingPerPeer, got.Count(c => c.PeerId == a.Lobby.LocalPeerId));
            Assert.Equal(1, got.Count(c => c.PeerId == b.Lobby.LocalPeerId));
        }

        [Fact]
        public void SubmitRejectsOversizedCommands()
        {
            var (_, host, _, _) = Trio();
            Assert.Throws<ArgumentException>(() => host.Lobby.Lockstep!.Submit(new byte[LockstepSession.MaxCommandBytes + 1]));
        }
    }
}
