using System.Net;
using Godot;
using OneLobby;
using OneLobby.Direct;
using OneLobby.Direct.Nostr;

namespace OneLobbyDemo;

/// <summary>
/// The menu demo plus a game you can see: after "game started" a flat floor and one capsule per player, walking with the arrow keys
/// or WASD and jumping with space. Every machine runs the same scene; the OneLobbyNetPlayer node in each capsule does the networking.
/// <code>
///   host:    godot --path clients/dotnet/demo-godot res://NetPlayerDemo.tscn -- --host --local --name=Sam
///   joiner:  godot --path clients/dotnet/demo-godot res://NetPlayerDemo.tscn -- --join=127.0.0.1:47810 --local --name=Alex
/// </code>
/// (<c>--local</c> keeps both on 127.0.0.1; the game starts by itself when the second player is in). Add <c>--netplayer-test</c> to both and
/// run them headless (net-player-test.sh): the joiner walks a scripted path and the host prints NETPLAYER_OK or NETPLAYER_FAIL &lt;why&gt;.
/// <c>--netplayer-selfcheck</c> runs the headless check on an in-memory network instead (NetPlayerSelfCheck.cs).
/// </summary>
public partial class NetPlayerDemo : Control
{
    private NetPlayerGame? _game;

    public override void _Ready()
    {
        var menu = GetNode<OneLobbyMenu>("Menu");
        if (System.Array.IndexOf(OS.GetCmdlineUserArgs(), "--netplayer-selfcheck") >= 0)
        {
            menu.Visible = false; // the check builds its own lobbies on an in-memory network
            menu.Model!.LocalOnly = true; // and this menu must not run the connection check on open (nothing may leave this PC)
            AddChild(new NetPlayerSelfCheck());
            return;
        }
        // direct hosting and joining, wired as MenuDemo does (OneLobby.Core cannot reference OneLobby.Direct, so the game hands the menu these two)
        if (menu.Client?.Blueprint is { Hosting.Direct: true })
        {
            var local = System.Array.IndexOf(OS.GetCmdlineUserArgs(), "--local") >= 0;
            var client = menu.Client;
            menu.HostDirect = password =>
            {
                var options = client.Blueprint!.ToDirectHostOptions(null, string.IsNullOrEmpty(menu.Model?.NameText) ? null : menu.Model!.NameText);
                options.Password = password;
                if (local)
                {
                    options.BindAddress = IPAddress.Loopback;
                    options.Nostr = new NostrOptions { Enabled = false };
                    options.OpenPort = false;
                    options.PublicAddress = "127.0.0.1";
                }
                return client.HostDirectAsync(options);
            };
            menu.JoinDirect = (address, password) => client.JoinDirectAsync(address, password);
        }
        menu.GameStarted += lobby =>
        {
            if (_game != null) return;
            _game = new NetPlayerGame();
            AddChild(_game);
            _game.Start(lobby, menu.Client!.Blueprint!);
        };
    }
}
