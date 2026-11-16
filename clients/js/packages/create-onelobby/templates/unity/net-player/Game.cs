#nullable enable
using System;
using System.Collections.Generic;
using OneLobby;
using OneLobby.Replication;
using OneLobby.Unity;
using UnityEngine;

/// <summary>
/// The game, started by Boot.cs when the menu says the game started and destroyed when the players go back to the lobby: a flat floor, a light, a
/// camera that follows your character, and one character (<see cref="GamePlayer.Make"/>) per player in the lobby. All the networking is the
/// <see cref="OneLobbyNetPlayerSpawner"/> below and the <see cref="OneLobbyNetPlayer"/> on each character; this script builds the world and hands
/// them the lobby. Players who join or leave later appear and disappear on their own. Written by create-onelobby; yours to edit: put your own
/// level in <see cref="BuildWorld"/> (it is the one place that makes the floor, the light and the camera).
/// </summary>
public sealed class Game : MonoBehaviour
{
    /// <summary>The spawner: <c>Spawner.Characters</c>, <c>Spawner.CharacterOf(peer)</c>.</summary>
    public OneLobbyNetPlayerSpawner Spawner { get; private set; } = null!;
    /// <summary>The layer behind the spawner: <c>Players.Stats</c>, <c>Players.TryRewound(...)</c>, <c>Players.HostAction(...)</c>.</summary>
    public NetPlayers Players { get; private set; } = null!;
    public Lobby Lobby { get; private set; } = null!;
    public Camera? Camera { get; private set; }
    GamePlayer? _local;
    readonly Dictionary<int, GamePlayer> _everyone = new();

    /// <summary>
    /// Starts the game. <paramref name="lobby"/>: the menu's <c>GameStarted</c> lobby; <paramref name="blueprint"/>: the game's onelobby.json
    /// (its <c>sync.player</c> says owner or host authority and 3D or 2D). Returns the object to destroy when the game ends.
    /// </summary>
    public static Game Begin(Lobby lobby, Blueprint blueprint)
    {
        var game = new GameObject("Game").AddComponent<Game>();
        game.Lobby = lobby;
        game.BuildWorld();
        var spawner = game.gameObject.AddComponent<OneLobbyNetPlayerSpawner>();
        game.Spawner = spawner;
        spawner.Factory = GamePlayer.Make;
        spawner.Parent = game.transform;
//@if 3d
        spawner.SpawnPoint = peer => new Vector3(-6f + 3f * game.Seat(peer), 1f, 0f); // a place per seat
//@end
//@if 2d
        spawner.SpawnPoint = peer => new Vector3(-6f + 3f * game.Seat(peer), 0.5f, 0f); // a place per seat
//@end
//@if host
        spawner.Step = GamePlayer.Step; // the movement the host and every owner run (GamePlayer.cs)
//@end
        spawner.PlayerSpawned += game.OnSpawned;
        spawner.PlayerRemoved += (peer, _) => game._everyone.Remove(peer);
        game.Players = spawner.Begin(lobby, blueprint); // the layer: the spawner pumps it every frame and makes one character per player
        return game;
    }

    int Seat(int peer) => Math.Max(0, Lobby.Room.Player(peer)?.Seat ?? 0);

    string NameOf(int peer) => Lobby.Room.Player(peer)?.Name is { Length: > 0 } n ? n : "player " + peer;

    void OnSpawned(int peer, GameObject character, bool isLocal)
    {
        var player = character.GetComponent<GamePlayer>();
        player.DisplayName = NameOf(peer);
        _everyone[peer] = player;
        Debug.Log("Game: " + player.DisplayName + (isLocal ? " (you)" : "") + " is in the world"); // a log shows who has a character
        if (!isLocal) return; // the other characters get their colour (the team) with their state
        _local = player;
        player.Net.Team = Seat(peer);
    }

    void BuildWorld()
    {
//@if 3d
        var floor = GameObject.CreatePrimitive(PrimitiveType.Cube); // keeps its collider: the owner's character stands on it
        floor.name = "Floor";
        floor.transform.SetParent(transform, false);
        floor.transform.position = new Vector3(0f, -0.5f, 0f); // the top is at y = 0
        floor.transform.localScale = new Vector3(40f, 1f, 40f);
        floor.GetComponent<Renderer>().material.color = new Color(0.35f, 0.4f, 0.35f);
        var sun = new GameObject("Sun").AddComponent<Light>();
        sun.type = LightType.Directional;
        sun.transform.SetParent(transform, false);
        sun.transform.rotation = Quaternion.Euler(55f, 30f, 0f);
        Camera = MakeCamera(new Vector3(0f, 9f, 11f));
        Camera.transform.LookAt(Vector3.zero);
//@end
//@if 2d
        var floor = GameObject.CreatePrimitive(PrimitiveType.Cube);
        floor.name = "Floor";
        floor.transform.SetParent(transform, false);
        floor.transform.position = new Vector3(0f, -0.5f, 0f); // the top is at y = 0
        floor.transform.localScale = new Vector3(60f, 1f, 1f);
        floor.GetComponent<Renderer>().material.color = new Color(0.35f, 0.4f, 0.35f);
        var sun = new GameObject("Sun").AddComponent<Light>();
        sun.type = LightType.Directional;
        sun.transform.SetParent(transform, false);
        sun.transform.rotation = Quaternion.Euler(20f, 20f, 0f); // shines along +z, onto the side the camera sees
        Camera = MakeCamera(new Vector3(0f, 2f, -10f));
        Camera.orthographic = true;
        Camera.orthographicSize = 5f;
//@end
    }

    Camera MakeCamera(Vector3 at)
    {
        var camera = new GameObject("Camera").AddComponent<Camera>();
        camera.gameObject.tag = "MainCamera";
        camera.transform.SetParent(transform, false);
        camera.clearFlags = CameraClearFlags.SolidColor;
        camera.backgroundColor = new Color(0.55f, 0.7f, 0.9f);
        camera.transform.position = at;
        return camera;
    }

    void LateUpdate()
    {
        if (Camera == null || _local == null) return;
        var p = _local.transform.position;
//@if 3d
        Camera.transform.position = Vector3.Lerp(Camera.transform.position, p + new Vector3(0f, 9f, 11f), 0.1f);
        Camera.transform.LookAt(p);
//@end
//@if 2d
        Camera.transform.position = Vector3.Lerp(Camera.transform.position, new Vector3(p.x, 2f, -10f), 0.1f);
//@end
    }

    // the name over each character
    void OnGUI()
    {
        if (Camera == null) return;
        foreach (var player in _everyone.Values)
        {
            if (player == null) continue;
            var at = Camera.WorldToScreenPoint(player.transform.position + Vector3.up * 1.6f);
            if (at.z > 0f) GUI.Label(new Rect(at.x - 60f, Screen.height - at.y - 10f, 120f, 24f), player.DisplayName, new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter });
        }
    }
}
