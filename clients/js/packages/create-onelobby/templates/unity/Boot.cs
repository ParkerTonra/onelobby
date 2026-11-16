#nullable enable
using System.Linq;
using OneLobby.Unity;
using UnityEngine;
using UnityEngine.SceneManagement;

/// <summary>
/// Starts the OneLobby menu in every scene, with no scene object to add: Unity calls <see cref="Create"/> once after the first scene
/// has loaded. The menu hosts and joins by itself and reads the blueprint at Assets/Resources/onelobby.json. Written by
/// create-onelobby; yours to edit. Flags after the program name (the menu reads them, see docs/recipes/menu.md, "Unity"):
///   Game.exe --host --local --name=Sam                      (--local: 127.0.0.1 only, no Nostr, nothing leaves this PC)
///   Game.exe --join=127.0.0.1:47810 --local --name=Ann
/// Delete this file when the game has its own start-up and put the two lines of <see cref="Awake"/> there.
/// </summary>
public sealed class GameBoot : MonoBehaviour
{
    OneLobbyMenu _menu = null!;
    string _status = "";
    int _players;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    static void Create()
    {
        // not while a play-mode test runs (the Test Framework plays its own scene, "InitTestScene..."): a test makes its own clients, and a menu
        // opened there would run its connection check against the internet
        if (SceneManager.GetActiveScene().name.StartsWith("InitTestScene", System.StringComparison.Ordinal)) return;
        if (FindFirstObjectByType<GameBoot>() == null) new GameObject("GameBoot").AddComponent<GameBoot>();
    }

    void Awake()
    {
        _menu = gameObject.AddComponent<OneLobbyMenu>();
        _menu.GameStarted += lobby =>
        {
            // start your game here; the menu hid itself
            _status = "In game: " + string.Join(", ", lobby.Room.Players.Select(p => p.Name));
            Debug.Log(_status);
        };
        _menu.ReturnedToLobby += _ => { _status = ""; }; // end the match; the menu shows the lobby again
        _menu.Left += () => { _status = ""; };
    }

    // one log line each time the roster changes ("Lobby: 2 players: Host, Joiner"), so a log shows who is in the lobby
    void Update()
    {
        var lobby = _menu.Model?.Lobby;
        var count = lobby?.Room.Players.Count ?? 0;
        if (count == _players) return;
        _players = count;
        if (lobby != null) Debug.Log("Lobby: " + count + " players: " + string.Join(", ", lobby.Room.Players.Select(p => p.Name)));
    }

    void OnGUI()
    {
        if (_status.Length > 0) GUI.Label(new Rect(16, 16, 600, 32), _status);
    }
}
