using System;
using System.Collections.Generic;
using System.Linq;

namespace OneLobby.Replication
{
    /// <summary>The action events of spec/net-player.md section 4; the value is the event id on the wire.</summary>
    public enum PlayerAction : byte
    {
        Jump = 1, Land = 2, Shoot = 3, Melee = 4, Reload = 5, Use = 6, ItemSwitch = 7, Throw = 8,
        /// <summary>Host only: "hit taken", raised for the victim.</summary>
        Hit = 9,
        /// <summary>Host only.</summary>
        Death = 10,
        Respawn = 11, Emote = 12,
    }

    /// <summary>The eight buttons of the input preset; the bit order is the wire order (jump first).</summary>
    [Flags]
    public enum PlayerButtons : byte
    {
        None = 0, Jump = 1, Crouch = 2, Sprint = 4, Aim = 8, Block = 16, Fire = 32, Use = 64, Reload = 128,
    }

    /// <summary>
    /// One player's state (the player preset of spec/net-player.md section 2). A struct, so a state is copied by value and a
    /// frame allocates nothing; positions and velocities are <c>double</c> (the codec quantises through float32 at the
    /// edge, as the spec says). 2D uses X, Y and Vx, Vy (Z, Vz and Pitch stay 0). A field the game leaves out holds its
    /// default. <c>new PlayerState()</c> is the default player (on the ground, alive, health 100); <c>default(PlayerState)</c>
    /// is all zero (not alive): use <c>new</c>.
    /// </summary>
    public record struct PlayerState
    {
        public double X, Y, Z, Vx, Vy, Vz;
        /// <summary>Facing in degrees [0, 360).</summary>
        public double Yaw;
        /// <summary>Aim in degrees [-90, 90] (3D).</summary>
        public double Pitch;
        public bool OnGround;
        /// <summary>0..15: 0 idle, 1 walk, 2 run, 3 crouch, 4 jump, 5 fall, 6 swim, 7 climb, 8 fly; 9 to 15 are the game's.</summary>
        public int Mode;
        /// <summary>Held item or slot, 0..15.</summary>
        public int Item;
        public bool Aiming, Blocking;
        /// <summary>0..255.</summary>
        public int Health;
        public bool Alive;
        /// <summary>Team or colour, 0..15.</summary>
        public int Team;
        /// <summary>0..7, wraps. A difference between two samples means "snap, do not slide".</summary>
        public int Teleport;

        public PlayerState()
        {
            X = Y = Z = Vx = Vy = Vz = Yaw = Pitch = 0;
            OnGround = true; Mode = 0; Item = 0; Aiming = false; Blocking = false; Health = 100; Alive = true; Team = 0; Teleport = 0;
        }
    }

    /// <summary>One input of host-decides mode (the input preset). <see cref="MoveX"/> is strafe right, <see cref="MoveY"/> is forward (2D: down is +1).</summary>
    public record struct PlayerInput
    {
        public double MoveX, MoveY;
        public double Yaw;
        /// <summary>3D only.</summary>
        public double Pitch;
        public PlayerButtons Buttons;
    }

    /// <summary>
    /// The arguments of one action event. One struct for all twelve events; the event decides which fields are on the wire:
    /// land: <see cref="Impact"/>; shoot: <see cref="Yaw"/>, <see cref="Pitch"/> (3D), <see cref="View"/>; melee: <see cref="Swing"/>;
    /// use: <see cref="Target"/>; itemSwitch: <see cref="Slot"/>; throw: <see cref="Yaw"/>, <see cref="Pitch"/> (3D), <see cref="Power"/>;
    /// hit: <see cref="By"/>, <see cref="Damage"/>; death: <see cref="By"/>; emote: <see cref="Emote"/>. Fields an event does not carry stay 0.
    /// </summary>
    public record struct ActionArgs
    {
        /// <summary>land: the speed it landed at, 0..64.</summary>
        public double Impact;
        public double Yaw, Pitch;
        /// <summary>shoot: the render tick the shooter was seeing, times 256. 0 on a local shoot means "fill in my render tick".</summary>
        public uint View;
        public int Swing;
        public int Target;
        public int Slot;
        /// <summary>throw: 0..1.</summary>
        public double Power;
        /// <summary>hit, death: the attacker's peer id, 0 for the world.</summary>
        public int By;
        public int Damage;
        public int Emote;
    }

    /// <summary>One action event as it travels (message kind 5).</summary>
    public readonly struct WireEvent
    {
        public WireEvent(uint player, uint seq, byte id, uint tick, byte[] args) { Player = player; Seq = seq; Id = id; Tick = tick; Args = args; }
        /// <summary>Peer id of the player it belongs to.</summary>
        public uint Player { get; }
        /// <summary>1, 2, 3 ... per player.</summary>
        public uint Seq { get; }
        /// <summary>Event id (1..12 today).</summary>
        public byte Id { get; }
        /// <summary>Host tick it happened (a client's claim to the host; the host's own stamp when relayed).</summary>
        public uint Tick { get; }
        public byte[] Args { get; }
    }

    /// <summary>What configures the preset on the wire. Everything else about the layer is local behaviour.</summary>
    public sealed record PlayerWireConfig(string Space = "3d", double Range = 300, double VelocityRange = 32, IReadOnlyList<string>? Omit = null)
    {
        public static readonly PlayerWireConfig Default = new PlayerWireConfig();

        /// <summary>The wire settings of a loaded <c>sync.player</c> section.</summary>
        public static PlayerWireConfig From(PlayerSection p) => new PlayerWireConfig(p.Space, p.Range, p.VelocityRange, p.Omit);
    }

    /// <summary>The tables of spec/net-player.md as code: ids, names, origins, the reserved type id, the kind 5 message.</summary>
    public static class PlayerWire
    {
        /// <summary>The reserved entity type id of a networked player.</summary>
        public const ushort PlayerTypeId = 65535;
        /// <summary>Message kind of the action events (additive to replication version 1).</summary>
        public const byte KindPlayerEvents = 5;
        /// <summary>The teleport counter wraps at this value (3 bits).</summary>
        public const int TeleportModulo = 8;
        /// <summary>Records one message may carry (a u8 count).</summary>
        public const int MaxEventsPerMessage = 255;
        /// <summary>The size past which older copies are left out of one message.</summary>
        public const int MaxEventMessageBytes = 1000;

        private static readonly string[] Names = { "", "jump", "land", "shoot", "melee", "reload", "use", "itemSwitch", "throw", "hit", "death", "respawn", "emote" };

        /// <summary>Movement modes of the preset (index = value); 9 to 15 are the game's own.</summary>
        public static readonly IReadOnlyList<string> MovementModes = new[] { "idle", "walk", "run", "crouch", "jump", "fall", "swim", "climb", "fly" };

        /// <summary>The action events, in id order.</summary>
        public static readonly IReadOnlyList<PlayerAction> Actions = Enum.GetValues(typeof(PlayerAction)).Cast<PlayerAction>().ToArray();

        /// <summary>State fields that may go into <c>sync.player.omit</c> (position and teleport never).</summary>
        public static readonly IReadOnlyList<string> OmittableFields = new[] { "velocity", "yaw", "pitch", "onGround", "mode", "item", "aiming", "blocking", "health", "alive", "team" };

        /// <summary>Every name <c>omit</c> accepts: the fields and the events.</summary>
        public static readonly IReadOnlyList<string> Omittable = OmittableFields.Concat(Actions.Select(Name)).ToArray();

        /// <summary>The wire name of an event, as <c>omit</c> and the spec write it ("itemSwitch").</summary>
        public static string Name(PlayerAction a) => Names[(int)a];

        public static bool TryParseAction(string name, out PlayerAction action)
        {
            for (var i = 1; i < Names.Length; i++) if (Names[i] == name) { action = (PlayerAction)i; return true; }
            action = 0;
            return false;
        }

        /// <summary>True when the event id is one of the twelve.</summary>
        public static bool IsKnown(byte id) => id >= 1 && id <= 12;

        /// <summary>True for the events only the host may start (hit, death).</summary>
        public static bool IsHostOrigin(PlayerAction a) => a == PlayerAction.Hit || a == PlayerAction.Death;

        /// <summary>Bits of a position axis: the smallest b in 8..24 with 2^b - 1 &gt;= ceil(2 x range / 0.01) (about 1 cm a step).</summary>
        public static int PositionBits(double range)
        {
            var steps = Math.Ceiling(2 * range / 0.01);
            var b = 8;
            while (b < 24 && Math.Pow(2, b) - 1 < steps) b++;
            return b;
        }

        // ---- kind 5: player events -----------------------------------------------------------------------------------

        /// <summary>Encode a kind 5 message of the first <paramref name="count"/> events (1..255).</summary>
        public static byte[] EncodePlayerEvents(IReadOnlyList<WireEvent> events, int count = -1) => Encode(events, count < 0 ? events.Count : count, new ByteWriter());

        internal static byte[] Encode(IReadOnlyList<WireEvent> events, int count, ByteWriter w)
        {
            if (count < 1 || count > MaxEventsPerMessage || count > events.Count) throw new ArgumentOutOfRangeException(nameof(events), "1..255 events per message");
            w.Clear();
            w.U8(Proto.Magic);
            w.U8(Proto.Version);
            w.U8(KindPlayerEvents);
            w.U8(count);
            for (var i = 0; i < count; i++)
            {
                var e = events[i];
                if (e.Args.Length > 255) throw new ArgumentException("event arguments over 255 bytes");
                w.Var(e.Player);
                w.Var(e.Seq);
                w.U8(e.Id);
                w.Var(e.Tick);
                w.U8(e.Args.Length);
                w.Bytes(e.Args);
            }
            return w.ToArray();
        }

        /// <summary>
        /// Decode a kind 5 message into <paramref name="into"/> (cleared first). Returns null on success, else the replication
        /// error name: <c>too_short</c>, <c>trailing</c>, <c>varint</c>, <c>range</c>, <c>count_0</c>, <c>player_0</c>, <c>seq_0</c>
        /// or <c>event_id</c>. Never throws on bad bytes.
        /// </summary>
        public static string? TryDecodePlayerEvents(ReadOnlySpan<byte> p, List<WireEvent> into)
        {
            into.Clear();
            if (p.Length < 4) return "too_short";
            try
            {
                var r = new ByteReader(p.Slice(3));
                var count = r.U8();
                if (count == 0) return "count_0";
                for (var i = 0; i < count; i++)
                {
                    var player = r.Var32();
                    var seq = r.Var32();
                    var id = r.U8();
                    var tick = r.Var32();
                    var len = r.U8();
                    var args = r.Bytes(len);
                    if (player == 0) return "player_0";
                    if (seq == 0) return "seq_0";
                    if (id == 0) return "event_id";
                    into.Add(new WireEvent(player, seq, id, tick, args.ToArray()));
                }
                return r.Remaining != 0 ? "trailing" : null;
            }
            catch (MalformedException e)
            {
                return e.Message;
            }
        }
    }
}
