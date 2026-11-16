using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Godot;
using OneLobby;

namespace OneLobbyDemo;

/// <summary>
/// A headless check of the Godot C# menu, run by <c>MenuDemo.tscn -- --menu-selfcheck</c>. Two menus share one in-memory network (no
/// sockets): at 1280x720 and 640x360 it walks every screen (start, settings, browse, error, connecting, the host's lobby, the
/// joiner's lobby, a countdown, the game, back to the lobby, a removed player, leaving), and on each one checks that every node
/// the controller names exists, nothing visible has zero size or clipped text, the relay line is in no label, and focus lands on a
/// visible control. It prints <c>MENU_OK</c> or <c>MENU_FAIL ...</c> as its last line and quits (exit code 0 or 1).
/// CI has only the non-.NET Godot, so this runs locally with the .NET build:
///   Godot_mono_console --headless --path clients/dotnet/demo-godot res://MenuDemo.tscn -- --menu-selfcheck
/// </summary>
public partial class MenuSelfCheck : Node
{
    private const string Relay = "turn:127.0.0.1:9 samuser sampass77";
    private const string ControllerPath = "res://addons/onelobby_menu/OneLobbyMenu.cs";

    private readonly InMemoryNetwork _net = new();
    private readonly List<string> _failures = new();
    private int _checks;
    private ulong _startedAt;
    private bool _done;

    private sealed class Player
    {
        public OneLobbyMenu Menu = null!;
        public int Started, Back, Left;
        public MenuModel M => Menu.Model!;
    }

    public override void _Ready() => Run();

    public override void _Process(double delta)
    {
        _net.Advance(33); // simulated time: the menus pump their clients themselves
        if (!_done && Time.GetTicksMsec() - _startedAt > 180_000)
        {
            Check(false, "timed out");
            Finish();
        }
    }

    private async void Run()
    {
        _startedAt = Time.GetTicksMsec();
        await Frames(2); // the root is still setting up its children in _Ready
        try
        {
            foreach (var size in new[] { new Vector2I(1280, 720), new Vector2I(640, 360) })
                await Layouts(size);
        }
        catch (Exception e)
        {
            Check(false, "exception: " + e);
        }
        Finish();
    }

    private void Finish()
    {
        if (_done) return;
        _done = true;
        foreach (var f in _failures) GD.Print("FAIL: ", f);
        GD.Print(_failures.Count == 0 ? $"MENU_OK ({_checks} checks)" : $"MENU_FAIL {_failures.Count} of {_checks} checks failed, first: {_failures[0]}");
        GetTree().Quit(_failures.Count == 0 ? 0 : 1);
    }

    private void Check(bool ok, string what)
    {
        _checks++;
        if (!ok) _failures.Add(what);
    }

    private async Task Frames(int n)
    {
        for (var i = 0; i < n; i++) await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);
    }

    private async Task<bool> Until(Func<bool> cond, int maxFrames = 900)
    {
        for (var i = 0; i < maxFrames && !cond(); i++) await Frames(1);
        return cond();
    }

    private Player NewPlayer(string name)
    {
        var config = new OneLobbyConfig("menu-selfcheck", "1", new Uri("ws://mem/ws"), SyncMode.Raw, 20, 20, "") { SettingsEnv = PlayerSettings.NoEnvironment };
        var menu = GD.Load<PackedScene>("res://addons/onelobby_menu/OneLobbyMenu.tscn").Instantiate<OneLobbyMenu>();
        menu.Client = new LobbyClient(config, _net.CreateTransport());
        menu.BootFlags = false;
        menu.HostOptions = new LobbyOptions("selfcheck", 4) { Room = new RoomOptions { CountdownSeconds = 1 } };
        var p = new Player { Menu = menu };
        menu.GameStarted += _ => p.Started++;
        menu.ReturnedToLobby += _ => p.Back++;
        menu.Left += () => p.Left++;
        GetTree().Root.AddChild(menu);
        p.M.SetName(name);
        return p;
    }

    private static string[] ControllerNodeNames()
    {
        var text = FileAccess.GetFileAsString(ControllerPath);
        var names = new List<string>();
        var on = false;
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.TrimEnd('\r').TrimStart();
            if (line.StartsWith("/// Nodes a controller")) { on = true; continue; }
            if (on && line.StartsWith("/// (The roster")) break;
            if (!on || !line.StartsWith("///")) continue;
            var body = line.Substring(3).Trim();
            var colon = body.IndexOf(':');
            if (colon > 0 && colon < 12) body = body.Substring(colon + 1);
            names.AddRange(body.Split(' ', StringSplitOptions.RemoveEmptyEntries));
        }
        return names.ToArray();
    }

    private static void VisibleControls(Node n, List<Control> output)
    {
        foreach (var c in n.GetChildren())
            if (c is Control ctl && ctl.Visible)
            {
                output.Add(ctl);
                VisibleControls(ctl, output);
            }
    }

    /// <summary>Everything visible has a size and unclipped text, the relay line is nowhere, the page fits, and focus is on a visible control of the menu.</summary>
    private async Task Audit(Player p, string label, Vector2 viewport, bool expectFocus = false)
    {
        await Frames(3);
        var menu = p.Menu;
        var all = new List<Control>();
        VisibleControls(menu, all);
        var zero = new List<string>();
        var clipped = new List<string>();
        var relaySeen = false;
        foreach (var c in all.Where(c => c.IsVisibleInTree()))
        {
            var emptyList = c is Container && c.GetChildCount() == 0; // a runtime-built list with no rows has no height
            if ((c.Size.X <= 0 || c.Size.Y <= 0) && !emptyList) zero.Add(menu.GetPathTo(c) + " " + c.Size);
            if (c is Label || c is Button)
            {
                var mn = c.GetCombinedMinimumSize();
                if (c.Size.X + 0.5f < mn.X || c.Size.Y + 0.5f < mn.Y) clipped.Add($"{menu.GetPathTo(c)} size {c.Size} min {mn}");
            }
            if ((c is Label l && (l.Text.Contains("samuser") || l.Text.Contains("sampass77"))) || (c is LineEdit e && e.Text.Contains("sampass77"))) relaySeen = true;
        }
        Check(zero.Count == 0, $"{label}: nothing has zero size {string.Join("; ", zero.Take(3))}");
        Check(clipped.Count == 0, $"{label}: no text is clipped {string.Join("; ", clipped.Take(3))}");
        Check(!relaySeen, $"{label}: the relay line is in no label");
        var pages = menu.GetNode<Control>("%Pages");
        Check(pages.GetCombinedMinimumSize().X <= viewport.X, $"{label}: the page fits the width ({pages.GetCombinedMinimumSize().X} of {viewport.X})");
        var f = GetViewport().GuiGetFocusOwner();
        if (expectFocus) Check(f != null && f.IsVisibleInTree() && menu.IsAncestorOf(f), $"{label}: focus is on a visible control ({f?.Name.ToString() ?? "none"})");
        // every focusable visible control of the screen can take focus
        foreach (var c in all.Where(c => c.IsVisibleInTree() && c.FocusMode == Control.FocusModeEnum.All && !(c is BaseButton { Disabled: true }) && !(c is global::Godot.Range)))
        {
            c.GrabFocus();
            if (!c.HasFocus()) Check(false, $"{label}: {menu.GetPathTo(c)} did not take focus");
        }
        Check(true, label + ": focus walked");
    }

    private static void Cancel()
    {
        Input.ParseInputEvent(new InputEventAction { Action = "ui_cancel", Pressed = true });
    }

    private async Task Layouts(Vector2I size)
    {
        var root = GetTree().Root;
        root.Size = size;
        var tag = $"{size.X}x{size.Y}";
        var view = new Vector2(size.X, size.Y);
        var a = NewPlayer("Sam");
        await Frames(2);
        foreach (var n in ControllerNodeNames())
            Check(a.Menu.GetNodeOrNull("%" + n) != null, $"{tag}: node %{n} exists");
        var m = a.M;

        await Audit(a, tag + " start", view, true);

        // settings, with a relay saved (it is only ever shown masked), then a connection check
        m.OpenSettings();
        m.SaveRelay(Relay);
        await Audit(a, tag + " settings", view, true);
        m.CheckRunner = _ => Task.FromResult(new CheckResult("ok", "cone", "ok", "v", "Your connection looks fine."));
        await m.RunCheckAsync();
        await Audit(a, tag + " settings after a check", view);
        Cancel();
        await Frames(2);
        Check(m.Screen == MenuScreen.Start, tag + ": ui_cancel leaves settings");

        // browse (empty list)
        await m.OpenBrowseAsync();
        await Until(() => m.BrowseStatus != MenuText.T("browse_loading"));
        await Audit(a, tag + " browse", view, true);
        Cancel();
        await Frames(2);

        // a bad code: the error screen with a sentence
        m.SetJoinText("hello");
        await m.JoinAsync();
        Check(m.Screen == MenuScreen.Error, tag + ": a bad code shows the error screen");
        await Audit(a, tag + " error", view, true);
        Cancel();
        await Frames(2);
        Check(m.Screen == MenuScreen.Start, tag + ": ui_cancel leaves the error screen");

        // connecting: hold the pump so the answer does not arrive, then Cancel
        a.Menu.Pump = false;
        m.SetJoinText("7HQ 4K2");
        var waiting = m.JoinAsync();
        await Frames(2);
        Check(m.Screen == MenuScreen.Connecting, tag + ": connecting screen");
        await Audit(a, tag + " connecting", view, true);
        Cancel();
        await Frames(2);
        Check(m.Screen == MenuScreen.Start, tag + ": ui_cancel while connecting cancels");
        a.Menu.Pump = true;
        await waiting;
        Check(m.Screen == MenuScreen.Start, tag + ": a failure that arrives after Cancel is not shown");

        // host, a second player joins by code
        await m.HostAsync();
        Check(await Until(() => m.RoomActive && m.Lobby!.Room.Me != null), tag + ": hosting reaches its room");
        await Audit(a, tag + " lobby (host)", view, true);
        var b = NewPlayer("Ann");
        b.M.SetJoinText(m.CodeText().ToLowerInvariant());
        await b.M.JoinAsync();
        Check(await Until(() => m.RosterRows().Count == 2 && b.M.RosterRows().Count == 2), tag + ": both see two players");
        m.SendChat("hello from the host");
        Check(await Until(() => b.M.ChatLines.Count == 1), tag + ": chat arrives");
        await Audit(b, tag + " lobby (joiner)", view, true);
        a.Menu.GetNode<Button>("%LobbySettingsToggle").ButtonPressed = true;
        await Audit(a, tag + " lobby with settings (host)", view);
        Check(a.Menu.GetNode<Control>("%LobbySettingsBox").Visible, tag + ": the lobby settings box opens");

        // ready, countdown, the game, back to the lobby
        b.M.ToggleReady();
        Check(await Until(() => m.RosterRows().Any(r => r.Ready)), tag + ": ready shows");
        m.StartGame();
        Check(await Until(() => m.CountingDown && b.M.CountingDown), tag + ": the countdown shows on both");
        await Audit(a, tag + " lobby with a countdown (host)", view);
        Check(a.Menu.GetNode<Control>("%CancelStartButton").Visible && a.Menu.GetNode<Label>("%CountdownLabel").Visible, tag + ": Cancel start and the countdown label are shown");
        Check(await Until(() => a.Started == 1 && b.Started == 1), tag + ": GameStarted on both");
        Check(!a.Menu.Visible && !b.Menu.Visible, tag + ": the menus hide while the game runs");
        m.Lobby!.Room.BackToLobby();
        Check(await Until(() => a.Back == 1 && b.Back == 1), tag + ": ReturnedToLobby on both");
        Check(a.Menu.Visible && b.Menu.Visible, tag + ": the menus show again");

        // a removed player gets the removed screen; the host's ban list shows
        m.Ban(m.RosterRows().First(r => !r.Me).Id, "just a test");
        Check(await Until(() => b.M.Screen == MenuScreen.Error && m.BanRows().Count == 1), tag + ": the banned player lands on the error screen");
        await Audit(b, tag + " removed", view);
        await Audit(a, tag + " lobby with a ban (host)", view);
        Check(b.M.Error.Ban && b.M.Error.Message == "just a test", tag + ": the ban reads with the host's reason");
        Cancel();
        await Frames(2);

        // ui_cancel in the lobby leaves it
        Cancel();
        await Until(() => a.Left == 1);
        Check(m.Screen == MenuScreen.Start && a.Left == 1, tag + ": ui_cancel in the lobby leaves it");
        a.Menu.QueueFree();
        b.Menu.QueueFree();
        await Frames(3);
    }
}
