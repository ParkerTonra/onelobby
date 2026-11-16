using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Xunit;

namespace OneLobby.Tests
{
    /// <summary>Seats, reconnecting, kick and ban, passwords, compatibility and robustness (the C# port of JS room-life.test.ts).</summary>
    public class RoomLifeTests
    {
        private static void Feed(Lobby l, int from, string json) => l.Room.HandleFrame(from, Encoding.UTF8.GetBytes(json));

        [Fact]
        public void APlayerWhoLeavesAndJoinsAgainWithTheSameInstallGetsTheSameSeatBack()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(new RoomOptions { RejoinWindowSeconds = 0 });
            var (ka, a) = r.Join(host, "Ann");
            r.Join(host, "Bob");
            var dropped = new List<string>();
            var restored = new List<string>();
            host.Room.SeatDropped += i => dropped.Add($"{i.Seat}:{i.Name}:{i.Reason}:{i.AfterWindow}");
            host.Room.SeatRestored += i => restored.Add($"{i.Seat}:{i.Name}:{i.Returning}");
            _ = a.LeaveAsync();
            r.Flush();
            Assert.Equal(new[] { "Host", "Bob" }, RoomRig.Names(host));
            Assert.Equal(new[] { "1:Ann:left:False" }, dropped);
            var (_, c) = r.Join(host, "Cara");
            Assert.Equal(3, c.Room.Me!.Seat); // seat 1 is remembered for Ann
            var (_, a2) = r.Join(host, "Ann", from: r.NewKit("Ann", from: ka));
            Assert.Equal((1, "Ann"), (a2.Room.Me!.Seat, a2.Room.Me.Name));
            Assert.Equal(new[] { "1:Ann:True" }, restored);
        }

        [Fact]
        public void ALostConnectionKeepsTheEntryReconnectingAndTheSameInstallTakesItBack()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(new RoomOptions { SeatDropped = SeatDroppedPolicy.Immediate });
            var kb = r.NewKit("Bob");
            var lb = r.R.Await(kb.Client.JoinAsync(host.Code));
            r.Flush();
            lb.Room.SetData(RoomRig.D(("avatar", "5")));
            lb.Room.SetReady(true);
            r.Flush();
            var seen = new List<string>();
            host.Room.PlayerChanged += (e, keys) => seen.Add($"{e.Name}:{e.Status}:{string.Join(",", keys)}");
            var events = new List<string>();
            host.Room.SeatDropped += i => events.Add($"dropped:{i.Seat}:{i.Reason}");
            host.Room.SeatRestored += i => events.Add($"restored:{i.Seat}:{i.Returning}");
            r.Net.Crash(kb.Client.Transport);
            r.Wait(500);
            var e1 = host.Room.Player(2)!;
            Assert.Equal((RoomStatus.Reconnecting, 1, true, RoomRole.Player), (e1.Status, e1.Seat, e1.Ready, e1.Role));
            Assert.False(host.Room.AllReady);
            Assert.Equal(new[] { "dropped:1:disconnected" }, events); // immediate policy
            var (_, lb2) = r.Join(host, "Bob", from: r.NewKit("Bob", from: kb));
            r.Wait(500);
            Assert.Equal(RoomStatus.Connected, host.Room.Player(lb2.LocalPeerId)!.Status);
            Assert.Null(host.Room.Player(2)); // the new peer id replaced the old entry
            var me = lb2.Room.Me!;
            Assert.Equal((1, false), (me.Seat, me.Ready)); // a new peer id is a new entry: seat back, flags fresh
            Assert.Equal(new[] { "dropped:1:disconnected", "restored:1:True" }, events);
            Assert.Contains("Bob:Reconnecting:status", seen);
        }

        [Fact]
        public void PastTheRejoinWindowTheEntryIsRemovedAndTheSeatDroppedHookFiresOnce()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(new RoomOptions { RejoinWindowSeconds = 30 });
            var kb = r.NewKit("Bob");
            r.R.Await(kb.Client.JoinAsync(host.Code));
            r.Flush();
            var left = new List<string>();
            host.Room.PlayerLeft += (e, why) => left.Add($"{e.Name}:{e.Status}:{why}");
            var dropped = new List<string>();
            host.Room.SeatDropped += i => dropped.Add($"{i.Seat}:{i.Reason}:{i.AfterWindow}:{i.Name}");
            r.Net.Crash(kb.Client.Transport);
            r.Wait(29_000);
            Assert.Equal(RoomStatus.Reconnecting, host.Room.Player(2)!.Status);
            Assert.Empty(dropped);
            r.Wait(2000);
            Assert.Null(host.Room.Player(2));
            Assert.Equal(new[] { "Bob:Left:timeout" }, left);
            Assert.Equal(new[] { "1:timeout:True:Bob" }, dropped);
        }

        [Fact]
        public void ARejoinWindowOfZeroRemovesAtOnce()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(new RoomOptions { RejoinWindowSeconds = 0 });
            var kb = r.NewKit("Bob");
            r.R.Await(kb.Client.JoinAsync(host.Code));
            r.Flush();
            r.Net.Crash(kb.Client.Transport);
            r.Wait(300);
            Assert.Null(host.Room.Player(2));
        }

        [Fact]
        public void KickShowsTheRemovedPlayerACodeAndASentenceAndItMayComeBack()
        {
            var r = new RoomRig();
            var (_, host) = r.Host();
            var (ka, a) = r.Join(host, "Ann");
            var seen = new List<string>();
            a.Room.Removed += i => seen.Add($"{i.Code}|{i.Reason}|{i.Ban}");
            var ended = new List<string>();
            a.SessionEnded += why => ended.Add(why);
            host.Room.Kick(2, "too_loud", "Please use push to talk.");
            r.Flush();
            Assert.Equal(new[] { "too_loud|Please use push to talk.|False" }, seen);
            Assert.Equal(new RemovalInfo("too_loud", "Please use push to talk.", false), a.Removal);
            Assert.Equal(new[] { "disconnected" }, ended);
            Assert.Null(host.Room.Player(2));
            var again = r.R.Await(ka.Client.JoinAsync(host.Code));
            r.Flush();
            Assert.Equal("Ann", again.Room.Me!.Name);
            var seen2 = new List<string>();
            again.Room.Removed += i => seen2.Add($"{i.Code}|{i.Reason}");
            host.Room.Kick(again.LocalPeerId);
            r.Flush();
            Assert.Equal(new[] { "kicked|The host removed you from the game." }, seen2);
        }

        [Fact]
        public void BanRemovesForGoodTheHubRefusesThePlayerIdAndUnbanLiftsIt()
        {
            var r = new RoomRig();
            var (k, host) = r.Host();
            var (ka, a) = r.Join(host, "Ann");
            var seen = new List<string>();
            a.Room.Removed += i => seen.Add($"{i.Code}|{i.Reason}|{i.Ban}");
            host.Room.Ban(2, reason: "spam");
            r.Flush();
            Assert.Equal(new[] { "banned|spam|True" }, seen);
            var list = host.Room.Bans.List();
            Assert.Single(list);
            Assert.Equal((ka.PlayerId, "Ann", "spam", "banned"), (list[0].Id, list[0].Name, list[0].Reason, list[0].Code));
            Assert.Equal("banned", Assert.Throws<OneLobbyException>(() => r.R.Await(ka.Client.JoinAsync(host.Code))).Code);
            // a fresh BanList over the same store (a restart) still has it
            Assert.Equal(new[] { ka.PlayerId }, new BanList(k.BanStore, Rig.Config().GameId).List().Select(e => e.Id));
            Assert.Equal(1, host.Room.Unban(ka.PlayerId));
            var back = r.R.Await(ka.Client.JoinAsync(host.Code));
            r.Flush();
            Assert.Equal("Ann", back.Room.Me!.Name);
        }

        [Fact]
        public void OnAHubWithoutTheRoomFeatureTheHostsRoomStillRefusesABannedIdWithTheReason()
        {
            var r = new RoomRig(roomHub: false);
            var (_, host) = r.Host();
            var (ka, _) = r.Join(host, "Ann");
            host.Room.Ban(2, reason: "spam");
            r.Flush();
            var l = r.R.Await(ka.Client.JoinAsync(host.Code));
            var seen = new List<string>();
            l.Room.Removed += i => seen.Add($"{i.Code}|{i.Reason}");
            r.Flush();
            Assert.Equal(new[] { "banned|You are banned from this game." }, seen);
            Assert.Equal("banned", l.Removal!.Code);
            Assert.Equal(new[] { "Host" }, host.Room.Entries.Select(e => e.Name));
        }

        private static System.Text.Json.JsonElement Notice(string code, bool? ban) =>
            System.Text.Json.JsonDocument.Parse(System.Text.Json.JsonSerializer.Serialize(
                ban == null ? new Dictionary<string, object> { ["code"] = code, ["closeReason"] = RoomRules.RemovalReason(code, "") }
                            : new Dictionary<string, object> { ["code"] = code, ["closeReason"] = RoomRules.RemovalReason(code, ""), ["ban"] = ban.Value })).RootElement.Clone();

        [Theory]
        [InlineData("bad_password")]
        [InlineData("banned")]
        public void AJoinerTheHostHasNotAnsweredYetIsRefusedWhenTheHubsNoticeBeatsTheDeny(string code)
        {
            var r = new RoomRig();
            var (_, host) = r.Host();
            var (ka, a) = r.Join(host, "Ann");
            var errors = new List<string>();
            ka.Client.Error += e => errors.Add(e.Code);
            var ended = new List<string>();
            a.SessionEnded += w => ended.Add(w);
            var removed = 0;
            a.Room.Removed += _ => removed++;
            typeof(Room).GetProperty("Supported")!.SetValue(a.Room, null); // the host's answer has not arrived
            a.OnServerError(new LobbyError("kicked", "kicked"), true, Notice(code, false));
            Assert.Equal(new RemovalInfo(code, RoomRules.RemovalReason(code, ""), false), a.Removal);
            Assert.Contains(code, errors);
            Assert.Single(ended);
            Assert.Equal(1, removed);
        }

        [Fact]
        public void AJoinerAlreadyInTheRoomThatIsKickedWithBanTrueStillReadsBanTrue()
        {
            var r = new RoomRig();
            var (_, host) = r.Host();
            var (_, a) = r.Join(host, "Ann");
            Assert.True(a.Room.Supported);
            a.OnServerError(new LobbyError("kicked", "kicked"), false, Notice("banned", null));
            Assert.Equal(new RemovalInfo("banned", RoomRules.RemovalReason("banned", ""), true), a.Removal);
        }

        [Fact]
        public void ABanByAddressAloneCatchesAClientByItsLinkAddress()
        {
            var r = new RoomRig();
            var (_, host) = r.Host();
            host.Room.Bans.Add(ip: "192.0.2.7", reason: "earlier");
            var (_, a) = r.Join(host, "Ann");
            Assert.NotNull(host.Room.Player(2));
            var seen = new List<string>();
            a.Room.Removed += i => seen.Add(i.Code);
            host.Room.OnLinkAddress(2, "::ffff:192.0.2.7");
            r.Flush();
            Assert.Equal(new[] { "banned" }, seen);
            Assert.Throws<ArgumentException>(() => host.Room.Bans.Add(ip: "127.0.0.1"));
        }

        [Fact]
        public void BadKickCodesThrowAndOnlyTheHostCanKick()
        {
            var r = new RoomRig();
            var (_, host) = r.Host();
            var (_, a) = r.Join(host, "Ann");
            Assert.Throws<ArgumentException>(() => host.Room.Kick(2, "Bad Code"));
            Assert.Contains("only the host", Assert.Throws<InvalidOperationException>(() => a.Room.Kick(1)).Message);
        }

        [Fact]
        public void AServerLobbyWithAPasswordRefusesAMissingOrWrongOne()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(password: "Hunter2");
            Assert.Equal("bad_password", Assert.Throws<OneLobbyException>(() => r.R.Await(r.NewKit("A").Client.JoinAsync(host.Code))).Code);
            Assert.Equal("bad_password", Assert.Throws<OneLobbyException>(() => r.R.Await(r.NewKit("B").Client.JoinAsync(host.Code, new RoomJoinOptions { Password = "hunter2" }))).Code);
            var ok = r.R.Await(r.NewKit("C").Client.JoinAsync(host.Code, new RoomJoinOptions { Password = "Hunter2" }));
            r.Flush();
            Assert.True(ok.Room.Supported);
            Assert.Equal(new[] { "Host", "C" }, RoomRig.Names(host));
        }

        [Fact]
        public void OnAHubThatDoesNotKnowPasswordsTheHostsRoomChecksAndTheJoinerIsToldWhy()
        {
            var r = new RoomRig(roomHub: false);
            var (_, host) = r.Host(password: "Hunter2");
            var errors = new List<string>();
            var bad = r.NewKit("Bad");
            bad.Client.Error += e => errors.Add(e.Code);
            var lb = r.R.Await(bad.Client.JoinAsync(host.Code, new RoomJoinOptions { Password = "nope" }));
            var seen = new List<string>();
            lb.Room.Removed += i => seen.Add($"{i.Code}|{i.Reason}");
            r.Flush();
            Assert.Equal(new[] { "bad_password|Wrong password." }, seen);
            Assert.Contains("bad_password", errors); // the kick notice itself also reaches Error, as it always did
            var good = r.R.Await(r.NewKit("Good").Client.JoinAsync(host.Code, new RoomJoinOptions { Password = "Hunter2" }));
            r.Flush();
            Assert.True(good.Room.Supported);
            Assert.Equal(new[] { "Host", "Good" }, RoomRig.Names(host));
            Assert.DoesNotContain(host.Room.Entries, e => e.Name == "Bad");
        }

        [Fact]
        public void ThePasswordNeverAppearsInTheRoomState()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(password: "Hunter2");
            var a = r.R.Await(r.NewKit("A").Client.JoinAsync(host.Code, new RoomJoinOptions { Password = "Hunter2" }));
            r.Flush();
            Assert.DoesNotContain("Hunter2", System.Text.Json.JsonSerializer.Serialize(a.Room.Entries) + RoomWire.SettingsKey(a.Room.Settings));
        }

        [Fact]
        public void PasswordRequiredMakesHostFailWithoutOne()
        {
            var r = new RoomRig();
            var e = Assert.Throws<OneLobbyException>(() => r.R.Await(r.NewKit("H").Client.HostAsync(new LobbyOptions("t", 2) { Room = new RoomOptions { PasswordRequired = true } })));
            Assert.Equal("password_required", e.Code);
            var ok = r.R.Await(r.NewKit("H2").Client.HostAsync(new LobbyOptions("t", 2) { Room = new RoomOptions { PasswordRequired = true }, Password = "x" }));
            Assert.NotEmpty(ok.Code);
        }

        [Fact]
        public void AJoinerOfAHostWithoutTheRoomLayerLearnsItAfterTheWaitAndCannotMutate()
        {
            var r = new RoomRig();
            var (_, host) = r.Host();
            host.Room.TestIgnoreFrames = true; // an older host ignores the room frame
            var l = r.R.Await(r.NewKit("Ann").Client.JoinAsync(host.Code));
            var events = new List<string>();
            l.Room.Unsupported += () => events.Add("unsupported");
            r.Flush();
            Assert.Null(l.Room.Supported);
            Assert.Equal(new[] { "1:Host", "2:Ann" }, l.Room.Players.Select(p => p.Id + ":" + p.Name));
            r.Wait(3100);
            Assert.False(l.Room.Supported);
            Assert.Equal(new[] { "unsupported" }, events);
            Assert.StartsWith("room_unsupported", RoomRig.Throws(() => l.Room.SetReady(true)));
            Assert.Equal(RoomState.Lobby, l.Room.State);
        }

        [Fact]
        public void AnOldJoinerIsAdmittedAsALegacyPlayerNoRoomFramesNeverReadyNotCounted()
        {
            var r = new RoomRig();
            var (k, host) = r.Host(new RoomOptions { AutoStart = AutoStartMode.AllReady, CountdownSeconds = 0, MinPlayers = 1 });
            var errors = new List<string>();
            k.Client.Error += e => errors.Add(e.Code);
            var l = r.R.Await(r.NewKit("Old").Client.JoinAsync(host.Code));
            l.Room.TestNoJoin = true; // an older client sends no room join
            r.Wait(500);
            Assert.Null(host.Room.Player(2)); // still inside the wait
            r.Wait(3000);
            var e2 = host.Room.Player(2)!;
            Assert.Equal((true, RoomRole.Player, 1, false, "Old"), (e2.Legacy, e2.Role, e2.Seat, e2.Ready, e2.Name));
            host.Room.SetReady(true);
            r.Flush();
            Assert.Equal(RoomState.Started, host.Room.State); // the legacy player does not block all_ready
            Assert.Empty(errors);
            Assert.Null(l.Room.Supported);
        }

        [Fact]
        public void AHubWithoutTheRoomFeatureGetsTheSpectatorSlotsAddedAndTheRoomSplitsThem()
        {
            var r = new RoomRig(roomHub: false);
            var (_, host) = r.Host(new RoomOptions { Spectators = 2 }, max: 2);
            Assert.Equal(2, host.Room.Settings.MaxPlayers);
            r.Join(host, "Ann");
            var (_, c) = r.Join(host, "Cara"); // would be a third player: the room refuses it
            Assert.Equal("lobby_full", c.Removal?.Code);
            Assert.Equal(2, host.Room.Players.Count);
            var (_, s) = r.Join(host, "Spec", new RoomJoinOptions { Role = RoomRole.Spectator });
            Assert.Equal(RoomRole.Spectator, s.Room.Me!.Role);
        }

        [Fact]
        public void AGameThatNeverTouchesTheRoomSeesNoChangeInPeersPhaseOrMessages()
        {
            var r = new RoomRig(roomHub: false);
            var (_, host) = r.Host();
            var (_, a) = r.Join(host, "Ann");
            var got = new List<byte[]>();
            a.MessageReceived += (f, b, ch) => got.Add(b.ToArray());
            host.Broadcast(new byte[] { 1, 2, 3 });
            _ = host.StartAsync();
            r.Flush();
            Assert.Equal(new[] { new byte[] { 1, 2, 3 } }, got);
            Assert.Equal(LobbyPhase.InGame, a.Phase);
            Assert.Equal(new[] { "Host", "Ann" }, host.Peers.Select(p => p.Name));
            Assert.Equal(RoomState.Started, host.Room.State); // the room follows a direct lobby.StartAsync()
        }

        [Fact]
        public void AReplicaThatMissesAnUpdateAsksForASnapshotAndConverges()
        {
            var r = new RoomRig();
            var (_, host) = r.Host();
            var (_, a) = r.Join(host, "Ann");
            Feed(a, 1, "{\"t\":\"upd\",\"rev\":" + (a.Room.Revision + 5) + ",\"players\":[]}");
            r.Flush();
            Assert.Equal(host.Room.Revision, a.Room.Revision);
            foreach (var junk in new[] { "", "[]", "{", "{\"t\":5}", "{\"t\":\"zzz\"}", "{\"t\":\"snap\"}" }) Feed(a, 1, junk); // dropped, never thrown
            Assert.Equal(2, a.Room.Players.Count);
        }

        [Fact]
        public void TooManyRequestsInASecondAreRefusedWithRateLimited()
        {
            var r = new RoomRig();
            var (_, host) = r.Host();
            var (_, a) = r.Join(host, "Ann");
            var codes = new List<string>();
            a.Room.Rejected += (c, re, k) => codes.Add(c);
            for (var i = 0; i < 14; i++) a.Room.SetReady(i % 2 == 0);
            r.Flush();
            Assert.True(codes.Count >= 3);
            Assert.All(codes, c => Assert.Equal("rate_limited", c));
        }

        [Fact]
        public void HostMigrationTheNewHostRebuildsTheRoomFromItsReplicaAndRebindsEachPlayer()
        {
            var r = new RoomRig();
            var (_, host) = r.Host();
            var (_, a) = r.Join(host, "Ann", new RoomJoinOptions { Data = RoomRig.D(("color", "#abcdef")) });
            var (_, b) = r.Join(host, "Bob");
            a.Room.SetReady(true);
            r.Wait(500);
            _ = host.LeaveAsync();
            r.Wait(3000);
            Assert.True(a.IsHost);
            Assert.True(a.Room.Supported);
            Assert.Equal(new[] { "Ann:Connected", "Bob:Connected" }, a.Room.Players.Select(p => p.Name + ":" + p.Status));
            Assert.Equal("#abcdef", a.Room.Me!.Data["color"]);
            Assert.True(a.Room.Me.Ready);
            Assert.Equal(new[] { "Ann", "Bob" }, RoomRig.Names(b));
            a.Room.SetData(3, RoomRig.D(("team", "2")));
            r.Flush();
            Assert.Equal("2", b.Room.Me!.Data["team"]);
        }

        [Fact]
        public void TheBlueprintsRoomKeysFillTheHostsSettings()
        {
            var r = new RoomRig();
            var bp = Blueprint.Parse("{\"game\":{\"id\":\"gridpaint\"},\"hosting\":{\"lobbyServer\":\"ws://mem/ws\"},\"lobby\":{\"maxPlayers\":4},\"room\":{\"autoStart\":\"players\",\"autoStartPlayers\":3,\"minPlayers\":2,\"countdownSeconds\":5,\"spectators\":2,\"lateJoin\":\"spectate\",\"seatDropped\":\"immediate\",\"rejoinWindowSeconds\":10,\"data\":{\"role\":{\"type\":\"enum\",\"values\":[\"a\",\"b\"],\"default\":\"a\"}}}}");
            var c = LobbyClient.FromBlueprint(bp, r.Net.CreateTransport(), "Host");
            r.R.Clients.Add(c);
            var host = r.R.Await(c.HostAsync());
            var s = host.Room.Settings;
            Assert.Equal((AutoStartMode.Players, 3, 2, 5000, 2, LateJoinPolicy.Spectate, SeatDroppedPolicy.Immediate, 10_000, 4),
                (s.AutoStart, s.AutoStartPlayers, s.MinPlayers, s.CountdownMs, s.Spectators, s.LateJoin, s.SeatDropped, s.RejoinWindowMs, s.MaxPlayers));
            Assert.Equal(DataType.Enum, s.Data["role"].Type);
            Assert.Equal("a", host.Room.Me!.Data["role"]);
            var k2 = Blueprint.Parse("{\"game\":{\"id\":\"gridpaint\"},\"hosting\":{\"lobbyServer\":\"ws://mem/ws\"},\"room\":{\"passwordRequired\":true}}");
            var c2 = LobbyClient.FromBlueprint(k2, r.Net.CreateTransport(), "H2");
            r.R.Clients.Add(c2);
            Assert.Equal("password_required", Assert.Throws<OneLobbyException>(() => r.R.Await(c2.HostAsync())).Code);
        }
    }
}
