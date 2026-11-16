using System;
using Godot;
using OneLobby.Replication;

namespace OneLobby;

/// <summary>
/// One networked player, as a node under the game's character (<c>CharacterBody3D</c>, <c>CharacterBody2D</c>, or any <c>Node3D</c> / <c>Node2D</c>).
/// Put it under the character, set <see cref="PeerId"/> (the spawner does), and the character is in the world on every screen: position,
/// facing, movement state and the action events, smooth on the other machines. No player sync of your own. The twin of the GDScript
/// <c>OneLobbyNetPlayer</c> (names in PascalCase), on top of <see cref="NetPlayers"/> (OneLobby.Replication).
/// <para>2D or 3D follows <c>sync.player.space</c> of the layer; a parent of the other kind is one clear error and the node stays unbound.
/// Positions are the parent's <c>GlobalPosition</c> (Godot floats widen to the layer's doubles; the codec quantises through float32 on the
/// wire); the facing is <c>GlobalRotationDegrees.Y</c> (3D) or <c>GlobalRotationDegrees</c> (2D), wrapped to [0, 360).</para>
/// <para>Three roles, decided by <see cref="PeerId"/> and the layer's authority:
/// the machine that owns the player in authority "owner" (the default): the game moves its character as it always did; each physics frame
/// this node reads the parent (position, velocity and <c>IsOnFloor()</c> of a CharacterBody, yaw) plus the values the game sets here
/// (<see cref="Pitch"/>, <see cref="Mode"/>, <see cref="Item"/>, <see cref="Aiming"/>, <see cref="Blocking"/>, <see cref="Health"/>, <see cref="Alive"/>,
/// <see cref="Team"/>) and hands them to the layer. The machine that owns the player in authority "host": the game gives this node its input
/// each physics frame (<see cref="SetInput(in NetPlayerInput)"/>), the node predicts with <see cref="StepFunction"/> (deterministic, it runs
/// on the host too) and writes the predicted position plus the smoothed correction into the parent; nothing is written before the host's
/// first state of the player has arrived. Every other machine: each rendered frame the node writes the smoothed state into the parent and
/// exposes the rest as properties.</para>
/// <para>Action events are Godot signals, played at the right tick (also for the local player, at once), so GDScript code in the same game
/// can connect to them (<c>net.Connect("Jumped", ...)</c>); the owner starts one with a method of the same word (<see cref="Jump"/>,
/// <see cref="Shoot"/> ...). <c>Melee</c> is the one signal whose method needs another name (<see cref="MeleeAttack"/>), and the host raises
/// <c>Hit</c> and <c>Died</c> with <see cref="Hurt"/> and <see cref="Kill"/>.</para>
/// A node class in a referenced assembly cannot be attached to a scene in the editor, so this one is a script of the game project
/// (the add-on folder <c>addons/onelobby_net_player</c>), as the menu is; the game references <c>OneLobby.Replication</c>.
/// </summary>
[GlobalClass]
public partial class OneLobbyNetPlayer : Node
{
    /// <summary>An action event of this player, once it plays (also for the local player, at once).</summary>
    [Signal] public delegate void JumpedEventHandler();
    [Signal] public delegate void LandedEventHandler(float impact);
    [Signal] public delegate void ShotEventHandler(float yaw, float pitch, long view);
    [Signal] public delegate void MeleeEventHandler(int swing);
    [Signal] public delegate void ReloadedEventHandler();
    [Signal] public delegate void UsedEventHandler(int target);
    [Signal] public delegate void ItemSwitchedEventHandler(int slot);
    [Signal] public delegate void ThrownEventHandler(float yaw, float pitch, float power);
    /// <summary>The host judged a hit on this player.</summary>
    [Signal] public delegate void HitEventHandler(int by, int damage);
    [Signal] public delegate void DiedEventHandler(int by);
    [Signal] public delegate void RespawnedEventHandler();
    [Signal] public delegate void EmotedEventHandler(int emote);

    /// <summary>The peer this player belongs to (set by the spawner or the game).</summary>
    [Export] public int PeerId { get; set; }

    /// <summary>Path to an <c>AnimationPlayer</c>; it plays <see cref="ModeAnimations"/>[mode] on the owner's machine (from the local state) and on remote ones.</summary>
    [Export(PropertyHint.NodePathValidTypes, "AnimationPlayer")] public NodePath AnimationPlayerPath { get; set; } = new NodePath();

    /// <summary>Path to an <c>AnimationTree</c>; each key of <see cref="AnimationParams"/> that this node knows is set on it.</summary>
    [Export(PropertyHint.NodePathValidTypes, "AnimationTree")] public NodePath AnimationTreePath { get; set; } = new NodePath();

    /// <summary>Mode number to animation name: the nine modes of the preset (idle walk run crouch jump fall swim climb fly).</summary>
    [Export] public global::Godot.Collections.Dictionary<int, string> ModeAnimations { get; set; } = new()
    {
        { 0, "idle" }, { 1, "walk" }, { 2, "run" }, { 3, "crouch" }, { 4, "jump" }, { 5, "fall" }, { 6, "swim" }, { 7, "climb" }, { 8, "fly" },
    };

    /// <summary>
    /// Value name to AnimationTree parameter path. Names: <c>mode</c>, <c>speed</c> (horizontal speed), <c>on_ground</c>, <c>aiming</c>, <c>blocking</c>,
    /// <c>alive</c>, <c>health</c>, <c>item</c>, <c>team</c> (the same names as the GDScript node). Example: <c>{"speed": "parameters/Move/blend_position"}</c>.
    /// The map is read when the node is bound and when its count changes; call <see cref="RefreshAnimationParams"/> after changing a value in place.
    /// </summary>
    [Export] public global::Godot.Collections.Dictionary<string, string> AnimationParams { get; set; } = new();

    /// <summary>True: the node derives <see cref="Mode"/> on the owner's machine (idle, walk, jump, fall) from the parent's movement; set <c>Mode</c> yourself and switch this off to use the others.</summary>
    [Export] public bool AutoMode { get; set; } = true;

    /// <summary>True: a remote player's character stays hidden until its first state has arrived (nobody sees a player flash at the origin).</summary>
    [Export] public bool HideUntilFirstState { get; set; } = true;

    /// <summary>Host authority: the game's movement step. It goes to the layer the node is bound to when the layer has none (the same function must run on the host and on every owner).</summary>
    public PlayerStepFunc? StepFunction { get; set; }

    /// <summary>True for the player this machine controls (set by <see cref="Bind"/>).</summary>
    public bool IsLocal { get; private set; }

    // The values of the player: the game sets them for its own player; they are read-only on remote machines.
    public double Pitch { get; set; }
    public int Mode { get; set; }
    public bool OnGround { get; set; } = true;
    public int Item { get; set; }
    public bool Aiming { get; set; }
    public bool Blocking { get; set; }
    public int Health { get; set; } = 100;
    public bool Alive { get; set; } = true;
    public int Team { get; set; }
    /// <summary>Metres per second of a 3D player (zero for a 2D one; see <see cref="Velocity2D"/>).</summary>
    public Vector3 Velocity { get; private set; }
    /// <summary>Metres per second of a 2D player.</summary>
    public Vector2 Velocity2D { get; private set; }

    /// <summary>The layer this node is bound to, or null.</summary>
    public NetPlayers? Players => _players;
    public bool IsBound => _players != null;

    /// <summary>True once the node has logged that host authority has no step function (it logs once).</summary>
    internal bool StepWarned => _warned;

    private NetPlayers? _players;
    private bool _haveState, _warned, _haveInput;
    private NetPlayerInput _input;
    private int _animMode = -1;
    private StringName? _animName;
    private int _paramCount = -1;
    private string[] _paramKeys = Array.Empty<string>();
    private StringName[] _paramPaths = Array.Empty<StringName>();
    private double[] _paramLast = Array.Empty<double>();

    /// <summary>Join a layer (the spawner calls this; a game that makes its own layer calls it for each character). Binding again moves the node to another layer.</summary>
    public void Bind(NetPlayers players)
    {
        Unbind();
        _players = players ?? throw new ArgumentNullException(nameof(players));
        if (!CheckSpace())
        {
            _players = null;
            return;
        }
        IsLocal = PeerId == players.LocalPeerId;
        if (StepFunction != null && players.Step == null) players.Step = StepFunction;
        players.OnAction += OnAction;
        players.Corrected += OnCorrected;
        _haveState = false;
        _paramCount = -1;
        if (HideUntilFirstState && !IsLocal) SetVisible(false);
        SetProcess(true);
        SetPhysicsProcess(true);
    }

    /// <summary>Leave the layer (the node does nothing until bound again).</summary>
    public void Unbind()
    {
        if (_players != null)
        {
            _players.OnAction -= OnAction;
            _players.Corrected -= OnCorrected;
        }
        _players = null;
        IsLocal = false;
    }

    /// <summary>Read <see cref="AnimationParams"/> again (after changing a value of an existing key).</summary>
    public void RefreshAnimationParams() => _paramCount = -1;

    public override void _Ready()
    {
        if (_players == null)
        {
            SetProcess(false);
            SetPhysicsProcess(false);
        }
    }

    public override void _ExitTree() => Unbind();

    // ---- the game's side ---------------------------------------------------------------------------------------------

    /// <summary>
    /// Host authority, local player: this physics frame's input (<c>MoveX</c>, <c>MoveY</c>, <c>Yaw</c>, <c>Pitch</c>, <c>Buttons</c>). The whole
    /// struct replaces the last one (the GDScript node merges a patch); call it every physics frame. Until the host's first state of this
    /// player has arrived there is nothing to step and nothing is sent (the call is harmless; the character is not moved).
    /// </summary>
    public void SetInput(in NetPlayerInput input)
    {
        _input = input;
        _haveInput = true;
    }

    /// <summary>Put the player somewhere else without sliding (3D; it moves the parent too). The owner, or the host for its own player; the host places any other player through <see cref="Players"/>.<c>TeleportPlayer</c>.</summary>
    public void Teleport(Vector3 to)
    {
        if (_players == null) return;
        if (GetParent() is Node3D p) p.GlobalPosition = to;
        _players.Teleport(to.X, to.Y, to.Z);
    }

    /// <summary>Put the player somewhere else without sliding (2D).</summary>
    public void Teleport(Vector2 to)
    {
        if (_players == null) return;
        if (GetParent() is Node2D p) p.GlobalPosition = to;
        _players.Teleport(to.X, to.Y);
    }

    /// <summary>Respawn where the character stands: a teleport that also makes the player alive with full health, then the <c>Respawned</c> event.</summary>
    public void Respawn()
    {
        if (_players == null) return;
        Alive = true;
        Health = 100;
        _players.Respawn(_players.Authority == PlayerAuthority.Owner ? ReadParent() : _players.Local ?? new PlayerState());
    }

    public void Respawn(Vector3 to)
    {
        if (_players == null) return;
        if (GetParent() is Node3D p) p.GlobalPosition = to;
        Respawn();
    }

    public void Respawn(Vector2 to)
    {
        if (_players == null) return;
        if (GetParent() is Node2D p) p.GlobalPosition = to;
        Respawn();
    }

    // Starting an action event (the owner; the host may start any player's through this node):

    public void Jump() => Send(PlayerAction.Jump, default);
    public void Land(float impact) => Send(PlayerAction.Land, new ActionArgs { Impact = impact });
    public void Shoot(float yaw, float pitch = 0f) => Send(PlayerAction.Shoot, new ActionArgs { Yaw = yaw, Pitch = pitch });
    /// <summary><c>Melee</c> is the signal, this starts it (<paramref name="swing"/> is the game's swing id, 0..255).</summary>
    public void MeleeAttack(int swing = 0) => Send(PlayerAction.Melee, new ActionArgs { Swing = swing });
    public void Reload() => Send(PlayerAction.Reload, default);
    public void Use(int target = 0) => Send(PlayerAction.Use, new ActionArgs { Target = target });
    public void SwitchItem(int slot)
    {
        Item = slot;
        Send(PlayerAction.ItemSwitch, new ActionArgs { Slot = slot });
    }
    public void ThrowItem(float yaw, float pitch, float power) => Send(PlayerAction.Throw, new ActionArgs { Yaw = yaw, Pitch = pitch, Power = power });
    public void Emote(int id) => Send(PlayerAction.Emote, new ActionArgs { Emote = id });

    /// <summary>Host only: this player took a hit (the host judged a shot).</summary>
    public void Hurt(int by, int damage) => _players?.HostAction(PeerId, PlayerAction.Hit, new ActionArgs { By = by, Damage = damage });

    /// <summary>Host only: this player died.</summary>
    public void Kill(int by) => _players?.HostAction(PeerId, PlayerAction.Death, new ActionArgs { By = by });

    private void Send(PlayerAction name, in ActionArgs args)
    {
        if (_players == null)
        {
            GD.PushError("OneLobbyNetPlayer: not bound to a layer (the spawner binds it; or call Bind)");
            return;
        }
        if (!IsLocal)
        {
            // the host may start any player's owner event
            if (_players.IsHost) _players.HostAction(PeerId, name, args);
            else GD.PushError("OneLobbyNetPlayer: " + name + "() is for the player this machine controls");
            return;
        }
        _players.Action(name, args);
    }

    // ---- frames ------------------------------------------------------------------------------------------------------

    public override void _PhysicsProcess(double delta)
    {
        if (_players == null || !IsLocal) return;
        if (_players.Authority == PlayerAuthority.Owner)
        {
            _players.SetLocalState(ReadParent());
            return;
        }
        if (_players.Step == null)
        {
            if (!_warned)
            {
                _warned = true;
                GD.PushError("OneLobbyNetPlayer: sync.player.authority is \"host\": give the node a StepFunction (a PlayerStepFunc) or set NetPlayers.Step");
            }
            return;
        }
        if (_haveInput) _players.SetLocalInput(_input);
    }

    public override void _Process(double delta)
    {
        if (_players == null) return;
        if (IsLocal)
        {
            if (_players.Authority == PlayerAuthority.Host)
            {
                // Local is null until the host's first state of this player has arrived: nothing to write into the parent before that
                if (_players.Local is PlayerState l) ApplyState(l, _players.Smoother.Offset); // the predicted state plus the smoothed correction
            }
            else if (!_haveState)
            {
                _haveState = true;
                SetVisible(true);
            }
            Animate(Mode, Speed(Velocity.X, Velocity.Y, Velocity.Z, Velocity2D), OnGround, Aiming, Blocking, Alive, Health, Item, Team);
            return;
        }
        if (!_players.TryGet(PeerId, out var s)) return;
        ApplyState(s, (0f, 0f, 0f));
        Animate(s.Mode, Speed(s.Vx, s.Vy, s.Vz, default), s.OnGround, s.Aiming, s.Blocking, s.Alive, s.Health, s.Item, s.Team);
    }

    private double Speed(double vx, double vy, double vz, Vector2 v2)
        => _players!.Codec.Is3D ? Math.Sqrt(vx * vx + vz * vz) : Math.Sqrt(v2.X * v2.X + v2.Y * v2.Y);

    /// <summary>The game's side of an owner's state: what the parent says, plus the values set on this node.</summary>
    private PlayerState ReadParent()
    {
        var d = new PlayerState();
        var p = GetParent();
        if (p is Node3D n3)
        {
            var pos = n3.GlobalPosition;
            d.X = pos.X; d.Y = pos.Y; d.Z = pos.Z; // float to double: exact
            d.Yaw = PosMod360(n3.GlobalRotationDegrees.Y);
            d.Pitch = Pitch;
            if (p is CharacterBody3D cb)
            {
                var v = cb.Velocity;
                d.Vx = v.X; d.Vy = v.Y; d.Vz = v.Z;
                OnGround = cb.IsOnFloor() || cb.MotionMode == CharacterBody3D.MotionModeEnum.Floating;
                Velocity = v;
            }
        }
        else if (p is Node2D n2)
        {
            var pos = n2.GlobalPosition;
            d.X = pos.X; d.Y = pos.Y;
            d.Yaw = PosMod360(n2.GlobalRotationDegrees);
            if (p is CharacterBody2D cb2)
            {
                var v = cb2.Velocity;
                d.Vx = v.X; d.Vy = v.Y;
                OnGround = cb2.IsOnFloor() || cb2.MotionMode == CharacterBody2D.MotionModeEnum.Floating; // a top-down game is always on the ground
                Velocity2D = v;
            }
        }
        d.OnGround = OnGround;
        if (AutoMode) Mode = DeriveMode(d);
        d.Mode = Mode;
        d.Item = Item;
        d.Aiming = Aiming;
        d.Blocking = Blocking;
        d.Health = Health;
        d.Alive = Alive;
        d.Team = Team;
        return d;
    }

    private static double PosMod360(double deg)
    {
        var r = deg % 360.0;
        return r < 0 ? r + 360.0 : r;
    }

    private int DeriveMode(in PlayerState d)
    {
        if (!OnGround) return d.Vy > 0.0 && _players!.Codec.Is3D ? 4 : 5;
        var sp = _players!.Codec.Is3D ? Math.Sqrt(d.Vx * d.Vx + d.Vz * d.Vz) : Math.Sqrt(d.Vx * d.Vx + d.Vy * d.Vy);
        return sp > 0.1 ? 1 : 0;
    }

    /// <summary>Write a state into the parent (position, facing) and into the properties of this node. <paramref name="offset"/> is the smoother's correction (a 2D one rides its X and Z).</summary>
    private void ApplyState(in PlayerState s, (float X, float Y, float Z) offset)
    {
        var p = GetParent();
        if (p is Node3D n3)
        {
            n3.GlobalPosition = new Vector3((float)(s.X + offset.X), (float)(s.Y + offset.Y), (float)(s.Z + offset.Z));
            var r = n3.GlobalRotationDegrees;
            n3.GlobalRotationDegrees = new Vector3(r.X, (float)s.Yaw, r.Z);
            Velocity = new Vector3((float)s.Vx, (float)s.Vy, (float)s.Vz);
        }
        else if (p is Node2D n2)
        {
            n2.GlobalPosition = new Vector2((float)(s.X + offset.X), (float)(s.Y + offset.Z));
            n2.GlobalRotationDegrees = (float)s.Yaw;
            Velocity2D = new Vector2((float)s.Vx, (float)s.Vy);
        }
        Pitch = s.Pitch;
        Mode = s.Mode;
        OnGround = s.OnGround;
        Item = s.Item;
        Aiming = s.Aiming;
        Blocking = s.Blocking;
        Health = s.Health;
        Alive = s.Alive;
        Team = s.Team;
        if (!_haveState)
        {
            _haveState = true;
            SetVisible(true);
        }
    }

    private void SetVisible(bool v)
    {
        var p = GetParent();
        if (p is CanvasItem ci) ci.Visible = v;
        else if (p is Node3D n3) n3.Visible = v;
    }

    /// <summary>The 2D / 3D check: one clear error when the parent is the other kind.</summary>
    private bool CheckSpace()
    {
        var is3d = _players!.Codec.Is3D;
        var p = GetParent();
        if (p is Node3D && !is3d)
        {
            GD.PushError("OneLobbyNetPlayer: the parent \"" + p.Name + "\" is a Node3D but sync.player.space is \"2d\"");
            return false;
        }
        if (p is Node2D && is3d)
        {
            GD.PushError("OneLobbyNetPlayer: the parent \"" + p.Name + "\" is a Node2D but sync.player.space is \"3d\" (set sync.player.space to \"2d\")");
            return false;
        }
        if (p is not (Node3D or Node2D))
        {
            GD.PushError("OneLobbyNetPlayer: put the node under a Node3D or Node2D (the character); the parent is " + (p == null ? "missing" : p.GetClass()));
            return false;
        }
        return true;
    }

    // ---- events and animation ----------------------------------------------------------------------------------------

    private void OnAction(ActionEvent e)
    {
        if (e.Player != PeerId) return;
        var a = e.Args;
        switch (e.Name)
        {
            case PlayerAction.Jump: EmitSignal(SignalName.Jumped); break;
            case PlayerAction.Land: EmitSignal(SignalName.Landed, (float)a.Impact); break;
            case PlayerAction.Shoot: EmitSignal(SignalName.Shot, (float)a.Yaw, (float)a.Pitch, (long)a.View); break;
            case PlayerAction.Melee: EmitSignal(SignalName.Melee, a.Swing); break;
            case PlayerAction.Reload: EmitSignal(SignalName.Reloaded); break;
            case PlayerAction.Use: EmitSignal(SignalName.Used, a.Target); break;
            case PlayerAction.ItemSwitch: EmitSignal(SignalName.ItemSwitched, a.Slot); break;
            case PlayerAction.Throw: EmitSignal(SignalName.Thrown, (float)a.Yaw, (float)a.Pitch, (float)a.Power); break;
            case PlayerAction.Hit: EmitSignal(SignalName.Hit, a.By, a.Damage); break;
            case PlayerAction.Death: EmitSignal(SignalName.Died, a.By); break;
            case PlayerAction.Respawn: EmitSignal(SignalName.Respawned); break;
            case PlayerAction.Emote: EmitSignal(SignalName.Emoted, a.Emote); break;
        }
    }

    /// <summary>Owner mode: the host put this player back: take its state as ours.</summary>
    private void OnCorrected(PlayerState s)
    {
        if (!IsLocal) return;
        ApplyState(s, (0f, 0f, 0f));
        var p = GetParent();
        if (p is CharacterBody3D cb) cb.Velocity = Velocity;
        else if (p is CharacterBody2D cb2) cb2.Velocity = Velocity2D;
    }

    private void Animate(int mode, double speed, bool onGround, bool aiming, bool blocking, bool alive, int health, int item, int team)
    {
        if (!AnimationPlayerPath.IsEmpty)
        {
            var ap = GetNodeOrNull<AnimationPlayer>(AnimationPlayerPath);
            if (ap != null)
            {
                var changed = mode != _animMode;
                if (changed)
                {
                    _animMode = mode;
                    // resolved once per mode change (a missing animation is skipped silently); no read of AnimationPlayer.CurrentAnimation:
                    // its C# accessor is not in every Godot 4.x build
                    _animName = ModeAnimations.TryGetValue(mode, out var name) && !string.IsNullOrEmpty(name) && ap.HasAnimation(name) ? new StringName(name) : null;
                }
                if (_animName != null && (changed || !ap.IsPlaying())) ap.Play(_animName);
            }
        }
        if (!AnimationTreePath.IsEmpty && AnimationParams.Count > 0)
        {
            var tree = GetNodeOrNull<AnimationTree>(AnimationTreePath);
            if (tree == null) return;
            if (_paramCount != AnimationParams.Count) ReadParams();
            for (var i = 0; i < _paramKeys.Length; i++)
            {
                double v;
                switch (_paramKeys[i])
                {
                    case "mode": v = mode; break;
                    case "speed": v = speed; break;
                    case "on_ground": v = onGround ? 1 : 0; break;
                    case "aiming": v = aiming ? 1 : 0; break;
                    case "blocking": v = blocking ? 1 : 0; break;
                    case "alive": v = alive ? 1 : 0; break;
                    case "health": v = health; break;
                    case "item": v = item; break;
                    case "team": v = team; break;
                    default: continue;
                }
                if (v == _paramLast[i]) continue; // nothing to set (and nothing to allocate)
                _paramLast[i] = v;
                switch (_paramKeys[i])
                {
                    case "mode": case "health": case "item": case "team": tree.Set(_paramPaths[i], (int)v); break;
                    case "speed": tree.Set(_paramPaths[i], (float)v); break;
                    default: tree.Set(_paramPaths[i], v != 0); break;
                }
            }
        }
    }

    private void ReadParams()
    {
        _paramCount = AnimationParams.Count;
        _paramKeys = new string[_paramCount];
        _paramPaths = new StringName[_paramCount];
        _paramLast = new double[_paramCount];
        var i = 0;
        foreach (var kv in AnimationParams)
        {
            _paramKeys[i] = kv.Key;
            _paramPaths[i] = new StringName(kv.Value);
            _paramLast[i] = double.NaN;
            i++;
        }
    }
}
