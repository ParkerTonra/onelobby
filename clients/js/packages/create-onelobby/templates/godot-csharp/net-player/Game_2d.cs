using System.Linq;
using Godot;
using OneLobby;
using OneLobby.Replication;

namespace {{ns}};

/// <summary>
/// The game, started by Main.cs when the menu says the game started: a flat floor, a camera that follows your character and one
/// character (Player.tscn) per player in the lobby. All the networking is the spawner below and the OneLobbyNetPlayer node inside
/// Player.tscn; this script builds the world and hands them the lobby. Yours to edit: put your own level in <see cref="BuildWorld"/>.
/// Players who join or leave later appear and disappear on their own.
/// </summary>
public partial class Game : Node2D
{
    private const string PlayerPath = "res://Player.tscn";

    public OneLobbyNetPlayerSpawner Spawner { get; private set; } = null!;
    /// <summary>The layer behind the spawner: Players.Stats, Players.TryRewound(...), Players.HostAction(...).</summary>
    public NetPlayers Players { get; private set; } = null!;
    public Lobby Lobby { get; private set; } = null!;
    public Camera2D Camera { get; private set; } = null!;
    private Player? _local;

    /// <summary><paramref name="lobby"/>: the menu's <c>GameStarted</c> lobby; <paramref name="blueprint"/>: the game's onelobby.json (the menu's <c>Client.Blueprint</c>).</summary>
    public void Start(Lobby lobby, Blueprint blueprint)
    {
        Lobby = lobby;
        BuildWorld();
        Spawner = new OneLobbyNetPlayerSpawner
        {
            Scene = GD.Load<PackedScene>(PlayerPath),
            SpawnPoint2D = peer => new Vector2(-120f + 80f * Seat(peer), -16f), // a place per seat, standing on the floor
//@if host
            StepFunction = Player.Step, // the movement the host and every owner run (Player.cs)
//@end
        };
        Spawner.PlayerSpawned += OnSpawned;
        AddChild(Spawner);
        Players = Spawner.Start(lobby, blueprint);
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
        var floor = new StaticBody2D { Position = new Vector2(0f, 20f) }; // the top is at y = 0
        floor.AddChild(new CollisionShape2D { Shape = new RectangleShape2D { Size = new Vector2(4000f, 40f) } });
        floor.AddChild(new Polygon2D
        {
            Polygon = new[] { new Vector2(-2000f, -20f), new Vector2(2000f, -20f), new Vector2(2000f, 20f), new Vector2(-2000f, 20f) },
            Color = new Color(0.35f, 0.4f, 0.35f),
        });
        AddChild(floor);
        Camera = new Camera2D { Position = new Vector2(0f, -120f) };
        AddChild(Camera);
        Camera.MakeCurrent();
    }

    public override void _Process(double delta)
    {
        if (_local == null || !IsInstanceValid(_local) || !Camera.IsInsideTree()) return;
        Camera.GlobalPosition = Camera.GlobalPosition.Lerp(_local.GlobalPosition + new Vector2(0f, -80f), 0.1f);
    }
}
