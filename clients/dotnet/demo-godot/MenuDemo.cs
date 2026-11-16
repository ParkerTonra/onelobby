using System.Net;
using Godot;
using OneLobby;
using OneLobby.Direct;
using OneLobby.Direct.Nostr;

namespace OneLobbyDemo;

/// <summary>
/// The drop-in menu and about 20 lines of "game". Run it with <c>godot --path clients/dotnet/demo-godot res://MenuDemo.tscn -- --host --name=Sam</c>
/// (and <c>--join=&lt;code&gt;</c> in a second window). <c>--menu-selfcheck</c> runs the headless layout check instead (MenuSelfCheck.cs).
/// To see the LAN games list on one PC (the blueprint has <c>hosting.lan</c> on): a host window
/// <c>godot --path clients/dotnet/demo-godot res://MenuDemo.tscn -- --local --host --name=Sam</c>, then a second window
/// <c>godot --path clients/dotnet/demo-godot res://MenuDemo.tscn -- --local --name=Ann</c> and press Browse games: the host's game is listed.
/// </summary>
public partial class MenuDemo : Control
{
    public override void _Ready()
    {
        var menu = GetNode<OneLobbyMenu>("Menu");
        var inGame = GetNode<Control>("InGame");
        var label = GetNode<Label>("InGame/Box/Text");
        if (System.Array.IndexOf(OS.GetCmdlineUserArgs(), "--menu-selfcheck") >= 0)
        {
            menu.Visible = false; // the check builds its own menus on an in-memory network
            menu.Model!.LocalOnly = true; // and this one must not run the connection check on open (nothing may leave this PC)
            AddChild(new MenuSelfCheck());
            return;
        }
        // direct hosting and joining (OneLobby.Core cannot reference OneLobby.Direct, so the game hands the menu these two); --local keeps both on 127.0.0.1
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
            inGame.Visible = true;
            label.Text = $"In game: {lobby.Room.Players.Count} players (code {lobby.Code}).";
        };
        menu.ReturnedToLobby += _ => inGame.Visible = false;
        menu.Left += () => inGame.Visible = false;
        GetNode<Button>("InGame/Box/BackButton").Pressed += () =>
        {
            if (menu.Model?.Lobby is { IsHost: true } lobby) lobby.Room.BackToLobby();
        };
    }
}
