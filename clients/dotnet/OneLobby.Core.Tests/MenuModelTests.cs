using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Xunit;

namespace OneLobby.Tests
{
    /// <summary>
    /// The drop-in menu's model (MenuModel) driven with no engine, on the in-memory network: host, a second player joins by code,
    /// roster, ready, start with the countdown, back to lobby, kick with a reason, ban and a refused rejoin, unban, wrong password,
    /// a bad code, an old host, saved name and last code as defaults, the relay line never being shown, the Copy invite sentence and
    /// the pasted-sentence parser. The same cases as the GDScript menu's tests/menu.gd (which uses real peers on 127.0.0.1).
    /// </summary>
    [Collection("menu text")]
    public class MenuModelTests
    {
        private const string Relay = "turn:127.0.0.1:9 samuser sampass77";

        private sealed class P
        {
            public RoomRig.Kit Kit = null!;
            public MenuModel M = null!;
            public readonly List<string> Copied = new();
            public int Started, Back, Left;
            public LobbyClient Client => Kit.Client;
            public Lobby L => M.Lobby!;
        }

        private sealed class World
        {
            public readonly RoomRig Rig = new();

            public P New(string? name = null, P? from = null, Func<OneLobbyConfig, OneLobbyConfig>? tweak = null, bool hostOpts = true)
            {
                var p = new P();
                p.Kit = Rig.NewKit(name ?? "p", from: from?.Kit, tweak: c => (tweak ?? (x => x))(c with { DisplayName = "", SettingsEnv = PlayerSettings.NoEnvironment }));
                Wire(p);
                if (hostOpts) p.M.HostOptions = new LobbyOptions("menu", 4) { Room = new RoomOptions { CountdownSeconds = 1 } };
                return p;
            }

            public P FromBlueprint(string json)
            {
                var p = new P();
                var c = LobbyClient.FromBlueprint(Blueprint.Parse(json), Rig.Net.CreateTransport(), "", configure: cfg => cfg with { SettingsEnv = PlayerSettings.NoEnvironment });
                Rig.R.Clients.Add(c);
                p.Kit = new RoomRig.Kit { Client = c };
                Wire(p);
                return p;
            }

            private static void Wire(P p)
            {
                p.M = new MenuModel(p.Kit.Client) { Clipboard = t => p.Copied.Add(t) };
                p.M.GameStarted += _ => p.Started++;
                p.M.ReturnedToLobby += _ => p.Back++;
                p.M.Left += () => p.Left++;
            }

            /// <summary>Runs simulated time until the task completes.</summary>
            public void Run(Task t)
            {
                Rig.R.Until(() => t.IsCompleted, 800);
                Assert.True(t.IsCompleted, "the call did not finish");
                t.GetAwaiter().GetResult();
            }

            public bool Until(Func<bool> cond, int steps = 1200) => Rig.R.Until(cond, steps);
            public void Wait(int ms) => Rig.Wait(ms);

            public P Hosting(string name, Func<OneLobbyConfig, OneLobbyConfig>? tweak = null, LobbyOptions? options = null)
            {
                var h = New(name, tweak: tweak);
                if (options != null) h.M.HostOptions = options;
                h.M.SetName(name);
                Run(h.M.HostAsync());
                return h;
            }

            public P Guest(P host, string name, string password = "", P? from = null)
            {
                var g = New(name, from: from);
                g.M.SetName(name);
                g.M.SetJoinText(host.M.CodeText().ToLowerInvariant());
                g.M.SetPassword(password);
                Run(g.M.JoinAsync());
                return g;
            }
        }

        private static List<string> Names(P p) => p.M.RosterRows().Select(r => r.Name).ToList();
        private static MenuRosterRow? Row(P p, string who) => p.M.RosterRows().FirstOrDefault(r => r.Name == who);
        private static bool In(P p) => p.M.Screen == MenuScreen.Lobby && p.M.RoomActive && p.M.Lobby!.Room.Me != null;

        // ---- parsing, text and defaults ---------------------------------------------------------------------------------------

        [Fact]
        public void ACodeIsCleanedAsTypedAndParsedFromCodesAddressesAndLinks()
        {
            Assert.Equal("7HQ-4K2 ", MenuModel.CleanJoinText("7hq-4k2 !!"));
            Assert.Equal("127.0.0.1:47810", MenuModel.CleanJoinText("127.0.0.1:47810"));
            Assert.Equal("https://g.example/?join=7hq4k2", MenuModel.CleanJoinText("https://g.example/?join=7hq4k2"));
            Assert.Equal(new MenuJoinParse(MenuJoinKind.Lobby, "7HQ4K2"), MenuModel.ParseJoin("7hq 4k2"));
            Assert.Equal(new MenuJoinParse(MenuJoinKind.Lobby, "7HQ4K2"), MenuModel.ParseJoin("https://g.example/play?join=7HQ-4K2"));
            Assert.Equal(MenuJoinKind.Address, MenuModel.ParseJoin("192.168.1.20:47810").Kind);
            Assert.Equal(MenuJoinKind.Address, MenuModel.ParseJoin("192.168.1.20").Kind);
            Assert.Equal(MenuJoinKind.Direct, MenuModel.ParseJoin(JoinCode.Encode("10.1.2.3", 47810)).Kind);
            Assert.Equal(MenuJoinKind.None, MenuModel.ParseJoin("hello").Kind);
            Assert.Equal(MenuJoinKind.None, MenuModel.ParseJoin("").Kind);
            Assert.Equal(MenuJoinKind.None, MenuModel.ParseJoin(null).Kind);
        }

        [Fact]
        public void APastedInviteSentenceYieldsItsCodeNeverTheGameTitle()
        {
            var code = new MenuJoinParse(MenuJoinKind.Lobby, "7HQ4K2");
            Assert.Equal(code, MenuModel.ParseJoin("Join my game in Fortress: code 7HQ 4K2")); // "Fortress" is eight valid code letters
            Assert.Equal(code, MenuModel.ParseJoin("Join my game in Castle: code 7HQ-4K2"));    // "Castle" is a whole valid lobby code
            Assert.Equal(code, MenuModel.ParseJoin("Join my game: code 7HQ-4K2"));
            Assert.Equal(code, MenuModel.ParseJoin("Join my game: code 7HQ 4K2."));              // a trailing full stop
            Assert.Equal(code, MenuModel.ParseJoin("\"Join my game in Fortress: code 7HQ-4K2\""));
            Assert.Equal(code, MenuModel.ParseJoin("code '7HQ-4K2'!"));
            Assert.Equal(code, MenuModel.ParseJoin("Join my game in Fortress: code 7HQ 4K2 https://g.example/play?join=7HQ-4K2"));
            Assert.Equal(code, MenuModel.ParseJoin("Come play Fortress 7HQ-4K2"));              // reworded, no marker: scanned from the end
            Assert.Equal(code, MenuModel.ParseJoin("Rejoins ma partie Castle : 7HQ 4K2"));
            Assert.Equal(MenuJoinKind.Address, MenuModel.ParseJoin("Join my game: code 192.168.1.20:47810").Kind);
            var dc = JoinCode.Encode("10.1.2.3", 47810);
            Assert.Equal(new MenuJoinParse(MenuJoinKind.Direct, dc), MenuModel.ParseJoin("Join my game in Fortress: code " + dc));
            Assert.Equal(MenuJoinKind.None, MenuModel.ParseJoin("Join my game in Fortress").Kind);
        }

        [Fact]
        public void BootFlagsAreParsed()
        {
            Assert.Equal(new MenuBootFlags(true, "", "Sam"), MenuModel.ParseBootFlags(new[] { "--host", "--name=Sam" }));
            Assert.Equal("7HQ4K2", MenuModel.ParseBootFlags(new[] { "--join=7HQ4K2", "--other" }).Join);
        }

        [Fact]
        public void TheTextTableFillsPlaceholdersAndCanBeOverridden()
        {
            Assert.Equal("Players 2/4", MenuText.T("players_header", 2, 4));
            MenuText.Override(new Dictionary<string, string> { ["host"] = "Create game" });
            try
            {
                Assert.Equal("Create game", MenuText.T("host"));
                Assert.Equal("Join", MenuText.T("join"));
            }
            finally { MenuText.Override(null); }
            Assert.Equal("Host a game", MenuText.T("host"));
            Assert.Equal("no_such_key", MenuText.T("no_such_key"));
            MenuText.Override(new Dictionary<string, string> { ["invite_sentence_untitled"] = "Come play: code %s" });
            try { Assert.Equal("Come play: code 7HQ 4K2", MenuText.T("invite_sentence_untitled", "7HQ 4K2")); }
            finally { MenuText.Override(null); }
        }

        [Fact]
        public void TheTextTableMatchesTheGdscriptMenusKeyForKeyAndWordForWord()
        {
            var path = Path.Combine(Path.GetDirectoryName(Spec.Root)!, "clients", "gdscript", "addons", "onelobby", "menu", "menu_text.gd");
            var gd = ReadGdTable(File.ReadAllText(path));
            Assert.True(gd.Count > 100, "menu_text.gd parsed to only " + gd.Count + " keys");
            var cs = MenuText.Table;
            Assert.Empty(gd.Keys.Except(cs.Keys));   // a key only the GDScript table has
            Assert.Empty(cs.Keys.Except(gd.Keys));   // a key only the C# table has
            foreach (var kv in gd) Assert.Equal(kv.Value, cs[kv.Key]);
        }

        /// <summary>Reads <c>const TABLE := { "key": "text", ... }</c> out of menu_text.gd.</summary>
        internal static Dictionary<string, string> ReadGdTable(string source)
        {
            var start = source.IndexOf("const TABLE := {", StringComparison.Ordinal);
            var end = source.IndexOf("\n}", start, StringComparison.Ordinal);
            Assert.True(start >= 0 && end > start, "TABLE not found in menu_text.gd");
            var table = new Dictionary<string, string>();
            foreach (Match m in Regex.Matches(source.Substring(start, end - start), "^\\s*\"([^\"]+)\":\\s*\"((?:[^\"\\\\]|\\\\.)*)\",?\\s*$", RegexOptions.Multiline))
                table[m.Groups[1].Value] = Regex.Unescape(m.Groups[2].Value);
            return table;
        }

        [Fact]
        public void TheSavedNameAndLastCodeAreTheStartScreensDefaults()
        {
            var w = new World();
            var p = w.New("p");
            p.Client.Settings.Save(name: "Sam", lastCode: "7HQ4K2");
            var m = new MenuModel(p.Client);
            Assert.Equal(("Sam", "7HQ 4K2"), (m.NameText, m.JoinText));
            Assert.True(m.CanBrowse());
            m.Route = MenuRoute.Direct;
            Assert.False(m.CanBrowse());
        }

        // ---- host, join, roster, ready, countdown, start, back to lobby -----------------------------------------------------------

        [Fact]
        public void HostJoinRosterReadyStartCountdownAndBackToTheLobby()
        {
            var w = new World();
            var h = w.Hosting("Sam");
            Assert.Equal(MenuScreen.Lobby, h.M.Screen);
            Assert.True(h.M.IsHost);
            Assert.True(w.Until(() => In(h)));
            var code = h.M.CodeText();
            Assert.Matches("^[0-9A-Z]{3} [0-9A-Z]{3}$", code);
            Assert.True(h.M.CopyCode());
            Assert.Equal(code, h.Copied.Last());
            Assert.Equal("Sam", h.Client.Settings.Effective().Name);
            Assert.Equal(code.Replace(" ", ""), h.Client.Settings.Effective().LastCode);

            var g = w.Guest(h, "Ann");
            Assert.Equal(MenuScreen.Lobby, g.M.Screen);
            Assert.True(w.Until(() => In(g) && Names(g).SequenceEqual(new[] { "Sam", "Ann" }) && Names(h).SequenceEqual(new[] { "Sam", "Ann" })), "both see the roster: " + string.Join(",", Names(g)) + " / " + string.Join(",", Names(h)));
            Assert.True(Row(h, "Sam")!.Host && !Row(h, "Ann")!.Host);
            Assert.True(Row(h, "Ann")!.CanKick && !Row(h, "Sam")!.CanKick);
            Assert.False(Row(g, "Ann")!.CanKick);
            Assert.Equal("Players 2/4", h.M.PlayersHeader());

            g.M.ToggleReady();
            Assert.True(w.Until(() => Row(h, "Ann")!.Ready), "ready shows in the host's roster");
            Assert.Equal("Ready", h.M.RowMarks(Row(h, "Ann")!));
            Assert.Equal("Host", h.M.RowMarks(Row(h, "Sam")!));

            h.M.SendChat("hi there");
            Assert.True(w.Until(() => g.M.ChatLines.Count == 1), "chat reaches the other player");
            Assert.Equal(new MenuChatLine(h.L.LocalPeerId, "Sam", "hi there"), g.M.ChatLines[0]);

            Assert.Equal(1, h.M.LobbySettings()!.CountdownSeconds);
            Assert.Equal("off", g.M.LobbySettings()!.AutoStart);
            h.M.SetLobbySetting("min_players", 2);
            Assert.True(w.Until(() => g.M.LobbySettings()!.MinPlayers == 2), "the host changes a lobby setting for everyone");
            h.M.SetLobbySetting("min_players", 1);

            g.M.StartGame();
            Assert.False(g.M.CountingDown); // a joiner's Start does nothing
            h.M.StartGame();
            Assert.True(w.Until(() => h.M.CountingDown && g.M.CountingDown), "the countdown shows on both");
            Assert.StartsWith("Starting in", h.M.CountdownText());
            Assert.NotEqual("", g.M.CountdownText());
            Assert.True(w.Until(() => h.Started == 1 && g.Started == 1), "GameStarted fires once on both");
            w.Wait(500);
            Assert.Equal((1, 1), (h.Started, g.Started));
            Assert.Equal((MenuScreen.Playing, MenuScreen.Playing), (h.M.Screen, g.M.Screen));

            h.L.Room.BackToLobby();
            Assert.True(w.Until(() => h.Back == 1 && g.Back == 1), "ReturnedToLobby fires on both");
            Assert.Equal((MenuScreen.Lobby, MenuScreen.Lobby), (h.M.Screen, g.M.Screen));
            Assert.False(Row(h, "Ann")!.Ready); // ready flags reset

            w.Run(g.M.LeaveAsync());
            Assert.Equal((MenuScreen.Start, 1), (g.M.Screen, g.Left));
            Assert.Null(g.M.Lobby);
            Assert.True(w.Until(() => Names(h).SequenceEqual(new[] { "Sam" })), "the host's roster shows the player gone");
            w.Run(h.M.LeaveAsync());
        }

        // ---- Copy invite and the invite link -------------------------------------------------------------------------------------

        [Fact]
        public void CopyInviteCopiesASentenceWithTheCodeAndTheJoinBoxReadsItBack()
        {
            var w = new World();
            var h = w.Hosting("Sam");
            var code = h.M.CodeText();
            Assert.True(h.M.InviteAvailable);
            Assert.True(h.M.CopyInvite());
            Assert.Equal("Join my game: code " + code, h.Copied.Last()); // no blueprint, no title
            h.M.InviteBase = "https://g.example/play";
            Assert.Equal("Join my game: code " + code + " https://g.example/play?join=" + code.Replace(' ', '-'), h.M.InviteText());
            Assert.Equal(new MenuJoinParse(MenuJoinKind.Lobby, code.Replace(" ", "")), MenuModel.ParseJoin(h.M.InviteText()));
            h.M.InviteBase = "";
            h.M.Clipboard = null;
            Assert.False(h.M.CopyInvite() || h.M.CopyCode()); // no clipboard injected: nothing copied
        }

        [Theory]
        [InlineData("Fortress")]
        [InlineData("Castle")]
        public void WithAGameTitleTheSentenceNamesTheGameAndTheCodeStillWins(string title)
        {
            var w = new World();
            var json = @"{""game"":{""id"":""menu-test"",""title"":""" + title + @"""},""sync"":{""mode"":""raw""},""hosting"":{""server"":true,""lobbyServer"":""ws://x.test/ws""}}";
            var h = w.FromBlueprint(json);
            h.M.SetName("Sam");
            w.Run(h.M.HostAsync());
            var code = h.M.CodeText();
            Assert.Equal("Join my game in " + title + ": code " + code, h.M.InviteText());
            h.M.InviteBase = "https://g.example/play";
            Assert.Equal("Join my game in " + title + ": code " + code + " https://g.example/play?join=" + code.Replace(' ', '-'), h.M.InviteText());
            var lobbyCode = h.L.Code;
            Assert.Equal(new MenuJoinParse(MenuJoinKind.Lobby, lobbyCode), MenuModel.ParseJoin(h.M.InviteText()));
            h.M.InviteBase = "";
            Assert.Equal(new MenuJoinParse(MenuJoinKind.Lobby, lobbyCode), MenuModel.ParseJoin(h.M.InviteText()));
            // a second client that pastes the sentence into its Join box lands in the lobby
            var g = w.FromBlueprint(json);
            g.M.SetName("Ann");
            g.M.SetJoinText(h.M.InviteText());
            w.Run(g.M.JoinAsync());
            Assert.Equal(MenuScreen.Lobby, g.M.Screen);
        }

        // ---- kick, ban, unban --------------------------------------------------------------------------------------------------------

        [Fact]
        public void KickWithAReasonBanThenARefusedRejoinAndUnban()
        {
            var w = new World();
            var h = w.Hosting("Sam");
            var g = w.Guest(h, "Ann");
            Assert.True(w.Until(() => In(g) && Names(h).Count == 2));
            h.M.Kick(Row(h, "Ann")!.Id, "afk too long");
            Assert.True(w.Until(() => g.M.Screen == MenuScreen.Error), "a kicked player lands on the error screen");
            var e = g.M.Error;
            Assert.True(e.Removed);
            Assert.Equal(("afk too long", "afk too long", false), (e.Message, e.Reason, e.Ban));
            Assert.Equal(("kicked", "kicked", MenuText.T("removed_title")), (g.M.Removal!.Code, e.Code, e.Title));
            Assert.True(g.M.Back());
            Assert.Equal(MenuScreen.Start, g.M.Screen);

            // a kick without a reason says the default sentence of the code
            var g2 = w.Guest(h, "Ann", from: g);
            Assert.True(w.Until(() => In(g2)));
            h.M.Kick(Row(h, "Ann")!.Id);
            Assert.True(w.Until(() => g2.M.Screen == MenuScreen.Error));
            Assert.Equal(RoomRules.RemovalReason("kicked"), g2.M.Error.Message);

            // ban with a reason, then a refused rejoin
            var g3 = w.Guest(h, "Ann", from: g);
            Assert.True(w.Until(() => In(g3)));
            h.M.Ban(Row(h, "Ann")!.Id, "no spoilers");
            Assert.True(w.Until(() => g3.M.Screen == MenuScreen.Error), "a banned player lands on the error screen");
            Assert.Equal((true, "no spoilers", MenuText.T("banned_title")), (g3.M.Error.Ban, g3.M.Error.Message, g3.M.Error.Title));
            var rows = h.M.BanRows();
            Assert.Single(rows);
            Assert.Contains("no spoilers", rows[0].Text);
            Assert.Contains("Ann", rows[0].Text);

            var g4 = w.New("Ann", from: g);
            g4.M.SetName("Ann");
            g4.M.SetJoinText(h.M.CodeText());
            w.Run(g4.M.JoinAsync());
            Assert.Equal(MenuScreen.Error, g4.M.Screen);
            Assert.Equal("banned", g4.M.Error.Code);
            Assert.True(g4.M.Error.Message != "" && g4.M.Error.Message != "banned", "a sentence: " + g4.M.Error.Message);

            // Unban lifts it
            h.M.Unban(rows[0].Key);
            Assert.Empty(h.M.BanRows());
            g4.M.Back();
            w.Run(g4.M.JoinAsync());
            Assert.True(w.Until(() => In(g4)), "after Unban the player can join again");
            w.Run(h.M.LeaveAsync());
        }

        [Fact]
        public void JoinRequestsAreKeptUntilAnswered()
        {
            var w = new World();
            var h = w.Hosting("Sam", options: new LobbyOptions("menu", 4, Visibility.Private));
            var g = w.New("Bob");
            g.M.SetName("Bob");
            g.M.SetJoinText(h.M.CodeText());
            var join = g.M.JoinAsync();
            Assert.True(w.Until(() => h.M.Requests.Count == 1), "a join request is listed");
            Assert.Equal("Bob", h.M.Requests[0].Name);
            h.M.Approve(h.M.Requests[0].PeerId, true);
            Assert.Empty(h.M.Requests);
            w.Run(join);
            Assert.Equal(MenuScreen.Lobby, g.M.Screen);
            // a refusal reads as the denied sentence on the other side
            var g2 = w.New("Cy");
            g2.M.SetName("Cy");
            g2.M.SetJoinText(h.M.CodeText());
            var join2 = g2.M.JoinAsync();
            Assert.True(w.Until(() => h.M.Requests.Count == 1));
            h.M.Approve(h.M.Requests[0].PeerId, false);
            w.Run(join2);
            Assert.Equal(MenuScreen.Error, g2.M.Screen);
        }

        // ---- errors the player reads -----------------------------------------------------------------------------------------------

        [Fact]
        public void AWrongPasswordABadCodeAndAnUnknownCodeEachReadAsAPlainSentence()
        {
            var w = new World();
            var h = w.Hosting("Sam", options: new LobbyOptions("menu", 4) { Password = "pw" });
            var g = w.Guest(h, "Ann", "wrong");
            Assert.Equal((MenuScreen.Error, "bad_password"), (g.M.Screen, g.M.Error.Code));
            Assert.Equal("That password isn't right.", g.M.Error.Message);
            Assert.NotEqual("", g.M.Error.Hint);
            g.M.Back();
            g.M.SetPassword("pw");
            w.Run(g.M.JoinAsync());
            Assert.True(w.Until(() => In(g)), "the right password joins");
            w.Run(g.M.LeaveAsync());
            w.Run(h.M.LeaveAsync());

            var b = w.New("b");
            b.M.SetJoinText("hello world");
            w.Run(b.M.JoinAsync());
            Assert.Equal((MenuScreen.Error, "bad_code"), (b.M.Screen, b.M.Error.Code));
            Assert.Equal(Friendly.DescribeError("bad_code").Message, b.M.Error.Message);
            Assert.True(b.M.Error.Message.Length > 20 && b.M.Error.Hint != "", "a sentence, not only the code");
            Assert.True(b.M.Back());
            Assert.Equal(MenuScreen.Start, b.M.Screen);

            // a good-looking code that no lobby has
            b.M.SetJoinText("7HQ 4K2");
            w.Run(b.M.JoinAsync());
            Assert.Equal(MenuScreen.Error, b.M.Screen);
            Assert.Equal(Friendly.DescribeError("unknown_code").Message, b.M.Error.Message);
            Assert.NotEqual("", b.M.Error.Hint);

            // logs: copy and save, the note says so
            b.M.CopyLogs();
            Assert.StartsWith("# onelobby netlog", b.Copied.Last());
            Assert.Equal(MenuText.T("logs_copied"), b.M.LogNote);
            var file = Path.Combine(Path.GetTempPath(), "onelobby-menu-test-" + Guid.NewGuid().ToString("N") + ".txt");
            try
            {
                b.M.LogsPath = file;
                b.M.SaveLogs();
                Assert.True(File.Exists(file));
                Assert.Contains(file, b.M.LogNote);
            }
            finally { File.Delete(file); }
        }

        [Fact]
        public void CancelWhileConnectingGoesBackAndALateAnswerIsNotShown()
        {
            var w = new World();
            var h = w.Hosting("Sam");
            var c = w.New("c");
            c.M.SetJoinText(h.M.CodeText());
            var task = c.M.JoinAsync();
            Assert.Equal(MenuScreen.Connecting, c.M.Screen);
            Assert.Contains(h.M.CodeText(), c.M.ConnectingText);
            Assert.True(c.M.Back());
            Assert.Equal(MenuScreen.Start, c.M.Screen);
            w.Run(task);
            w.Wait(1000);
            Assert.Equal(MenuScreen.Start, c.M.Screen); // the lobby that arrived anyway was left, not shown
            Assert.Null(c.M.Lobby);
        }

        [Fact]
        public void WhenTheSessionEndsBecauseTheHostLeftTheJoinerGetsAScreenThatSaysSo()
        {
            var w = new World();
            var h = w.Hosting("Sam");
            var g = w.Guest(h, "Ann");
            Assert.True(w.Until(() => In(g)));
            // a server lobby migrates its host (the blueprint's session.hostLeaves "end" is not applied by this client), so only a
            // direct lobby ends with "host_left"; the lobby's own end is called here
            typeof(Lobby).GetMethod("End", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.Invoke(g.L, new object[] { "host_left" });
            w.Wait(100);
            Assert.Equal(MenuScreen.Error, g.M.Screen);
            Assert.Equal((MenuText.T("ended_title"), MenuText.T("host_left"), MenuText.T("host_left_hint")), (g.M.Error.Title, g.M.Error.Message, g.M.Error.Hint));
        }

        [Fact]
        public void WhenTheHostLeavesAMigratingLobbyTheJoinerStaysAndBecomesTheHost()
        {
            var w = new World(); // no blueprint: server lobbies migrate the host by default (a difference from the direct GDScript flow)
            var h = w.Hosting("Sam");
            var g = w.Guest(h, "Ann");
            Assert.True(w.Until(() => In(g) && Names(g).Count == 2));
            w.Run(h.M.LeaveAsync());
            Assert.True(w.Until(() => g.M.IsHost), "the joiner took over");
            Assert.Equal(MenuScreen.Lobby, g.M.Screen);
            Assert.Equal(new[] { "Ann" }, Names(g));
        }

        // ---- an old host (no room layer) ---------------------------------------------------------------------------------------------

        [Fact]
        public void AnOldHostGivesAPlainPeerListWithNoRoomFeatures()
        {
            var w = new World();
            var h = w.Hosting("Sam");
            h.L.Room.TestIgnoreFrames = true; // an older host ignores the room's join frame, as one with no room layer would
            var g = w.Guest(h, "Ann");
            Assert.Equal(MenuScreen.Lobby, g.M.Screen);
            Assert.True(w.Until(() => g.M.Lobby!.Room.Supported == false, 400), "it learns the host has no room layer");
            var rows = g.M.RosterRows();
            Assert.Equal(2, rows.Count);
            Assert.All(rows, r => Assert.False(r.Ready || r.CanKick));
            Assert.False(g.M.RoomActive);
            Assert.Equal("Players 2", g.M.PlayersHeader());
            g.M.ToggleReady();
            Assert.Equal("", g.M.LobbyNote);
            Assert.False(g.M.CountingDown);
            Assert.Null(g.M.LobbySettings());
            w.Run(g.M.LeaveAsync());
        }

        // ---- the rest: relay line, connection check, blueprint switches, boot flags, browse ---------------------------------------

        [Fact]
        public void TheRelayLineIsNeverInAnyTextTheModelExposes()
        {
            var w = new World();
            var p = w.New("p", tweak: c => c with { LobbyServer = Blueprint.NoServer });
            var m = p.M;
            m.OpenSettings();
            Assert.Equal(MenuScreen.Settings, m.Screen);
            Assert.False(m.SaveRelay("this is not a relay line"));
            Assert.Equal(MenuText.T("relay_bad_input"), m.RelayNote);
            Assert.True(m.SaveRelay(Relay));
            Assert.Equal(MenuText.T("relay_saved"), m.RelayNote);
            m.CopyLogs();
            m.SaveServer("not a server");
            m.CheckRunner = _ => Task.FromResult(new CheckResult("ok", "symmetric", "none", "v", Diagnose.CheckVerdict(new CheckFindings("ok", "symmetric", "none")).Message));
            w.Run(m.RunCheckAsync());
            foreach (var s in new[] { m.RelayStatusText(), m.RelayNote, m.SettingsNote, m.CheckVerdict, string.Join("|", m.CheckFacts), m.Error.ToString(), m.LogNote, m.LobbyNote,
                m.StartNote, m.ServerText, p.Client.NetLog.Export(), string.Join("|", p.Copied) })
                Assert.DoesNotMatch("samuser|sampass77", s);
            Assert.Equal("Relay in use: turn:127.0.0.1:9 <hidden> <hidden>", m.RelayStatusText());
            m.ClearRelay();
            Assert.Equal(MenuText.T("relay_none"), m.RelayStatusText());
            Assert.False(m.SaveServer("not a server"));
            Assert.Equal(MenuText.T("server_bad_input"), m.SettingsNote);
            Assert.True(m.SaveServer("wss://lobby.mygame.test/ws"));
            Assert.Equal("wss://lobby.mygame.test/ws", m.ServerText);
            Assert.True(m.CanBrowse());
        }

        [Fact]
        public void TheConnectionCheckShowsTheLibrarysVerdictAndThreeFacts()
        {
            var w = new World();
            var m = w.New("p").M;
            m.CheckRunner = _ => Task.FromResult(new CheckResult("ok", "symmetric", "none", "v", Diagnose.CheckVerdict(new CheckFindings("ok", "symmetric", "none")).Message));
            w.Run(m.RunCheckAsync());
            Assert.Equal(Diagnose.CheckVerdict(new CheckFindings("ok", "symmetric", "none")).Message, m.CheckVerdict);
            Assert.Equal(3, m.CheckFacts.Count);
            Assert.Contains("gets out", m.CheckFacts[0]);
            Assert.Contains("symmetric", m.CheckFacts[1]);
            Assert.Contains("none set", m.CheckFacts[2]);
            Assert.False(m.CheckRunning);
            m.OpenSettings();
            Assert.True(m.Back() && m.Screen == MenuScreen.Start && !m.Back(), "Back leaves settings; there is nothing behind the start screen");
        }

        [Fact]
        public void TheBlueprintSwitchesTheScreens()
        {
            var w = new World();
            var a = w.FromBlueprint(@"{""game"":{""id"":""menu-test""},""diagnostics"":{""showConnectionCheck"":false,""logSize"":60,""reportToHost"":false},""players"":{""identity"":""anonymous""},""chat"":{""text"":false},""lobby"":{""approveJoins"":true},""sync"":{""mode"":""raw""}}");
            Assert.False(a.M.ConnectionCheckShown);
            Assert.False(a.M.NamesAllowed);
            Assert.True(a.M.ApproveJoinsOn);
            Assert.False(a.M.CanBrowse()); // no lobby server in this blueprint
            var b = w.FromBlueprint(@"{""game"":{""id"":""menu-test""},""players"":{""maxNameLength"":5}}");
            Assert.Equal("Abcde", b.M.SetName("Abcdefghij"));
            Assert.True(b.M.NamesAllowed && b.M.ConnectionCheckShown);
        }

        [Fact]
        public void BootFlagsHostAndJoinAtOnce()
        {
            var w = new World();
            var h = w.New("h");
            Assert.Equal("host", h.M.ApplyBootFlags(new[] { "--host", "--name=Sam" }));
            Assert.Equal("Sam", h.M.NameText);
            Assert.True(w.Until(() => h.M.Screen == MenuScreen.Lobby), "the boot host reaches the lobby");
            var j = w.New("j");
            Assert.Equal("join", j.M.ApplyBootFlags(new[] { "--join=" + h.M.Lobby!.Code, "--name=Ann" }));
            Assert.True(w.Until(() => j.M.Screen == MenuScreen.Lobby), "the boot joiner reaches the lobby");
            Assert.Equal("", w.New("n").M.ApplyBootFlags(new[] { "--something" }));
            w.Run(j.M.LeaveAsync());
            w.Run(h.M.LeaveAsync());
        }

        [Fact]
        public void BrowseListsPublicLobbiesAndJoinsOne()
        {
            var w = new World();
            var h = w.Hosting("Sam", options: new LobbyOptions("Sam's game", 4, Visibility.Public));
            var g = w.New("g");
            g.M.SetName("Ann");
            Assert.True(g.M.CanBrowse());
            w.Run(g.M.OpenBrowseAsync());
            Assert.Equal(MenuScreen.Browse, g.M.Screen);
            Assert.Single(g.M.BrowseItems);
            Assert.Equal("", g.M.BrowseStatus);
            Assert.Equal("Sam's game (Sam) 1/4", MenuModel.BrowseRowText(g.M.BrowseItems[0]));
            w.Run(g.M.JoinListedAsync(g.M.BrowseItems[0].Code));
            Assert.Equal(MenuScreen.Lobby, g.M.Screen);
            w.Run(g.M.LeaveAsync());
            var e = w.New("e");
            w.Run(h.M.LeaveAsync());
            w.Run(e.M.OpenBrowseAsync());
            Assert.Equal(MenuText.T("browse_empty"), e.M.BrowseStatus);
        }

        [Fact]
        public void ADirectRouteWithNoDirectDelegatesSaysThereIsNoServer()
        {
            var w = new World();
            var p = w.New("p");
            p.M.Route = MenuRoute.Direct;
            w.Run(p.M.HostAsync());
            Assert.Equal((MenuScreen.Error, LobbyErrorCodes.NoServer), (p.M.Screen, p.M.Error.Code));
            p.M.Back();
            p.M.SetJoinText("192.168.1.20:47810");
            w.Run(p.M.JoinAsync());
            Assert.Equal(MenuScreen.Error, p.M.Screen);
            Assert.NotEqual("", p.M.Error.Message);
        }

        // ---- the connection check when the menu opens (every runner here is a counted fake: nothing touches the network) ----------

        private static CheckResult Found(string kind)
        {
            var f = kind switch
            {
                "symmetric" => new CheckFindings("ok", "symmetric", "none"),
                "blocked" => new CheckFindings("blocked", "unknown", "none"),
                "relay_refused" => new CheckFindings("ok", "cone", "refused"),
                "relay_works" => new CheckFindings("blocked", "unknown", "ok"),
                _ => new CheckFindings("ok", "cone", "none"),
            };
            var v = Diagnose.CheckVerdict(f);
            return new CheckResult(f.Udp, f.NatType, f.Relay, v.Verdict, v.Message);
        }

        private static (P P, int[] Runs) OpenRig(World w, string? diagnostics, string answer = "cone", TaskCompletionSource<bool>? gate = null)
        {
            var server = @"""sync"":{""mode"":""raw""},""hosting"":{""server"":true,""lobbyServer"":""ws://x.test/ws""}";
            var json = @"{""game"":{""id"":""menu-test""}," + server + (diagnostics == null ? "" : @",""diagnostics"":" + diagnostics) + "}";
            var p = w.FromBlueprint(json);
            p.M.HostOptions = new LobbyOptions("menu", 4) { Room = new RoomOptions { CountdownSeconds = 1 } };
            var runs = new[] { 0 };
            p.M.CheckRunner = async _ =>
            {
                runs[0]++;
                if (gate != null) await gate.Task.ConfigureAwait(true);
                return Found(answer);
            };
            return (p, runs);
        }

        [Fact]
        public void TheDefaultRunsTheCheckOnceWhenTheStartScreenFirstShowsAndNotAgainOnTheWayBack()
        {
            var w = new World();
            var (p, runs) = OpenRig(w, null);
            var m = p.M;
            Assert.True(m.CheckOnOpenEnabled);
            Assert.Equal(0, runs[0]);
            w.Run(m.StartShown());
            Assert.Equal((1, "good", false), (runs[0], m.CheckVerdictId, m.CheckRunning));
            Assert.Equal(3, m.CheckFacts.Count);
            Assert.Equal("", m.StartCheckLine);
            m.OpenSettings();
            m.Back();
            w.Run(m.StartShown());
            m.SetName("Sam");
            w.Run(m.HostAsync());
            Assert.True(w.Until(() => m.RoomActive));
            w.Run(m.LeaveAsync());
            w.Run(m.StartShown());
            Assert.Equal(1, runs[0]);
            w.Run(m.RunCheckAsync());
            Assert.Equal(2, runs[0]);
        }

        [Theory]
        [InlineData("symmetric", "likely_fail", true)]
        [InlineData("blocked", "blocked", true)]
        [InlineData("relay_refused", "relay_refused", true)]
        [InlineData("cone", "good", false)]
        [InlineData("relay_works", "relay_works", false)]
        public void TheStartScreenLineIsTheVerdictSentenceForAWarningAndNothingElse(string answer, string verdict, bool warns)
        {
            var w = new World();
            var (p, _) = OpenRig(w, null, answer);
            w.Run(p.M.StartShown());
            Assert.Equal(verdict, p.M.CheckVerdictId);
            Assert.Equal(warns ? p.M.CheckVerdict : "", p.M.StartCheckLine);
            if (answer == "symmetric") Assert.Equal("Direct connections: likely to fail. A relay is recommended.", p.M.StartCheckLine);
        }

        [Fact]
        public void CheckOnOpenFalseShowFalseAndLocalRunNothingUntilTheButton()
        {
            var w = new World();
            var (off, offRuns) = OpenRig(w, @"{""checkOnOpen"":false}");
            w.Run(off.M.StartShown());
            Assert.False(off.M.CheckOnOpenEnabled);
            Assert.True(off.M.ConnectionCheckShown);
            Assert.Equal(0, offRuns[0]);
            w.Run(off.M.RunCheckAsync());
            Assert.Equal(1, offRuns[0]);

            var (hidden, hiddenRuns) = OpenRig(w, @"{""showConnectionCheck"":false}");
            w.Run(hidden.M.StartShown());
            Assert.Equal((0, false), (hiddenRuns[0], hidden.M.CheckOnOpenEnabled));

            var (local, localRuns) = OpenRig(w, null);
            local.M.LocalOnly = MenuModel.ArgsSayLocal(new[] { "--host", "--local" });
            Assert.False(MenuModel.ArgsSayLocal(new[] { "--host" }));
            w.Run(local.M.StartShown());
            Assert.Equal(0, localRuns[0]);

            var (late, lateRuns) = OpenRig(w, null);
            late.M.OpenSettings();
            w.Run(late.M.StartShown());
            Assert.Equal(0, lateRuns[0]);
            late.M.Back();
            w.Run(late.M.StartShown());
            Assert.Equal(1, lateRuns[0]);
        }

        [Fact]
        public void ARunInProgressIsNeverStartedTwiceAndHostWorksWhileItRuns()
        {
            var w = new World();
            var gate = new TaskCompletionSource<bool>();
            var (p, runs) = OpenRig(w, null, "symmetric", gate);
            var m = p.M;
            var first = m.RunCheckAsync();
            var open = m.StartShown();
            var again = m.RunCheckAsync();
            Assert.Equal(1, runs[0]);
            Assert.True(m.CheckRunning);
            Assert.Equal("", m.StartCheckLine);
            m.SetName("Sam");
            w.Run(m.HostAsync());
            Assert.True(w.Until(() => m.RoomActive));
            Assert.True(m.CheckRunning, "the check is still running while the lobby is open");
            gate.SetResult(true);
            w.Run(Task.WhenAll(first, open, again));
            Assert.Equal((MenuScreen.Lobby, "likely_fail", 1), (m.Screen, m.CheckVerdictId, runs[0]));
            Assert.Equal("", m.Error.Message);
            w.Run(m.LeaveAsync());
            Assert.Equal(m.CheckVerdict, m.StartCheckLine);
        }
    }
}
