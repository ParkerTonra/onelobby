using System;
using System.Linq;
using OneLobby.Replication;
using Xunit;
using Xunit.Abstractions;

namespace OneLobby.Replication.Tests
{
    /// <summary>The smaller contracts of the layer and of the session additions (twins of the JS net-player-units tests).</summary>
    public class NetPlayerUnitTests
    {
        private readonly ITestOutputHelper _out;
        public NetPlayerUnitTests(ITestOutputHelper output) { _out = output; }

        [Fact]
        public void ABareSessionKeepsTheFixed100MsAndMeasuresJitterAnyway()
        {
            var rig = new Rig(null, 100, 0.03, 40);
            var host = rig.StartHost();
            var a = rig.Join("a");
            host.Session.Spawn(1, 0, new Alien());
            rig.Run(5);
            Assert.False(a.Session.Config.AdaptiveDelay);
            Assert.Equal(100, a.Session.InterpolationDelayMs);
            Assert.True(a.Session.JitterMs > 5);
        }

        [Fact]
        public void TheAdaptiveDelayGrowsWithJitterAndShrinksWhenTheLinkIsCalmInsideItsBounds()
        {
            var calm = Scene.Make(PlayerAuthority.Owner, jitterMs: 0, loss: 0);
            calm.Drive(); calm.Rig.Run(15);
            var rough = Scene.Make(PlayerAuthority.Owner, jitterMs: 80, loss: 0.03);
            rough.Drive(); rough.Rig.Run(15);
            var c = calm.Bl.Session.InterpolationDelayMs;
            var r = rough.Bl.Session.InterpolationDelayMs;
            _out.WriteLine($"adaptive delay: calm link {c:F1} ms, 80 ms jitter {r:F1} ms (bounds 66.7 to 250)");
            Assert.True(c >= 2 * (1000.0 / 30) - 1e-9);
            Assert.True(c < 110);
            Assert.True(r > c + 40);
            Assert.True(r <= 250);
        }

        [Fact]
        public void ASessionWithNoLayerSeesNoPlayerEntityAndAKindFiveMessageIsIgnored()
        {
            var rig = new Rig();
            var host = rig.StartHost();
            var a = rig.Join("a");
            host.Session.Spawn(5, 0, new Alien());
            rig.Run(2);
            Assert.DoesNotContain(a.Session.Entities, e => e.TypeId == PlayerWire.PlayerTypeId);
            var bytes = PlayerWire.EncodePlayerEvents(new[] { new WireEvent((uint)a.PeerId, 1, 1, 1, Array.Empty<byte>()) });
            Assert.Equal(PlayerWire.KindPlayerEvents, bytes[2]);
            a.Lobby.Send(host.PeerId, bytes, Channel.Fast);
            rig.Run(0.5);
            Assert.Equal(0, host.Session.Stats.Malformed);
        }

        [Fact]
        public void TheHostDropsHostOnlyEventsOtherPlayersEventsAndLeftOutEventsAndCountsThem()
        {
            var s = Scene.Make(PlayerAuthority.Owner, omit: new[] { "emote" });
            s.Drive();
            s.Rig.Run(3);
            var seen = 0;
            s.Hl.OnAction += _ => seen++;
            void Send(uint player, byte id, uint seq, byte[]? args = null) =>
                s.A.Lobby.Send(s.Host.PeerId, PlayerWire.EncodePlayerEvents(new[] { new WireEvent(player, seq, id, 1, args ?? Array.Empty<byte>()) }), Channel.Reliable);
            Send((uint)s.A.PeerId, 9, 100, new byte[3]);  // "hit": the host raises that one
            Send((uint)s.B.PeerId, 1, 101);               // "jump" of someone else
            Send((uint)s.A.PeerId, 12, 102, new byte[1]); // "emote" is left out of this game
            Send((uint)s.A.PeerId, 1, 103, new byte[1]);  // a jump with arguments it does not have
            s.Rig.Run(1);
            Assert.Equal(0, seen);
            Assert.Equal(4, s.Hl.Stats.ActionsRejected);
            Assert.Throws<InvalidOperationException>(() => s.Al.Action(PlayerAction.Emote, new ActionArgs { Emote = 1 }));
            Assert.Throws<InvalidOperationException>(() => s.Al.Action(PlayerAction.Hit));
        }

        [Fact]
        public void AMalformedKindFiveMessageIsCountedNeverThrown()
        {
            var s = Scene.Make(PlayerAuthority.Owner);
            s.A.Lobby.Send(s.Host.PeerId, new byte[] { 0x52, 1, 5, 0 }, Channel.Reliable);
            s.Rig.Run(0.5);
            Assert.Equal(1, s.Host.Session.Stats.Malformed);
        }

        [Fact]
        public void ATwoDPlayerTravelsAndIsWatchedWith12BytesOfState()
        {
            var cfg = new ReplicationConfig(AdaptiveDelay: true);
            var rig = new Rig(cfg, 100, 0.03, 20);
            var o = new NetPlayersOptions { Authority = PlayerAuthority.Owner, Space = "2d", Range = 100, VelocityRange = 16 };
            var host = rig.StartHostLayer(o);
            var a = rig.JoinLayer("a", o);
            var b = rig.JoinLayer("b", o);
            a.Layer!.Tick += _ => { var p = Scene.PathAt(rig.NowMs); a.Layer.SetLocalState(new PlayerState { X = p.X, Y = p.Z, Vx = p.Vx, Vy = p.Vz, Yaw = p.Yaw }); };
            rig.Run(5);
            Assert.Equal(12, a.Layer.Codec.StateBytes);
            var v = b.Layer!.Get(a.PeerId)!.Value;
            var truth = Scene.PathAt(rig.NowMs - 400);
            Assert.True(Math.Sqrt(Math.Pow(v.X - truth.X, 2) + Math.Pow(v.Y - truth.Z, 2)) < 1.5);
            Assert.Equal(0, host.Layer!.Latest(a.PeerId)!.Value.Z);
        }

        [Fact]
        public void TheLayerCanBeBuiltFromASessionOrALobby()
        {
            var rig = new Rig();
            var host = rig.StartHost();
            using var layer = new NetPlayers(host.Lobby);
            Assert.IsType<ReplicationSession>(layer.Session);
            Assert.True(layer.Session.Config.AdaptiveDelay);
            using var own = new NetPlayers(host.Session);
            Assert.Same(host.Session, own.Session);
            Assert.False(own.Session.Config.AdaptiveDelay);
        }

        [Fact]
        public void FromConfigReadsSyncPlayerAndTheTickRate()
        {
            var bp = Blueprint.Parse("{\"game\":{\"id\":\"a\"},\"sync\":{\"mode\":\"replication\",\"tickRate\":60,\"player\":{\"authority\":\"host\",\"space\":\"2d\",\"range\":100,\"limits\":{\"maxSpeed\":8},\"omit\":[\"emote\"]}}}");
            var rig = new Rig();
            var host = rig.StartHost();
            using var layer = NetPlayers.FromConfig(host.Lobby, bp);
            Assert.Equal(PlayerAuthority.Host, layer.Authority);
            Assert.Equal("2d", layer.Codec.Config.Space);
            Assert.Equal(100, layer.Codec.Config.Range);
            Assert.Equal(32, layer.Codec.Config.VelocityRange);
            Assert.Equal(new[] { "emote" }, layer.Codec.Config.Omit!.ToArray());
            Assert.Equal(8, layer.Limits.MaxSpeed);
            Assert.Equal(60, layer.Session.Config.TickRate);
            Assert.True(PlayerSection.Omittable.SequenceEqual(PlayerWire.Omittable));
        }

        [Fact]
        public void TheSessionCountsBytesPerPeerAndTheKindFiveHookCountsAsEvents()
        {
            var s = Scene.Make(PlayerAuthority.Owner, loss: 0, jitterMs: 0);
            s.Drive();
            s.Rig.Run(3);
            var up = s.Hl.Session.TrafficWith(s.A.PeerId);
            Assert.True(up.Sent > 1000 && up.Received > 1000);
            Assert.True(up.Sent >= s.Hl.Session.BytesSentTo(s.A.PeerId));
            s.Al.Action(PlayerAction.Jump);
            s.Rig.Run(0.2);
            Assert.True(s.Al.Session.Rates.EventsSent > 0);
        }

        [Fact]
        public void TheLocalStateKeepsTheLayersTeleportCounter()
        {
            var s = Scene.Make(PlayerAuthority.Owner);
            s.Al.SetLocalState(new PlayerState { Teleport = 5 });
            Assert.Equal(0, s.Al.Local!.Value.Teleport);
            s.Al.Teleport(new PlayerState { X = 9 });
            s.Al.SetLocalState(new PlayerState { X = 10, Teleport = 6 });
            Assert.Equal(1, s.Al.Local!.Value.Teleport);
            Assert.Throws<InvalidOperationException>(() => s.Al.SetLocalInput(default));
        }
    }
}
