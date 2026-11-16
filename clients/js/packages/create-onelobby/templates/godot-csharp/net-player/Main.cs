using Godot;
using OneLobby;

namespace {{ns}};

/// <summary>
/// The drop-in menu is the whole front end; the game (<see cref="Game"/>) starts when it says so, and one character per player appears in it.
/// Flags after <c>--</c>:
///   godot --path . -- --host --name=Sam            (--local: 127.0.0.1 only, no Nostr, nothing leaves this PC)
///   godot --path . -- --join=&lt;code or ip:port&gt; --name=Ann
/// </summary>
public partial class Main : Control
{
    private Game? _game;

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
        OneLobbyNet.Wire(menu, args);            // direct hosting: HostDirect / JoinDirect (OneLobby.Core cannot reference OneLobby.Direct)
        // The menu acts on --host, --join=<code> and --name=<name> by itself, right after this method: the wiring above is in time.
    }

    private void EndGame()
    {
        _game?.QueueFree();
        _game = null;
    }
}
