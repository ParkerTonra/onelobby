using Godot;
using OneLobby;

/// Test-only. clients/dotnet/scaffold-test.sh copies this into a scratch project and registers it as an autoload, then starts the game
/// exactly as AGENTS.md and the .olc entry say (two processes, `-- --host --local ...` and `-- --join=... --local ...`).
/// It watches the drop-in menu and prints one verdict line:
///   PROBE_HOST_LISTENING code=CODE   the host's menu reached the lobby
///   PROBE_OK ROLE players=N          the menu is in the lobby with two players (the joiner quits a moment later; the host waits to be stopped)
///   PROBE_FAIL ROLE WHAT             the menu's own error text, or what it was still showing
/// Nothing here is part of the template.
public partial class ScaffoldProbe : Node
{
    private const int NeedPlayers = 2;
    private const ulong GiveUpMs = 45000;
    private const ulong HostLingerMs = 40000; // the host waits to be stopped by the test
    private const ulong JoinerLingerMs = 3000; // the joiner stays a moment so the host sees it too

    private string _role = "host";
    private ulong _t0;
    private bool _listening;
    private long _okAt = -1;

    public override void _Ready()
    {
        _t0 = Time.GetTicksMsec();
        foreach (var a in OS.GetCmdlineUserArgs())
            if (a.StartsWith("--join=")) _role = "joiner";
    }

    private void End(bool ok, string what)
    {
        GD.Print((ok ? "PROBE_OK " : "PROBE_FAIL ") + _role + " " + what);
        if (ok) { _okAt = (long)Time.GetTicksMsec(); return; }
        GetTree().Quit(1);
    }

    public override void _Process(double delta)
    {
        var now = Time.GetTicksMsec();
        if (_okAt >= 0)
        {
            if (now - (ulong)_okAt > (_role == "host" ? HostLingerMs : JoinerLingerMs)) GetTree().Quit(0);
            return;
        }
        var menu = GetTree().CurrentScene?.GetNodeOrNull<OneLobbyMenu>("Menu");
        var model = menu?.Model;
        if (model == null)
        {
            if (now - _t0 > 10000) End(false, "the main scene has no Menu node with a model after 10 s");
            return;
        }
        if (model.Screen == MenuScreen.Error)
        {
            End(false, $"menu error: {model.Error.Title} {model.Error.Message}");
            return;
        }
        var lobby = model.Lobby;
        if (model.Screen == MenuScreen.Lobby && lobby != null)
        {
            if (_role == "host" && !_listening)
            {
                _listening = true;
                GD.Print("PROBE_HOST_LISTENING code=" + lobby.JoinCode);
            }
            var n = lobby.Room.Players.Count;
            if (n >= NeedPlayers)
            {
                End(true, $"players={n}");
                return;
            }
        }
        if (now - _t0 > GiveUpMs) End(false, $"gave up after {GiveUpMs / 1000} s: the menu is still on screen {model.Screen}{(lobby == null ? "" : $" with {lobby.Room.Players.Count} player(s)")}");
    }
}
