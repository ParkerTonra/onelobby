using Godot;
using OneLobby;
//@if host
using OneLobby.Replication;
//@end

namespace {{ns}};

/// <summary>
/// One player's character: the scene Player.tscn, one copy per player on every machine. The OneLobbyNetPlayer child (<c>NetPlayer</c>)
/// does the networking; this script only reads the keyboard of the local player. A side-on platformer: left and right, jump. Yours to edit.
//@if owner
/// Authority "owner" (sync.player.authority in onelobby.json): the player's own PC moves this body as in any single-player game and the
/// node sends where it is. On every other PC the node moves the body, so this script does nothing there.
/// (For "host" authority, set sync.player.authority to "host" and scaffold again, or see docs/recipes/net-player.md section 10b:
/// the node is given SetInput() and one pure step function instead.)
//@end
//@if host
/// Authority "host" (sync.player.authority in onelobby.json): this script does NOT move the body. It tells the node what the keys say
/// (SetInput) and the node moves the body with Step(), the same function the host runs; the host has the last word.
/// (For "owner" authority, where the player's own PC moves the body, set sync.player.authority to "owner" and scaffold again, or see
/// docs/recipes/net-player.md section 10b.)
//@end
/// </summary>
public partial class Player : CharacterBody2D
{
    private const float Speed = 220f;
    private const float JumpSpeed = 420f;
    private const float Gravity = 1100f;
//@if host
    private const double GroundY = -16.0; // the square's centre when it stands on the floor (the floor's top is at y = 0, the square is 32 high)
//@end
    private static readonly Color[] Colors =
    {
        new(0.9f, 0.3f, 0.3f), new(0.3f, 0.5f, 0.95f), new(0.3f, 0.8f, 0.4f), new(0.95f, 0.8f, 0.25f),
        new(0.7f, 0.4f, 0.9f), new(0.3f, 0.85f, 0.85f), new(0.95f, 0.55f, 0.2f), new(0.8f, 0.8f, 0.8f),
    };

    private OneLobbyNetPlayer _net = null!;
    private Polygon2D _body = null!;
    private Label _label = null!;
    private int _colorTeam = -1;
//@if host
    private bool _jumpDown;
//@end

    public OneLobbyNetPlayer Net => _net;

    public override void _Ready()
    {
        _net = GetNode<OneLobbyNetPlayer>("NetPlayer");
        _body = GetNode<Polygon2D>("Body");
        _label = GetNode<Label>("Name");
    }

    /// <summary>Game.cs calls this when the character appears: the name over its head and (the local one) a team, which is the colour on every screen.</summary>
    public void Setup(string displayName, int team)
    {
        _label.Text = displayName;
        if (_net.IsLocal) _net.Team = team;
    }

//@if owner
    public override void _PhysicsProcess(double delta)
    {
        if (!_net.IsLocal) return; // on the other machines the node moves this body
        var v = Velocity;
        v.X = ReadMove() * Speed;
        if (IsOnFloor())
        {
            v.Y = 0f;
            if (JumpPressed())
            {
                v.Y = -JumpSpeed;
                _net.Jump(); // the others see (and hear) it at the right moment
            }
        }
        else v.Y += Gravity * (float)delta;
        Velocity = v;
        MoveAndSlide();
    }
//@end
//@if host
    public override void _PhysicsProcess(double delta)
    {
        if (!_net.IsLocal) return;
        var jump = JumpPressed();
        var onGround = _net.Players?.Local?.OnGround ?? true;
        if (jump && !_jumpDown && onGround) _net.Jump(); // the others see (and hear) it at the right moment
        _jumpDown = jump;
        _net.SetInput(new NetPlayerInput { MoveX = ReadMove(), Buttons = jump ? PlayerButtons.Jump : PlayerButtons.None });
    }

    /// <summary>One step of movement, the same on the host and on every owner (it must depend only on its three arguments): Game.cs gives it to the spawner. The y axis points down, so a jump is a negative vy.</summary>
    public static PlayerState Step(PlayerState s, NetPlayerInput i, double dt)
    {
        var y = s.Y;
        var vy = s.Vy;
        if (y >= GroundY - 0.001 && i.Buttons.HasFlag(PlayerButtons.Jump)) vy = -JumpSpeed;
        if (y < GroundY - 0.001 || vy < 0.0) vy += Gravity * dt;
        y += vy * dt;
        var grounded = y >= GroundY;
        if (grounded)
        {
            y = GroundY;
            vy = 0.0;
        }
        s.X += i.MoveX * Speed * dt;
        s.Y = y;
        s.Vx = i.MoveX * Speed;
        s.Vy = vy;
        s.OnGround = grounded;
        return s;
    }
//@end

    private static float ReadMove()
    {
        var move = Input.GetAxis("ui_left", "ui_right"); // the arrow keys
        if (Input.IsKeyPressed(Key.A)) move -= 1f;
        if (Input.IsKeyPressed(Key.D)) move += 1f;
        return Mathf.Clamp(move, -1f, 1f);
    }

    private static bool JumpPressed() => Input.IsKeyPressed(Key.Space) || Input.IsKeyPressed(Key.Up) || Input.IsKeyPressed(Key.W);

    public override void _Process(double delta)
    {
        if (_colorTeam == _net.Team) return;
        _colorTeam = _net.Team;
        _body.Color = Colors[_net.Team % Colors.Length];
    }
}
