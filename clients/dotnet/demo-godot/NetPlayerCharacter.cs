using System;
using Godot;
using OneLobby;

namespace OneLobbyDemo;

/// <summary>
/// One capsule. The local one walks with the arrow keys or WASD and jumps with space; every other one is moved by its
/// OneLobbyNetPlayer node (position and facing arrive from the network), so this script only moves the local player.
/// </summary>
public partial class NetPlayerCharacter : CharacterBody3D
{
    private const float Speed = 5f;
    private const float JumpSpeed = 6f;
    private const float Gravity = 18f;
    private static readonly Color[] Colors =
    {
        new(0.9f, 0.3f, 0.3f), new(0.3f, 0.5f, 0.95f), new(0.3f, 0.8f, 0.4f), new(0.95f, 0.8f, 0.25f),
        new(0.7f, 0.4f, 0.9f), new(0.3f, 0.85f, 0.85f), new(0.95f, 0.55f, 0.2f), new(0.8f, 0.8f, 0.8f),
    };

    /// <summary>The headless test drives the local player with this instead of the keyboard: the move (x right, y back) and whether to jump.</summary>
    public Func<(Vector2 Move, bool Jump)>? Scripted { get; set; }

    private OneLobbyNetPlayer _net = null!;
    private MeshInstance3D _body = null!;
    private Label3D _label = null!;
    private int _colorTeam = -1;

    public OneLobbyNetPlayer Net => _net;

    public override void _Ready()
    {
        _net = GetNode<OneLobbyNetPlayer>("NetPlayer");
        _body = GetNode<MeshInstance3D>("Body");
        _label = GetNode<Label3D>("Name");
    }

    /// <summary>The player's name over its head, and (the local one) its team: the colour travels as the <c>Team</c> of the state.</summary>
    public void Setup(string displayName, int team)
    {
        _label.Text = displayName;
        if (_net.IsLocal) _net.Team = team;
    }

    public override void _PhysicsProcess(double delta)
    {
        if (!_net.IsLocal) return;
        var move = Vector2.Zero;
        var wantJump = false;
        if (Scripted != null)
        {
            (move, wantJump) = Scripted();
        }
        else
        {
            move = Input.GetVector("ui_left", "ui_right", "ui_up", "ui_down");
            if (Input.IsKeyPressed(Key.A)) move.X -= 1f;
            if (Input.IsKeyPressed(Key.D)) move.X += 1f;
            if (Input.IsKeyPressed(Key.W)) move.Y -= 1f;
            if (Input.IsKeyPressed(Key.S)) move.Y += 1f;
            move = move.LimitLength(1f);
            wantJump = Input.IsKeyPressed(Key.Space);
        }
        var v = Velocity;
        v.X = move.X * Speed;
        v.Z = move.Y * Speed;
        if (IsOnFloor())
        {
            v.Y = 0f;
            if (wantJump)
            {
                v.Y = JumpSpeed;
                _net.Jump(); // the others see (and hear) it at the right moment
            }
        }
        else v.Y -= Gravity * (float)delta;
        Velocity = v;
        if (move.Length() > 0.01f) Rotation = new Vector3(Rotation.X, Mathf.Atan2(-move.X, -move.Y), Rotation.Z);
        MoveAndSlide();
    }

    public override void _Process(double delta)
    {
        if (_colorTeam == _net.Team) return;
        _colorTeam = _net.Team;
        _body.MaterialOverride = new StandardMaterial3D { AlbedoColor = Colors[_net.Team % Colors.Length] };
    }
}
