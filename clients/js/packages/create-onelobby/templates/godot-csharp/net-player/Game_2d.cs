using System.Collections.Generic;
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
            SpawnPoint2D = peer => new Vector2(-120f + 80f * Seat(peer), -16f), // a place per seat, standing on the floor
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
        if (_autotest) ReportMovers();
        if (_local == null || !IsInstanceValid(_local) || !Camera.IsInsideTree()) return;
        Camera.GlobalPosition = Camera.GlobalPosition.Lerp(_local.GlobalPosition + new Vector2(0f, -80f), 0.1f);
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
