using System;
using OneLobby.Replication;
using Xunit;
using Xunit.Abstractions;

namespace OneLobby.Replication.Tests
{
    /// <summary>
    /// A second networked-player layer on a lobby that is already playing: a session made again on the same lobby holds no snapshot
    /// and sends ack 0; the host then sends it a full snapshot at once (spec/replication.md "Resync"). In-memory rig, no socket.
    /// </summary>
    public class NetPlayerLateLayerTests
    {
        private readonly ITestOutputHelper _out;
        public NetPlayerLateLayerTests(ITestOutputHelper output) { _out = output; }

        [Theory]
        [InlineData(PlayerAuthority.Owner)]
        [InlineData(PlayerAuthority.Host)]
        public void ASecondLayerOnAPlayingLobbySeesTheOtherPlayers(PlayerAuthority mode)
        {
            var s = Scene.Make(mode);
            s.Drive(s.Al);
            s.Rig.Run(4); // the lobby is playing: B holds snapshots, the host has B's ack
            Assert.NotNull(s.Bl.Get(s.A.PeerId));
            Assert.True(s.Host.Session.AckedTick(s.B.PeerId) > 0);

            // B's layer and session are made again (a scene reload): a new session on the same lobby holds no snapshot
            s.Bl.Dispose();
            s.B.Session.Dispose();
            s.B.Attach(s.Rig.Config);
            var options = new NetPlayersOptions { Authority = mode, Step = Scene.WalkStep };
            var layer = new NetPlayers(s.B.Session, options);
            s.B.Layer = layer;
            Assert.Null(layer.Get(s.A.PeerId));
            // B plays on in its new layer (a layer with nothing to send is silent until its first snapshot: see spec/net-player.md section 13)
            if (mode == PlayerAuthority.Owner) layer.Tick += _ => layer.SetLocalState(Scene.PathAt(s.Rig.NowMs, 1));
            else layer.Tick += _ => layer.SetLocalInput(new NetPlayerInput { MoveX = 0.5, MoveY = 0.5, Yaw = 90 });

            var t0 = s.Rig.NowMs;
            long seen = -1;
            for (var i = 0; i < 400 && seen < 0; i++)
            {
                s.Rig.Step();
                if (layer.Get(s.A.PeerId) != null) seen = s.Rig.NowMs - t0;
            }
            var ticks = seen / s.Host.Session.Clock.TickMs;
            _out.WriteLine($"late layer ({mode}): sees the other players after {seen} ms ({ticks:F1} ticks)");
            if (mode == PlayerAuthority.Owner) Assert.True(seen >= 0 && ticks <= 24, $"ticks until the second layer sees A, render delay included: {ticks:F1}");
            else Assert.InRange(seen, 0, 5999); // the host-authority layer sends no input before its first snapshot, so the ack 0 rule cannot help it (documented limit)
        }
    }
}
