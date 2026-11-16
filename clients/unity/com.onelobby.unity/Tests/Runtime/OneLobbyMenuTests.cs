#nullable enable
using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;

namespace OneLobby.Unity.PlayTests
{
    /// <summary>
    /// The drop-in menu, in Play mode (UI Toolkit panels only lay out in the player loop), with no socket: every menu drives a
    /// <see cref="LobbyClient"/> on one <see cref="InMemoryNetwork"/>, and every menu has a counted fake connection check, so nothing
    /// here reaches the network or a public STUN server. The port of <c>MenuSelfCheck.cs</c> of the Godot C# demo; the main test ends
    /// with the log line <c>MENU_OK</c>.
    /// <code>Unity -batchmode -nographics -projectPath P -runTests -testPlatform PlayMode -testFilter OneLobby.Unity.PlayTests</code>
    /// </summary>
    public sealed class OneLobbyMenuTests
    {
        private const string Relay = "turn:127.0.0.1:9 samuser sampass77";

        private InMemoryNetwork _net = null!;
        private readonly List<GameObject> _objects = new();
        private readonly List<string> _logged = new();
        private int _checks;

        private sealed class P
        {
            public OneLobbyMenu Menu = null!;
            public int Started, Back, Left, Runs;
            public MenuModel M => Menu.Model!;
            public VisualElement Q(string name) => Menu.Q(name) ?? throw new AssertionException("no control named " + name);
            public T Q<T>(string name) where T : VisualElement => Menu.Q<T>(name) ?? throw new AssertionException("no " + typeof(T).Name + " named " + name);
        }

        [SetUp]
        public void SetUp()
        {
            _net = new InMemoryNetwork();
            _objects.Clear();
            _logged.Clear();
            _checks = 0;
            Application.logMessageReceived += OnLog;
        }

        [TearDown]
        public void TearDown()
        {
            Application.logMessageReceived -= OnLog;
            foreach (var go in _objects)
                if (go != null) UnityEngine.Object.Destroy(go);
            _objects.Clear();
            MenuText.Override(null);
        }

        private void OnLog(string condition, string stack, LogType type) => _logged.Add(condition);

        private void Check(bool ok, string what)
        {
            _checks++;
            Assert.IsTrue(ok, what);
        }

        // ---- rig ------------------------------------------------------------------------------------------------------------

        private IEnumerator Frames(int n)
        {
            for (var i = 0; i < n; i++)
            {
                _net.Advance(33);
                yield return null;
            }
        }

        private IEnumerator Until(Func<bool> cond, string what, int maxFrames = 900)
        {
            for (var i = 0; i < maxFrames && !cond(); i++)
            {
                _net.Advance(33);
                yield return null;
            }
            Check(cond(), "timed out waiting for: " + what);
        }

        private IEnumerator Wait(Task t)
        {
            while (!t.IsCompleted) yield return null;
            if (t.IsFaulted) throw t.Exception!;
        }

        /// <summary>
        /// A menu on the in-memory network. Its connection check is always a counted fake (<c>Runs</c>), so no test reaches the internet;
        /// <paramref name="answer"/> is the fake's NAT type and <paramref name="gate"/> holds its answer until set.
        /// </summary>
        private P NewPlayer(string name, string answer = "cone", TaskCompletionSource<bool>? gate = null, string[]? args = null, string? blueprint = null, bool bootFlags = false)
        {
            var config = new OneLobbyConfig("menu-test", "1", new Uri("ws://mem/ws"), SyncMode.Raw, 20, 20, "") { SettingsEnv = PlayerSettings.NoEnvironment };
            var go = new GameObject("menu " + name);
            _objects.Add(go);
            var menu = go.AddComponent<OneLobbyMenu>();
            menu.Client = blueprint == null
                ? new LobbyClient(config, _net.CreateTransport())
                : LobbyClient.FromBlueprint(Blueprint.Parse(blueprint), _net.CreateTransport(), "", configure: c => c with { SettingsEnv = PlayerSettings.NoEnvironment });
            var p = new P { Menu = menu };
            menu.CheckRunner = async _ =>
            {
                p.Runs++;
                if (gate != null) await gate.Task;
                var v = Diagnose.CheckVerdict(new CheckFindings("ok", answer, "none"));
                return new CheckResult("ok", answer, "none", v.Verdict, v.Message);
            };
            menu.BootArgs = args ?? Array.Empty<string>();
            menu.BootFlags = bootFlags;
            menu.HostOptions = new LobbyOptions(name + "'s game", 4) { Room = new RoomOptions { CountdownSeconds = 1 } };
            menu.GameStarted += _ => p.Started++;
            menu.ReturnedToLobby += _ => p.Back++;
            menu.Left += () => p.Left++;
            return p;
        }

        private static void Click(VisualElement e)
        {
            using var ev = NavigationSubmitEvent.GetPooled();
            ev.target = e;
            e.SendEvent(ev);
        }

        private static void Enter(VisualElement e)
        {
            using var ev = KeyDownEvent.GetPooled('\n', KeyCode.Return, EventModifiers.None);
            ev.target = e;
            e.SendEvent(ev);
        }

        private static void CancelKey(P p)
        {
            var target = p.Menu.Root!.panel.focusController.focusedElement as VisualElement ?? p.Menu.Root;
            using var ev = NavigationCancelEvent.GetPooled();
            ev.target = target;
            target.SendEvent(ev);
        }

        private static void EscapeKey(P p)
        {
            var target = p.Menu.Root!.panel.focusController.focusedElement as VisualElement ?? p.Menu.Root;
            using var ev = KeyDownEvent.GetPooled('\u001b', KeyCode.Escape, EventModifiers.None);
            ev.target = target;
            target.SendEvent(ev);
        }

        private static bool Shown(VisualElement e)
        {
            for (var x = e; x != null; x = x.parent)
                if (x.style.display == DisplayStyle.None) return false;
            return true;
        }

        private static IEnumerable<string> AllTexts(VisualElement root)
        {
            foreach (var l in root.Query<Label>().ToList()) yield return l.text ?? "";
            foreach (var b in root.Query<Button>().ToList()) yield return b.text ?? "";
            foreach (var t in root.Query<TextField>().ToList()) yield return t.value ?? "";
        }

        private static string Texts(VisualElement e) => string.Join("\n", AllTexts(e));

        private static Label LabelOf(VisualElement e, string text) => e.Query<Label>().ToList().First(l => l.text.Contains(text));

        private static Button ButtonOf(VisualElement e, string text) => e.Query<Button>().ToList().First(b => b.text == text);

        private static void SetPanelSize(P p, int w, int h)
        {
            var doc = p.Menu.GetComponentInChildren<UIDocument>();
            var rt = new RenderTexture(w, h, 0);
            rt.Create();
            doc.panelSettings.targetTexture = rt;
        }

        private IEnumerator HostLobby(P a)
        {
            Click(a.Q("HostButton"));
            yield return Until(() => a.M.RoomActive && a.M.Lobby!.Room.Me != null, "hosting reaches its room");
        }

        private IEnumerator JoinByCode(P b, string code)
        {
            b.Q<TextField>("JoinEdit").value = code.ToLowerInvariant();
            Click(b.Q("JoinButton"));
            yield return Until(() => b.M.Screen == MenuScreen.Lobby && b.M.RoomActive && b.M.Lobby!.Room.Me != null, "joining reaches the room");
        }

        // ---- the main flow -------------------------------------------------------------------------------------------------------

        [UnityTest]
        public IEnumerator HostJoinReadyStartKickBanChatSettings()
        {
            var a = NewPlayer("Sam");
            yield return Frames(4);
            Check(a.M.Screen == MenuScreen.Start && Shown(a.Q("StartPage")) && !Shown(a.Q("LobbyPage")), "the start screen shows first");
            Check(a.Menu.FocusedControl == "HostButton", "focus lands on Host when the start screen opens, was '" + a.Menu.FocusedControl + "'");
            var b = NewPlayer("Ann"); // keyboard focus is one per window: a menu made later takes it, so focus is checked where it was the last to ask
            yield return Frames(3);

            // host through the controls
            a.Q<TextField>("NameEdit").value = "Sam";
            var copied = "";
            a.M.Clipboard = text => copied = text;
            yield return HostLobby(a);
            Check(a.M.Screen == MenuScreen.Lobby && Shown(a.Q("LobbyPage")) && !Shown(a.Q("StartPage")), "Host opens the lobby screen");
            Check(a.M.NameText == "Sam", "the name typed is the name used");
            var code = a.M.CodeText();
            Check(code.Length > 0 && a.Q<Label>("CodeLabel").text == code, "the lobby shows the code, large");
            Click(a.Q("CopyCodeButton"));
            Check(copied == code, "Copy code copies the code");
            Click(a.Q("CopyInviteButton"));
            Check(copied.Contains(code) && copied.StartsWith("Join my game"), "Copy invite copies the invite sentence: " + copied);
            yield return Frames(2);
            Check(a.Menu.FocusedControl == "ReadyButton", "the lobby's focus lands on Ready (the host is a player too), was '" + a.Menu.FocusedControl + "'");

            // the second player joins by the code
            b.Q<TextField>("NameEdit").value = "Ann";
            yield return JoinByCode(b, code);
            yield return Until(() => a.M.RosterRows().Count == 2 && b.M.RosterRows().Count == 2, "both see two players");
            yield return Frames(2);
            var hostRows = a.Q("RosterList").Children().ToList();
            Check(hostRows.Count == 2, "the host's roster has two rows, has " + hostRows.Count);
            Check(Texts(a.Q("RosterList")).Contains("Sam (you)") && Texts(a.Q("RosterList")).Contains("Ann"), "the roster names both players: " + Texts(a.Q("RosterList")));
            Check(Texts(a.Q("RosterList")).Contains("Host"), "the host row carries the Host mark");
            Check(a.Q("RosterList").Query<Button>().ToList().Count(x => x.text == "Kick") == 1 && a.Q("RosterList").Query<Button>().ToList().Count(x => x.text == "Ban") == 1,
                "the host can kick and ban the other player, once");
            Check(b.Q("RosterList").Query<Button>().ToList().Count == 0, "the joiner has no kick or ban buttons");
            Check(a.Q<Label>("PlayersHeader").text == "Players 2/4", "the header counts players: " + a.Q<Label>("PlayersHeader").text);
            Check(!Shown(b.Q("StartButton")) && Shown(b.Q("ReadyButton")), "the joiner has Ready and no Start");
            Check(b.Q<Label>("LobbyNote").text == "Waiting for the host to start the game.", "the joiner is told to wait");
            Check(b.Menu.FocusedControl == "ReadyButton", "the joiner's focus lands on Ready, was '" + b.Menu.FocusedControl + "'");

            // ready
            Click(b.Q("ReadyButton"));
            yield return Until(() => a.M.RosterRows().Any(r => r.Ready), "ready shows on the host");
            yield return Frames(2);
            Check(Texts(a.Q("RosterList")).Contains("Ready"), "the Ready mark is drawn");
            Check(b.Q<Button>("ReadyButton").text == "Not ready", "the Ready button reads Not ready after");

            // chat
            b.Q<TextField>("ChatEdit").value = "gg";
            Enter(b.Q("ChatEdit"));
            yield return Until(() => a.M.ChatLines.Count == 1 && b.M.ChatLines.Count == 1, "the chat line arrives");
            yield return Frames(2);
            Check(a.Q<Label>("ChatLog").text == "Ann: gg", "the chat log shows the line: " + a.Q<Label>("ChatLog").text);
            Check(b.Q<TextField>("ChatEdit").value == "", "Enter sends the chat line and clears the box");

            // host settings
            Click(a.Q("LobbySettingsToggle"));
            yield return Frames(2);
            Check(Shown(a.Q("LobbySettingsBox")) && Shown(a.Q("AutoStartOption")) && Shown(a.Q("LateJoinCheck")), "the lobby settings box opens");
            a.Q<IntegerField>("CountdownSpin").value = 2;
            yield return Until(() => a.M.LobbySettings()!.CountdownSeconds == 2, "the host changes the countdown");
            a.Q<IntegerField>("CountdownSpin").value = 1;
            yield return Until(() => a.M.LobbySettings()!.CountdownSeconds == 1, "the host changes it back");

            // countdown, the game, back to the lobby
            Click(a.Q("StartButton"));
            yield return Until(() => a.M.CountingDown && b.M.CountingDown, "the countdown shows on both");
            yield return Frames(2);
            Check(Shown(a.Q("CancelStartButton")) && Shown(a.Q("CountdownLabel")) && a.Q<Label>("CountdownLabel").text.StartsWith("Starting in"), "Cancel start and the countdown label show: " + a.Q<Label>("CountdownLabel").text);
            Check(Shown(b.Q("CountdownLabel")) && !Shown(b.Q("CancelStartButton")), "the joiner sees the countdown and no Cancel start");
            yield return Until(() => a.Started == 1 && b.Started == 1, "GameStarted on both");
            Check(!a.Menu.IsShown && !b.Menu.IsShown, "the menus hide while the game runs");
            a.M.Lobby!.Room.BackToLobby();
            yield return Until(() => a.Back == 1 && b.Back == 1, "ReturnedToLobby on both");
            Check(a.Menu.IsShown && b.Menu.IsShown && Shown(a.Q("LobbyPage")), "the menus show again");

            // kick with a reason: the removed screen reads it
            a.Q<TextField>("ReasonEdit").value = "be nice";
            Click(ButtonOf(a.Q("RosterList"), "Kick"));
            yield return Until(() => b.M.Screen == MenuScreen.Error, "the kicked player lands on the error screen");
            yield return Frames(2);
            Check(Shown(b.Q("ErrorPage")) && b.Q<Label>("ErrorTitle").text == "You were removed", "the removed screen has its title: " + b.Q<Label>("ErrorTitle").text);
            Check(b.Q<Label>("ErrorMessage").text == "be nice", "the removed screen reads the host's reason: " + b.Q<Label>("ErrorMessage").text);
            Check(a.Q<TextField>("ReasonEdit").value == "", "the reason box is cleared after a kick");
            Check(b.Menu.FocusedControl == "ErrorBackButton", "the error screen's focus lands on Back, was '" + b.Menu.FocusedControl + "'");
            Click(b.Q("ErrorBackButton"));
            Check(b.M.Screen == MenuScreen.Start, "Back leaves the removed screen");

            // ban with a reason, refused rejoin, unban, in again
            yield return JoinByCode(b, code);
            yield return Until(() => a.M.RosterRows().Count == 2, "the kicked player can come back");
            yield return Frames(2);
            a.Q<TextField>("ReasonEdit").value = "just a test";
            Click(ButtonOf(a.Q("RosterList"), "Ban"));
            yield return Until(() => b.M.Screen == MenuScreen.Error && a.M.BanRows().Count == 1, "the banned player lands on the error screen and the ban list has a row");
            yield return Frames(2);
            Check(b.Q<Label>("ErrorTitle").text == "You were banned" && b.Q<Label>("ErrorMessage").text == "just a test", "the ban reads with the host's reason: " + b.Q<Label>("ErrorMessage").text);
            Check(Shown(a.Q("BansHeader")) && Texts(a.Q("BansList")).Contains("just a test") && a.Q("BansList").Query<Button>().ToList().Any(x => x.text == "Unban"), "the host's ban list shows the row with Unban: " + Texts(a.Q("BansList")));
            Click(b.Q("ErrorBackButton"));
            b.Q<TextField>("JoinEdit").value = code;
            Click(b.Q("JoinButton"));
            yield return Until(() => b.M.Screen == MenuScreen.Error, "a banned player's rejoin ends on the error screen");
            Check(b.M.Lobby == null, "the refused rejoin holds no lobby (error code " + b.M.Error.Code + ")");
            Click(b.Q("ErrorBackButton"));
            Click(ButtonOf(a.Q("BansList"), "Unban"));
            yield return Frames(2);
            Check(a.M.BanRows().Count == 0 && !Shown(a.Q("BansHeader")), "Unban empties the ban list");
            yield return JoinByCode(b, code);
            yield return Until(() => a.M.RosterRows().Count == 2 && b.M.RosterRows().Count == 2, "an unbanned player gets back in");

            // settings: a saved relay line is masked everywhere
            Click(b.Q("LeaveButton"));
            yield return Until(() => b.M.Screen == MenuScreen.Start && b.Left == 1, "Leave goes back to the start screen and raises Left");
            Click(b.Q("SettingsButton"));
            yield return Frames(2);
            Check(b.M.Screen == MenuScreen.Settings && Shown(b.Q("SettingsPage")), "Settings opens");
            Check(b.Menu.FocusedControl == "RelayEdit", "the settings focus lands on the relay box, was '" + b.Menu.FocusedControl + "'");
            b.Q<TextField>("RelayEdit").value = Relay;
            Click(b.Q("RelaySaveButton"));
            yield return Frames(2);
            Check(b.Q<TextField>("RelayEdit").value == "", "the relay box is cleared after Save");
            Check(b.Q<Label>("RelayStatus").text.Contains("<hidden>") && b.Q<Label>("RelayNote").text == "Relay saved.", "the relay shows only masked: " + b.Q<Label>("RelayStatus").text);
            AssertRelayHidden(b);
            Click(b.Q("ConnectionCheckButton"));
            yield return Until(() => !b.M.CheckRunning && b.Runs == 2, "the button runs the check (once on open, once by the button)");
            Check(b.Q<Label>("CheckFacts").text.Count(c => c == '\n') == 2 && b.Q<Label>("CheckVerdict").text.Length > 0, "the verdict and three facts are drawn");
            AssertRelayHidden(b);
            Click(b.Q("SettingsBackButton"));
            Check(b.M.Screen == MenuScreen.Start, "Back leaves Settings");

            // the error screen for a bad code, with its logs
            b.Q<TextField>("JoinEdit").value = "hello";
            Click(b.Q("JoinButton"));
            yield return Frames(2);
            Check(b.M.Screen == MenuScreen.Error && b.Q<Label>("ErrorMessage").text == "That doesn't look like a lobby code.", "a bad code shows the plain sentence: " + b.Q<Label>("ErrorMessage").text);
            Check(Shown(b.Q("CopyLogsButton")) && Shown(b.Q("SaveLogsButton")), "the error screen offers Copy logs and Save logs");
            var logCopy = "";
            b.M.Clipboard = text => logCopy = text;
            Click(b.Q("CopyLogsButton"));
            yield return Frames(2);
            Check(Shown(b.Q("LogNote")) && b.Q<Label>("LogNote").text.StartsWith("Logs copied"), "Copy logs says so: " + b.Q<Label>("LogNote").text);
            Check(!logCopy.Contains("sampass77"), "the copied logs hold no relay secret");
            Click(b.Q("ErrorBackButton"));

            Debug.Log($"MENU_OK ({_checks} checks)");
        }

        private void AssertRelayHidden(P p)
        {
            var all = Texts(p.Menu.Root!);
            Check(!all.Contains("samuser") && !all.Contains("sampass77"), "the relay line is in no label, button or field");
            Check(!p.M.RelayStatusText().Contains("sampass77") && !p.M.RelayNote.Contains("sampass77") && !p.M.ServerText.Contains("sampass77"), "the relay line is in no model text");
            Check(!p.M.Client.NetLog.Export().Contains("sampass77"), "the relay line is not in the net log");
            Check(!_logged.Any(l => l.Contains("sampass77") || l.Contains("samuser")), "the relay line is not in the Unity console");
        }

        // ---- Escape and Tab ------------------------------------------------------------------------------------------------------

        [UnityTest]
        public IEnumerator EscapeGoesBackOneScreenOnEveryScreen()
        {
            var a = NewPlayer("Sam");
            yield return Frames(4);
            var m = a.M;

            CancelKey(a);
            Check(m.Screen == MenuScreen.Start, "Escape on the start screen does nothing");

            Click(a.Q("SettingsButton"));
            yield return Frames(2);
            CancelKey(a);
            Check(m.Screen == MenuScreen.Start, "Escape leaves Settings");

            Click(a.Q("BrowseButton"));
            yield return Until(() => m.Screen == MenuScreen.Browse && m.BrowseStatus != MenuText.T("browse_loading"), "browse loads");
            yield return Frames(2);
            Check(Shown(a.Q("BrowsePage")) && a.Menu.FocusedControl == "BrowseBackButton", "an empty browse screen focuses Back, was '" + a.Menu.FocusedControl + "'");
            EscapeKey(a);
            Check(m.Screen == MenuScreen.Start, "the Escape key leaves Browse");
            yield return null;

            a.Q<TextField>("JoinEdit").value = "hello";
            Click(a.Q("JoinButton"));
            yield return Frames(2);
            Check(m.Screen == MenuScreen.Error, "a bad code shows the error screen");
            CancelKey(a);
            Check(m.Screen == MenuScreen.Start, "Escape leaves the error screen");
            yield return null;

            // connecting: nothing pumps the client, so the answer never arrives
            a.Menu.Pump = false;
            a.Q<TextField>("JoinEdit").value = "7HQ 4K2";
            Click(a.Q("JoinButton"));
            yield return Frames(2);
            Check(m.Screen == MenuScreen.Connecting && Shown(a.Q("ConnectingPage")) && a.Menu.FocusedControl == "ConnectingCancel", "the connecting screen focuses Cancel, was '" + a.Menu.FocusedControl + "'");
            CancelKey(a);
            Check(m.Screen == MenuScreen.Start, "Escape while connecting cancels");
            a.Menu.Pump = true;
            yield return Frames(30);
            Check(m.Screen == MenuScreen.Start, "a failure that arrives after Cancel is not shown");

            // the lobby: Escape leaves it
            yield return HostLobby(a);
            yield return Frames(2);
            CancelKey(a);
            yield return Until(() => m.Screen == MenuScreen.Start && a.Left == 1, "Escape in the lobby leaves it and raises Left");
            yield return Frames(2);
            Check(Shown(a.Q("StartPage")), "the start screen is back");

            // Escape does not fire twice for one press (a key press and a cancel event in the same frame)
            Click(a.Q("SettingsButton"));
            yield return Frames(2);
            Click(a.Q("SettingsButton"));
            CancelKey(a);
            EscapeKey(a);
            Check(m.Screen == MenuScreen.Start, "one press goes back once");
        }

        [UnityTest]
        public IEnumerator TabWalksTheControlsInOrder()
        {
            var a = NewPlayer("Sam");
            yield return Frames(4);
            Check(a.Menu.FocusedControl == "HostButton", "start: focus on Host, was '" + a.Menu.FocusedControl + "'");
            // Tab follows document order among the shown controls that take focus (every tabIndex is 0). The Tab key itself reaches the panel
            // through the engine's input module, which no batchmode test can press; what is checked is the order the controls are built in.
            var order = a.Menu.Root!.Query<VisualElement>().ToList()
                .Where(e => !string.IsNullOrEmpty(e.name) && OneLobbyMenu.ControlNames.Contains(e.name) && e.focusable && e.tabIndex == 0 && Shown(e) && e is not Label)
                .Select(e => e.name).ToList();
            Debug.Log("TAB_ORDER " + string.Join(" > ", order));
            Check(order.SequenceEqual(new[] { "NameEdit", "HostButton", "JoinEdit", "PasswordEdit", "JoinButton", "BrowseButton", "SettingsButton" }), "Tab order on the start screen: " + string.Join(" > ", order));
        }

        // ---- layout at two sizes ---------------------------------------------------------------------------------------------------

        [UnityTest]
        public IEnumerator EveryNamedControlExistsAndHasASizeAtBothResolutions([ValueSource(nameof(Sizes))] Vector2Int size)
        {
            var tag = size.x + "x" + size.y;
            var a = NewPlayer("Sam");
            yield return Frames(4);
            SetPanelSize(a, size.x, size.y);
            yield return Frames(3);
            foreach (var n in OneLobbyMenu.ControlNames) Check(a.Menu.Q(n) != null, $"{tag}: control {n} exists");
            var m = a.M;

            yield return Audit(a, tag + " start", true);

            Click(a.Q("SettingsButton"));
            yield return Frames(1);
            a.Q<TextField>("RelayEdit").value = Relay;
            Click(a.Q("RelaySaveButton"));
            yield return Audit(a, tag + " settings", true);
            Click(a.Q("ConnectionCheckButton"));
            yield return Until(() => !m.CheckRunning && m.CheckFacts.Count == 3, tag + " check finishes");
            yield return Audit(a, tag + " settings after a check", false);
            CancelKey(a);

            Click(a.Q("BrowseButton"));
            yield return Until(() => m.Screen == MenuScreen.Browse && m.BrowseStatus != MenuText.T("browse_loading"), tag + " browse loads");
            yield return Audit(a, tag + " browse", true);
            CancelKey(a);
            yield return null;

            a.Q<TextField>("JoinEdit").value = "hello";
            Click(a.Q("JoinButton"));
            yield return Audit(a, tag + " error", true);
            CancelKey(a);
            yield return null;

            a.Menu.Pump = false;
            a.Q<TextField>("JoinEdit").value = "7HQ 4K2";
            Click(a.Q("JoinButton"));
            yield return Audit(a, tag + " connecting", true);
            CancelKey(a);
            a.Menu.Pump = true;
            yield return Frames(2);

            yield return HostLobby(a);
            yield return Audit(a, tag + " lobby (host)", true);
            var b = NewPlayer("Ann");
            yield return Frames(3);
            yield return JoinByCode(b, m.CodeText());
            yield return Until(() => m.RosterRows().Count == 2, tag + " both see two players");
            m.SendChat("hello from the host");
            yield return Until(() => b.M.ChatLines.Count == 1, tag + " chat arrives");
            SetPanelSize(b, size.x, size.y);
            yield return Audit(b, tag + " lobby (joiner)", true);
            Click(a.Q("LobbySettingsToggle"));
            yield return Audit(a, tag + " lobby with settings (host)", false);
            Click(b.Q("ReadyButton"));
            yield return Until(() => m.RosterRows().Any(r => r.Ready), tag + " ready shows");
            Click(a.Q("StartButton"));
            yield return Until(() => m.CountingDown, tag + " the countdown shows");
            yield return Audit(a, tag + " lobby with a countdown (host)", false);
            yield return Until(() => a.Started == 1 && b.Started == 1, tag + " the game starts");
            m.Lobby!.Room.BackToLobby();
            yield return Until(() => a.Back == 1 && b.Back == 1, tag + " back to the lobby");
            m.Ban(m.RosterRows().First(r => !r.Me).Id, "just a test");
            yield return Until(() => b.M.Screen == MenuScreen.Error && m.BanRows().Count == 1, tag + " the banned player lands on the error screen");
            yield return Audit(b, tag + " removed", false);
            yield return Audit(a, tag + " lobby with a ban (host)", false);
        }

        public static IEnumerable<Vector2Int> Sizes() => new[] { new Vector2Int(1280, 720), new Vector2Int(640, 360) };

        /// <summary>Everything shown has a size and sits inside the panel's width, the relay line is nowhere, and focus is on a control of the menu.</summary>
        private IEnumerator Audit(P p, string label, bool expectFocus)
        {
            yield return Frames(3);
            var root = p.Menu.Root!;
            var panelWidth = root.panel.visualTree.layout.width;
            var zero = new List<string>();
            var outside = new List<string>();
            foreach (var n in OneLobbyMenu.ControlNames)
            {
                var e = p.Q(n);
                if (!Shown(e)) continue;
                var emptyList = e.childCount == 0 && e is not Label && e is not Button && e is not TextField && e.GetType() == typeof(VisualElement);
                var r = e.worldBound;
                if ((r.width <= 0 || r.height <= 0) && !emptyList) zero.Add($"{n} {r}");
                if (r.xMax > panelWidth + 0.5f && n != "Pages") outside.Add($"{n} {r.xMax} > {panelWidth}");
            }
            Check(zero.Count == 0, $"{label}: every shown control has a size: {string.Join("; ", zero.Take(4))}");
            Check(outside.Count == 0, $"{label}: nothing runs past the right edge: {string.Join("; ", outside.Take(4))}");
            Check(!Texts(root).Contains("sampass77") && !Texts(root).Contains("samuser"), $"{label}: the relay line is in no control");
            if (expectFocus) Check(p.Menu.FocusedControl.Length > 0, $"{label}: focus is on a control of the menu");
            // every shown, enabled control can take focus (Tab can reach it)
            var stuck = new List<string>();
            foreach (var n in OneLobbyMenu.ControlNames)
            {
                var e = p.Q(n);
                if (!Shown(e) || !e.enabledSelf || !e.focusable || e is Label) continue;
                e.Focus();
                if (p.Menu.FocusedControl != n) stuck.Add(n);
            }
            Check(stuck.Count == 0, $"{label}: every shown control takes focus, not: {string.Join(", ", stuck.Take(4))}");
        }

        // ---- boot flags ----------------------------------------------------------------------------------------------------------

        [UnityTest]
        public IEnumerator BootFlagsHostAndJoin()
        {
            var host = NewPlayer("x", args: new[] { "--host", "--name=Sam" }, bootFlags: true);
            yield return Until(() => host.M != null && host.M.Screen == MenuScreen.Lobby && host.M.RoomActive, "--host hosts at once");
            Check(host.M.NameText == "Sam", "--name sets the name: " + host.M.NameText);
            var code = host.M.CodeText();
            var guest = NewPlayer("y", args: new[] { "--join=" + code, "--name=Ann" }, bootFlags: true);
            yield return Until(() => guest.M != null && guest.M.Screen == MenuScreen.Lobby && guest.M.RoomActive, "--join joins at once");
            yield return Until(() => host.M.RosterRows().Count == 2, "the host sees the guest");
            Check(guest.M.NameText == "Ann", "--name sets the guest's name");

            var off = NewPlayer("z", args: new[] { "--host" }, bootFlags: false);
            yield return Frames(6);
            Check(off.M.Screen == MenuScreen.Start, "BootFlags off ignores --host");
        }

        // ---- the connection check on open ---------------------------------------------------------------------------------------

        [UnityTest]
        public IEnumerator ConnectionCheckOnOpen()
        {
            // the default: once, when the menu opens; the warning verdict is the one line on the start screen
            var gate = new TaskCompletionSource<bool>();
            var p = NewPlayer("Sam", "symmetric", gate);
            yield return Frames(4);
            var line = p.Q<Label>("StartCheckLine");
            Check(p.Runs == 1 && p.M.CheckRunning && !Shown(line), "on open: the check runs once and the start screen says nothing while it runs");
            // Host works while the check is running
            yield return HostLobby(p);
            Check(p.M.Screen == MenuScreen.Lobby && p.M.CheckRunning, "Host works while the check is running");
            Click(p.Q("LeaveButton"));
            yield return Until(() => p.M.Screen == MenuScreen.Start, "leaving returns to the start screen");
            gate.SetResult(true);
            yield return Until(() => !p.M.CheckRunning, "the check ends");
            yield return Frames(2);
            Check(Shown(line) && line.text == "Direct connections: likely to fail. A relay is recommended.", "on open: the start screen shows the warning sentence: '" + line.text + "'");
            Check(p.Runs == 1, "coming back to the start screen did not run it again");
            Click(p.Q("SettingsButton"));
            yield return Frames(2);
            Check(p.Q<Label>("CheckVerdict").text == line.text && p.Q<Label>("CheckFacts").text.Count(c => c == '\n') == 2, "on open: Settings already shows the verdict and three facts");
            CancelKey(p);
            yield return Frames(2);
            Check(p.Runs == 1, "coming back from Settings does not run it again");

            // a good verdict says nothing on the start screen
            var good = NewPlayer("Cy", "cone");
            yield return Frames(6);
            Check(good.Runs == 1 && !good.M.CheckRunning && !Shown(good.Q("StartCheckLine")) && good.M.CheckVerdict.Length > 0, "a good verdict shows no line on the start screen");

            // --local, checkOnOpen false and showConnectionCheck false run nothing until the button
            var local = NewPlayer("Ann", args: new[] { "--local" });
            yield return Frames(6);
            Check(local.Runs == 0 && local.M.LocalOnly, "--local: the check does not run by itself");
            Click(local.Q("SettingsButton"));
            yield return Frames(2);
            Click(local.Q("ConnectionCheckButton"));
            yield return Until(() => local.Runs == 1 && !local.M.CheckRunning, "--local: the button still runs it");

            var off = NewPlayer("Bo", blueprint: @"{""game"":{""id"":""menu-test""},""diagnostics"":{""checkOnOpen"":false}}");
            yield return Frames(6);
            Check(off.Runs == 0, "checkOnOpen false: nothing runs on open");
            Click(off.Q("SettingsButton"));
            yield return Frames(2);
            Click(off.Q("ConnectionCheckButton"));
            yield return Until(() => off.Runs == 1, "checkOnOpen false: the button runs it");

            var hidden = NewPlayer("Di", blueprint: @"{""game"":{""id"":""menu-test""},""diagnostics"":{""showConnectionCheck"":false}}");
            yield return Frames(6);
            Check(hidden.Runs == 0, "showConnectionCheck false: nothing runs on open");
            Click(hidden.Q("SettingsButton"));
            yield return Frames(2);
            Check(!Shown(hidden.Q("ConnectionCheckButton")), "showConnectionCheck false: no button");

            // a menu destroyed while the check runs is never called afterwards
            var gate2 = new TaskCompletionSource<bool>();
            var q = NewPlayer("Ed", "symmetric", gate2);
            yield return Frames(4);
            var model = q.M;
            Check(q.Runs == 1 && model.CheckRunning, "destroyed mid-check: the check is running");
            var go = q.Menu.gameObject;
            UnityEngine.Object.Destroy(go);
            yield return Frames(3);
            _logged.Clear();
            gate2.SetResult(true);
            yield return Frames(5);
            Check(go == null && !model.CheckRunning && model.CheckVerdictId == "likely_fail", "destroyed mid-check: the late answer ended quietly");
            Check(!_logged.Any(l => l.Contains("Exception") || l.Contains("MissingReference") || l.Contains("destroyed")), "destroyed mid-check: nothing was called on the dead menu: " + string.Join(" | ", _logged));
        }

        // ---- rewording, restyling and no static state --------------------------------------------------------------------------------

        [UnityTest]
        public IEnumerator RewordingAndRestylingLeaveNoStaticState()
        {
            Check(MenuText.T("host") == "Host a game", "the default text before the menu");
            var a = NewPlayer("Sam");
            a.Menu.Texts = new Dictionary<string, string> { ["host"] = "Create game", ["join"] = "Enter game" };
            var sheet = ScriptableObject.CreateInstance<StyleSheet>();
            a.Menu.StyleSheets = new[] { sheet };
            yield return Frames(4);
            Check(a.Q<Button>("HostButton").text == "Create game" && a.Q<Button>("JoinButton").text == "Enter game", "Texts reword the menu: " + a.Q<Button>("HostButton").text);
            Check(a.Menu.Root!.parent.styleSheets.count >= 2 && a.Menu.Root.parent.styleSheets.Contains(sheet), "a StyleSheet of the game is added after the stock one");
            Check(MenuText.T("host") == "Create game", "the override is live while the menu is");
            var model = a.M;
            yield return HostLobby(a);
            Check(ListenerCount(model, "Changed") == 1, "the menu listens to the model while it lives");
            UnityEngine.Object.Destroy(a.Menu.gameObject);
            yield return Frames(3);
            Check(MenuText.T("host") == "Host a game", "the reworded text is gone with the menu");
            foreach (var ev in new[] { "Changed", "GameStarted", "ReturnedToLobby", "Left" })
                Check(ListenerCount(model, ev) == 0, "no listener left on the model's " + ev);
            UnityEngine.Object.Destroy(sheet);

            // a disabled menu stops listening too, and listens again when enabled
            var b = NewPlayer("Ann");
            yield return Frames(4);
            var m2 = b.M;
            b.Menu.enabled = false;
            Check(ListenerCount(m2, "Changed") == 0, "a disabled menu does not listen");
            b.Menu.enabled = true;
            Check(ListenerCount(m2, "Changed") == 1, "an enabled menu listens again");
        }

        private static int ListenerCount(MenuModel model, string eventName)
        {
            var f = typeof(MenuModel).GetField(eventName, BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.IsNotNull(f, "MenuModel has no event field " + eventName);
            return (f!.GetValue(model) as Delegate)?.GetInvocationList().Length ?? 0;
        }

        // ---- the runner ---------------------------------------------------------------------------------------------------------------

        [UnityTest]
        public IEnumerator WithNoClientTheMenuAddsARunnerAndWiresDirectHosting()
        {
            // no socket is opened: nothing hosts or joins here
            var go = new GameObject("menu runner");
            _objects.Add(go);
            var menu = go.AddComponent<OneLobbyMenu>();
            var runs = 0;
            menu.CheckRunner = _ => { runs++; return Task.FromResult(new CheckResult("ok", "cone", "none", "good", "fine")); };
            menu.BootArgs = new[] { "--local" };
            yield return Frames(4);
            var runner = menu.Runner;
            Check(runner != null, "the menu found or added a OneLobbyRunner");
            if (runner != null) _objects.Add(runner.gameObject);
            Check(menu.Model != null && ReferenceEquals(menu.Client, runner!.Client) && ReferenceEquals(menu.Model!.Client, runner.Client), "the model drives the runner's client");
            Check(menu.Model!.HostDirect != null && menu.Model.JoinDirect != null, "direct hosting and joining are wired to the runner");
            Check(menu.Model.LocalOnly && menu.Model.Route == MenuRoute.Direct && runs == 0, "--local: direct route, no automatic check");
            Check(runner.BindAddress == "127.0.0.1", "--local: the runner is bound to 127.0.0.1 only, was '" + runner.BindAddress + "'");
            Check(menu.Q("HostButton") != null && !Shown(menu.Q("BrowseButton")!), "no lobby server: no Browse button");
            Check(go.GetComponentsInChildren<UIDocument>().Length == 1, "one panel");
            UnityEngine.Object.Destroy(runner.gameObject);
            yield return null;
        }
    }
}
