#nullable enable
using System.Linq;
using OneLobby;
using OneLobby.Unity;
using UnityEngine;
using UnityEngine.SceneManagement;

/// <summary>
/// Starts the OneLobby menu in every scene, with no scene object to add: Unity calls <see cref="Create"/> once after the first scene
/// has loaded. The menu hosts and joins by itself and reads the blueprint at Assets/Resources/onelobby.json. Written by
/// create-onelobby; yours to edit. Flags after the program name (the menu reads them, see docs/recipes/menu.md, "Unity"):
///   Game.exe --host --local --name=Sam                      (--local: 127.0.0.1 only, no Nostr, nothing leaves this PC)
///   Game.exe --local --name=Ann                          (type the code the host window shows, or --join=<that code>; no fixed port)
/// Add <c>--autostart</c> to BOTH copies for a test with no clicks: the host starts the match as soon as a second player has joined, and every copy
/// walks its own player and logs one MULTIPLAYER_PLAYER line when it sees another player move (see Game.cs):
///   Game.exe -batchmode -nographics -logFile host.log --host --local --autostart --name=Sam
///   Game.exe -batchmode -nographics -logFile join.log --join=<the code host.log prints after "code"> --local --autostart --name=Ann
/// (join by the printed code, not a fixed port; stop each with timeout)
/// When the game starts (<c>GameStarted</c>) it opens Game.cs, which makes the world and one networked character per player; it ends it again on
/// <c>ReturnedToLobby</c> and <c>Left</c>. Delete this file when the game has its own start-up and put the lines of <see cref="Awake"/> there.
/// </summary>
public sealed class GameBoot : MonoBehaviour
{
    OneLobbyMenu _menu = null!;
    string _status = "";
    int _players;
    Game? _game;
    bool _autostart, _autostarted; // --autostart (tests only): the host starts the match by itself, once

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
        _autostart = Game.AutoTest;
        _menu.GameStarted += lobby =>
        {
            // start your game here; the menu hid itself
            _status = "In game: " + string.Join(", ", lobby.Room.Players.Select(p => p.Name));
            Debug.Log(_status);
            EndGame();
            // sync.player of Assets/Resources/onelobby.json (authority, 2D or 3D) is read from the blueprint the menu's client loaded
            var blueprint = _menu.Client?.Blueprint ?? Blueprint.Parse(Resources.Load<TextAsset>(OneLobbyMenu.BlueprintResourceName).text);
            _game = Game.Begin(lobby, blueprint);
        };
        _menu.ReturnedToLobby += _ => { _status = ""; EndGame(); }; // end the match; the menu shows the lobby again
        _menu.Left += () => { _status = ""; EndGame(); };
    }

    void EndGame()
    {
        if (_game != null) Destroy(_game.gameObject); // its spawner removes the characters and stops the layer
        _game = null;
    }

    // one log line each time the roster changes ("Lobby: 2 players: Host, Joiner"), so a log shows who is in the lobby
    void Update()
    {
        var lobby = _menu.Model?.Lobby;
        var count = lobby?.Room.Players.Count ?? 0;
        if (_autostart && !_autostarted && _game == null && lobby is { IsHost: true } && count >= 2) { _autostarted = true; _menu.Model!.StartGame(); } // what the Start button does
        if (count == _players) return;
        _players = count;
        if (lobby != null) Debug.Log("Lobby: " + count + " players: " + string.Join(", ", lobby.Room.Players.Select(p => p.Name)));
    }

    void OnGUI()
    {
        if (_status.Length > 0) GUI.Label(new Rect(16, 16, 600, 32), _status);
    }
}
