#nullable enable
using System;
using System.Collections.Generic;
using OneLobby.Replication;
using UnityEngine;

namespace OneLobby.Unity
{
    /// <summary>One entry of <see cref="OneLobbyNetPlayer.AnimatorMap"/>: the name of a player value and the Animator parameter that gets it.</summary>
    [Serializable]
    public struct NetPlayerAnimatorEntry
    {
        /// <summary>One of <c>mode</c>, <c>speed</c>, <c>on_ground</c>, <c>aiming</c>, <c>blocking</c>, <c>alive</c>, <c>health</c>, <c>item</c>, <c>team</c>.</summary>
        public string Value;
        /// <summary>The name of the Animator parameter (float, int or bool; a trigger is skipped).</summary>
        public string Parameter;
    }

    /// <summary>
    /// One networked player, as a component on the game's character (its root object, or a child with <see cref="Character"/> set). Set
    /// <see cref="PeerId"/> (the <see cref="OneLobbyNetPlayerSpawner"/> does), call <see cref="Bind"/>, and the character is in the world
    /// on every screen: position, facing, movement state and the action events, smooth on the other machines. No player sync of your own.
    /// <para>The character may have a <see cref="CharacterController"/>, a <see cref="Rigidbody"/>, or only a <see cref="Transform"/>.
    /// 3D (<c>sync.player.space</c> "3d", the default) maps the wire's x, y, z to the world position (y up) and the yaw to
    /// <c>eulerAngles.y</c>; "2d" maps x, y to the world x, y and the yaw to <c>eulerAngles.z</c>.</para>
    /// <para>Three roles, decided by <see cref="PeerId"/> and the layer's authority:</para>
    /// <list type="bullet">
    /// <item><b>The machine that owns the player, authority "owner"</b> (the default): the game moves its character as it always did; each
    /// <c>FixedUpdate</c> this component reads it (position, velocity of the controller or body, grounded, yaw) plus the values the game
    /// sets here (<see cref="Pitch"/>, <see cref="Mode"/>, <see cref="Item"/>, <see cref="Aiming"/>, <see cref="Blocking"/>,
    /// <see cref="Health"/>, <see cref="Alive"/>, <see cref="Team"/>) and gives them to the layer.</item>
    /// <item><b>The machine that owns the player, authority "host"</b>: the game gives this component its input (<see cref="SetInput(NetPlayerInput)"/>),
    /// the component hands it to the layer, which predicts with <see cref="Step"/> (deterministic, the same function on the host); each rendered
    /// frame the predicted position plus the smoothed correction is written into the character. Nothing is written until the host's first state of the
    /// player has arrived: the character stays where the game put it (never the origin).</item>
    /// <item><b>Every other machine</b>: each rendered frame the layer's smoothed state is written into the character (a teleport snaps) and the rest is
    /// exposed as read-only properties. A <see cref="CharacterController"/> on such a character is disabled and a non-kinematic
    /// <see cref="Rigidbody"/> made kinematic with no interpolation (both restored by <see cref="Unbind"/>), because the component places it by
    /// transform and a controller or a simulated body would fight that. The same holds for the local character in authority "host".</item>
    /// </list>
    /// Action events are C# events raised when the layer plays them (also for the local player, at once); the owner starts one with a method of the
    /// same word (<see cref="Jump"/>, <see cref="Shoot"/> ...). <c>Melee</c> is the one event whose method needs another name (<see cref="MeleeAttack"/>),
    /// and the host raises <c>Hit</c> and <c>Died</c> with <see cref="Hurt"/> and <see cref="Kill"/>.
    /// </summary>
    [DisallowMultipleComponent]
    [DefaultExecutionOrder(100)] // after the game's own scripts: it reads the character they moved, and writes after the layer was pumped
    public sealed class OneLobbyNetPlayer : MonoBehaviour
    {
        /// <summary>The peer this player belongs to (the spawner sets it).</summary>
        public int PeerId;
        [Tooltip("The transform that is the character (position, yaw). Empty: the object with the CharacterController or Rigidbody on this object or above it, else this object.")]
        public Transform? Character;
        [Tooltip("Optional. Gets the values of Animator Map as parameters; a parameter the Animator does not have is skipped.")]
        public Animator? Animator;
        [Tooltip("Value name -> Animator parameter. Empty: each value is looked up by its own name (mode, speed, on_ground, aiming, blocking, alive, health, item, team).")]
        public List<NetPlayerAnimatorEntry> AnimatorMap = new();
        [Tooltip("The machine that owns the player derives Mode (idle, walk, jump, fall) from the movement. Switch it off to set Mode yourself.")]
        public bool AutoMode = true;
        [Tooltip("A remote player's renderers stay off until its first state has arrived (nobody sees a player flash at the origin).")]
        public bool HideUntilFirstState = true;

        /// <summary>The value names of <see cref="AnimatorMap"/>.</summary>
        public static IReadOnlyList<string> AnimatorValueNames => ValueNames;
        private static readonly string[] ValueNames = { "mode", "speed", "on_ground", "aiming", "blocking", "alive", "health", "item", "team" };

        // ---- events (C#: see the recipe for why not UnityEvents) ----------------------------------------------------------

        /// <summary>Every action event of this player, once it plays.</summary>
        public event Action<ActionEvent>? ActionPlayed;
        public event Action? Jumped;
        /// <summary>The speed it landed at.</summary>
        public event Action<float>? Landed;
        /// <summary>yaw, pitch (degrees), the render tick the shooter was seeing times 256 (for hit rewind on the host).</summary>
        public event Action<float, float, uint>? Shot;
        /// <summary>The swing id.</summary>
        public event Action<int>? Melee;
        public event Action? Reloaded;
        public event Action<int>? Used;
        public event Action<int>? ItemSwitched;
        /// <summary>yaw, pitch, power 0..1.</summary>
        public event Action<float, float, float>? Thrown;
        /// <summary>The host judged a hit on this player: the attacker's peer id (0: the world), the damage.</summary>
        public event Action<int, int>? Hit;
        /// <summary>The attacker's peer id (0: the world).</summary>
        public event Action<int>? Died;
        public event Action? Respawned;
        public event Action<int>? Emoted;

        // ---- state --------------------------------------------------------------------------------------------------------

        private NetPlayers? _players;
        private PlayerState _state = new();
        private NetPlayerInput _input;
        private bool _haveState;
        private bool _stepWarned;
        private Transform? _root;
        private CharacterController? _cc;
        private Rigidbody? _rb;
        private bool _ccWasEnabled, _rbWasKinematic;
        private RigidbodyInterpolation _rbInterpolation;
        private bool _ownsMotion; // the component placed the character by transform: controller off, body kinematic
        private bool _twoD;
        private Vector3 _lastPos;
        private Vector3 _velocity;
        private Vector3 _offset;
        private readonly List<Renderer> _hidden = new();
        private PlayerStepFunc? _step;

        private struct AnimBinding { public int Hash; public AnimatorControllerParameterType Type; public int Value; }
        private AnimBinding[] _bindings = Array.Empty<AnimBinding>();
        private bool _bindingsResolved;

        /// <summary>The layer this component is bound to, or null.</summary>
        public NetPlayers? Players => _players;
        public bool IsBound => _players != null;
        /// <summary>True for the player this machine controls (set by <see cref="Bind"/>).</summary>
        public bool IsLocal => _players != null && PeerId == _players.LocalPeerId;
        /// <summary>False until this machine has a state of the player to show (a remote player's first state; for the local player in authority "host", the host's first state).</summary>
        public bool HasState => _haveState;
        /// <summary>Host authority: the movement step. It goes to the layer when the component binds (a layer that has one keeps its own).</summary>
        public PlayerStepFunc? Step { get => _step; set { _step = value; if (_players != null && value != null && _players.Step == null) _players.Step = value; } }
        /// <summary>The whole state as this component knows it (the owner's: what the game set and the character said; any other: the layer's).</summary>
        public PlayerState State => _state;
        /// <summary>Metres per second, as the wire carries it.</summary>
        public Vector3 Velocity => _velocity;

        // The values the game sets for its own player (owner authority). On every other machine, and for a host-authority player, they are
        // read-only: a set is ignored.
        private bool Settable => _players == null || (IsLocal && _players.Authority == PlayerAuthority.Owner);
        public float Pitch { get => (float)_state.Pitch; set { if (Settable) _state.Pitch = value; } }
        public int Mode { get => _state.Mode; set { if (Settable) _state.Mode = value; } }
        /// <summary>Whether the character stands on something. Read from the <see cref="CharacterController"/> when there is one; set it yourself otherwise.</summary>
        public bool OnGround { get => _state.OnGround; set { if (Settable) _state.OnGround = value; } }
        public int Item { get => _state.Item; set { if (Settable) _state.Item = value; } }
        public bool Aiming { get => _state.Aiming; set { if (Settable) _state.Aiming = value; } }
        public bool Blocking { get => _state.Blocking; set { if (Settable) _state.Blocking = value; } }
        public int Health { get => _state.Health; set { if (Settable) _state.Health = value; } }
        public bool Alive { get => _state.Alive; set { if (Settable) _state.Alive = value; } }
        public int Team { get => _state.Team; set { if (Settable) _state.Team = value; } }

        // ---- bind ---------------------------------------------------------------------------------------------------------

        /// <summary>
        /// Join a layer (the spawner calls this; a game that makes its own layer calls it for each character after setting <see cref="PeerId"/>).
        /// Binding again moves the component to another layer.
        /// </summary>
        public void Bind(NetPlayers players)
        {
            if (players == null) throw new ArgumentNullException(nameof(players));
            Unbind();
            _players = players;
            _twoD = !players.Codec.Is3D;
            ResolveCharacter();
            _haveState = false;
            _bindingsResolved = false;
            _stepWarned = false;
            if (_step != null && players.Step == null) players.Step = _step;
            players.OnAction += OnAction;
            players.Corrected += OnCorrected;
            _lastPos = _root!.position;
            _velocity = Vector3.zero;
            _offset = Vector3.zero;
            if (IsLocal && players.Authority == PlayerAuthority.Host)
            {
                TakeMotion();
                CheckStep();
            }
            else if (!IsLocal)
            {
                TakeMotion();
                if (HideUntilFirstState) Hide();
            }
        }

        /// <summary>Leave the layer: the component does nothing until bound again; a controller, body or renderer it changed is put back.</summary>
        public void Unbind()
        {
            if (_players != null)
            {
                _players.OnAction -= OnAction;
                _players.Corrected -= OnCorrected;
            }
            _players = null;
            ReleaseMotion();
            Reveal();
        }

        private void OnDestroy() => Unbind();

        private void ResolveCharacter()
        {
            if (Character != null)
            {
                _root = Character;
                _cc = _root.GetComponent<CharacterController>();
                _rb = _root.GetComponent<Rigidbody>();
            }
            else
            {
                _cc = GetComponentInParent<CharacterController>();
                _rb = GetComponentInParent<Rigidbody>();
                _root = _cc != null ? _cc.transform : _rb != null ? _rb.transform : transform;
            }
        }

        /// <summary>The component places this character by transform: a controller would fight it, a simulated body too.</summary>
        private void TakeMotion()
        {
            if (_ownsMotion) return;
            _ownsMotion = true;
            if (_cc != null) { _ccWasEnabled = _cc.enabled; _cc.enabled = false; }
            if (_rb != null)
            {
                _rbWasKinematic = _rb.isKinematic;
                _rbInterpolation = _rb.interpolation;
                _rb.interpolation = RigidbodyInterpolation.None;
                _rb.isKinematic = true;
            }
        }

        private void ReleaseMotion()
        {
            if (!_ownsMotion) return;
            _ownsMotion = false;
            if (_cc != null) _cc.enabled = _ccWasEnabled;
            if (_rb != null) { _rb.isKinematic = _rbWasKinematic; _rb.interpolation = _rbInterpolation; }
        }

        private void Hide()
        {
            _hidden.Clear();
            foreach (var r in GetRoot().GetComponentsInChildren<Renderer>(true))
                if (r.enabled) { r.enabled = false; _hidden.Add(r); }
        }

        private void Reveal()
        {
            foreach (var r in _hidden) if (r != null) r.enabled = true;
            _hidden.Clear();
        }

        private Transform GetRoot() => _root != null ? _root : transform;

        private bool CheckStep()
        {
            if (_players == null || _players.Authority != PlayerAuthority.Host || _players.Step != null) return true;
            if (!_stepWarned)
            {
                _stepWarned = true;
                Debug.LogError("OneLobbyNetPlayer: sync.player.authority is \"host\": give the component a Step (a PlayerStepFunc(state, input, dt) -> state, deterministic) or set it on the spawner or NetPlayers.Step");
            }
            return false;
        }

        // ---- the game's side ----------------------------------------------------------------------------------------------

        /// <summary>Authority "host", the local player: this fixed step's input. Hand it over every <c>FixedUpdate</c> (or every frame; the latest is used).</summary>
        public void SetInput(in NetPlayerInput input) => _input = input;

        /// <summary>Authority "host": the same with plain values (<paramref name="move"/>: x strafe right, y forward; 2D: y is down).</summary>
        public void SetInput(Vector2 move, float yaw, float pitch = 0, PlayerButtons buttons = PlayerButtons.None) =>
            _input = new NetPlayerInput { MoveX = move.x, MoveY = move.y, Yaw = yaw, Pitch = pitch, Buttons = buttons };

        /// <summary>
        /// Put the player somewhere else without sliding (the owner; the host places any other player through <see cref="Players"/>).
        /// It moves the character too. 2D: <c>to.z</c> is ignored.
        /// </summary>
        public void Teleport(Vector3 to)
        {
            if (_players == null) return;
            Place(to, null);
            _lastPos = to;
            var s = _state;
            s.X = to.x; s.Y = to.y; s.Z = _twoD ? 0 : to.z;
            _state = s;
            _players.Teleport(s);
        }

        /// <summary>
        /// Put the character somewhere without telling the network (the spawner does this for the start position). Use it instead of writing
        /// <c>transform.position</c> when the character has a <see cref="CharacterController"/>, which would put it back.
        /// </summary>
        public void SetPosition(Vector3 to)
        {
            if (_root == null) ResolveCharacter();
            Place(to, null);
            _lastPos = to;
        }

        /// <summary>Respawn: a teleport (when <paramref name="to"/> is given) that also makes the player alive with full health, then the <c>Respawned</c> event.</summary>
        public void Respawn(Vector3? to = null)
        {
            if (_players == null) return;
            var s = _state;
            if (to is Vector3 v) { Place(v, null); s.X = v.x; s.Y = v.y; s.Z = _twoD ? 0 : v.z; }
            s.Alive = true; s.Health = 100;
            _state = s;
            _players.Respawn(s);
        }

        public void Jump() => Send(PlayerAction.Jump, default);
        public void Land(float impact) => Send(PlayerAction.Land, new ActionArgs { Impact = impact });
        public void Shoot(float yaw, float pitch = 0) => Send(PlayerAction.Shoot, new ActionArgs { Yaw = yaw, Pitch = pitch });
        /// <summary><c>Melee</c> is the event, this starts it (<paramref name="swing"/> is the game's swing id, 0..255).</summary>
        public void MeleeAttack(int swing = 0) => Send(PlayerAction.Melee, new ActionArgs { Swing = swing });
        public void Reload() => Send(PlayerAction.Reload, default);
        public void Use(int target = 0) => Send(PlayerAction.Use, new ActionArgs { Target = target });
        public void SwitchItem(int slot) { if (Settable) _state.Item = slot; Send(PlayerAction.ItemSwitch, new ActionArgs { Slot = slot }); }
        public void Throw(float yaw, float pitch, float power) => Send(PlayerAction.Throw, new ActionArgs { Yaw = yaw, Pitch = pitch, Power = power });
        public void Emote(int emote) => Send(PlayerAction.Emote, new ActionArgs { Emote = emote });

        /// <summary>Host only: this player took a hit (the host judged a shot). The game keeps the health.</summary>
        public void Hurt(int by, int damage) => HostOnly(PlayerAction.Hit, new ActionArgs { By = by, Damage = damage });
        /// <summary>Host only: this player died.</summary>
        public void Kill(int by) => HostOnly(PlayerAction.Death, new ActionArgs { By = by });

        private void HostOnly(PlayerAction name, ActionArgs args)
        {
            if (_players == null) { Debug.LogError("OneLobbyNetPlayer: not bound to a layer (the spawner binds it; or call Bind)"); return; }
            if (!_players.IsHost) { Debug.LogError("OneLobbyNetPlayer: " + PlayerWire.Name(name) + " is raised by the host only (Hurt and Kill work on the host)"); return; }
            _players.HostAction(PeerId, name, args);
        }

        private void Send(PlayerAction name, ActionArgs args)
        {
            if (_players == null) { Debug.LogError("OneLobbyNetPlayer: not bound to a layer (the spawner binds it; or call Bind)"); return; }
            if (!IsLocal)
            {
                // the host may start any player's owner event
                if (_players.IsHost) _players.HostAction(PeerId, name, args);
                else Debug.LogError("OneLobbyNetPlayer: " + PlayerWire.Name(name) + " is for the player this machine controls");
                return;
            }
            _players.Action(name, args);
        }

        // ---- frames -------------------------------------------------------------------------------------------------------

        private void FixedUpdate()
        {
            if (_players == null || !IsLocal) return;
            if (_players.Authority == PlayerAuthority.Owner) PushOwnerState();
            else if (CheckStep()) _players.SetLocalInput(_input);
        }

        private void LateUpdate()
        {
            if (_players == null) return;
            if (IsLocal && _players.Authority == PlayerAuthority.Owner)
            {
                if (!_haveState) _haveState = true;
                if (_cc == null && _rb == null) EstimateVelocity();
                Animate();
                return;
            }
            PlayerState s;
            Vector3 offset = Vector3.zero;
            if (IsLocal)
            {
                var l = _players.Local; // host authority on a client: null until the host's first state of this player has arrived
                if (l == null) return;
                s = l.Value;
                var o = _players.Smoother.Offset;
                offset = _twoD ? new Vector3(o.X, o.Z, 0) : new Vector3(o.X, o.Y, o.Z); // a 2D correction rides the smoother's x and z
            }
            else if (!_players.TryGet(PeerId, out s)) return;
            Apply(s, offset);
            Animate();
        }

        private void PushOwnerState()
        {
            var t = GetRoot();
            var p = t.position;
            var s = _state;
            Vector3 v;
            if (_cc != null) { v = _cc.velocity; s.OnGround = _cc.isGrounded; }
            else if (_rb != null) v = _rb.linearVelocity;
            else v = _velocity; // a bare transform: the speed measured over the last rendered frames
            _velocity = v;
            s.X = p.x; s.Y = p.y;
            if (_twoD) { s.Z = 0; s.Vx = v.x; s.Vy = v.y; s.Vz = 0; s.Yaw = Wrap(t.eulerAngles.z); s.Pitch = 0; }
            else { s.Z = p.z; s.Vx = v.x; s.Vy = v.y; s.Vz = v.z; s.Yaw = Wrap(t.eulerAngles.y); }
            if (AutoMode) s.Mode = DeriveMode(s);
            _state = s;
            _players!.SetLocalState(s);
        }

        /// <summary>A character with no controller or body: its speed is what it moved over the last frame (the game may move it in Update or in FixedUpdate).</summary>
        private void EstimateVelocity()
        {
            var p = GetRoot().position;
            var dt = Time.deltaTime;
            if (dt > 0) _velocity = (p - _lastPos) / dt;
            _lastPos = p;
        }

        private int DeriveMode(in PlayerState s)
        {
            if (!s.OnGround) return s.Vy > 0 ? 4 : 5;
            var speed = _twoD ? Math.Sqrt(s.Vx * s.Vx + s.Vy * s.Vy) : Math.Sqrt(s.Vx * s.Vx + s.Vz * s.Vz);
            return speed > 0.1 ? 1 : 0;
        }

        /// <summary>Write a state into the character (position, facing) and keep it as this component's values.</summary>
        private void Apply(in PlayerState s, Vector3 offset)
        {
            var t = GetRoot();
            Vector3 pos;
            if (_twoD) pos = new Vector3((float)s.X + offset.x, (float)s.Y + offset.y, t.position.z);
            else pos = new Vector3((float)s.X + offset.x, (float)s.Y + offset.y, (float)s.Z + offset.z);
            Place(pos, s.Yaw);
            _state = s;
            _velocity = _twoD ? new Vector3((float)s.Vx, (float)s.Vy, 0) : new Vector3((float)s.Vx, (float)s.Vy, (float)s.Vz);
            _lastPos = pos;
            if (!_haveState)
            {
                _haveState = true;
                Reveal();
            }
        }

        /// <summary>Set the character's position and, when given, its yaw. A controller that is enabled (the owner's) is switched off around the write, or it would put the character back.</summary>
        private void Place(Vector3 pos, double? yaw)
        {
            var t = GetRoot();
            var back = _cc != null && _cc.enabled;
            if (back) _cc!.enabled = false;
            if (yaw is double y)
            {
                var e = t.eulerAngles;
                if (_twoD) e.z = (float)y; else e.y = (float)y;
                t.SetPositionAndRotation(pos, Quaternion.Euler(e));
            }
            else t.position = pos;
            if (back) _cc!.enabled = true;
        }

        private static double Wrap(double deg)
        {
            var d = deg % 360.0;
            return d < 0 ? d + 360.0 : d;
        }

        // ---- events -------------------------------------------------------------------------------------------------------

        private void OnAction(ActionEvent e)
        {
            if (e.Player != PeerId) return;
            ActionPlayed?.Invoke(e);
            var a = e.Args;
            switch (e.Name)
            {
                case PlayerAction.Jump: Jumped?.Invoke(); break;
                case PlayerAction.Land: Landed?.Invoke((float)a.Impact); break;
                case PlayerAction.Shoot: Shot?.Invoke((float)a.Yaw, (float)a.Pitch, a.View); break;
                case PlayerAction.Melee: Melee?.Invoke(a.Swing); break;
                case PlayerAction.Reload: Reloaded?.Invoke(); break;
                case PlayerAction.Use: Used?.Invoke(a.Target); break;
                case PlayerAction.ItemSwitch: ItemSwitched?.Invoke(a.Slot); break;
                case PlayerAction.Throw: Thrown?.Invoke((float)a.Yaw, (float)a.Pitch, (float)a.Power); break;
                case PlayerAction.Hit: Hit?.Invoke(a.By, a.Damage); break;
                case PlayerAction.Death: Died?.Invoke(a.By); break;
                case PlayerAction.Respawn: Respawned?.Invoke(); break;
                case PlayerAction.Emote: Emoted?.Invoke(a.Emote); break;
            }
        }

        /// <summary>Owner authority: the host put this player back (a limit, or a teleport by the host); take its state as ours.</summary>
        private void OnCorrected(PlayerState s)
        {
            if (!IsLocal) return;
            Apply(s, Vector3.zero);
            if (_cc == null && _rb != null && !_rb.isKinematic) _rb.linearVelocity = _velocity;
        }

        // ---- animation ----------------------------------------------------------------------------------------------------

        /// <summary>
        /// Look at the Animator's parameters again (done once at the first frame after binding; call it after changing <see cref="Animator"/> or
        /// <see cref="AnimatorMap"/>). A name the Animator does not have, or a trigger, is skipped without a message.
        /// </summary>
        public void RefreshAnimator()
        {
            _bindingsResolved = true;
            var list = new List<AnimBinding>();
            var anim = Animator;
            if (anim != null && anim.runtimeAnimatorController != null)
            {
                var have = new Dictionary<string, AnimatorControllerParameterType>();
                foreach (var p in anim.parameters) have[p.name] = p.type;
                if (AnimatorMap == null || AnimatorMap.Count == 0)
                {
                    foreach (var n in ValueNames) AddBinding(list, have, n, n);
                }
                else foreach (var m in AnimatorMap) AddBinding(list, have, m.Value, m.Parameter);
            }
            _bindings = list.ToArray();
        }

        private static void AddBinding(List<AnimBinding> list, Dictionary<string, AnimatorControllerParameterType> have, string value, string parameter)
        {
            var id = Array.IndexOf(ValueNames, value);
            if (id < 0 || string.IsNullOrEmpty(parameter) || !have.TryGetValue(parameter, out var type) || type == AnimatorControllerParameterType.Trigger) return;
            list.Add(new AnimBinding { Hash = UnityEngine.Animator.StringToHash(parameter), Type = type, Value = id });
        }

        private void Animate()
        {
            if (Animator == null) return;
            if (!_bindingsResolved) RefreshAnimator();
            var s = _state;
            for (var i = 0; i < _bindings.Length; i++)
            {
                var b = _bindings[i];
                double v;
                switch (b.Value)
                {
                    case 0: v = s.Mode; break;
                    case 1: v = _twoD ? Math.Sqrt(s.Vx * s.Vx + s.Vy * s.Vy) : Math.Sqrt(s.Vx * s.Vx + s.Vz * s.Vz); break;
                    case 2: v = s.OnGround ? 1 : 0; break;
                    case 3: v = s.Aiming ? 1 : 0; break;
                    case 4: v = s.Blocking ? 1 : 0; break;
                    case 5: v = s.Alive ? 1 : 0; break;
                    case 6: v = s.Health; break;
                    case 7: v = s.Item; break;
                    default: v = s.Team; break;
                }
                switch (b.Type)
                {
                    case AnimatorControllerParameterType.Float: Animator.SetFloat(b.Hash, (float)v); break;
                    case AnimatorControllerParameterType.Int: Animator.SetInteger(b.Hash, (int)Math.Round(v)); break;
                    case AnimatorControllerParameterType.Bool: Animator.SetBool(b.Hash, v != 0); break;
                }
            }
        }
    }
}
