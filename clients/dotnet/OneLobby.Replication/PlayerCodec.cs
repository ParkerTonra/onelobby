using System;
using System.Collections.Generic;

namespace OneLobby.Replication
{
    /// <summary>
    /// Encodes and decodes the player preset for one configuration (spec/net-player.md sections 2 to 4): the state, the input
    /// preset and the arguments of the action events. No lobby, no session. Positions stay <c>double</c>; a value goes
    /// through float32 at the edge (<see cref="NetWriter.WriteQuantized"/> takes a float), then rounds half away from zero.
    /// Not thread safe (it reuses its scratch buffers).
    /// </summary>
    public sealed class PlayerCodec : IStateSchema<PlayerState>
    {
        private const int VelBits = 10, YawBits = 12, PitchBits = 10, MoveBits = 7;

        private readonly HashSet<string> _omitted;
        private readonly NetWriter _w = new();   // public encode calls
        private readonly NetWriter _q = new();   // quantize round trips
        private readonly NetReader _r = new();
        private readonly byte[] _rbuf = new byte[256];
        private readonly int[] _argsBytes = new int[13];
        private readonly float _range, _velRange;

        public PlayerCodec(PlayerWireConfig? config = null)
        {
            Config = config ?? PlayerWireConfig.Default;
            if (Config.Space != "2d" && Config.Space != "3d") throw new ArgumentException("space must be \"2d\" or \"3d\"");
            if (!(Config.Range > 0)) throw new ArgumentOutOfRangeException(nameof(config), "range must be positive");
            if (!(Config.VelocityRange > 0)) throw new ArgumentOutOfRangeException(nameof(config), "velocityRange must be positive");
            _omitted = new HashSet<string>();
            foreach (var n in Config.Omit ?? Array.Empty<string>())
            {
                if (!IsOmittable(n)) throw new ArgumentException("cannot leave out \"" + n + "\"");
                _omitted.Add(n);
            }
            PosBits = PlayerWire.PositionBits(Config.Range);
            _range = (float)Config.Range;
            _velRange = (float)Config.VelocityRange;
            Is3D = Config.Space == "3d";
            var def = new PlayerState();
            _w.Reset();
            WriteState(_w, def);
            StateBits = _w.BitCount;
            StateBytes = _w.ByteCount;
            _w.Reset();
            WriteInput(_w, default);
            InputBytes = _w.ByteCount;
            for (var id = 1; id <= 12; id++)
            {
                _w.Reset();
                WriteArgs(_w, (PlayerAction)id, default);
                _argsBytes[id] = _w.ByteCount;
            }
            _w.Reset();
        }

        private static bool IsOmittable(string name)
        {
            foreach (var o in PlayerWire.Omittable) if (o == name) return true;
            return false;
        }

        public PlayerWireConfig Config { get; }
        /// <summary>Bits of one position axis.</summary>
        public int PosBits { get; }
        public bool Is3D { get; }
        /// <summary>Bits of one state.</summary>
        public int StateBits { get; }
        public int StateBytes { get; }
        /// <summary>Bytes of one input preset.</summary>
        public int InputBytes { get; }

        /// <summary>True unless <paramref name="name"/> (a field group or an event name) is left out.</summary>
        public bool Has(string name) => !_omitted.Contains(name);
        /// <summary>Whether the game uses this event (not left out).</summary>
        public bool HasEvent(PlayerAction a) => !_omitted.Contains(PlayerWire.Name(a));

        // ---- state ---------------------------------------------------------------------------------------------------

        public void WriteState(NetWriter w, in PlayerState s)
        {
            var R = _range;
            var V = _velRange;
            var pb = PosBits;
            w.WriteQuantized((float)s.X, -R, R, pb);
            w.WriteQuantized((float)s.Y, -R, R, pb);
            if (Is3D) w.WriteQuantized((float)s.Z, -R, R, pb);
            if (Has("velocity"))
            {
                w.WriteQuantized((float)s.Vx, -V, V, VelBits);
                w.WriteQuantized((float)s.Vy, -V, V, VelBits);
                if (Is3D) w.WriteQuantized((float)s.Vz, -V, V, VelBits);
            }
            if (Has("yaw")) w.WriteAngle((float)s.Yaw, YawBits);
            if (Is3D && Has("pitch")) w.WriteQuantized((float)s.Pitch, -90, 90, PitchBits);
            if (Has("onGround")) w.WriteBool(s.OnGround);
            if (Has("mode")) w.WriteBits((uint)s.Mode, 4);
            if (Has("item")) w.WriteBits((uint)s.Item, 4);
            if (Has("aiming")) w.WriteBool(s.Aiming);
            if (Has("blocking")) w.WriteBool(s.Blocking);
            if (Has("health")) w.WriteBits((uint)s.Health, 8);
            if (Has("alive")) w.WriteBool(s.Alive);
            if (Has("team")) w.WriteBits((uint)s.Team, 4);
            w.WriteBits((uint)s.Teleport, 3);
            w.WriteBool(s.Carried);
        }

        public PlayerState ReadState(NetReader r)
        {
            var R = _range;
            var V = _velRange;
            var pb = PosBits;
            var s = new PlayerState();
            s.X = r.ReadQuantized(-R, R, pb);
            s.Y = r.ReadQuantized(-R, R, pb);
            if (Is3D) s.Z = r.ReadQuantized(-R, R, pb);
            if (Has("velocity"))
            {
                s.Vx = r.ReadQuantized(-V, V, VelBits);
                s.Vy = r.ReadQuantized(-V, V, VelBits);
                if (Is3D) s.Vz = r.ReadQuantized(-V, V, VelBits);
            }
            if (Has("yaw")) s.Yaw = r.ReadAngle(YawBits);
            if (Is3D && Has("pitch")) s.Pitch = r.ReadQuantized(-90, 90, PitchBits);
            if (Has("onGround")) s.OnGround = r.ReadBool();
            if (Has("mode")) s.Mode = (int)r.ReadBits(4);
            if (Has("item")) s.Item = (int)r.ReadBits(4);
            if (Has("aiming")) s.Aiming = r.ReadBool();
            if (Has("blocking")) s.Blocking = r.ReadBool();
            if (Has("health")) s.Health = (int)r.ReadBits(8);
            if (Has("alive")) s.Alive = r.ReadBool();
            if (Has("team")) s.Team = (int)r.ReadBits(4);
            s.Teleport = (int)r.ReadBits(3);
            s.Carried = r.ReadBool();
            return s;
        }

        PlayerState IStateSchema<PlayerState>.Read(NetReader reader) => ReadState(reader);
        PlayerState IStateSchema<PlayerState>.Lerp(in PlayerState a, in PlayerState b, double t) => Lerp(a, b, t);

        /// <summary>The state as bytes (what goes into an entity's state, or into an input in owner mode).</summary>
        public byte[] EncodeState(in PlayerState s)
        {
            _w.Reset();
            WriteState(_w, s);
            return _w.ToArray();
        }

        /// <summary>The state as bytes without an allocation: valid until the next encode call on this codec.</summary>
        public ReadOnlySpan<byte> EncodeStateSpan(in PlayerState s)
        {
            _w.Reset();
            WriteState(_w, s);
            return _w.Span;
        }

        /// <summary>The state from bytes; false when the length is not exactly the layout's (a malformed state).</summary>
        public bool DecodeState(ReadOnlySpan<byte> b, out PlayerState state)
        {
            state = default;
            if (b.Length != StateBytes) return false;
            b.CopyTo(_rbuf);
            _r.Reset(_rbuf, b.Length);
            state = ReadState(_r);
            return true;
        }

        /// <summary>What <paramref name="s"/> becomes after one trip over the wire (quantised, omitted fields at their defaults).</summary>
        public PlayerState QuantizeState(in PlayerState s)
        {
            _q.Reset();
            WriteState(_q, s);
            _q.CopyTo(_rbuf);
            _r.Reset(_rbuf, _q.ByteCount);
            return ReadState(_r);
        }

        /// <summary>Blend two states for rendering: numbers by <paramref name="t"/>, yaw on the shortest arc, everything else from <paramref name="a"/>; a teleport snaps (returns <paramref name="a"/>).</summary>
        public PlayerState Lerp(in PlayerState a, in PlayerState b, double t)
        {
            if (a.Teleport != b.Teleport) return a; // the snap happens when render time reaches b's tick
            var r = a;
            r.X = L(a.X, b.X, t); r.Y = L(a.Y, b.Y, t); r.Z = L(a.Z, b.Z, t);
            r.Vx = L(a.Vx, b.Vx, t); r.Vy = L(a.Vy, b.Vy, t); r.Vz = L(a.Vz, b.Vz, t);
            r.Yaw = LerpAngle(a.Yaw, b.Yaw, t);
            r.Pitch = L(a.Pitch, b.Pitch, t);
            return r;
        }

        private static double L(double a, double b, double t) => a + (b - a) * t;

        /// <summary>Lerp between two angles in degrees along the shorter arc; result in [0, 360). Double precision (NetMath.LerpAngle is float).</summary>
        public static double LerpAngle(double a, double b, double t)
        {
            var d = (b - a) % 360;
            if (d > 180) d -= 360;
            if (d < -180) d += 360;
            var r = (a + d * t) % 360;
            return r < 0 ? r + 360 : r;
        }

        // ---- input preset (host-decides mode) ------------------------------------------------------------------------

        public void WriteInput(NetWriter w, in NetPlayerInput i)
        {
            w.WriteQuantized((float)i.MoveX, -1, 1, MoveBits);
            w.WriteQuantized((float)i.MoveY, -1, 1, MoveBits);
            w.WriteAngle((float)i.Yaw, YawBits);
            if (Is3D) w.WriteQuantized((float)i.Pitch, -90, 90, PitchBits);
            var b = (int)i.Buttons;
            for (var k = 0; k < 8; k++) w.WriteBool((b >> k & 1) != 0);
        }

        public NetPlayerInput ReadInput(NetReader r)
        {
            var i = new NetPlayerInput();
            i.MoveX = r.ReadQuantized(-1, 1, MoveBits);
            i.MoveY = r.ReadQuantized(-1, 1, MoveBits);
            i.Yaw = r.ReadAngle(YawBits);
            if (Is3D) i.Pitch = r.ReadQuantized(-90, 90, PitchBits);
            var b = 0;
            for (var k = 0; k < 8; k++) if (r.ReadBool()) b |= 1 << k;
            i.Buttons = (PlayerButtons)b;
            return i;
        }

        public byte[] EncodeInput(in NetPlayerInput i)
        {
            _w.Reset();
            WriteInput(_w, i);
            return _w.ToArray();
        }

        /// <summary>The input as bytes without an allocation: valid until the next encode call on this codec.</summary>
        public ReadOnlySpan<byte> EncodeInputSpan(in NetPlayerInput i)
        {
            _w.Reset();
            WriteInput(_w, i);
            return _w.Span;
        }

        public bool DecodeInput(ReadOnlySpan<byte> b, out NetPlayerInput input)
        {
            input = default;
            if (b.Length != InputBytes) return false;
            b.CopyTo(_rbuf);
            _r.Reset(_rbuf, b.Length);
            input = ReadInput(_r);
            return true;
        }

        /// <summary>What an input becomes after one trip over the wire.</summary>
        public NetPlayerInput QuantizeInput(in NetPlayerInput i)
        {
            _q.Reset();
            WriteInput(_q, i);
            _q.CopyTo(_rbuf);
            _r.Reset(_rbuf, _q.ByteCount);
            return ReadInput(_r);
        }

        // ---- action events -------------------------------------------------------------------------------------------

        public void WriteArgs(NetWriter w, PlayerAction name, in ActionArgs a)
        {
            switch (name)
            {
                case PlayerAction.Land: w.WriteQuantized((float)a.Impact, 0, 64, 6); break;
                case PlayerAction.Shoot:
                    w.WriteAngle((float)a.Yaw, YawBits);
                    if (Is3D) w.WriteQuantized((float)a.Pitch, -90, 90, PitchBits);
                    w.WriteUInt32(a.View);
                    break;
                case PlayerAction.Melee: w.WriteBits((uint)a.Swing, 8); break;
                case PlayerAction.Use: w.WriteBits((uint)a.Target, 16); break;
                case PlayerAction.ItemSwitch: w.WriteBits((uint)a.Slot, 4); break;
                case PlayerAction.Throw:
                    w.WriteAngle((float)a.Yaw, YawBits);
                    if (Is3D) w.WriteQuantized((float)a.Pitch, -90, 90, PitchBits);
                    w.WriteQuantized((float)a.Power, 0, 1, 6);
                    break;
                case PlayerAction.Hit: w.WriteBits((uint)a.By, 16); w.WriteBits((uint)a.Damage, 8); break;
                case PlayerAction.Death: w.WriteBits((uint)a.By, 16); break;
                case PlayerAction.Emote: w.WriteBits((uint)a.Emote, 6); break;
                default: break; // jump, reload, respawn: no arguments
            }
        }

        public ActionArgs ReadArgs(NetReader r, PlayerAction name)
        {
            var a = new ActionArgs();
            switch (name)
            {
                case PlayerAction.Land: a.Impact = r.ReadQuantized(0, 64, 6); break;
                case PlayerAction.Shoot:
                    a.Yaw = r.ReadAngle(YawBits);
                    a.Pitch = Is3D ? r.ReadQuantized(-90, 90, PitchBits) : 0;
                    a.View = r.ReadUInt32();
                    break;
                case PlayerAction.Melee: a.Swing = (int)r.ReadBits(8); break;
                case PlayerAction.Use: a.Target = (int)r.ReadBits(16); break;
                case PlayerAction.ItemSwitch: a.Slot = (int)r.ReadBits(4); break;
                case PlayerAction.Throw:
                    a.Yaw = r.ReadAngle(YawBits);
                    a.Pitch = Is3D ? r.ReadQuantized(-90, 90, PitchBits) : 0;
                    a.Power = r.ReadQuantized(0, 1, 6);
                    break;
                case PlayerAction.Hit: a.By = (int)r.ReadBits(16); a.Damage = (int)r.ReadBits(8); break;
                case PlayerAction.Death: a.By = (int)r.ReadBits(16); break;
                case PlayerAction.Emote: a.Emote = (int)r.ReadBits(6); break;
                default: break;
            }
            return a;
        }

        public byte[] EncodeArgs(PlayerAction name, in ActionArgs a)
        {
            _w.Reset();
            WriteArgs(_w, name, a);
            return _w.BitCount == 0 ? Array.Empty<byte>() : _w.ToArray();
        }

        /// <summary>Bytes of this event's arguments.</summary>
        public int ArgsBytes(PlayerAction name) => _argsBytes[(int)name];

        /// <summary>Decode arguments; false when the length is not exactly the layout's.</summary>
        public bool DecodeArgs(PlayerAction name, ReadOnlySpan<byte> b, out ActionArgs args)
        {
            args = default;
            if (b.Length != _argsBytes[(int)name]) return false;
            b.CopyTo(_rbuf);
            _r.Reset(_rbuf, b.Length);
            args = ReadArgs(_r, name);
            return true;
        }

        /// <summary>What the arguments become after one trip over the wire (the others see this).</summary>
        public ActionArgs QuantizeArgs(PlayerAction name, in ActionArgs a)
        {
            _q.Reset();
            WriteArgs(_q, name, a);
            _q.CopyTo(_rbuf);
            _r.Reset(_rbuf, _q.ByteCount);
            return ReadArgs(_r, name);
        }
    }
}
