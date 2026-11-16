using System;
using System.Collections.Generic;
using System.Linq;
using Godot;
using OneLobby.Replication;

namespace OneLobby;

/// <summary>
/// Makes one character per seated player. Give it the lobby (the menu's <c>GameStarted</c> lobby), the game's blueprint and a
/// <c>PackedScene</c> of the game's character (with a <see cref="OneLobbyNetPlayer"/> inside); it creates the layer
/// (<see cref="NetPlayers"/>), pumps it every frame, adds a character when the layer says a player joined (this machine's own at once,
/// marked local so the game can attach its camera and input), and frees it when the player leaves. The twin of the GDScript spawner.
/// <code>
/// var spawner = new OneLobbyNetPlayerSpawner { Scene = GD.Load&lt;PackedScene&gt;("res://Player.tscn") };
/// spawner.SpawnPoint = peer =&gt; new Vector3(peer * 2f, 1f, 0f);
/// spawner.Connect(OneLobbyNetPlayerSpawner.SignalName.PlayerSpawned, Callable.From((int peer, Node c, bool local) =&gt; { }));
/// AddChild(spawner);
/// spawner.Start(lobby, blueprint);
/// </code>
/// A game that wants to do this itself uses <see cref="NetPlayers"/> and <see cref="OneLobbyNetPlayer"/> directly (the spawner is a few
/// dozen lines on top of them). The spawner owns the layer it is given: <see cref="Stop"/> and leaving the tree dispose it
/// (the lobby and the session stay yours).
/// </summary>
[GlobalClass]
public partial class OneLobbyNetPlayerSpawner : Node
{
    /// <summary>A character was added: <c>character</c> is the scene's root, <c>isLocal</c> is true for the player this machine controls.</summary>
    [Signal] public delegate void PlayerSpawnedEventHandler(int peer, Node character, bool isLocal);

    /// <summary>A character is about to be freed (its player left, or became a spectator).</summary>
    [Signal] public delegate void PlayerRemovedEventHandler(int peer, Node character);

    /// <summary>The game's character: a scene with a <see cref="OneLobbyNetPlayer"/> somewhere inside (its parent should be the character).</summary>
    [Export] public PackedScene? Scene { get; set; }

    /// <summary>Where the characters go: a path from this node, default this node's parent.</summary>
    [Export] public NodePath SpawnParent { get; set; } = new NodePath();

    /// <summary>True: the spawner pumps the layer every frame (turn it off when your own code calls <c>Players.Pump()</c>).</summary>
    [Export] public bool PumpLayer { get; set; } = true;

    /// <summary>Where a 3D player starts. Used for the character instance, and, with authority "host", as the player's place on the host. Default: the origin.</summary>
    public Func<int, Vector3>? SpawnPoint { get; set; }

    /// <summary>The same for a 2D game.</summary>
    public Func<int, Vector2>? SpawnPoint2D { get; set; }

    /// <summary>Host authority: the movement step that goes to the layer (see <see cref="OneLobbyNetPlayer"/>).</summary>
    public PlayerStepFunc? StepFunction { get; set; }

    /// <summary>The layer (after <see cref="Start"/> or <see cref="UsePlayers"/>).</summary>
    public NetPlayers? Players { get; private set; }

    /// <summary>Peer id to the character instance.</summary>
    public IReadOnlyDictionary<int, Node> Characters => _characters;

    private readonly Dictionary<int, Node> _characters = new();

    /// <summary>
    /// Make the layer from a lobby and start spawning. <paramref name="blueprint"/>: the game's <c>onelobby.json</c> (null: the layer's
    /// defaults, or <paramref name="options"/> as given). <paramref name="options"/> adds <c>Step</c>, <c>Spawn</c> ... (with no blueprint it is the
    /// whole configuration; with one only its <c>Step</c>, <c>Spawn</c>, <c>AdaptiveDelay</c> and <c>Session</c> are read, as in <see cref="NetPlayers.FromConfig"/>).
    /// </summary>
    public NetPlayers Start(Lobby lobby, Blueprint? blueprint = null, NetPlayersOptions? options = null)
    {
        var merged = new NetPlayersOptions
        {
            Authority = options?.Authority ?? PlayerAuthority.Owner,
            Space = options?.Space ?? "3d",
            Range = options?.Range ?? 300,
            VelocityRange = options?.VelocityRange ?? 32,
            Limits = options?.Limits ?? new PlayerLimits(null, null, null, null),
            Omit = options?.Omit ?? Array.Empty<string>(),
            Step = options?.Step ?? StepFunction,
            Spawn = options?.Spawn ?? (SpawnPoint != null || SpawnPoint2D != null ? SpawnState : null),
            Session = options?.Session,
            AdaptiveDelay = options?.AdaptiveDelay ?? true,
        };
        var layer = blueprint != null ? NetPlayers.FromConfig(lobby, blueprint, merged) : new NetPlayers(lobby, merged);
        UsePlayers(layer);
        return layer;
    }

    /// <summary>Spawn for a layer you made yourself (the spawner disposes it on <see cref="Stop"/>).</summary>
    public void UsePlayers(NetPlayers layer)
    {
        Stop();
        Players = layer ?? throw new ArgumentNullException(nameof(layer));
        layer.PlayerJoined += OnJoined;
        layer.PlayerLeft += OnLeft;
        layer.Tick += OnTick;
        // this machine's own character at once: in owner authority its state is what makes the player appear on the others, so waiting for the join event would deadlock
        if (!IsSpectator(layer)) OnJoined(layer.LocalPeerId);
        foreach (var peer in layer.Players.ToArray()) OnJoined(peer);
        SetProcess(PumpLayer);
    }

    /// <summary>Stop spawning, free the characters and dispose the layer.</summary>
    public void Stop()
    {
        var layer = Players;
        if (layer == null) return;
        layer.PlayerJoined -= OnJoined;
        layer.PlayerLeft -= OnLeft;
        layer.Tick -= OnTick;
        foreach (var peer in _characters.Keys.ToArray()) OnLeft(peer);
        Players = null;
        layer.Dispose();
    }

    /// <summary>The character of a peer, or null.</summary>
    public Node? CharacterOf(int peer) => _characters.TryGetValue(peer, out var n) ? n : null;

    public override void _Ready() => SetProcess(Players != null && PumpLayer);

    public override void _Process(double delta) => Players?.Pump();

    public override void _ExitTree() => Stop();

    /// <summary>The host's start of a player (host authority): the spawn point as a state.</summary>
    private PlayerState SpawnState(int peer)
    {
        var s = new PlayerState();
        if (SpawnPoint != null) { var v = SpawnPoint(peer); s.X = v.X; s.Y = v.Y; s.Z = v.Z; }
        else if (SpawnPoint2D != null) { var v = SpawnPoint2D(peer); s.X = v.X; s.Y = v.Y; }
        return s;
    }

    private static bool IsSpectator(NetPlayers layer) => layer.Session.Lobby.Room.Me is { Role: RoomRole.Spectator };

    // A joiner's roster says "player" until the host's room snapshot arrives, so a spectator's local character made at once is taken
    // back as soon as the roster says otherwise (the layer itself never announces the local spectator).
    private void OnTick(uint tick)
    {
        if (Players != null && _characters.ContainsKey(Players.LocalPeerId) && IsSpectator(Players)) OnLeft(Players.LocalPeerId);
    }

    private void OnJoined(int peer)
    {
        if (_characters.ContainsKey(peer)) return;
        if (Scene == null)
        {
            GD.PushError("OneLobbyNetPlayerSpawner: set Scene to the game's character (a PackedScene)");
            return;
        }
        var inst = Scene.Instantiate();
        inst.Name = "Player" + peer;
        var np = FindNetPlayer(inst);
        if (np == null)
        {
            GD.PushError("OneLobbyNetPlayerSpawner: the character scene has no OneLobbyNetPlayer inside");
            inst.Free();
            return;
        }
        np.PeerId = peer;
        if (inst is Node3D n3 && SpawnPoint != null) n3.Position = SpawnPoint(peer);
        else if (inst is Node2D n2 && SpawnPoint2D != null) n2.Position = SpawnPoint2D(peer);
        var holder = (SpawnParent.IsEmpty ? null : GetNodeOrNull(SpawnParent)) ?? GetParent();
        holder.AddChild(inst);
        np.StepFunction = StepFunction;
        np.Bind(Players!);
        _characters[peer] = inst;
        inst.SetMeta("onelobby_local", np.IsLocal);
        EmitSignal(SignalName.PlayerSpawned, peer, inst, np.IsLocal);
    }

    private void OnLeft(int peer)
    {
        if (!_characters.Remove(peer, out var inst)) return;
        EmitSignal(SignalName.PlayerRemoved, peer, inst);
        if (IsInstanceValid(inst)) inst.QueueFree();
    }

    private static OneLobbyNetPlayer? FindNetPlayer(Node n)
    {
        if (n is OneLobbyNetPlayer np) return np;
        foreach (var c in n.GetChildren())
        {
            var f = FindNetPlayer(c);
            if (f != null) return f;
        }
        return null;
    }
}
