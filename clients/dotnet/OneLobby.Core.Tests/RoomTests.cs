using System;
using System.Collections.Generic;
using System.Linq;
using OneLobby.Gridpaint;
using Xunit;

namespace OneLobby.Tests
{
    /// <summary>The room layer over the in-memory network (the C# port of JS room.test.ts).</summary>
    public class RoomTests
    {
        private static string J(IEnumerable<object?> xs) => string.Join(",", xs);

        [Fact]
        public void EveryLobbyHasARoomAndTheHostIsSeatZero()
        {
            var r = new RoomRig();
            var (_, host) = r.Host();
            Assert.True(host.Room.Supported);
            Assert.Equal(RoomState.Lobby, host.Room.State);
            var me = host.Room.Me!;
            Assert.Equal((1, RoomRole.Player, 0, false, RoomStatus.Connected), (me.Id, me.Role, me.Seat, me.Ready, me.Status));
            Assert.Single(host.Room.Players);
        }

        [Fact]
        public void JoinersGetTheWholeRoomAndSeatsFollowJoinOrder()
        {
            var r = new RoomRig();
            var (_, host) = r.Host();
            var events = new List<string>();
            host.Room.PlayerJoined += e => events.Add("join:" + e.Name);
            var (_, a) = r.Join(host, "Ann");
            Assert.True(a.Room.Supported);
            Assert.Equal("Host:0,Ann:1", J(a.Room.Players.Select(p => p.Name + ":" + p.Seat)));
            var (_, b) = r.Join(host, "Bob");
            r.Flush();
            foreach (var l in new[] { host, a, b }) Assert.Equal("1:Host:0,2:Ann:1,3:Bob:2", J(l.Room.Players.Select(p => p.Id + ":" + p.Name + ":" + p.Seat)));
            Assert.Equal(new[] { "join:Ann", "join:Bob" }, events);
            Assert.Equal(3, b.Room.Me!.Id);
            Assert.Equal(host.Room.Revision, a.Room.Revision);
        }

        [Fact]
        public void ThePlayerIdIsSentInHelloAndStaysTheSameForTheInstall()
        {
            var r = new RoomRig();
            var (k, _) = r.Host();
            Assert.Matches("^[0-9a-f]{32}$", k.PlayerId);
            Assert.Equal(k.PlayerId, k.IdStore.GetItem("onelobby.pid." + Rig.Config().GameId));
            var again = r.NewKit("x", from: k);
            Assert.Equal(k.PlayerId, again.PlayerId);
            Assert.NotEqual(k.PlayerId, r.NewKit("y").PlayerId);
        }

        [Fact]
        public void NamesAreDefaultedDedupedClampedAndRerunOnRename()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(name: "Sam");
            var (_, a) = r.Join(host, "Sam");
            var (_, b) = r.Join(host, "");
            var (_, c) = r.Join(host, "  Sam  ");
            Assert.Equal(new[] { "Sam", "Sam 2", "Player 3", "Sam 3" }, RoomRig.Names(host));
            Assert.Equal(RoomRig.Names(host), RoomRig.Names(c));
            _ = a.RenameAsync("Ann‮");
            r.Flush();
            Assert.Equal(new[] { "Sam", "Ann", "Player 3", "Sam 3" }, RoomRig.Names(host));
            _ = a.RenameAsync("Sam");
            r.Flush();
            Assert.Equal(new[] { "Sam", "Sam 2", "Player 3", "Sam 3" }, RoomRig.Names(host));
            Assert.Equal("Player 3", b.Room.Player(3)!.Name);
        }

        [Fact]
        public void TheFilterHookCleansNamesAndChatOnTheHost()
        {
            var r = new RoomRig();
            var (_, host) = r.Host();
            var (_, a) = r.Join(host, "darnit");
            Assert.Equal(new[] { "Host", "darnit" }, RoomRig.Names(host));
            host.Room.Filter = (t, kind) => t.Replace("darn", "****");
            var (_, b) = r.Join(host, "darn");
            Assert.Equal("****", b.Room.Me!.Name);
            var lines = new List<string>();
            a.Chat.Received += m => lines.Add(m.Text);
            host.Chat.Send("what a darn day");
            r.Flush();
            Assert.Equal(new[] { "what a **** day" }, lines);
            host.Room.Filter = (t, kind) => throw new InvalidOperationException("boom");
            host.Chat.Send("darn again");
            r.Flush();
            Assert.Equal("darn again", lines[1]);
        }

        private static RoomOptions MoodRoom() => new()
        {
            Data = new Dictionary<string, DataDecl>
            {
                ["mood"] = new DataDecl(DataType.Enum) { Values = new[] { "happy", "sad" } },
                ["vip"] = new DataDecl(DataType.Bool) { HostOnly = true },
            },
        };

        [Fact]
        public void DataStartsWithDefaultsReplicatesAndRefusesBadSets()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(MoodRoom());
            Assert.Equal("avatar=0,team=0", J(host.Room.Me!.Data.OrderBy(k => k.Key).Select(k => k.Key + "=" + k.Value)));
            var (_, a) = r.Join(host, "Ann", new RoomJoinOptions { Data = RoomRig.D(("color", "#FF8800"), ("mood", "sad"), ("zzz", "1"), ("avatar", "999")) });
            Assert.Equal("avatar=0,color=#ff8800,mood=sad,team=0", J(a.Room.Me!.Data.OrderBy(k => k.Key).Select(k => k.Key + "=" + k.Value)));
            var rejected = new List<string>();
            a.Room.Rejected += (code, re, key) => rejected.Add(re + ":" + code + ":" + key);
            var changes = new List<string>();
            host.Room.PlayerChanged += (e, keys) => { if (e.Id == 2) changes.Add(string.Join("|", keys)); };
            a.Room.SetData(RoomRig.D(("avatar", "7"), ("team", "2")));
            r.Flush();
            Assert.Equal("7", host.Room.Player(2)!.Data["avatar"]);
            Assert.Equal("2", a.Room.Me!.Data["team"]);
            Assert.Equal(new[] { "data.avatar|data.team" }, changes);
            a.Room.SetData(RoomRig.D(("mood", "angry")));
            a.Room.SetData(RoomRig.D(("vip", "true")));
            a.Room.SetData(RoomRig.D(("nope", "1")));
            a.Room.SetData(RoomRig.D(("avatar", "300")));
            r.Flush();
            Assert.Equal(new[] { "set:bad_value:mood", "set:not_allowed:vip", "set:unknown_key:nope", "set:bad_value:avatar" }, rejected);
            Assert.Equal("sad", host.Room.Player(2)!.Data["mood"]);
        }

        [Fact]
        public void TheHostOverridesAnyPlayerAndAnUnsetKeyGoesAway()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(MoodRoom());
            var (_, a) = r.Join(host, "Ann", new RoomJoinOptions { Data = RoomRig.D(("color", "#00ff00")) });
            host.Room.SetData(2, RoomRig.D(("vip", "true"), ("color", "")));
            r.Flush();
            Assert.Equal("avatar=0,team=0,vip=true", J(a.Room.Me!.Data.OrderBy(k => k.Key).Select(k => k.Key + "=" + k.Value)));
            Assert.Contains("bad_value", RoomRig.Throws(() => host.Room.SetData(2, RoomRig.D(("vip", "maybe")))));
            Assert.Contains("not_allowed", RoomRig.Throws(() => a.Room.SetData(1, RoomRig.D(("team", "1")))));
            host.Room.SetData(RoomRig.D(("team", "3")));
            r.Flush();
            Assert.Equal("3", a.Room.Player(1)!.Data["team"]);
        }

        [Fact]
        public void ReadyFlagsReplicateAndAllReadyIgnoresSpectators()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(new RoomOptions { Spectators = 2 });
            var (_, a) = r.Join(host, "Ann");
            var (_, s) = r.Join(host, "Spec", new RoomJoinOptions { Role = RoomRole.Spectator });
            var flips = new List<bool>();
            host.Room.AllReadyChanged += v => flips.Add(v);
            Assert.False(host.Room.AllReady);
            a.Room.SetReady(true);
            r.Flush();
            Assert.True(host.Room.Player(2)!.Ready);
            Assert.True(s.Room.Player(2)!.Ready);
            host.Room.SetReady(true);
            r.Flush();
            Assert.True(host.Room.AllReady);
            Assert.Equal(new[] { true }, flips);
            a.Room.ToggleReady();
            r.Flush();
            Assert.Equal(new[] { true, false }, flips);
            var rejected = new List<string>();
            s.Room.Rejected += (c, re, k) => rejected.Add(c);
            s.Room.SetReady(true);
            r.Flush();
            Assert.Equal(new[] { "not_allowed" }, rejected);
        }

        [Fact]
        public void StartRunsACountdownEveryPeerSeesThenStartsForAll()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(new RoomOptions { CountdownSeconds = 3 });
            var (_, a) = r.Join(host, "Ann");
            var log = new List<string>();
            a.Room.StateChanged += (s, prev) => log.Add(prev + ">" + s);
            var ticks = new List<int>();
            a.Room.CountdownUpdated += c => ticks.Add((int)Math.Round(c.RemainingMs / 100.0) * 100);
            host.Room.Start();
            r.Flush();
            Assert.Equal(RoomState.Countdown, host.Room.State);
            Assert.Equal(RoomState.Countdown, a.Room.State);
            Assert.Equal(3000, a.Room.Countdown!.Total);
            Assert.Equal(LobbyPhase.Lobby, a.Phase);
            r.Wait(1100);
            Assert.InRange(a.Room.Countdown!.RemainingMs, 1501, 2000);
            r.Wait(2200);
            foreach (var l in new[] { host, a })
            {
                Assert.Equal(RoomState.Started, l.Room.State);
                Assert.Equal(LobbyPhase.InGame, l.Phase);
                Assert.Null(l.Room.Countdown);
            }
            Assert.Equal(new[] { "Lobby>Countdown", "Countdown>Started" }, log);
            Assert.Equal(3000, ticks[0]);
            Assert.True(ticks.Count >= 3);
        }

        [Fact]
        public void TheCountdownIsCancelableAndAJoinerSeesWhy()
        {
            var r = new RoomRig();
            var (_, host) = r.Host();
            var (_, a) = r.Join(host, "Ann");
            var why = new List<string>();
            a.Room.CountdownCancelled += w => why.Add(w);
            host.Room.Start();
            r.Wait(1200);
            host.Room.CancelCountdown();
            r.Flush();
            Assert.Equal(new[] { "host" }, why);
            Assert.Equal(RoomState.Lobby, a.Room.State);
            r.Wait(5000);
            Assert.Equal(LobbyPhase.Lobby, host.Phase);
            Assert.Equal(LobbyPhase.Lobby, a.Phase);
        }

        [Fact]
        public void StartRefusesOutsideTheLobbyAndBelowMinPlayers()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(new RoomOptions { MinPlayers = 2, CountdownSeconds = 0 });
            Assert.StartsWith("not_enough_players", RoomRig.Throws(() => host.Room.Start()));
            var (_, a) = r.Join(host, "Ann");
            host.Room.Start();
            r.Flush();
            Assert.Equal(RoomState.Started, host.Room.State);
            Assert.Equal(LobbyPhase.InGame, a.Phase);
            Assert.StartsWith("wrong_state", RoomRig.Throws(() => host.Room.Start()));
        }

        [Fact]
        public void AJoinersRequestRaisesTheHostEventAndChangesNothing()
        {
            var r = new RoomRig();
            var (_, host) = r.Host();
            var (_, a) = r.Join(host, "Ann");
            var asked = new List<string>();
            host.Room.Requested += (id, what) => asked.Add(id + ":" + what);
            a.Room.Request(RoomRequest.Rematch);
            r.Flush();
            Assert.Equal(new[] { "2:Rematch" }, asked);
            Assert.Equal(RoomState.Lobby, host.Room.State);
        }

        [Fact]
        public void AllReadyAutoStartCountsDownAndCancelsWhenSomeoneIsNotReady()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(new RoomOptions { AutoStart = AutoStartMode.AllReady, MinPlayers = 2, CountdownSeconds = 3 });
            var (_, a) = r.Join(host, "Ann");
            var why = new List<string>();
            a.Room.CountdownCancelled += w => why.Add(w);
            host.Room.SetReady(true);
            r.Flush();
            Assert.Equal(RoomState.Lobby, host.Room.State);
            a.Room.SetReady(true);
            r.Flush();
            Assert.Equal(RoomState.Countdown, host.Room.State);
            Assert.Equal(RoomState.Countdown, a.Room.State);
            r.Wait(1000);
            a.Room.SetReady(false);
            r.Flush();
            Assert.Equal(RoomState.Lobby, host.Room.State);
            Assert.Equal(new[] { "condition" }, why);
            a.Room.SetReady(true);
            r.Flush();
            r.Wait(3300);
            Assert.Equal(LobbyPhase.InGame, host.Phase);
            Assert.Equal(LobbyPhase.InGame, a.Phase);
        }

        [Fact]
        public void PlayersModeStartsWhenEnoughAreConnectedAndALeaverCancelsIt()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(new RoomOptions { AutoStart = AutoStartMode.Players, AutoStartPlayers = 3, CountdownSeconds = 2 });
            var (_, a) = r.Join(host, "Ann");
            Assert.Equal(RoomState.Lobby, host.Room.State);
            var (_, b) = r.Join(host, "Bob");
            Assert.Equal(RoomState.Countdown, host.Room.State);
            _ = a.LeaveAsync();
            r.Flush();
            Assert.Equal(RoomState.Lobby, host.Room.State);
            Assert.Equal(RoomState.Lobby, b.Room.State);
            r.Join(host, "Cara");
            r.Wait(2300);
            Assert.Equal(LobbyPhase.InGame, host.Phase);
        }

        [Fact]
        public void BackToLobbyResetsReadyKeepsLinksAndRosterThenRematches()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(new RoomOptions { CountdownSeconds = 0 });
            var (_, a) = r.Join(host, "Ann", new RoomJoinOptions { Data = RoomRig.D(("color", "#112233")) });
            host.Room.SetReady(true);
            a.Room.SetReady(true);
            r.Flush();
            host.Room.Start();
            r.Flush();
            Assert.Equal(LobbyPhase.InGame, a.Phase);
            var got = new List<byte[]>();
            a.MessageReceived += (f, bytes, ch) => got.Add(bytes.ToArray());
            var log = new List<string>();
            a.Room.BackedToLobby += () => log.Add("back");
            host.Room.BackToLobby();
            r.Flush();
            foreach (var l in new[] { host, a })
            {
                Assert.Equal(RoomState.Lobby, l.Room.State);
                Assert.Equal(LobbyPhase.Lobby, l.Phase);
                Assert.All(l.Room.Players, p => Assert.False(p.Ready));
                Assert.Equal(new[] { 0, 1 }, l.Room.Players.Select(p => p.Seat));
            }
            Assert.Equal("#112233", a.Room.Me!.Data["color"]);
            Assert.Equal(new[] { "back" }, log);
            host.Send(2, new byte[] { 7, 7 });
            r.Flush();
            Assert.Equal(new[] { new byte[] { 7, 7 } }, got);
            host.Room.Rematch();
            r.Flush();
            Assert.Equal(RoomState.Started, host.Room.State);
            Assert.Equal(LobbyPhase.InGame, a.Phase);
            host.Room.BackToLobby();
            host.Room.BackToLobby(); // a no-op in the lobby
            r.Flush();
            Assert.Equal(RoomState.Lobby, host.Room.State);
        }

        [Fact]
        public void ARematchRightBehindBackToLobbyIsNotUndoneByTheHubsLateEcho()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(new RoomOptions { CountdownSeconds = 0 });
            var (_, a) = r.Join(host, "Ann");
            host.Room.Start();
            r.Flush();
            host.Room.Rematch();
            r.Flush();
            r.Wait(500);
            Assert.Equal(LobbyPhase.InGame, host.Phase);
            Assert.Equal(RoomState.Started, host.Room.State);
            Assert.Equal(LobbyPhase.InGame, a.Phase);
        }

        [Fact]
        public void AutoStartWaitsForTheNextChangeAfterBackToLobby()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(new RoomOptions { AutoStart = AutoStartMode.Players, AutoStartPlayers = 2, CountdownSeconds = 0 });
            var (_, a) = r.Join(host, "Ann");
            r.Flush();
            Assert.Equal(RoomState.Started, host.Room.State);
            host.Room.BackToLobby();
            r.Flush();
            Assert.Equal(RoomState.Lobby, host.Room.State); // not instantly started again
            r.Join(host, "Bob");
            r.Flush();
            Assert.Equal(RoomState.Started, host.Room.State);
            Assert.Equal(RoomState.Started, a.Room.State);
        }

        [Fact]
        public void ALockstepMatchRestartsFromTickOneWithEqualState()
        {
            var r = new RoomRig();
            var host = r.R.NewPlayer("host");
            host.Attach(r.R.Await(host.Client.HostAsync(new LobbyOptions("t", 4) { Room = new RoomOptions { CountdownSeconds = 0 } })));
            var ann = r.R.Join(host.Lobby.Code, "ann");
            r.Flush();
            host.Lobby.Room.Start();
            r.Flush();
            host.Paint(3, 3);
            r.R.Step(80);
            Assert.True(host.Game.Tick > 20);
            host.Lobby.Room.BackToLobby();
            r.R.Step(10);
            Assert.Equal(LobbyPhase.Lobby, ann.Lobby.Phase);
            host.Lobby.Room.Start();
            host.Game = new GridpaintGame(host.Lobby.Code);
            ann.Game = new GridpaintGame(ann.Lobby.Code);
            host.Hashes.Clear();
            ann.Hashes.Clear();
            r.R.Step(5);
            host.Paint(5, 5);
            r.R.Step(80);
            Assert.True(host.Game.Tick > 20);
            Assert.True(ann.Game.Tick > 20);
            Assert.Empty(ann.Desyncs);
            Assert.True(Rig.CompareHashes(host, ann) > 0);
            Assert.Equal(host.Game.Grid.ToArray(), ann.Game.Grid.ToArray());
        }

        [Fact]
        public void SpectatorsHaveNoSeatAreNotCountedAndAreCapped()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(new RoomOptions { Spectators = 1 }, max: 2);
            r.Join(host, "Ann");
            var (_, s) = r.Join(host, "Spec", new RoomJoinOptions { Role = RoomRole.Spectator });
            Assert.Equal((RoomRole.Spectator, -1), (s.Room.Me!.Role, s.Room.Me.Seat));
            Assert.Equal(new[] { "Host", "Ann" }, RoomRig.Names(host));
            Assert.Equal(new[] { "Spec" }, host.Room.Spectators.Select(p => p.Name));
            var e = Assert.Throws<OneLobbyException>(() => r.R.Await(r.NewKit("Late").Client.JoinAsync(host.Code)));
            Assert.Equal("lobby_full", e.Code);
        }

        [Fact]
        public void TheHostMovesPlayersAndSpectatorsCapacityRulesApply()
        {
            var r = new RoomRig();
            var (_, host) = r.Host(new RoomOptions { Spectators = 2 }, max: 2);
            var (_, a) = r.Join(host, "Ann");
            var (_, s) = r.Join(host, "Spec", new RoomJoinOptions { Role = RoomRole.Spectator });
            var rejected = new List<string>();
            s.Room.Rejected += (c, re, k) => rejected.Add(c);
            s.Room.SetRole(RoomRole.Player);
            r.Flush();
            Assert.Equal(new[] { "lobby_full" }, rejected);
            host.Room.MoveTo(2, RoomRole.Spectator);
            r.Flush();
            var me = a.Room.Me!;
            Assert.Equal((RoomRole.Spectator, -1, false), (me.Role, me.Seat, me.Ready));
            s.Room.SetRole(RoomRole.Player);
            r.Flush();
            Assert.Equal((RoomRole.Player, 1), (s.Room.Me!.Role, s.Room.Me.Seat));
            Assert.StartsWith("lobby_full", RoomRig.Throws(() => host.Room.MoveTo(2, RoomRole.Player)));
            Assert.StartsWith("not_allowed", RoomRig.Throws(() => host.Room.MoveTo(99, RoomRole.Player)));
        }

        [Theory]
        [InlineData(LateJoinPolicy.Allow)]
        [InlineData(LateJoinPolicy.Spectate)]
        [InlineData(LateJoinPolicy.Refuse)]
        public void LateJoinPolicy_AllowSpectateAndRefuseOnceStarted(LateJoinPolicy policy)
        {
            var r = new RoomRig();
            var (_, host) = r.Host(new RoomOptions { LateJoin = policy, Spectators = 2, CountdownSeconds = 0 }, max: 3);
            r.Join(host, "Ann");
            host.Room.Start();
            r.Flush();
            var k = r.NewKit("Late");
            if (policy == LateJoinPolicy.Refuse)
            {
                // the hub refuses it: lateJoin false means in_game
                Assert.Equal("in_game", Assert.Throws<OneLobbyException>(() => r.R.Await(k.Client.JoinAsync(host.Code))).Code);
                return;
            }
            var l = r.R.Await(k.Client.JoinAsync(host.Code));
            r.Flush();
            var want = policy == LateJoinPolicy.Allow ? RoomRole.Player : RoomRole.Spectator;
            Assert.Equal(want, l.Room.Me!.Role);
            Assert.Equal(want, host.Room.Entries.First(e => e.Name == "Late").Role);
        }

        [Fact]
        public void RefuseIsEnforcedByTheHostsRoomOnAHubThatLetsTheJoinerIn()
        {
            var r = new RoomRig(roomHub: false);
            var (_, host) = r.Host(new RoomOptions { LateJoin = LateJoinPolicy.Refuse, CountdownSeconds = 0 });
            // an old hub sees lateJoin false for refuse; let it admit anyway, as an older hub that ignores the field would
            host.Room.Start();
            r.Flush();
            var k = r.NewKit("Late");
            Lobby l;
            try { l = r.R.Await(k.Client.JoinAsync(host.Code)); }
            catch (OneLobbyException e) { Assert.Equal("in_game", e.Code); return; } // the hub itself said no: also correct
            var removed = new List<string>();
            l.Room.Removed += i => removed.Add(i.Code + "|" + i.Reason);
            r.Flush();
            Assert.Equal(new[] { "in_game|The game has already started." }, removed);
            Assert.Equal("in_game", l.Removal!.Code);
            Assert.Equal(new[] { "Host" }, host.Room.Entries.Select(e => e.Name));
        }
    }
}
