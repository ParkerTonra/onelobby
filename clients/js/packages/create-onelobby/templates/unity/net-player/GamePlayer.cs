#nullable enable
using System;
using OneLobby.Unity;
//@if host
using OneLobby.Replication;
//@end
using UnityEngine;

/// <summary>
/// One player's character, made in code by <see cref="Make"/> (Game.cs gives it to the spawner): one copy per player on every machine. The
/// <see cref="OneLobbyNetPlayer"/> on it does all the networking; this script only reads the keyboard of the local player. Arrow keys or WASD
/// move it, space jumps. Written by create-onelobby; yours to edit (<c>update</c> never rewrites it). Make a prefab of it when you have art.
//@if owner
/// Authority "owner" (sync.player.authority in Assets/Resources/onelobby.json): the player's own PC moves this character as in any single-player
/// game and the component sends where it is. On every other PC the component moves it, so this script does nothing there.
/// (For "host" authority set sync.player.authority to "host" and scaffold again, or see docs/recipes/net-player.md section 12: the component is
/// given SetInput() and one pure step function instead.)
//@end
//@if host
/// Authority "host" (sync.player.authority in Assets/Resources/onelobby.json): this script does NOT move the character. It tells the component
/// what the keys say (SetInput) and the component moves it with <see cref="Step"/>, the same function the host runs; the host has the last word.
/// (For "owner" authority, where the player's own PC moves the character, set sync.player.authority to "owner" and scaffold again, or see
/// docs/recipes/net-player.md section 12.)
//@end
/// </summary>
public sealed class GamePlayer : MonoBehaviour
{
    const float Speed = 5f, JumpSpeed = 6f, Gravity = 18f;
//@if 3d
//@if host
    const double GroundY = 1.0; // the capsule's centre when it stands on the floor (the floor's top is at y = 0, the capsule is 2 m tall)
//@end
//@end
//@if 2d
//@if owner
    const float GroundY = 0.5f; // the square's centre when it stands on the floor (the floor's top is at y = 0, the square is 1 m tall)
//@end
//@if host
    const double GroundY = 0.5; // the square's centre when it stands on the floor (the floor's top is at y = 0, the square is 1 m tall)
//@end
//@end

    static readonly Color[] Colors =
    {
        new Color(0.9f, 0.3f, 0.3f), new Color(0.3f, 0.5f, 0.95f), new Color(0.3f, 0.8f, 0.4f), new Color(0.95f, 0.8f, 0.25f),
        new Color(0.7f, 0.4f, 0.9f), new Color(0.3f, 0.85f, 0.85f), new Color(0.95f, 0.55f, 0.2f), new Color(0.8f, 0.8f, 0.8f),
    };

    /// <summary>The name shown over the character (Game.cs sets it when the character appears).</summary>
    public string DisplayName = "";
    /// <summary>The networking of this character.</summary>
    public OneLobbyNetPlayer Net { get; private set; } = null!;

    Renderer[] _renderers = Array.Empty<Renderer>();
    int _color = -1;
    bool _inputWarned;
//@if owner
//@if 3d
    CharacterController _cc = null!;
//@end
    float _vy;
//@end
//@if host
    float _yaw; // degrees, the way the character faces
    bool _jumpDown;
//@end

    /// <summary>Makes one character, complete (renderers and all) because the component hides the renderers it finds when it is bound.</summary>
    public static GameObject Make(int peer)
    {
        var root = new GameObject("Player" + peer);
//@if 3d
//@if owner
        var cc = root.AddComponent<CharacterController>(); // the owner's PC moves the body with it, as in any single-player game
        cc.height = 2f; cc.radius = 0.5f; cc.center = Vector3.zero;
//@end
        var body = GameObject.CreatePrimitive(PrimitiveType.Capsule);
        body.name = "Body";
        Destroy(body.GetComponent<Collider>());
        body.transform.SetParent(root.transform, false);
        // a nose, so the facing can be seen
        var nose = GameObject.CreatePrimitive(PrimitiveType.Cube);
        nose.name = "Nose";
        Destroy(nose.GetComponent<Collider>());
        nose.transform.SetParent(root.transform, false);
        nose.transform.localScale = new Vector3(0.25f, 0.25f, 0.5f);
        nose.transform.localPosition = new Vector3(0f, 0.5f, 0.55f);
//@end
//@if 2d
        // a square, side-on: x is right, y is up (the layer's x and y; the transform's z is never written)
        var body = GameObject.CreatePrimitive(PrimitiveType.Cube);
        body.name = "Body";
        Destroy(body.GetComponent<Collider>());
        body.transform.SetParent(root.transform, false);
        body.transform.localScale = new Vector3(1f, 1f, 0.2f);
//@end
        root.AddComponent<OneLobbyNetPlayer>(); // the whole networking of this character
        root.AddComponent<GamePlayer>();
        return root;
    }

    void Awake()
    {
        Net = GetComponent<OneLobbyNetPlayer>();
        _renderers = GetComponentsInChildren<Renderer>();
//@if owner
//@if 3d
        _cc = GetComponent<CharacterController>();
//@end
//@end
    }

//@if owner
//@if 3d
    void FixedUpdate()
    {
        if (!Net.IsLocal || !_cc.enabled) return; // on the other machines the component moves this character
        var (move, jump) = ReadKeys();
        var dt = Time.fixedDeltaTime;
        if (_cc.isGrounded)
        {
            _vy = -1f;
            if (jump)
            {
                _vy = JumpSpeed;
                Net.Jump(); // the others see (and hear) it at the right moment
            }
        }
        else _vy -= Gravity * dt;
        _cc.Move(new Vector3(move.x * Speed, _vy, move.y * Speed) * dt);
        if (move.sqrMagnitude > 0.0001f) transform.rotation = Quaternion.Euler(0f, Mathf.Atan2(move.x, move.y) * Mathf.Rad2Deg, 0f);
    }
//@end
//@if 2d
    void FixedUpdate()
    {
        if (!Net.IsLocal) return; // on the other machines the component moves this character
        var (move, jump) = ReadKeys();
        var dt = Time.fixedDeltaTime;
        var p = transform.position;
        if (p.y <= GroundY + 0.001f && _vy <= 0f && jump)
        {
            _vy = JumpSpeed;
            Net.Jump(); // the others see (and hear) it at the right moment
        }
        _vy -= Gravity * dt;
        p.x += move.x * Speed * dt;
        p.y += _vy * dt;
        if (p.y <= GroundY) { p.y = GroundY; _vy = 0f; }
        transform.position = p;
        Net.OnGround = p.y <= GroundY + 0.001f; // no controller here, so say it
    }
//@end
//@end
//@if host
    void FixedUpdate()
    {
        if (!Net.IsLocal) return;
        var (move, jump) = ReadKeys();
        if (move.sqrMagnitude > 0.0001f) _yaw = Mathf.Atan2(move.x, move.y) * Mathf.Rad2Deg;
        var onGround = Net.Players?.Local?.OnGround ?? true;
        if (jump && !_jumpDown && onGround) Net.Jump(); // the others see (and hear) it at the right moment
        _jumpDown = jump;
        Net.SetInput(new NetPlayerInput { MoveX = move.x, MoveY = move.y, Yaw = _yaw, Buttons = jump ? PlayerButtons.Jump : PlayerButtons.None });
    }

    /// <summary>
    /// One step of movement, the same on the host and on every owner (it must depend only on its three arguments): Game.cs gives it to the spawner.
    /// The component writes the result into the transform; nothing else moves this character.
    /// </summary>
    public static PlayerState Step(PlayerState s, NetPlayerInput i, double dt)
    {
        var y = s.Y;
        var vy = s.Vy;
        if (y <= GroundY + 0.001 && i.Buttons.HasFlag(PlayerButtons.Jump)) vy = JumpSpeed;
        if (y > GroundY + 0.001 || vy > 0.0) vy -= Gravity * dt;
        y += vy * dt;
        var grounded = y <= GroundY;
        if (grounded)
        {
            y = GroundY;
            vy = 0.0;
        }
        s.X += i.MoveX * Speed * dt;
//@if 3d
        s.Z += i.MoveY * Speed * dt;
//@end
        s.Y = y;
        s.Vx = i.MoveX * Speed;
        s.Vy = vy;
//@if 3d
        s.Vz = i.MoveY * Speed;
        s.Yaw = ((i.Yaw % 360.0) + 360.0) % 360.0;
//@end
        s.OnGround = grounded;
        return s;
    }
//@end

    void Update()
    {
        if (_color == Net.Team) return; // the team is the colour on every screen: the local player sets it (Game.cs), the others get it with their state
        _color = Net.Team;
        foreach (var r in _renderers) r.material.color = Colors[Math.Abs(_color) % Colors.Length];
    }

    /// <summary>(move: x right, y forward; jump). The old Input class: with only the Input System package active, swap these lines for its Keyboard.current reads.</summary>
    (Vector2, bool) ReadKeys()
    {
        try
        {
            var m = Vector2.zero;
            if (Input.GetKey(KeyCode.A) || Input.GetKey(KeyCode.LeftArrow)) m.x -= 1f;
            if (Input.GetKey(KeyCode.D) || Input.GetKey(KeyCode.RightArrow)) m.x += 1f;
//@if 3d
            if (Input.GetKey(KeyCode.W) || Input.GetKey(KeyCode.UpArrow)) m.y += 1f;
            if (Input.GetKey(KeyCode.S) || Input.GetKey(KeyCode.DownArrow)) m.y -= 1f;
//@end
            return (Vector2.ClampMagnitude(m, 1f), Input.GetKey(KeyCode.Space));
        }
        catch (InvalidOperationException e)
        {
            if (!_inputWarned) { _inputWarned = true; Debug.LogWarning("GamePlayer: the old Input class is off in this project; keys are ignored (" + e.Message + ")"); }
            return (Vector2.zero, false);
        }
    }
}
