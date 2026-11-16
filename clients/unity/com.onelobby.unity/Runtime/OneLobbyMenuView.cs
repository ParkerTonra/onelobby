#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using UnityEngine.UIElements;

namespace OneLobby.Unity
{
    /// <summary>
    /// The control tree of <see cref="OneLobbyMenu"/>, built in code (UI Toolkit, no asset) with the same control names as the Godot
    /// menus' unique names, and its drawing: it reads <see cref="MenuModel"/> and forwards input to it. All decisions live in the
    /// model and all text in <see cref="MenuText"/>. Internal: a game reaches the controls through <see cref="OneLobbyMenu.Q"/>.
    /// </summary>
    internal sealed class OneLobbyMenuView
    {
        /// <summary>The names a controller may touch, as in the header of the Godot menu's controller.</summary>
        public static readonly string[] Names =
        {
            "Pages",
            "StartPage", "StartTitle", "StartNote", "NameLabel", "NameEdit", "HostButton", "JoinLabel", "JoinEdit", "JoinButton", "PasswordEdit", "BrowseButton", "SettingsButton", "StartCheckLine",
            "ConnectingPage", "ConnectingLabel", "ConnectingCancel",
            "LobbyPage", "CodeCaption", "CodeLabel", "CopyCodeButton", "CopyInviteButton", "PlayersHeader", "RosterList", "RosterNote", "CountdownLabel",
            "ReadyButton", "StartButton", "CancelStartButton", "LeaveButton", "LobbyNote", "RequestsHeader", "RequestsList", "ReasonEdit", "BansHeader", "BansList",
            "LobbySettingsToggle", "LobbySettingsBox", "AutoStartLabel", "AutoStartOption", "MinPlayersLabel", "MinPlayersSpin", "CountdownSecondsLabel",
            "CountdownSpin", "LateJoinCheck", "ChatBox", "ChatLog", "ChatEdit", "ChatSendButton",
            "ErrorPage", "ErrorTitle", "ErrorMessage", "ErrorHint", "ErrorCode", "CopyLogsButton", "SaveLogsButton", "LogNote", "ErrorBackButton",
            "SettingsPage", "SettingsTitle", "RelayLabel", "RelayStatus", "RelayEdit", "RelaySaveButton", "RelayClearButton", "RelayNote", "ServerLabel",
            "ServerEdit", "ServerSaveButton", "ServerNote", "ConnectionCheckButton", "CheckVerdict", "CheckFacts", "SettingsCopyLogsButton", "SettingsBackButton",
            "BrowsePage", "BrowseTitle", "BrowseTabs", "BrowseTabOnlineButton", "BrowseTabLanButton", "BrowseStatus", "BrowseLanPasswordEdit", "BrowseList", "BrowseRefreshButton", "BrowseBackButton",
        };

        private static readonly string[] AutoStartKeys = { "off", "all_ready", "players" };
        private static readonly string[] AutoStartTexts = { "auto_start_off", "auto_start_all_ready", "auto_start_players" };
        private static readonly string[] PageNames = { "StartPage", "ConnectingPage", "LobbyPage", "ErrorPage", "SettingsPage", "BrowsePage" };

        private readonly Dictionary<string, VisualElement> _by = new();
        private readonly Dictionary<int, Label> _pingLabels = new();
        private readonly Func<bool> _autoHide;
        private readonly Action<Action> _later;
        private readonly Action _backed;
        private string _rosterSig = "", _bansSig = "", _requestsSig = "", _browseSig = "";
        private int _shown = -1;
        private bool _syncing;
        private bool _nameDirty; // the name field holds text the player typed and the model has not taken yet
        private bool _settingsOpen;
        private bool _roomSeen;
        private float _pingAt;
        private int _lastBackFrame = -1;

        public OneLobbyMenuView(MenuModel model, Func<bool> autoHide, Action<Action> later, Action backed)
        {
            Model = model;
            _autoHide = autoHide;
            _later = later;
            _backed = backed;
            Root = new VisualElement { name = "OneLobbyMenu" };
            Root.AddToClassList("onelobby-menu");
            Build();
            Root.RegisterCallback<NavigationCancelEvent>(_ => GoBack());
            // Escape also arrives as a plain key press (a text field has focus); one press goes back once
            Root.RegisterCallback<KeyDownEvent>(e => { if (e.keyCode != KeyCode.Escape) return; GoBack(); e.StopPropagation(); }, TrickleDown.TrickleDown);
            ApplyStaticText();
        }

        public MenuModel Model { get; }
        public VisualElement Root { get; }

        public T Get<T>(string name) where T : VisualElement => (T)_by[name];

        public VisualElement? Find(string name) => _by.TryGetValue(name, out var e) ? e : null;

        /// <summary>The name of the control that has keyboard focus (a text field's inner element counts as the field), or "".</summary>
        public string FocusedName()
        {
            for (var f = Root.panel?.focusController?.focusedElement as VisualElement; f != null; f = f.parent)
                if (!string.IsNullOrEmpty(f.name) && _by.TryGetValue(f.name, out var e) && ReferenceEquals(e, f)) return f.name;
            return "";
        }

        // ---- building ---------------------------------------------------------------------------------------------------

        private T Add<T>(VisualElement parent, T el, string name, params string[] classes) where T : VisualElement
        {
            el.name = name;
            foreach (var c in classes) el.AddToClassList(c);
            _by[name] = el;
            parent.Add(el);
            return el;
        }

        private VisualElement Row(VisualElement parent, string name = "") =>
            name.Length > 0 ? Add(parent, new VisualElement(), name, "onelobby-row") : AddRow(parent);

        private static VisualElement AddRow(VisualElement parent)
        {
            var r = new VisualElement();
            r.AddToClassList("onelobby-row");
            parent.Add(r);
            return r;
        }

        private Button Btn(VisualElement parent, string name, Action onClick)
        {
            var b = Add(parent, new Button(), name);
            b.clicked += onClick;
            return b;
        }

        private Label Lbl(VisualElement parent, string name, params string[] classes) => Add(parent, new Label(), name, classes);

        private TextField Edit(VisualElement parent, string name, bool password = false)
        {
            var f = Add(parent, new TextField(), name);
            f.isPasswordField = password;
            return f;
        }

        private static void OnEnter(TextField f, Action act) =>
            f.RegisterCallback<KeyDownEvent>(e =>
            {
                if (e.keyCode != KeyCode.Return && e.keyCode != KeyCode.KeypadEnter) return;
                act();
                e.StopPropagation();
            }, TrickleDown.TrickleDown);

        private void Build()
        {
            var m = Model;
            var scroll = new ScrollView(ScrollViewMode.Vertical);
            scroll.AddToClassList("onelobby-scroll");
            scroll.focusable = false;
            Root.Add(scroll);
            var pages = Add(scroll, new VisualElement(), "Pages", "onelobby-pages");

            // start
            var start = Add(pages, new VisualElement(), "StartPage");
            Lbl(start, "StartTitle", "onelobby-title");
            Lbl(start, "StartNote");
            Lbl(start, "NameLabel");
            var name = Edit(start, "NameEdit");
            name.RegisterValueChangedCallback(_ => { if (!_syncing) _nameDirty = true; });
            name.RegisterCallback<FocusOutEvent>(_ => CommitName());
            OnEnter(name, CommitName);
            Btn(start, "HostButton", () =>
            {
                CommitName();
                m.SetPassword(Get<TextField>("PasswordEdit").value);
                _ = m.HostAsync();
            });
            Lbl(start, "JoinLabel");
            var join = Edit(start, "JoinEdit");
            join.RegisterValueChangedCallback(e => OnJoinText(e.newValue));
            OnEnter(join, Join);
            Edit(start, "PasswordEdit", password: true);
            OnEnter(Get<TextField>("PasswordEdit"), Join);
            Btn(start, "JoinButton", Join);
            Btn(start, "BrowseButton", () => _ = m.OpenBrowseAsync());
            Btn(start, "SettingsButton", m.OpenSettings);
            Lbl(start, "StartCheckLine");

            // connecting
            var conn = Add(pages, new VisualElement(), "ConnectingPage");
            Lbl(conn, "ConnectingLabel");
            Btn(conn, "ConnectingCancel", m.CancelConnecting);

            // lobby
            var lobby = Add(pages, new VisualElement(), "LobbyPage");
            Lbl(lobby, "CodeCaption");
            Lbl(lobby, "CodeLabel", "onelobby-code");
            var codeRow = Row(lobby);
            Btn(codeRow, "CopyCodeButton", () => Copied("CopyCodeButton", "copy_code", m.CopyCode()));
            Btn(codeRow, "CopyInviteButton", () => Copied("CopyInviteButton", "copy_invite", m.CopyInvite()));
            Lbl(lobby, "PlayersHeader");
            Add(lobby, new VisualElement(), "RosterList");
            Lbl(lobby, "RosterNote");
            Lbl(lobby, "CountdownLabel");
            var actions = Row(lobby);
            Btn(actions, "ReadyButton", m.ToggleReady);
            Btn(actions, "StartButton", m.StartGame);
            Btn(actions, "CancelStartButton", m.CancelCountdown);
            Btn(actions, "LeaveButton", () => _ = m.LeaveAsync());
            Lbl(lobby, "LobbyNote");
            Lbl(lobby, "RequestsHeader");
            Add(lobby, new VisualElement(), "RequestsList");
            Edit(lobby, "ReasonEdit");
            Lbl(lobby, "BansHeader");
            Add(lobby, new VisualElement(), "BansList");
            Btn(lobby, "LobbySettingsToggle", () =>
            {
                _settingsOpen = !_settingsOpen;
                Refresh();
            });
            var box = Add(lobby, new VisualElement(), "LobbySettingsBox");
            Lbl(box, "AutoStartLabel");
            var auto = Add(box, new DropdownField(), "AutoStartOption");
            auto.choices = AutoStartTexts.Select(_ => "").ToList();
            auto.RegisterValueChangedCallback(_ => { if (!_syncing && auto.index >= 0) m.SetLobbySetting("auto_start", AutoStartKeys[auto.index]); });
            Lbl(box, "MinPlayersLabel");
            Add(box, new IntegerField(), "MinPlayersSpin").RegisterValueChangedCallback(e => { if (!_syncing) m.SetLobbySetting("min_players", e.newValue); });
            Lbl(box, "CountdownSecondsLabel");
            Add(box, new IntegerField(), "CountdownSpin").RegisterValueChangedCallback(e => { if (!_syncing) m.SetLobbySetting("countdown_seconds", e.newValue); });
            Add(box, new Toggle(), "LateJoinCheck").RegisterValueChangedCallback(e => { if (!_syncing) m.SetLobbySetting("late_join", e.newValue); });
            var chat = Add(lobby, new VisualElement(), "ChatBox");
            var chatScroll = new ScrollView(ScrollViewMode.Vertical);
            chatScroll.AddToClassList("onelobby-chat-scroll");
            chatScroll.focusable = false;
            chat.Add(chatScroll);
            Lbl(chatScroll, "ChatLog");
            var chatRow = Row(chat);
            var chatEdit = Edit(chatRow, "ChatEdit");
            chatEdit.style.flexGrow = 1;
            OnEnter(chatEdit, SendChat);
            Btn(chatRow, "ChatSendButton", SendChat);

            // error / removed
            var err = Add(pages, new VisualElement(), "ErrorPage");
            Lbl(err, "ErrorTitle", "onelobby-title");
            Lbl(err, "ErrorMessage");
            Lbl(err, "ErrorHint");
            Lbl(err, "ErrorCode", "onelobby-error-code");
            var errRow = Row(err);
            Btn(errRow, "CopyLogsButton", m.CopyLogs);
            Btn(errRow, "SaveLogsButton", m.SaveLogs);
            Lbl(err, "LogNote");
            Btn(err, "ErrorBackButton", () => m.Back());

            // settings
            var set = Add(pages, new VisualElement(), "SettingsPage");
            Lbl(set, "SettingsTitle", "onelobby-title");
            Lbl(set, "RelayLabel");
            Lbl(set, "RelayStatus");
            var relay = Edit(set, "RelayEdit");
            OnEnter(relay, SaveRelay);
            var relayRow = Row(set);
            Btn(relayRow, "RelaySaveButton", SaveRelay);
            Btn(relayRow, "RelayClearButton", () =>
            {
                Get<TextField>("RelayEdit").SetValueWithoutNotify("");
                m.ClearRelay();
            });
            Lbl(set, "RelayNote");
            Lbl(set, "ServerLabel");
            var server = Edit(set, "ServerEdit");
            OnEnter(server, SaveServer);
            Btn(set, "ServerSaveButton", SaveServer);
            Lbl(set, "ServerNote");
            Btn(set, "ConnectionCheckButton", () => _ = m.RunCheckAsync());
            Lbl(set, "CheckVerdict");
            Lbl(set, "CheckFacts");
            var setRow = Row(set);
            Btn(setRow, "SettingsCopyLogsButton", m.CopyLogs);
            Btn(setRow, "SettingsBackButton", () => m.Back());

            // browse
            var browse = Add(pages, new VisualElement(), "BrowsePage");
            Lbl(browse, "BrowseTitle", "onelobby-title");
            var tabs = Row(browse, "BrowseTabs");
            Btn(tabs, "BrowseTabOnlineButton", () => _ = m.SetBrowseTabAsync("online"));
            Btn(tabs, "BrowseTabLanButton", () => _ = m.SetBrowseTabAsync("lan"));
            Lbl(browse, "BrowseStatus");
            Edit(browse, "BrowseLanPasswordEdit", password: true).RegisterValueChangedCallback(e => m.SetLanPassword(e.newValue));
            Add(browse, new VisualElement(), "BrowseList");
            var browseRow = Row(browse);
            Btn(browseRow, "BrowseRefreshButton", () => _ = m.RefreshBrowseAsync());
            Btn(browseRow, "BrowseBackButton", () => m.Back());
        }

        // ---- input ------------------------------------------------------------------------------------------------------

        /// <summary>Escape and the gamepad's cancel button: one screen back, exactly as <see cref="MenuModel.Back"/> decides.</summary>
        private void GoBack()
        {
            if (_lastBackFrame == Time.frameCount || Root.resolvedStyle.display == DisplayStyle.None) return;
            _lastBackFrame = Time.frameCount;
            if (Model.Back()) _backed();
        }

        private void CommitName()
        {
            if (_syncing) return;
            _nameDirty = false;
            var edit = Get<TextField>("NameEdit");
            var cleaned = Model.SetName(edit.value);
            if (cleaned != edit.value) edit.SetValueWithoutNotify(cleaned);
        }

        private void OnJoinText(string text)
        {
            if (_syncing) return;
            var cleaned = Model.SetJoinText(text);
            if (cleaned == text) return;
            var edit = Get<TextField>("JoinEdit");
            var at = edit.cursorIndex;
            edit.SetValueWithoutNotify(cleaned);
            edit.cursorIndex = edit.selectIndex = Math.Min(at, cleaned.Length);
        }

        private void Join()
        {
            CommitName();
            Model.SetJoinText(Get<TextField>("JoinEdit").value);
            Model.SetPassword(Get<TextField>("PasswordEdit").value);
            _ = Model.JoinAsync();
        }

        private void SendChat()
        {
            var edit = Get<TextField>("ChatEdit");
            Model.SendChat(edit.value);
            edit.SetValueWithoutNotify("");
        }

        private void SaveRelay()
        {
            var edit = Get<TextField>("RelayEdit");
            if (Model.SaveRelay(edit.value)) edit.SetValueWithoutNotify("");
        }

        private void SaveServer() => Model.SaveServer(Get<TextField>("ServerEdit").value);

        private void Copied(string button, string key, bool ok)
        {
            var b = Get<Button>(button);
            b.text = MenuText.T(ok ? "copied" : "copy_failed");
            b.schedule.Execute(() => b.text = MenuText.T(key)).StartingIn(1500);
        }

        // ---- text -------------------------------------------------------------------------------------------------------

        private void Text(string name, string key)
        {
            switch (_by[name])
            {
                case Label l: l.text = MenuText.T(key); break;
                case Button b: b.text = MenuText.T(key); break;
                case Toggle t: t.text = MenuText.T(key); break;
            }
        }

        private void Placeholder(string name, string key) => Get<TextField>(name).textEdition.placeholder = MenuText.T(key);

        public void ApplyStaticText()
        {
            Text("StartTitle", "title");
            Text("NameLabel", "name_label");
            Placeholder("NameEdit", "name_placeholder");
            Text("HostButton", "host");
            Text("JoinLabel", "join_label");
            Placeholder("JoinEdit", "join_placeholder");
            Text("JoinButton", "join");
            Placeholder("PasswordEdit", "password_placeholder");
            Text("BrowseButton", "browse");
            Text("SettingsButton", "settings");
            Text("ConnectingCancel", "cancel");
            Text("CodeCaption", "code_caption");
            Text("CopyCodeButton", "copy_code");
            Text("CopyInviteButton", "copy_invite");
            Text("CancelStartButton", "cancel_countdown");
            Text("LeaveButton", "leave");
            Text("StartButton", "start");
            Placeholder("ReasonEdit", "reason_placeholder");
            Text("RequestsHeader", "requests_header");
            Text("BansHeader", "bans_header");
            Text("LobbySettingsToggle", "lobby_settings");
            Text("AutoStartLabel", "setting_auto_start");
            Text("MinPlayersLabel", "setting_min_players");
            Text("CountdownSecondsLabel", "setting_countdown");
            Text("LateJoinCheck", "setting_late_join");
            Placeholder("ChatEdit", "chat_placeholder");
            Text("ChatSendButton", "chat_send");
            Text("CopyLogsButton", "copy_logs");
            Text("SaveLogsButton", "save_logs");
            Text("ErrorBackButton", "back");
            Text("SettingsTitle", "settings_title");
            Text("RelayLabel", "relay_label");
            Placeholder("RelayEdit", "relay_placeholder");
            Text("RelaySaveButton", "relay_save");
            Text("RelayClearButton", "relay_clear");
            Text("ServerLabel", "server_label");
            Placeholder("ServerEdit", "server_placeholder");
            Text("ServerSaveButton", "server_save");
            Text("ConnectionCheckButton", "check");
            Text("SettingsCopyLogsButton", "copy_logs");
            Text("SettingsBackButton", "back");
            Text("BrowseTabOnlineButton", "browse_tab_online");
            Text("BrowseTabLanButton", "browse_tab_lan");
            Placeholder("BrowseLanPasswordEdit", "password_placeholder");
            Text("BrowseRefreshButton", "browse_refresh");
            Text("BrowseBackButton", "back");
            Get<Label>("RosterNote").text = MenuText.T("plain_list_note");
            var auto = Get<DropdownField>("AutoStartOption");
            var keep = auto.index;
            _syncing = true;
            auto.choices = AutoStartTexts.Select(k => MenuText.T(k)).ToList();
            if (keep >= 0) auto.index = keep;
            _syncing = false;
        }

        // ---- drawing ----------------------------------------------------------------------------------------------------

        private static void Show(VisualElement e, bool on) => e.style.display = on ? DisplayStyle.Flex : DisplayStyle.None;

        private string PageName(MenuScreen s) => s switch
        {
            MenuScreen.Start => "StartPage",
            MenuScreen.Connecting => "ConnectingPage",
            MenuScreen.Lobby => "LobbyPage",
            MenuScreen.Error => "ErrorPage",
            MenuScreen.Settings => "SettingsPage",
            MenuScreen.Browse => "BrowsePage",
            _ => "",
        };

        /// <summary>Draws the screen the model is on. Only what changed is rebuilt (the roster, ban, request and browse rows).</summary>
        public void Refresh()
        {
            var m = Model;
            var s = m.Screen;
            var page = PageName(s);
            foreach (var n in PageNames) Show(_by[n], n == page);
            var playing = s == MenuScreen.Playing;
            Show(Root, !(playing && _autoHide()));
            Root.EnableInClassList("onelobby-menu--playing", playing);
            Root.pickingMode = playing ? PickingMode.Ignore : PickingMode.Position;
            var entering = (int)s != _shown;
            _shown = (int)s;
            if (entering) _roomSeen = false;
            switch (s)
            {
                case MenuScreen.Start: DrawStart(entering); break;
                case MenuScreen.Connecting: Get<Label>("ConnectingLabel").text = m.ConnectingText; break;
                case MenuScreen.Lobby: DrawLobby(entering); break;
                case MenuScreen.Error: DrawError(); break;
                case MenuScreen.Settings: DrawSettings(entering); break;
                case MenuScreen.Browse: DrawBrowse(); break;
            }
            if (entering && page.Length > 0) _later(() => FocusFirst(s));
        }

        private void SetText(string name, string text)
        {
            var edit = Get<TextField>(name);
            if (edit.value == text) return;
            _syncing = true;
            edit.SetValueWithoutNotify(text);
            _syncing = false;
        }

        private void SetLabel(string name, string text)
        {
            var l = Get<Label>(name);
            l.text = text;
            Show(l, text.Length > 0);
        }

        private void DrawStart(bool entering)
        {
            var m = Model;
            Show(Get<Label>("NameLabel"), m.NamesAllowed);
            Show(Get<TextField>("NameEdit"), m.NamesAllowed);
            Show(Get<Button>("BrowseButton"), m.BrowseAvailable);
            SetLabel("StartNote", m.StartNote);
            SetLabel("StartCheckLine", m.StartCheckLine);
            if (entering)
            {
                _later(() => _ = m.StartShown()); // not before a boot flag has had its say; the model runs the check once
                SetText("JoinEdit", m.JoinText);
                SetText("PasswordEdit", "");
            }
            // The name field follows the model (a --name= boot flag sets it after the first draw) unless the player is typing in it.
            if (entering || !_nameDirty)
            {
                _nameDirty = false;
                SetText("NameEdit", m.NameText);
            }
        }

        private void DrawLobby(bool entering)
        {
            var m = Model;
            if (m.Lobby == null) return;
            var host = m.IsHost;
            var active = m.RoomActive;
            // the room answers a moment after the lobby opens and Ready appears then: a focus that fell back to Leave moves to it
            if (active && !_roomSeen && FocusedName() is "" or "LeaveButton") _later(() => FocusFirst(MenuScreen.Lobby));
            _roomSeen = active;
            Get<Label>("CodeLabel").text = m.CodeText();
            Show(Get<Button>("CopyInviteButton"), m.InviteAvailable);
            Get<Label>("PlayersHeader").text = m.PlayersHeader();
            Show(Get<Label>("RosterNote"), m.Lobby.Room.Supported == false);
            var ready = Get<Button>("ReadyButton");
            Show(ready, active && m.MeIsPlayer);
            ready.text = MenuText.T(m.MeReady ? "not_ready" : "ready");
            Show(Get<Button>("StartButton"), host);
            Get<Button>("StartButton").SetEnabled(!m.CountingDown);
            Show(Get<Button>("CancelStartButton"), host && m.CountingDown);
            var note = m.LobbyNote;
            if (note == "" && !host && !m.CountingDown) note = MenuText.T("start_wait");
            SetLabel("LobbyNote", note);
            SetLabel("CountdownLabel", m.CountingDown ? m.CountdownText() : "");
            Show(Get<TextField>("ReasonEdit"), host && active);
            DrawRoster();
            DrawRequests(host);
            DrawBans();
            Show(Get<Button>("LobbySettingsToggle"), host && active);
            var box = Get<VisualElement>("LobbySettingsBox");
            var boxOn = host && active && _settingsOpen;
            Show(box, boxOn);
            if (boxOn && m.LobbySettings() is { } st)
            {
                _syncing = true;
                Get<DropdownField>("AutoStartOption").index = Math.Max(0, Array.IndexOf(AutoStartKeys, st.AutoStart));
                Get<IntegerField>("MinPlayersSpin").SetValueWithoutNotify(st.MinPlayers);
                Get<IntegerField>("CountdownSpin").SetValueWithoutNotify(st.CountdownSeconds);
                Get<Toggle>("LateJoinCheck").SetValueWithoutNotify(st.LateJoin);
                _syncing = false;
            }
            var chat = Get<VisualElement>("ChatBox");
            Show(chat, m.ChatShown);
            if (m.ChatShown) Get<Label>("ChatLog").text = string.Join("\n", m.ChatLines.Select(l => MenuText.T("chat_line", l.Name, l.Text)));
            if (entering)
            {
                _syncing = true;
                Get<TextField>("ChatEdit").SetValueWithoutNotify("");
                Get<TextField>("ReasonEdit").SetValueWithoutNotify("");
                _syncing = false;
            }
        }

        private void DrawRoster()
        {
            var m = Model;
            var rows = m.RosterRows();
            var sig = string.Join("|", rows.Select(r => $"{r.Id},{r.Name},{r.Me},{r.Host},{r.Ready},{r.Spectator},{r.Reconnecting},{r.CanKick}"));
            if (sig == _rosterSig) return;
            _rosterSig = sig;
            var list = _by["RosterList"];
            list.Clear();
            _pingLabels.Clear();
            foreach (var r in rows)
            {
                var row = AddRow(list);
                row.AddToClassList("onelobby-roster-row");
                row.Add(new Label(r.Name + (r.Me ? " " + MenuText.T("you") : "")));
                var marks = m.RowMarks(r);
                if (marks != "") row.Add(new Label(marks));
                var ping = new Label();
                row.Add(ping);
                _pingLabels[r.Id] = ping;
                if (!r.CanKick) continue;
                var id = r.Id;
                row.Add(new Button(() =>
                {
                    m.Kick(id, Get<TextField>("ReasonEdit").value);
                    Get<TextField>("ReasonEdit").SetValueWithoutNotify("");
                }) { text = MenuText.T("kick") });
                row.Add(new Button(() =>
                {
                    m.Ban(id, Get<TextField>("ReasonEdit").value);
                    Get<TextField>("ReasonEdit").SetValueWithoutNotify("");
                }) { text = MenuText.T("ban") });
            }
            UpdatePings();
        }

        private void UpdatePings()
        {
            var l = Model.Lobby;
            if (l == null) return;
            foreach (var (id, label) in _pingLabels)
            {
                var ms = id != l.LocalPeerId ? l.PingMs(id) : 0;
                label.text = ms > 0 ? MenuText.T("ping", ms) : "";
            }
        }

        private void DrawRequests(bool host)
        {
            var m = Model;
            var items = host ? m.Requests : Array.Empty<MenuRequest>();
            Show(Get<Label>("RequestsHeader"), items.Count > 0);
            Show(_by["RequestsList"], items.Count > 0);
            var sig = string.Join("|", items.Select(r => r.PeerId + "," + r.Name));
            if (sig == _requestsSig) return;
            _requestsSig = sig;
            var list = _by["RequestsList"];
            list.Clear();
            foreach (var r in items)
            {
                var id = r.PeerId;
                var row = AddRow(list);
                row.Add(new Label(r.Name));
                row.Add(new Button(() => m.Approve(id, true)) { text = MenuText.T("let_in") });
                row.Add(new Button(() => m.Approve(id, false)) { text = MenuText.T("refuse") });
            }
        }

        private void DrawBans()
        {
            var m = Model;
            var rows = m.BanRows();
            Show(Get<Label>("BansHeader"), rows.Count > 0);
            Show(_by["BansList"], rows.Count > 0);
            var sig = string.Join("|", rows.Select(b => b.Key + "," + b.Text));
            if (sig == _bansSig) return;
            _bansSig = sig;
            var list = _by["BansList"];
            list.Clear();
            foreach (var b in rows)
            {
                var key = b.Key;
                var row = AddRow(list);
                row.Add(new Label(b.Text));
                row.Add(new Button(() => m.Unban(key)) { text = MenuText.T("unban") });
            }
        }

        private void DrawError()
        {
            var e = Model.Error;
            Get<Label>("ErrorTitle").text = e.Title;
            Get<Label>("ErrorMessage").text = e.Message;
            SetLabel("ErrorHint", e.Hint);
            SetLabel("ErrorCode", e.Code != "" ? MenuText.T("error_code", e.Code) : "");
            SetLabel("LogNote", Model.LogNote);
        }

        private void DrawSettings(bool entering)
        {
            var m = Model;
            Get<Label>("RelayStatus").text = m.RelayStatusText();
            SetLabel("RelayNote", m.RelayNote);
            SetLabel("ServerNote", m.SettingsNote);
            if (entering)
            {
                SetText("RelayEdit", "");
                SetText("ServerEdit", m.ServerText);
            }
            var check = Get<Button>("ConnectionCheckButton");
            Show(check, m.ConnectionCheckShown);
            check.SetEnabled(!m.CheckRunning);
            SetLabel("CheckVerdict", m.CheckVerdict);
            SetLabel("CheckFacts", string.Join("\n", m.CheckFacts));
        }

        private void DrawBrowse()
        {
            var m = Model;
            var lan = m.ShownList == "lan";
            Get<Label>("BrowseTitle").text = m.BrowseTitle;
            Show(_by["BrowseTabs"], m.BrowseTabsShown);
            _by["BrowseTabOnlineButton"].EnableInClassList("onelobby-tab--on", !lan);
            _by["BrowseTabLanButton"].EnableInClassList("onelobby-tab--on", lan);
            Show(_by["BrowseLanPasswordEdit"], lan);
            SetLabel("BrowseStatus", m.ListStatus);
            var lanRows = lan ? m.LanRows() : (IReadOnlyList<MenuLanRow>)Array.Empty<MenuLanRow>();
            var sig = lan ? "lan" + string.Join("|", lanRows.Select(r => r.Address + ":" + r.Port + "," + r.Text + "," + r.Lock + "," + r.CanJoin))
                          : "online" + string.Join("|", m.BrowseItems.Select(i => i.Code + "," + i.Name + "," + i.HostName + "," + i.Players + "," + i.MaxPlayers));
            if (sig == _browseSig) return;
            _browseSig = sig;
            var list = _by["BrowseList"];
            list.Clear();
            if (lan)
            {
                DrawLanRows(list, lanRows);
                Show(list, list.childCount > 0);
                return;
            }
            Show(list, true);
            foreach (var it in m.BrowseItems)
            {
                var code = it.Code;
                var row = AddRow(list);
                row.Add(new Label(MenuModel.BrowseRowText(it)));
                row.Add(new Button(() => _ = m.JoinListedAsync(code)) { text = MenuText.T("browse_join") });
            }
            if (_shown == (int)MenuScreen.Browse && list.childCount > 0) _later(() => FocusFirst(MenuScreen.Browse));
        }

        /// <summary>One row per LAN game: the line, a password mark, why it cannot be joined (greyed), and a Join button. Plain text, never markup.</summary>
        private void DrawLanRows(VisualElement list, IReadOnlyList<MenuLanRow> rows)
        {
            for (var i = 0; i < rows.Count; i++)
            {
                var r = rows[i];
                var index = i;
                var row = AddRow(list);
                row.Add(new Label(r.Text) { enableRichText = false });
                if (r.Lock.Length > 0) row.Add(new Label(r.Lock) { enableRichText = false });
                if (!r.CanJoin)
                {
                    row.AddToClassList("onelobby-row--disabled");
                    row.style.opacity = 0.5f;
                    row.Add(new Label(r.Note) { enableRichText = false });
                }
                var join = new Button(() => _ = Model.JoinLanAsync(index)) { text = MenuText.T("browse_join") };
                join.SetEnabled(r.CanJoin);
                row.Add(join);
            }
            // keep a player's focus (the password field) unless it was on a row that is gone
            if (_shown == (int)MenuScreen.Browse && FocusedName() == "") _later(() => FocusFirst(MenuScreen.Browse));
        }

        /// <summary>Every frame while the lobby shows: the countdown and, twice a second, the pings.</summary>
        public void Tick()
        {
            var m = Model;
            if (m.Screen != MenuScreen.Lobby) return;
            SetLabel("CountdownLabel", m.CountingDown ? m.CountdownText() : "");
            var now = Time.realtimeSinceStartup;
            if (now - _pingAt > 0.5f)
            {
                _pingAt = now;
                UpdatePings();
            }
        }

        // ---- focus ------------------------------------------------------------------------------------------------------

        private bool Shown(string name)
        {
            for (var e = _by[name]; e != null; e = e.parent)
                if (e.style.display == DisplayStyle.None) return false;
            return true;
        }

        /// <summary>A sensible first control on every screen, so keyboard and gamepad work without a mouse click.</summary>
        public void FocusFirst(MenuScreen s)
        {
            if (s != Model.Screen) return;
            VisualElement? target = null;
            switch (s)
            {
                case MenuScreen.Start: target = _by["HostButton"]; break;
                case MenuScreen.Connecting: target = _by["ConnectingCancel"]; break;
                case MenuScreen.Lobby:
                    target = Shown("ReadyButton") ? _by["ReadyButton"] : Shown("StartButton") ? _by["StartButton"] : _by["LeaveButton"];
                    break;
                case MenuScreen.Error: target = _by["ErrorBackButton"]; break;
                case MenuScreen.Settings: target = _by["RelayEdit"]; break;
                case MenuScreen.Browse:
                    target = _by["BrowseBackButton"];
                    var first = _by["BrowseList"].Query<Button>().First();
                    if (first != null) target = first;
                    break;
            }
            if (target != null && Root.panel != null) target.Focus();
        }
    }
}
