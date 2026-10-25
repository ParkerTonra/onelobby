using System.Collections.Generic;
using System.Linq;
using System.Text;
using Xunit;

namespace OneLobby.Tests
{
    public class NetSimTests
    {
        [Fact]
        public void AddsLatencyJitterAndFastLossButKeepsReliableOrderedAndWhole()
        {
            var rig = new Rig();
            rig.Net.LatencyMs = 10;
            var h = rig.Await(rig.NewClient("h", SyncMode.Raw).HostAsync(new LobbyOptions("sim", 4)));
            var sim = new NetSimTransport(rig.Net.CreateTransport(), new NetSimOptions(LatencyMs: 100, JitterMs: 30, LossPercent: 25, Seed: 7));
            var gc = new LobbyClient(Rig.Config("g", mode: SyncMode.Raw), sim);
            rig.Clients.Add(gc);
            var g = rig.Await(gc.JoinAsync(h.Code));
            Assert.True(rig.Until(() => g.ReadyAsync.IsCompleted));
            Assert.True(g.IsReady);

            var reliable = new List<string>();
            var fast = 0;
            h.MessageReceived += (_, p, ch) => { if (ch == Channel.Reliable) reliable.Add(Encoding.UTF8.GetString(p.Span)); else fast++; };
            for (var i = 0; i < 400; i++)
            {
                g.Send(h.LocalPeerId, Encoding.UTF8.GetBytes("r" + i));
                g.Send(h.LocalPeerId, Encoding.UTF8.GetBytes("f" + i), Channel.Fast);
                if (i % 4 == 0) rig.Step();
            }
            rig.Step(80);
            Assert.Equal(Enumerable.Range(0, 400).Select(i => "r" + i), reliable);
            Assert.InRange(fast, 400 * 0.65, 400 * 0.85);                // 25% one way

            var rtt = g.PingMs(h.LocalPeerId);
            Assert.InRange(rtt, 20 + 100, 20 + 100 + 60 + 50);             // base 2x10, +100 added, jitter both ways, pump steps

            sim.Options = new NetSimOptions();                             // switched off at run time
            rig.Step(120);
            Assert.InRange(g.PingMs(h.LocalPeerId), 0, 20 + 50);
        }
    }
}
