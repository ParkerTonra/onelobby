using System.Linq;
using Godot;
using OneLobby;
using OneLobby.Replication;

namespace OneLobbyDemo;

/// <summary>
/// The sample game: a flat floor, one capsule per player (a colour per team, a label per name), a camera that follows the local one.
/// All the networking is the spawner and the node inside NetPlayerCharacter.tscn; this script only builds the world and hands them the lobby.
/// </summary>
public partial class NetPlayerGame : Node3D
{
    private const string CharacterPath = "res://NetPlayerCharacter.tscn";

    public OneLobbyNetPlayerSpawner Spawner { get; private set; } = null!;
    public NetPlayers Players { get; private set; } = null!;
    public Lobby Lobby { get; private set; } = null!;
    public NetPlayerCharacter? LocalCharacter { get; private set; }
    public Camera3D Camera { get; private set; } = null!;
    public NetPlayerAutotest? Autotest { get; private set; }

    /// <summary><paramref name="lobby"/>: the menu's <c>GameStarted</c> lobby; <paramref name="blueprint"/>: the game's onelobby.json (the menu's <c>Client.Blueprint</c>).</summary>
    /// <remarks>The scripted walk of <c>--netplayer-test</c> starts when that flag is on the command line, or when <paramref name="test"/> is true (the self-check, with its virtual <paramref name="testClock"/>).</remarks>
    public void Start(Lobby lobby, Blueprint blueprint, System.Func<double>? testClock = null, bool test = false)
    {
        Lobby = lobby;
        BuildWorld();
        Spawner = MakeSpawner(pump: true);
        AddChild(Spawner);
        Players = Spawner.Start(lobby, blueprint);
        if (test || System.Array.IndexOf(OS.GetCmdlineUserArgs(), "--netplayer-test") >= 0) AttachAutotest(testClock);
    }

    private OneLobbyNetPlayerSpawner MakeSpawner(bool pump)
    {
        var sp = new OneLobbyNetPlayerSpawner
        {
            Scene = GD.Load<PackedScene>(CharacterPath),
            PumpLayer = pump,
            SpawnPoint = peer => new Vector3(-6f + 3f * Mathf.Max(0, Seat(peer)), 1f, 0f),
        };
        sp.PlayerSpawned += OnSpawned;
        return sp;
    }

    private int Seat(int peer) => Lobby?.Room.Entries.FirstOrDefault(e => e.Id == peer)?.Seat ?? 0;

    private string NameOf(int peer) => Lobby?.Room.Entries.FirstOrDefault(e => e.Id == peer)?.Name is { Length: > 0 } n ? n : "player " + peer;

    private void OnSpawned(int peer, Node character, bool isLocal)
    {
        var c = (NetPlayerCharacter)character;
        c.Setup(NameOf(peer), Seat(peer));
        if (isLocal) LocalCharacter = c;
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
        if (LocalCharacter == null || !IsInstanceValid(LocalCharacter) || !Camera.IsInsideTree()) return;
        var p = LocalCharacter.GlobalPosition;
        Camera.GlobalPosition = Camera.GlobalPosition.Lerp(p + new Vector3(0f, 9f, 11f), 0.1f);
        Camera.LookAt(p);
    }

    /// <summary>The scripted walk and its check (see NetPlayerAutotest); <paramref name="clock"/> null: the wall clock.</summary>
    public void AttachAutotest(System.Func<double>? clock)
    {
        Autotest = new NetPlayerAutotest { Clock = clock };
        AddChild(Autotest);
        Autotest.Attach(this);
    }
}
