#nullable enable
using OneLobby;
using OneLobby.Unity;
using UnityEngine;
using UnityEngine.UIElements;

/// <summary>
/// The drop-in menu in one script: add this to an empty GameObject in any scene and press Play. The menu hosts and joins by itself
/// (no lobby server needed: Host gives a join code); this script only says "In game" when the host starts, and shows the menu
/// again when the lobby comes back. It works with the command line too:
///   Player.exe --host --name=Sam
///   Player.exe --join=&lt;code&gt; --name=Ann
/// </summary>
public sealed class MenuSample : MonoBehaviour
{
    OneLobbyMenu _menu = null!;
    string _status = "";

    void Awake()
    {
        _menu = gameObject.AddComponent<OneLobbyMenu>();
        _menu.GameStarted += lobby => _status = "In game (" + lobby.Room.Players.Count + " players)";
        _menu.ReturnedToLobby += _ => _status = "";
        _menu.Left += () => _status = "";
    }

    void OnGUI()
    {
        if (_status.Length > 0) GUI.Label(new Rect(16, 16, 400, 32), _status);
    }
}
