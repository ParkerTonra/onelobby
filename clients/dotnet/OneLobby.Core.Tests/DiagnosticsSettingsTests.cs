using System;
using System.Text.RegularExpressions;
using Xunit;

namespace OneLobby.Tests
{
    public class DiagnosticsSettingsTests
    {
        [Fact]
        public void TheNetLogNeverHoldsTheSavedRelayOrTheServerLogin()
        {
            var rig = new Rig();
            var cfg = Rig.Config("Sam") with
            {
                LobbyServer = new Uri("ws://alice:pass@mem/ws?token=abc"),
                SettingsStore = KeyValueStores.Memory(),
                SettingsEnv = PlayerSettings.NoEnvironment,
            };
            var c = new LobbyClient(cfg, rig.Net.CreateTransport());
            rig.Clients.Add(c);
            Assert.True(c.Settings.Save(relay: "turn:127.0.0.1:3478 alice s3cret").Ok);
            var lobby = rig.Await(c.HostAsync(new LobbyOptions("room", 2)));
            rig.Step(10);
            foreach (var text in new[] { c.NetLog.Export(), c.NetLog.Export(includeAddresses: true) })
                foreach (var secret in new[] { "alice", "s3cret", "pass", "abc" })
                    Assert.DoesNotContain(secret, text);
            Assert.Contains("open route=server", c.NetLog.Export());
            _ = lobby;
        }
    }
}
