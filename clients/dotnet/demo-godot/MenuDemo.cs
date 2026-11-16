using Godot;
using OneLobby;

namespace OneLobbyDemo;

/// <summary>
/// The drop-in menu and about 20 lines of "game". Run it with <c>godot --path clients/dotnet/demo-godot res://MenuDemo.tscn -- --host --name=Sam</c>
/// (and <c>--join=&lt;code&gt;</c> in a second window). <c>--menu-selfcheck</c> runs the headless layout check instead (MenuSelfCheck.cs).
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
