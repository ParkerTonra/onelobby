using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace OneLobby.Tests
{
    /// <summary>The player settings (spec/settings.md) against spec/vectors/settings.json, then applied by the client on the in-memory network.</summary>
    public class SettingsTests
    {
        private const string Game = "com.you.game";
        private const string RigGame = "gridpaint";

        private static IKeyValueStore StoreWith(string? text, string game = Game)
        {
            var s = KeyValueStores.Memory();
            if (text != null) s.SetItem(PlayerSettings.Key(game), text);
            return s;
        }

        private static string Raw(JsonElement e) => e.ValueKind == JsonValueKind.Null ? null! : e.ValueKind == JsonValueKind.String ? e.GetString()! : e.GetRawText();

        private static Func<string, string?> EnvOf(JsonElement map)
        {
            var d = map.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString());
            return n => d.TryGetValue(n, out var v) ? v : null;
        }

        private static void AssertValues(JsonElement expected, SettingsValues got, string what)
        {
            Assert.True(expected.GetProperty("name").GetString() == got.Name, what + " name");
            Assert.True(expected.GetProperty("relay").GetString() == got.Relay, what + " relay");
            Assert.True(expected.GetProperty("lastCode").GetString() == got.LastCode, what + " lastCode");
            Assert.True(expected.GetProperty("server").GetString() == got.Server, what + " server");
        }

        [Fact]
        public void The_key_and_the_variable_names_match_the_vectors()
        {
            using var doc = Spec.Load("vectors/settings.json");
            foreach (var k in doc.RootElement.GetProperty("key").EnumerateArray())
                Assert.Equal(k.GetProperty("key").GetString(), PlayerSettings.Key(k.GetProperty("gameId").GetString()!));
            foreach (var p in doc.RootElement.GetProperty("envNames").EnumerateObject())
                Assert.Equal(p.Value.GetString(), SettingsRules.EnvNames[p.Name]);
            Assert.Equal("<hidden>", doc.RootElement.GetProperty("hidden").GetString());
            Assert.Equal("<hidden>", SettingsRules.Hidden);
        }

        [Fact]
        public void Clean_matches_every_vector()
        {
            using var doc = Spec.Load("vectors/settings.json");
            var clean = doc.RootElement.GetProperty("clean");
            foreach (var field in new[] { "name", "relay", "lastCode", "server" })
            {
                var cases = clean.GetProperty(field).EnumerateArray().ToList();
                Assert.True(cases.Count > 4, field);
                foreach (var c in cases)
                {
                    var input = c.GetProperty("input").GetString();
                    var got = SettingsRules.Clean(field, input);
                    if (c.TryGetProperty("invalid", out _)) Assert.True(got == null, field + " " + input + " should be invalid, got " + got);
                    else Assert.True(c.GetProperty("ok").GetString() == got, field + " " + input + " -> " + got);
                }
            }
        }

        [Fact]
        public void MaskRelay_matches_every_vector()
        {
            using var doc = Spec.Load("vectors/settings.json");
            foreach (var c in doc.RootElement.GetProperty("mask").EnumerateArray())
                Assert.Equal(c.GetProperty("masked").GetString(), SettingsRules.MaskRelay(c.GetProperty("relay").GetString()));
        }

        [Fact]
        public void Load_reads_corrupt_and_odd_values_as_no_settings()
        {
            using var doc = Spec.Load("vectors/settings.json");
            foreach (var c in doc.RootElement.GetProperty("load").EnumerateArray())
            {
                var stored = c.GetProperty("stored");
                var s = new PlayerSettings(StoreWith(stored.ValueKind == JsonValueKind.Null ? null : stored.GetString()), Game, PlayerSettings.NoEnvironment);
                AssertValues(c.GetProperty("values"), s.Load(), c.GetProperty("name").GetString()!);
            }
        }

        [Fact]
        public void Save_keeps_unknown_fields_rejects_bad_ones_and_replaces_a_corrupt_value()
        {
            using var doc = Spec.Load("vectors/settings.json");
            foreach (var c in doc.RootElement.GetProperty("save").EnumerateArray())
            {
                var what = c.GetProperty("name").GetString()!;
                var stored = c.GetProperty("stored");
                var store = StoreWith(stored.ValueKind == JsonValueKind.Null ? null : stored.GetString());
                var s = new PlayerSettings(store, Game, PlayerSettings.NoEnvironment);
                string? P(string f) => c.GetProperty("patch").TryGetProperty(f, out var v) ? v.GetString() : null;
                var r = s.Save(P("name"), P("relay"), P("lastCode"), P("server"));
                var expectRejected = c.GetProperty("rejected").EnumerateArray().Select(x => x.GetString()!).ToArray();
                Assert.True(expectRejected.SequenceEqual(r.Rejected), what + " rejected");
                Assert.Equal(expectRejected.Length == 0, r.Ok);
                var back = store.GetItem(PlayerSettings.Key(Game))!;
                Assert.True(JsonEq(JsonDocument.Parse(back).RootElement, c.GetProperty("result")), what + ": " + back);
            }
        }

        private static bool JsonEq(JsonElement a, JsonElement b)
        {
            if (a.ValueKind != b.ValueKind) return false;
            switch (a.ValueKind)
            {
                case JsonValueKind.Object:
                    var pa = a.EnumerateObject().ToDictionary(p => p.Name, p => p.Value);
                    var pb = b.EnumerateObject().ToDictionary(p => p.Name, p => p.Value);
                    return pa.Count == pb.Count && pa.All(kv => pb.TryGetValue(kv.Key, out var o) && JsonEq(kv.Value, o));
                case JsonValueKind.Array:
                    var la = a.EnumerateArray().ToList();
                    var lb = b.EnumerateArray().ToList();
                    return la.Count == lb.Count && la.Zip(lb, JsonEq).All(x => x);
                default: return a.GetRawText() == b.GetRawText();
            }
        }

        [Fact]
        public void Env_wins_for_the_run_and_is_never_written_back()
        {
            using var doc = Spec.Load("vectors/settings.json");
            foreach (var c in doc.RootElement.GetProperty("env").EnumerateArray())
            {
                var what = c.GetProperty("name").GetString()!;
                var store = StoreWith(c.GetProperty("stored").GetRawText());
                var before = store.GetItem(PlayerSettings.Key(Game));
                var s = new PlayerSettings(store, Game, EnvOf(c.GetProperty("env")));
                AssertValues(c.GetProperty("effective"), s.Effective(), what);
                Assert.Equal(before, store.GetItem(PlayerSettings.Key(Game)));
                s.Save(lastCode: "7HQ4K2");
                Assert.DoesNotContain("Ann", store.GetItem(PlayerSettings.Key(Game))!);
            }
        }

        [Fact]
        public void A_store_that_throws_is_no_error_the_settings_last_for_the_session()
        {
            var s = new PlayerSettings(new BrokenStore(), Game, PlayerSettings.NoEnvironment);
            Assert.Equal("", s.Load().Name);
            Assert.True(s.Save(name: "Sam").Ok);
            Assert.Equal("Sam", s.Load().Name);
            s.Clear();
        }

        private sealed class BrokenStore : IKeyValueStore
        {
            public string? GetItem(string key) => throw new IOException("blocked");
            public void SetItem(string key, string value) => throw new IOException("quota");
            public void RemoveItem(string key) => throw new IOException("blocked");
        }

        [Fact]
        public void A_settings_file_keeps_the_values_and_shares_the_entry_format_of_the_other_stores()
        {
            var path = Path.Combine(Path.GetTempPath(), "onelobby-settings-" + Guid.NewGuid().ToString("N") + ".json");
            try
            {
                new PlayerSettings(KeyValueStores.FromFile(path), Game, PlayerSettings.NoEnvironment).Save(name: "Sam", lastCode: "7hq 4k2");
                var again = new PlayerSettings(KeyValueStores.FromFile(path), Game, PlayerSettings.NoEnvironment).Load();
                Assert.Equal("Sam", again.Name);
                Assert.Equal("7HQ4K2", again.LastCode);
            }
            finally { File.Delete(path); }
        }

        // ---- applied by the client (in-memory network) --------------------------------------------------------------------

        private const string Relay = "turn:relay.example.com:3478 samuser sampass77";

        private static OneLobbyConfig Cfg(string name, IKeyValueStore? store, Func<string, string?>? env = null, SettingsOptions? use = null) =>
            Rig.Config(name, mode: SyncMode.Raw) with
            {
                SettingsStore = store,
                SettingsEnv = env ?? PlayerSettings.NoEnvironment,
                Settings = use,
            };

        private static (Rig rig, List<PeerLinkOptions> links) RigWithRelaySpy()
        {
            var rig = new Rig();
            var links = new List<PeerLinkOptions>();
            rig.Net.IceServers.Add(new IceServer(new[] { "stun:stun.example:3478" }));
            rig.Net.CanConnect = (a, b) => { links.Add(a); links.Add(b); return true; };
            return (rig, links);
        }

        private static void Leave(Rig rig, Lobby lobby)
        {
            var t = lobby.LeaveAsync();
            rig.Until(() => t.IsCompleted, 600);
        }

        private static OneLobbyException Fails(Rig rig, System.Threading.Tasks.Task task)
        {
            rig.Until(() => task.IsCompleted, 600);
            try { task.GetAwaiter().GetResult(); }
            catch (OneLobbyException e) { return e; }
            throw new Xunit.Sdk.XunitException("the call did not fail");
        }

        private static LobbyClient Client(Rig rig, OneLobbyConfig cfg)
        {
            var c = new LobbyClient(cfg, rig.Net.CreateTransport());
            rig.Clients.Add(c);
            return c;
        }

        [Fact]
        public void A_joiners_name_relay_entry_and_server_come_from_the_saved_settings()
        {
            var (rig, links) = RigWithRelaySpy();
            var host = rig.Await(Client(rig, Cfg("alice", null, use: SettingsOptions.None)).HostAsync(new LobbyOptions("t", 4)));
            var store = StoreWith("{\"v\":1,\"name\":\"Sam\",\"relay\":\"" + Relay + "\",\"server\":\"wss://lobby.mygame.test/ws\"}", RigGame);
            var cfg = Cfg("", store) with { LobbyServer = OneLobby.Blueprint.NoServer };
            var joinerClient = Client(rig, cfg);
            Assert.Equal(new Uri("wss://lobby.mygame.test/ws"), joinerClient.HubUri);
            var lobby = rig.Await(joinerClient.JoinAsync(host.Code));
            Assert.True(rig.Until(() => lobby.IsReady));
            Assert.Equal("Sam", host.Peers.First(p => p.PeerId == lobby.LocalPeerId).Name);
            Assert.Equal("Sam", joinerClient.Config.DisplayName);
            // the hub's list first, then this player's entry
            var mine = links.First(l => l.IceServers.Any(e => e.Username == "samuser"));
            Assert.Equal(2, mine.IceServers.Count);
            Assert.Equal("stun:stun.example:3478", mine.IceServers[0].Urls[0]);
            Assert.Equal(new[] { "turn:relay.example.com:3478" }, mine.IceServers[1].Urls.ToArray());
            Assert.Equal("samuser", mine.IceServers[1].Username);
            Assert.Equal("sampass77", mine.IceServers[1].Credential);
            // only this player's own link options carry it: the host's side has the hub's list alone
            Assert.Single(links, l => l.IceServers.Any(e => e.Username == "samuser"));
            Assert.Equal(host.Code, joinerClient.Settings.Load().LastCode);
        }

        [Fact]
        public void An_explicit_value_beats_the_saved_one_and_a_default_can_be_switched_off()
        {
            var (rig, links) = RigWithRelaySpy();
            var host = rig.Await(Client(rig, Cfg("alice", null, use: SettingsOptions.None)).HostAsync(new LobbyOptions("t", 4)));
            var json = "{\"v\":1,\"name\":\"Sam\",\"relay\":\"" + Relay + "\",\"server\":\"wss://lobby.mygame.test/ws\"}";

            var explicitClient = Client(rig, Cfg("Zed", StoreWith(json, RigGame)));
            var l1 = rig.Await(explicitClient.JoinAsync(host.Code));
            Assert.True(rig.Until(() => l1.IsReady));
            Assert.Equal("Zed", host.Peers.First(p => p.PeerId == l1.LocalPeerId).Name);
            Assert.Equal(new Uri("ws://mem/ws"), explicitClient.HubUri);
            Leave(rig, l1);

            var withRelay = links.Count(l => l.IceServers.Any(e => e.Username == "samuser"));
            Assert.True(withRelay > 0); // the explicit name did not switch the relay default off
            var off = Client(rig, Cfg("", StoreWith(json, RigGame), use: new SettingsOptions { Name = false, Relay = false }));
            var l2 = rig.Await(off.JoinAsync(host.Code));
            Assert.True(rig.Until(() => l2.IsReady));
            Assert.Equal("", off.Config.DisplayName);
            Assert.Equal(withRelay, links.Count(l => l.IceServers.Any(e => e.Username == "samuser"))); // no new entry
            Assert.Equal(host.Code, off.Settings.Load().LastCode); // lastCode was left on
            Leave(rig, l2);

            var none = Client(rig, Cfg("", StoreWith(json, RigGame), use: SettingsOptions.None));
            rig.Await(none.JoinAsync(host.Code));
            Assert.Equal("", none.Settings.Load().LastCode);
        }

        [Fact]
        public void The_default_Player_name_counts_as_none_and_the_environment_wins_without_being_written()
        {
            var rig = new Rig();
            var store = StoreWith("{\"v\":1,\"name\":\"Sam\",\"theme\":\"dark\"}", RigGame);
            var env = new Dictionary<string, string> { ["ONELOBBY_NAME"] = "Ann" };
            var c = Client(rig, Cfg("Player", store, n => env.TryGetValue(n, out var v) ? v : null));
            Assert.Equal("Ann", c.Config.DisplayName);
            var lobby = rig.Await(c.HostAsync(new LobbyOptions("t", 4)));
            Assert.Equal("Ann", lobby.Peers.First(p => p.PeerId == lobby.LocalPeerId).Name);
            var stored = store.GetItem(PlayerSettings.Key(RigGame))!;
            Assert.Contains("\"theme\":\"dark\"", stored);
            Assert.Contains("\"lastCode\":\"" + lobby.Code + "\"", stored);
            Assert.DoesNotContain("Ann", stored);
            Assert.Equal("Sam", c.Settings.Load().Name);
        }

        [Fact]
        public void No_server_is_raised_only_when_the_call_the_file_and_the_settings_all_give_none()
        {
            var rig = new Rig();
            var c = Client(rig, Cfg("p", StoreWith(null, RigGame)) with { LobbyServer = OneLobby.Blueprint.NoServer });
            Assert.Equal(LobbyErrorCodes.NoServer, Fails(rig, c.HostAsync(new LobbyOptions("t", 4))).Code);
            var d = Client(rig, Cfg("p", StoreWith("{\"server\":\"lobby.mygame.test\"}", RigGame)) with { LobbyServer = OneLobby.Blueprint.NoServer });
            Assert.Equal(new Uri("wss://lobby.mygame.test"), d.HubUri);
            rig.Await(d.HostAsync(new LobbyOptions("t", 4)));
        }

        [Fact]
        public void An_invalid_saved_relay_line_is_skipped_with_one_plain_warning_that_does_not_print_it()
        {
            var (rig, links) = RigWithRelaySpy();
            var host = rig.Await(Client(rig, Cfg("alice", null, use: SettingsOptions.None)).HostAsync(new LobbyOptions("t", 4)));
            var c = Client(rig, Cfg("bob", StoreWith("{\"v\":1,\"relay\":\"samuser sampass77\"}", RigGame)));
            var warnings = new List<string>();
            c.Warning += w => warnings.Add(w);
            for (var i = 0; i < 2; i++)
            {
                var l = rig.Await(c.JoinAsync(host.Code));
                Assert.True(rig.Until(() => l.IsReady));
                Leave(rig, l);
            }
            Assert.Equal(new[] { "The saved relay line is not valid, so it is not used." }, warnings.ToArray());
            Assert.All(links, l => Assert.Single(l.IceServers));
        }

        [Fact]
        public void A_saved_relay_line_shows_in_no_error_warning_or_console_output()
        {
            var (rig, _) = RigWithRelaySpy();
            var host = rig.Await(Client(rig, Cfg("alice", null, use: SettingsOptions.None)).HostAsync(new LobbyOptions("t", 4)));
            var c = Client(rig, Cfg("bob", StoreWith("{\"v\":1,\"relay\":\"" + Relay + "\",\"server\":\"wss://sam:pwserver9@lobby.mygame.test/ws?token=tok12345\"}", RigGame)) with { LobbyServer = OneLobby.Blueprint.NoServer });
            var seen = new List<string>();
            c.Error += e => seen.Add(e.Code + " " + e.Message);
            c.Warning += w => seen.Add(w);
            var oldOut = Console.Out;
            var oldErr = Console.Error;
            var sw = new StringWriter();
            Console.SetOut(sw);
            Console.SetError(sw);
            try
            {
                seen.Add(Fails(rig, c.JoinAsync("ZZZZZZ")).Message);
                var l = rig.Await(c.JoinAsync(host.Code));
                Assert.True(rig.Until(() => l.IsReady));
                Leave(rig, l);
            }
            finally { Console.SetOut(oldOut); Console.SetError(oldErr); }
            var all = string.Join("\n", seen) + "\n" + sw;
            foreach (var secret in new[] { "samuser", "sampass77", "pwserver9", "tok12345" }) Assert.DoesNotContain(secret, all);
            Assert.Equal("wss://lobby.mygame.test/ws?token=tok12345", SettingsRules.RedactUrl("wss://sam:pwserver9@lobby.mygame.test/ws?token=tok12345").Replace("wss://sam:pwserver9@", "wss://"));
            Assert.DoesNotContain("pwserver9", SettingsRules.RedactUrl("wss://sam:pwserver9@lobby.mygame.test/ws"));
        }
    }
}
