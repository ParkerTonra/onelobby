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

    /// <summary>Tunables. Defaults are the DESIGN s.19 decisions (30 Hz tick and send, 100 ms interpolation, 4x input redundancy).</summary>
    public sealed record ReplicationConfig(
        int TickRate = 30,
        int SnapshotEveryTicks = 1,
        double InterpolationDelayMs = 100,
        int InputRedundancy = 4,
        int HistoryTicks = 64,
        int MaxInputBuffer = 4,
        double MaxRewindMs = 250,
        int SnapshotWarnBytes = 1200)
    {
        public double TickMs => 1000.0 / TickRate;
    }

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
        public long Malformed { get; internal set; }
    }
}
