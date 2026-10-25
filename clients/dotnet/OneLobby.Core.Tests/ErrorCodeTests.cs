using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using Xunit;

namespace OneLobby.Tests
{
    public class ErrorCodeTests
    {
        private static string[] Codes() => typeof(LobbyErrorCodes).GetFields(BindingFlags.Public | BindingFlags.Static)
            .Select(f => (string)f.GetRawConstantValue()!).ToArray();

        private static string Repo()
        {
            var d = new DirectoryInfo(AppContext.BaseDirectory);
            while (d != null && !File.Exists(Path.Combine(d.FullName, "AGENTS.md"))) d = d.Parent;
            return d?.FullName ?? throw new InvalidOperationException("repo root not found");
        }

        [Fact]
        public void EveryCodeTheHubsSendIsAConstant()
        {
            var codes = Codes();
            Assert.Equal(codes.Length, codes.Distinct().Count());
            var root = Repo();
            foreach (var file in new[] { "server/OneLobby.Hub/Hub.cs", "clients/dotnet/OneLobby.Core/InMemoryNetwork.cs" })
            {
                var src = File.ReadAllText(Path.Combine(root, file));
                foreach (Match m in Regex.Matches(src, @"\bError\(\w+, ""([a-z_]+)"""))
                    Assert.Contains(m.Groups[1].Value, codes);
            }
            foreach (var dir in new[] { "clients/dotnet/OneLobby.Core", "clients/dotnet/OneLobby.Direct" })
                foreach (var f in Directory.GetFiles(Path.Combine(root, dir), "*.cs"))
                    foreach (Match m in Regex.Matches(File.ReadAllText(f), @"new OneLobbyException\(""([a-z_]+)"""))
                        Assert.Contains(m.Groups[1].Value, codes);
        }

        [Fact]
        public void LobbyFullAndVersionMismatchArriveAsTheConstants()
        {
            var rig = new Rig();
            var hc = rig.NewClient("h", SyncMode.Raw);
            var h = rig.Await(hc.HostAsync(new LobbyOptions("two", 2)));
            rig.Await(rig.NewClient("a", SyncMode.Raw).JoinAsync(h.Code));
            var full = Assert.Throws<OneLobbyException>(() => rig.Await(rig.NewClient("b", SyncMode.Raw).JoinAsync(h.Code)));
            Assert.Equal(LobbyErrorCodes.LobbyFull, full.Code);
            Assert.Equal("lobby_full", LobbyErrorCodes.LobbyFull);

            var other = new LobbyClient(Rig.Config("c", mode: SyncMode.Raw) with { NetVersion = "2" }, rig.Net.CreateTransport());
            rig.Clients.Add(other);
            var h2 = rig.Await(rig.NewClient("h2", SyncMode.Raw).HostAsync(new LobbyOptions("v1", 4)));
            var ver = Assert.Throws<OneLobbyException>(() => rig.Await(other.JoinAsync(h2.Code)));
            Assert.Equal(LobbyErrorCodes.VersionMismatch, ver.Code);
            Assert.Equal("version_mismatch", LobbyErrorCodes.VersionMismatch);
        }
    }
}
