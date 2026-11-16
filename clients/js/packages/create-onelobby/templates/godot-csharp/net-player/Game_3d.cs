using System.Collections.Generic;
using System.Linq;
using Godot;
using OneLobby;
using OneLobby.Replication;

namespace {{ns}};

/// <summary>
/// The game, started by Main.cs when the menu says the game started: a flat floor, a light, a camera that follows your character and one
/// character (Player.tscn) per player in the lobby. All the networking is the spawner below and the OneLobbyNetPlayer node inside
/// Player.tscn; this script builds the world and hands them the lobby. Yours to edit: put your own level in <see cref="BuildWorld"/>.
/// Players who join or leave later appear and disappear on their own.
/// </summary>
public partial class Game : Node3D
{
    private const string PlayerPath = "res://Player.tscn";

    public OneLobbyNetPlayerSpawner Spawner { get; private set; } = null!;
    /// <summary>The layer behind the spawner: Players.Stats, Players.TryRewound(...), Players.HostAction(...).</summary>
    public NetPlayers Players { get; private set; } = null!;
    public Lobby Lobby { get; private set; } = null!;
    public Camera3D Camera { get; private set; } = null!;
    private Player? _local;
    private readonly bool _autotest = OS.GetCmdlineUserArgs().Contains("--autostart"); // tests only (see Main.cs): this copy walks its player and reports movers
    private readonly Dictionary<int, float> _seen = new(); // peer -> x where this copy first saw that player
    private readonly HashSet<int> _reported = new();

    /// <summary><paramref name="lobby"/>: the menu's <c>GameStarted</c> lobby; <paramref name="blueprint"/>: the game's onelobby.json (the menu's <c>Client.Blueprint</c>).</summary>
    public void Start(Lobby lobby, Blueprint blueprint)
    {
        Lobby = lobby;
        BuildWorld();
        Spawner = new OneLobbyNetPlayerSpawner
        {
            Scene = GD.Load<PackedScene>(PlayerPath),
            SpawnPoint = peer => new Vector3(-6f + 3f * Seat(peer), 1f, 0f), // a place per seat
//@if host
            StepFunction = Player.Step, // the movement the host and every owner run (Player.cs)
//@end
        };
        Spawner.PlayerSpawned += OnSpawned;
        AddChild(Spawner);
        Players = Spawner.Start(lobby, blueprint);
        if (_autotest) Input.ActionPress("ui_right"); // the arrow key, held by code: the local player walks right with nobody at the keyboard
    }

    private int Seat(int peer) => Mathf.Max(0, Lobby.Room.Entries.FirstOrDefault(e => e.Id == peer)?.Seat ?? 0);

    private string NameOf(int peer) => Lobby.Room.Entries.FirstOrDefault(e => e.Id == peer)?.Name is { Length: > 0 } n ? n : "player " + peer;

    private void OnSpawned(int peer, Node character, bool isLocal)
    {
        var player = (Player)character;
        player.Setup(NameOf(peer), Seat(peer));
        if (isLocal) _local = player;
    }

    private void BuildWorld()
    {
        var floor = new StaticBody3D { Position = new Vector3(0f, -0.5f, 0f) }; // the top is at y = 0
        var size = new Vector3(40f, 1f, 40f);
        floor.AddChild(new CollisionShape3D { Shape = new BoxShape3D { Size = size } });
        floor.AddChild(new MeshInstance3D
        {
            Mesh = new BoxMesh { Size = size },
            MaterialOverride = new StandardMaterial3D { AlbedoColor = new Color(0.35f, 0.4f, 0.35f) },
        });
        AddChild(floor);
        AddChild(new DirectionalLight3D { RotationDegrees = new Vector3(-55f, 30f, 0f) });
        Camera = new Camera3D { Position = new Vector3(0f, 9f, 11f) };
        AddChild(Camera);
        Camera.LookAt(Vector3.Zero);
        Camera.Current = true;
    }

    public override void _Process(double delta)
    {
        if (_autotest) ReportMovers();
        if (_local == null || !IsInstanceValid(_local) || !Camera.IsInsideTree()) return;
        var p = _local.GlobalPosition;
        Camera.GlobalPosition = Camera.GlobalPosition.Lerp(p + new Vector3(0f, 9f, 11f), 0.1f);
        Camera.LookAt(p);
    }

    // --autostart: print one line per other player this copy has seen move more than two units.
    private void ReportMovers()
    {
        foreach (var e in Lobby.Room.Players)
        {
            if (e.Id == Lobby.LocalPeerId || _reported.Contains(e.Id) || Spawner.CharacterOf(e.Id) is not Player { Visible: true } c) continue;
            if (!_seen.TryGetValue(e.Id, out var x0)) _seen[e.Id] = c.GlobalPosition.X;
            else if (Mathf.Abs(c.GlobalPosition.X - x0) > 2f)
            {
                _reported.Add(e.Id);
                GD.Print($"MULTIPLAYER_PLAYER {NameOf(Lobby.LocalPeerId)} sees {e.Name} (peer {e.Id}) move: from x = {x0:0.00} to x = {c.GlobalPosition.X:0.00}");
            }
        }
    }
}
