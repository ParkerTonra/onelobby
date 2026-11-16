using System.Linq;
using Godot;
using OneLobby;

namespace {{ns}};

/// <summary>
/// The drop-in menu is the whole front end; the game starts when it says so. Flags after <c>--</c>:
///   godot --path . -- --host --name=Sam            (--local: 127.0.0.1 only, no Nostr, nothing leaves this PC)
///   godot --path . -- --join=&lt;code or ip:port&gt; --name=Ann
/// </summary>
public partial class Main : Control
{
    private Label _inGame = null!;

    public override void _Ready()
    {
        var menu = GetNode<OneLobbyMenu>("Menu");
        _inGame = GetNode<Label>("InGame");
        _inGame.Hide();
        menu.GameStarted += lobby =>
        {
            // start your game here; the menu hid itself
            _inGame.Text = "in game: " + string.Join(", ", lobby.Room.Players.Select(p => p.Name));
            _inGame.Show();
        };
        menu.ReturnedToLobby += _ => _inGame.Hide(); // end the match
        menu.Left += () => _inGame.Hide();

        var args = OS.GetCmdlineUserArgs();
        OneLobbyNet.Wire(menu, args);            // direct hosting: HostDirect / JoinDirect (OneLobby.Core cannot reference OneLobby.Direct)
        // The menu acts on --host, --join=<code> and --name=<name> by itself, right after this method: the wiring above is in time.
    }
}
