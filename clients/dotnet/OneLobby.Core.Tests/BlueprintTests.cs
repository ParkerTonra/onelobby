using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Xunit;

namespace OneLobby.Tests
{
    public class BlueprintTests
    {
        private static readonly JsonDocument Vectors = Spec.Load("vectors/blueprint.json");

        public static IEnumerable<object[]> Valid() =>
            Vectors.RootElement.GetProperty("valid").EnumerateArray().Select(v => new object[] { v.GetProperty("name").GetString()! });
        public static IEnumerable<object[]> Invalid() =>
            Vectors.RootElement.GetProperty("invalid").EnumerateArray().Select(v => new object[] { v.GetProperty("name").GetString()! });

        private static JsonElement Vector(string list, string name) =>
            Vectors.RootElement.GetProperty(list).EnumerateArray().First(v => v.GetProperty("name").GetString() == name);

        private static bool Same(JsonElement a, JsonElement b)
        {
            if (a.ValueKind != b.ValueKind)
                return (a.ValueKind == JsonValueKind.True || a.ValueKind == JsonValueKind.False) && false;
            switch (a.ValueKind)
            {
                case JsonValueKind.Object:
                    var ao = a.EnumerateObject().ToDictionary(p => p.Name, p => p.Value);
                    var bo = b.EnumerateObject().ToDictionary(p => p.Name, p => p.Value);
                    return ao.Count == bo.Count && ao.All(kv => bo.TryGetValue(kv.Key, out var o) && Same(kv.Value, o));
                case JsonValueKind.Array:
                    var aa = a.EnumerateArray().ToList(); var ba = b.EnumerateArray().ToList();
                    return aa.Count == ba.Count && aa.Zip(ba, Same).All(x => x);
                case JsonValueKind.String: return a.GetString() == b.GetString();
                case JsonValueKind.Number: return a.GetDouble() == b.GetDouble();
                default: return true; // true/false/null: same kind
            }
        }

        private static JsonElement? Dig(JsonElement root, string dotted)
        {
            var cur = root;
            foreach (var part in dotted.Split('.'))
            {
                if (cur.ValueKind != JsonValueKind.Object || !cur.TryGetProperty(part, out cur)) return null;
            }
            return cur.ValueKind == JsonValueKind.Null ? null : cur;
        }

        [Theory, MemberData(nameof(Valid))]
        public void ValidVectorFillsDefaults(string name)
        {
            var v = Vector("valid", name);
            var bp = Blueprint.Parse(v.GetProperty("input").GetRawText());
            using var filled = JsonDocument.Parse(bp.ToJson());
            foreach (var e in v.GetProperty("expect").EnumerateObject())
            {
                var got = Dig(filled.RootElement, e.Name);
                if (e.Value.ValueKind == JsonValueKind.Null) Assert.Null(got);
                else
                {
                    Assert.True(got.HasValue, name + ": " + e.Name + " is absent");
                    Assert.True(Same(e.Value, got!.Value), name + ": " + e.Name + " expected " + e.Value.GetRawText() + " got " + got.Value.GetRawText());
                }
            }
            // the filled-in file is itself valid and stable
            Assert.Equal(bp, Blueprint.Parse(bp.ToJson()), new RecordComparer());
        }

        // records holding collections compare by reference; compare the canonical JSON instead
        private sealed class RecordComparer : IEqualityComparer<Blueprint>
        {
            public bool Equals(Blueprint? a, Blueprint? b) => a!.ToJson() == b!.ToJson();
            public int GetHashCode(Blueprint o) => o.ToJson().GetHashCode();
        }

        [Theory, MemberData(nameof(Invalid))]
        public void InvalidVectorGivesPathAndRule(string name)
        {
            var v = Vector("invalid", name);
            var ex = Assert.Throws<BlueprintException>(() => Blueprint.Parse(v.GetProperty("input").GetRawText()));
            var want = v.GetProperty("error");
            Assert.Equal(want.GetProperty("path").GetString(), ex.Path);
            Assert.Equal(want.GetProperty("rule").GetString(), ex.Rule);
            Assert.Equal(LobbyErrorCodes.BadConfig, ex.Code);
        }

        [Fact]
        public void SchemaIsEmbeddedAndMatchesTheFile()
        {
            Assert.Equal(System.IO.File.ReadAllText(System.IO.Path.Combine(Spec.Root, "blueprint.schema.json")), Blueprint.SchemaJson);
        }

        [Fact]
        public void NotJsonIsBadConfig()
        {
            var ex = Assert.Throws<BlueprintException>(() => Blueprint.Parse("{nope"));
            Assert.Equal("bad_config", ex.Code);
        }

        // ---- adapters ----------------------------------------------------------------------------------------------

        private const string Full = @"{ ""game"": {""id"":""com.t.g"",""netVersion"":""3""}, ""engine"":""dotnet"",
          ""hosting"": {""direct"":true,""server"":true,""lobbyServer"":""ws://lobby.test/ws"",""directPort"":47811,""openPort"":false,""relayOnly"":true,""allowedOrigins"":[""https://a.test""]},
          ""lobby"": {""maxPlayers"":6,""listed"":true,""lateJoin"":false,""meta"":{""map"":""x""}},
          ""sync"": {""mode"":""lockstep"",""tickRate"":30},
          ""session"": {""readyTimeoutMs"":5000} }";

        [Fact]
        public void ToConfigMapsTheFile()
        {
            var c = Blueprint.Parse(Full).ToConfig("Ann");
            Assert.Equal("com.t.g", c.GameId);
            Assert.Equal("3", c.NetVersion);
            Assert.Equal("ws://lobby.test/ws", c.LobbyServer.AbsoluteUri);
            Assert.Equal(SyncMode.Lockstep, c.Mode);
            Assert.Equal(30, c.TickRate);
            Assert.Equal(30, c.HashEveryTicks);
            Assert.Equal("Ann", c.DisplayName);
            Assert.True(c.RelayOnly);
            Assert.Equal(47811, c.DirectPort);
            Assert.Equal(TimeSpan.FromSeconds(5), c.ReadyTimeout);
        }

        [Fact]
        public void ReplicationMapsToRawAndNoServerGetsThePlaceholder()
        {
            var c = Blueprint.Parse(@"{""game"":{""id"":""a""},""engine"":""unity"",""sync"":{""mode"":""replication""}}").ToConfig();
            Assert.Equal(SyncMode.Raw, c.Mode);
            Assert.Same(Blueprint.NoServer, c.LobbyServer);
        }

        [Fact]
        public void ToLobbyOptionsMapsVisibilityAndDefaults()
        {
            var o = Blueprint.Parse(Full).ToLobbyOptions(null, "Ann");
            Assert.Equal("Ann's game", o.Name);
            Assert.Equal(6, o.MaxPlayers);
            Assert.Equal(Visibility.Public, o.Visibility);
            Assert.False(o.LateJoin);
            Assert.Equal("x", o.Meta!["map"]);
            Assert.Equal("named", Blueprint.Parse(Full).ToLobbyOptions("named").Name);
            var priv = Blueprint.Parse(@"{""game"":{""id"":""a""},""lobby"":{""approveJoins"":true}}").ToLobbyOptions();
            Assert.Equal(Visibility.Private, priv.Visibility);
            Assert.Equal("Player's game", priv.Name);
            Assert.Equal(Visibility.Unlisted, Blueprint.Parse(@"{""game"":{""id"":""a""}}").ToLobbyOptions().Visibility);
        }

        // ---- enforcement -------------------------------------------------------------------------------------------

        private static (Rig rig, LobbyClient client) BlueprintClient(string json, string name = "Ann")
        {
            var rig = new Rig();
            var c = LobbyClient.FromBlueprint(Blueprint.Parse(json), rig.Net.CreateTransport(), name);
            rig.Clients.Add(c);
            return (rig, c);
        }

        private const string Server = @"""hosting"":{""server"":true,""lobbyServer"":""ws://x.test/ws""}";

        [Fact]
        public void HostAsyncUsesTheBlueprint()
        {
            var (rig, c) = BlueprintClient(@"{""game"":{""id"":""a""}," + Server + @",""lobby"":{""maxPlayers"":3,""listed"":true},""sync"":{""mode"":""raw""}}");
            Assert.NotNull(c.Blueprint);
            var lobby = rig.Await(c.HostAsync());
            Assert.Equal(SyncMode.Raw, lobby.Mode);
            Assert.Equal("a", c.Config.GameId);
        }

        [Fact]
        public void HostAndJoinWithoutAServerAreNoServer()
        {
            var (rig, c) = BlueprintClient(@"{""game"":{""id"":""a""}}");
            Assert.Equal(LobbyErrorCodes.NoServer, Assert.Throws<OneLobbyException>(() => rig.Await(c.HostAsync())).Code);
            Assert.Equal(LobbyErrorCodes.NoServer, Assert.Throws<OneLobbyException>(() => rig.Await(c.JoinAsync("C5AFX8"))).Code);
            Assert.Equal(LobbyErrorCodes.ListingDisabled, Assert.Throws<OneLobbyException>(() => rig.Await(c.ListAsync())).Code);   // hosting.server defaults off
        }

        [Fact]
        public void LobbyServerOverrideBeatsTheFile()
        {
            var c = LobbyClient.FromBlueprint(Blueprint.Parse(@"{""game"":{""id"":""a""}," + Server + "}"), new Rig().Net.CreateTransport(), "x", "wss://other.test/ws");
            Assert.Equal("wss://other.test/ws", c.Config.LobbyServer.AbsoluteUri);
        }

        [Fact]
        public void VoiceDisabledThrows()
        {
            var (rig, c) = BlueprintClient(@"{""game"":{""id"":""a""}," + Server + "}");
            var lobby = rig.Await(c.HostAsync());
            var ex = Assert.Throws<OneLobbyException>(() => lobby.Voice.Enabled = true);
            Assert.Equal(LobbyErrorCodes.VoiceDisabled, ex.Code);
            lobby.Voice.Enabled = false; // switching off is always fine
        }

        [Fact]
        public void VoiceEnabledWhenTheFileAllowsIt()
        {
            var (rig, c) = BlueprintClient(@"{""game"":{""id"":""a""}," + Server + @",""chat"":{""voice"":true}}");
            var lobby = rig.Await(c.HostAsync());
            lobby.Voice.Enabled = true;
            Assert.True(lobby.Voice.Enabled);
            lobby.Voice.Enabled = false;
        }

        [Fact]
        public void ChatDisabledThrowsAndEnabledDoesNot()
        {
            var (rig, c) = BlueprintClient(@"{""game"":{""id"":""a""}," + Server + @",""chat"":{""text"":false}}");
            var lobby = rig.Await(c.HostAsync());
            Assert.Equal(LobbyErrorCodes.ChatDisabled, Assert.Throws<OneLobbyException>(() => lobby.Chat.Send("hi")).Code);
            var (rig2, c2) = BlueprintClient(@"{""game"":{""id"":""a""}," + Server + "}");
            rig2.Await(c2.HostAsync()).Chat.Send("hi");
        }

        [Fact]
        public void ListingDisabledWithoutAServer()
        {
            var (rig, c) = BlueprintClient(@"{""game"":{""id"":""a""}}");
            var ex = Assert.Throws<OneLobbyException>(() => rig.Await(c.ListAsync()));
            Assert.Equal(LobbyErrorCodes.ListingDisabled, ex.Code);
        }

        [Fact]
        public void AnonymousIdentityRefusesANameAndLongNamesAreBadConfig()
        {
            var anon = Blueprint.Parse(@"{""game"":{""id"":""a""},""players"":{""identity"":""anonymous""}}");
            var t = new Rig().Net.CreateTransport();
            Assert.Equal(LobbyErrorCodes.IdentityAnonymous, Assert.Throws<OneLobbyException>(() => LobbyClient.FromBlueprint(anon, t, "Ann")).Code);
            LobbyClient.FromBlueprint(anon, t, ""); // no name is fine
            var short5 = Blueprint.Parse(@"{""game"":{""id"":""a""},""players"":{""maxNameLength"":5}}");
            var ex = Assert.Throws<BlueprintException>(() => LobbyClient.FromBlueprint(short5, t, "Annabelle"));
            Assert.Equal("bad_config", ex.Code);
            Assert.Equal("displayName", ex.Path);
            LobbyClient.FromBlueprint(short5, t, "Ann");
        }

        [Fact]
        public void PlainClientsAreUnchanged()
        {
            var rig = new Rig();
            var c = rig.NewClient("h", SyncMode.Raw);
            Assert.Null(c.Blueprint);
            var lobby = rig.Await(c.HostAsync(new LobbyOptions("x", 4)));
            lobby.Chat.Send("hi");
            lobby.Voice.Enabled = true;
            lobby.Voice.Enabled = false;
            Assert.Throws<InvalidOperationException>(() => rig.Await(c.HostAsync()));
        }
    }
}
