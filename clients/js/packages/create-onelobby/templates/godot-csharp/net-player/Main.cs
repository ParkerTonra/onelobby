using System.Linq;
using Godot;
using OneLobby;

namespace {{ns}};

/// <summary>
/// The drop-in menu is the whole front end; the game (<see cref="Game"/>) starts when it says so, and one character per player appears in it.
/// Flags after <c>--</c>:
///   godot --path . -- --host --name=Sam            (--local: 127.0.0.1 only, no Nostr, nothing leaves this PC)
///   godot --path . -- --join=&lt;code or ip:port&gt; --name=Ann
/// Add <c>--autostart</c> to BOTH copies for a test with no clicks: the host starts the match as soon as a second player has joined, and every copy
/// walks its own player and prints one MULTIPLAYER_PLAYER line when it sees another player move (see <see cref="Game"/>):
///   godot --headless --audio-driver Dummy --path . --quit-after 1500 -- --host --local --autostart --name=Sam
///   godot --headless --audio-driver Dummy --path . --quit-after 1500 -- --join=127.0.0.1:47810 --local --autostart --name=Ann
/// </summary>
public partial class Main : Control
{
    private Game? _game;
    private bool _autostarted; // --autostart (tests only): the host starts the match by itself, once

    public override void _Ready()
    {
        var menu = GetNode<OneLobbyMenu>("Menu");
        menu.GameStarted += lobby =>
        {
            if (_game != null) return;
            _game = new Game();
            AddChild(_game);
            _game.Start(lobby, menu.Client!.Blueprint!); // the menu hid itself; the lobby and onelobby.json go to the game
        };
        menu.ReturnedToLobby += _ => EndGame(); // end the match
        menu.Left += EndGame;

        var args = OS.GetCmdlineUserArgs();
        if (args.Contains("--autostart") && menu.Model != null) menu.Model.Changed += () => TryAutostart(menu);
        OneLobbyNet.Wire(menu, args);            // direct hosting: HostDirect / JoinDirect (OneLobby.Core cannot reference OneLobby.Direct)
        // The menu acts on --host, --join=<code> and --name=<name> by itself, right after this method: the wiring above is in time.
    }

    // --autostart: what the Start button does, once, as soon as a second player is in the room.
    private void TryAutostart(OneLobbyMenu menu)
    {
        if (_autostarted || _game != null || menu.Model?.Lobby is not { IsHost: true } lobby || lobby.Room.Players.Count < 2) return;
        _autostarted = true;
        menu.Model.StartGame();
    }

    private void EndGame()
    {
        _game?.QueueFree();
        _game = null;
    }
}
