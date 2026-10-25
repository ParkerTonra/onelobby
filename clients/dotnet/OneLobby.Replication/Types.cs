using System;

namespace OneLobby.Replication
{
    /// <summary>Session-unique entity id assigned by the host. Starts at 1, never reused within a session; 0 is "none".</summary>
    public readonly record struct NetId(uint Value)
    {
        public static readonly NetId None = default;
        public bool IsNone => Value == 0;
        public override string ToString() => "#" + Value;
    }

    /// <summary>What every peer knows about an entity besides its state: id, the game's type id, owning peer (0 = host-owned).</summary>
    public sealed record EntityInfo(NetId Id, ushort TypeId, int Owner);

    /// <summary>Host side: a game object the session reads every snapshot tick. Write the full, quantized state.</summary>
    public interface IReplicatedEntity
    {
        void Write(NetWriter writer);
    }

    /// <summary>
    /// Client side: a decoded state value (usually a struct) for one entity type. <see cref="Read"/> mirrors the host's
    /// <see cref="IReplicatedEntity.Write"/>; <see cref="Interpolate"/> blends two snapshots for rendering.
    /// </summary>
    public interface IReplicatedState<T>
    {
        void Read(NetReader reader);
        /// <summary>The state between <c>this</c> (older snapshot) and <paramref name="to"/>, t in [0, 1].</summary>
        T Interpolate(in T to, float t);
    }

    /// <summary>One input as the host receives it.</summary>
    public readonly struct InputFrame
    {
        public InputFrame(uint seq, double viewTick, ReadOnlyMemory<byte> bytes, bool repeated)
        { Seq = seq; ViewTick = viewTick; Bytes = bytes; Repeated = repeated; }

        /// <summary>The client's input sequence number (1, 2, 3 ... one per client tick).</summary>
        public uint Seq { get; }
        /// <summary>Host tick the client was rendering when it made this input (interpolated view, for lag compensation).</summary>
        public double ViewTick { get; }
        public ReadOnlyMemory<byte> Bytes { get; }
        /// <summary>True when no new input had arrived for this tick and the previous one is handed out again.</summary>
        public bool Repeated { get; }
    }

    /// <summary>Tunables. Defaults are the DESIGN s.18 decisions (30 Hz tick and send, 100 ms interpolation, 4x input redundancy).</summary>
    public sealed record ReplicationConfig(
        int TickRate = 30,
        int SnapshotEveryTicks = 1,
        double InterpolationDelayMs = 100,
        int InputRedundancy = 4,
        int HistoryTicks = 64,
        int MaxInputBuffer = 4,
        double MaxRewindMs = 250,
        int SnapshotWarnBytes = 1200,
        int HoldEventsForTicks = 0)
    {
        // HoldEventsForTicks (client, 0 = off): an event whose tick is newer than the newest snapshot waits (arrival order
        // kept) until that snapshot is in, or for at most this many ticks, so the event and the state it refers to line up.

        public double TickMs => 1000.0 / TickRate;
    }

    /// <summary>
    /// A hole in a numbered stream that was given up on: events <see cref="FirstMissing"/> up to (not including)
    /// <see cref="NextDelivered"/> from <see cref="From"/> on <see cref="Stream"/> never arrived; delivery goes on at
    /// <see cref="NextDelivered"/>.
    /// </summary>
    public readonly record struct StreamGap(int From, byte Stream, uint FirstMissing, uint NextDelivered)
    {
        /// <summary>How many sequence numbers were skipped.</summary>
        public uint Missing => NextDelivered - FirstMissing;
    }

    /// <summary>One received event (<see cref="ReplicationSession.EventDelivered"/>).</summary>
    /// <param name="From">Sender's peer id.</param>
    /// <param name="Tick">Sender's tick when sent (host: <c>Clock.Tick</c>; client: its <c>floor(ServerTick)</c>).</param>
    /// <param name="Stream">1-255 for a numbered stream, 0 for an unnumbered event.</param>
    /// <param name="Seq">Sequence number within (Stream, sender to me), from 1; 0 when unnumbered.</param>
    /// <param name="Payload">The game's event bytes.</param>
    /// <param name="Channel">The channel it came on.</param>
    public readonly record struct ReplicatedEvent(int From, uint Tick, byte Stream, uint Seq, ReadOnlyMemory<byte> Payload, Channel Channel);

    /// <summary>Host: one client's input counters (<see cref="ReplicationSession.InputStatsFor"/>).</summary>
    /// <param name="Repeated">Ticks this client had no new input and the previous one was handed out again.</param>
    /// <param name="Skipped">Inputs dropped by the latency cap (<see cref="ReplicationConfig.MaxInputBuffer"/>).</param>
    /// <param name="Lost">Inputs that never arrived (every redundant copy lost).</param>
    /// <param name="BufferDepth">Inputs received and not yet consumed by <see cref="ReplicationSession.TryGetInput"/>.</param>
    public readonly record struct ClientInputStats(long Repeated, long Skipped, long Lost, int BufferDepth);

    /// <summary>Counters for tests and debug overlays. Byte counts are replication payloads, before the 3-byte lobby header.</summary>
    public sealed class ReplicationStats
    {
        public long SnapshotsSent { get; internal set; }
        public long FullSnapshotsSent { get; internal set; }
        public long SnapshotBytesSent { get; internal set; }
        public int LargestSnapshot { get; internal set; }
        public long OversizeSnapshots { get; internal set; }
        public long SnapshotsReceived { get; internal set; }
        public long SnapshotsDropped { get; internal set; }
        public long InputsSent { get; internal set; }
        public long InputBytesSent { get; internal set; }
        public long InputsReceived { get; internal set; }
        public long InputsRepeated { get; internal set; }
        /// <summary>Inputs dropped by the host's latency cap (<see cref="ReplicationConfig.MaxInputBuffer"/>) after a burst.</summary>
        public long InputsSkipped { get; internal set; }
        /// <summary>Inputs that never reached the host (every redundant copy lost).</summary>
        public long InputsLost { get; internal set; }
        public long EventsSent { get; internal set; }
        public long EventsReceived { get; internal set; }
        /// <summary>Numbered stream events dropped because that sequence number was already delivered.</summary>
        public long EventsDuplicate { get; internal set; }
        /// <summary>Holes in a numbered stream given up on (see <see cref="ReplicationSession.EventGap"/>).</summary>
        public long EventsGap { get; internal set; }
        /// <summary>Numbered stream events that arrived ahead of a missing one and waited for it.</summary>
        public long EventsOutOfOrder { get; internal set; }
        public long Malformed { get; internal set; }
    }
}
