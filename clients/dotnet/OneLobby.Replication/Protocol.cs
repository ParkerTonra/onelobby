using System;
using System.Collections.Generic;

namespace OneLobby.Replication
{
    /// <summary>One entity inside one tick's world table. State is the entity's bit-packed bytes, shared (never mutated).</summary>
    internal readonly struct Ent
    {
        public Ent(uint id, ushort type, int owner, byte[] state) { Id = id; Type = type; Owner = owner; State = state; }
        public readonly uint Id;
        public readonly ushort Type;
        public readonly int Owner;
        public readonly byte[] State;
    }

    /// <summary>The replicated world at one tick: entities sorted by id.</summary>
    internal sealed class World
    {
        public World(uint tick, List<Ent> ents) { Tick = tick; Ents = ents; }
        public readonly uint Tick;
        public readonly List<Ent> Ents;

        public int IndexOf(uint id)
        {
            int lo = 0, hi = Ents.Count - 1;
            while (lo <= hi)
            {
                var mid = (lo + hi) >> 1;
                var v = Ents[mid].Id;
                if (v == id) return mid;
                if (v < id) lo = mid + 1; else hi = mid - 1;
            }
            return -1;
        }
    }

    internal sealed class MalformedException : Exception { public MalformedException(string m) : base(m) { } }

    internal sealed class ByteWriter
    {
        private byte[] _b = new byte[256];
        public int Length;
        public void Clear() => Length = 0;
        private void Need(int n) { if (Length + n > _b.Length) Array.Resize(ref _b, Math.Max(_b.Length * 2, Length + n)); }
        public void U8(int v) { Need(1); _b[Length++] = (byte)v; }
        public void Var(ulong v)
        {
            Need(10);
            while (v >= 0x80) { _b[Length++] = (byte)(v | 0x80); v >>= 7; }
            _b[Length++] = (byte)v;
        }
        public void Bytes(ReadOnlySpan<byte> s) { Need(s.Length); s.CopyTo(_b.AsSpan(Length)); Length += s.Length; }
        public void Append(ByteWriter o) => Bytes(o.Span);
        public ReadOnlySpan<byte> Span => _b.AsSpan(0, Length);
        public byte[] ToArray() => Span.ToArray();
    }

    internal ref struct ByteReader
    {
        private readonly ReadOnlySpan<byte> _s;
        private int _p;
        public ByteReader(ReadOnlySpan<byte> s) { _s = s; _p = 0; }
        public int Remaining => _s.Length - _p;
        public byte U8() { if (_p >= _s.Length) throw new MalformedException("too_short"); return _s[_p++]; }
        public ulong Var()
        {
            ulong v = 0;
            for (var shift = 0; shift < 64; shift += 7)
            {
                var b = U8();
                v |= (ulong)(b & 0x7F) << shift;
                if ((b & 0x80) == 0) return v;
            }
            throw new MalformedException("varint");
        }
        public uint Var32() { var v = Var(); if (v > uint.MaxValue) throw new MalformedException("range"); return (uint)v; }
        public ReadOnlySpan<byte> Bytes(int n) { if (n < 0 || n > Remaining) throw new MalformedException("too_short"); var r = _s.Slice(_p, n); _p += n; return r; }
        public ReadOnlySpan<byte> Rest() => Bytes(Remaining);
    }

    /// <summary>
    /// The replication wire format (spec/replication.md). Every message is a lobby <c>raw</c> payload that starts with
    /// <c>0x52 'R', version 1, kind</c>. Pure functions so tests and vectors can drive them without a lobby.
    /// </summary>
    internal static class Proto
    {
        public const byte Magic = 0x52;
        public const byte Version = 1;
        public const byte KindSnapshot = 1, KindInput = 2, KindEvent = 3, KindStreamEvent = 4;
        public const int OpDelta = 0, OpFull = 1, OpDespawn = 2;
        public const int MaxStateBytes = 255;

        public static bool IsReplication(ReadOnlySpan<byte> p) => p.Length >= 3 && p[0] == Magic;

        private static void Header(ByteWriter w, byte kind) { w.U8(Magic); w.U8(Version); w.U8(kind); }

        // ---- snapshot ------------------------------------------------------------------------------------------

        /// <summary>Encode <paramref name="cur"/> as a delta against <paramref name="baseline"/> (null = full snapshot).</summary>
        public static byte[] EncodeSnapshot(World cur, World? baseline, uint lastInputSeq, ByteWriter w, ByteWriter recs)
        {
            w.Clear(); recs.Clear();
            Header(w, KindSnapshot);
            w.Var(cur.Tick);
            w.Var(baseline == null ? 0u : cur.Tick - baseline.Tick);
            w.Var(lastInputSeq);
            var bas = baseline?.Ents;
            int i = 0, j = 0, count = 0;
            uint prev = 0;
            var c = cur.Ents;
            Span<byte> maskBuf = stackalloc byte[(MaxStateBytes + 7) >> 3];
            var bn = bas?.Count ?? 0;
            while (i < c.Count || j < bn)
            {
                if (j >= bn || (i < c.Count && c[i].Id < bas![j].Id))
                {
                    Full(recs, ref prev, c[i]); i++; count++;
                }
                else if (i >= c.Count || bas![j].Id < c[i].Id)
                {
                    RecHead(recs, ref prev, bas![j].Id, OpDespawn); j++; count++;
                }
                else
                {
                    var a = c[i]; var b = bas[j];
                    i++; j++;
                    if (a.Type != b.Type || a.Owner != b.Owner || a.State.Length != b.State.Length) { Full(recs, ref prev, a); count++; continue; }
                    if (ReferenceEquals(a.State, b.State) || a.State.AsSpan().SequenceEqual(b.State)) continue;
                    RecHead(recs, ref prev, a.Id, OpDelta);
                    var len = a.State.Length;
                    var maskLen = (len + 7) >> 3;
                    var mask = maskBuf.Slice(0, maskLen);
                    mask.Clear();
                    for (var k = 0; k < len; k++) if (a.State[k] != b.State[k]) mask[k >> 3] |= (byte)(1 << (k & 7));
                    recs.Bytes(mask);
                    for (var k = 0; k < len; k++) if (a.State[k] != b.State[k]) recs.U8(a.State[k]);
                    count++;
                }
            }
            w.Var((ulong)count);
            w.Append(recs);
            return w.ToArray();
        }

        private static void RecHead(ByteWriter w, ref uint prev, uint id, int op)
        {
            w.Var(((ulong)(id - prev) << 2) | (uint)op);
            prev = id;
        }

        private static void Full(ByteWriter w, ref uint prev, Ent e)
        {
            RecHead(w, ref prev, e.Id, OpFull);
            w.Var(e.Type); w.Var((ulong)e.Owner); w.Var((ulong)e.State.Length); w.Bytes(e.State);
        }

        public readonly struct SnapshotHeader
        {
            public SnapshotHeader(uint tick, uint baselineTick, uint lastInput) { Tick = tick; BaselineTick = baselineTick; LastInputSeq = lastInput; }
            public readonly uint Tick;
            /// <summary>0 = full snapshot.</summary>
            public readonly uint BaselineTick;
            public readonly uint LastInputSeq;
        }

        /// <summary>Reads only the header (after the 3-byte prefix) so the caller can find the baseline.</summary>
        public static SnapshotHeader PeekSnapshot(ReadOnlySpan<byte> p)
        {
            var r = new ByteReader(p.Slice(3));
            var tick = r.Var32();
            var back = r.Var32();
            var last = r.Var32();
            if (tick == 0 || back > tick) throw new MalformedException("tick");
            return new SnapshotHeader(tick, back == 0 ? 0 : tick - back, last);
        }

        /// <summary>Apply a snapshot to its baseline (null for a full snapshot). Throws <see cref="MalformedException"/>.</summary>
        public static World DecodeSnapshot(ReadOnlySpan<byte> p, World? baseline)
        {
            var r = new ByteReader(p.Slice(3));
            var tick = r.Var32(); var back = r.Var32(); r.Var32();
            if ((back == 0) != (baseline == null)) throw new MalformedException("baseline");
            var count = r.Var();
            var bas = baseline?.Ents;
            var bn = bas?.Count ?? 0;
            var outList = new List<Ent>(Math.Max(bn, 4));
            var j = 0;
            uint prev = 0;
            for (ulong n = 0; n < count; n++)
            {
                var head = r.Var();
                var op = (int)(head & 3);
                var delta = head >> 2;
                if (delta == 0 || prev + delta > uint.MaxValue) throw new MalformedException("id");
                var id = (uint)(prev + delta);
                prev = id;
                while (j < bn && bas![j].Id < id) outList.Add(bas[j++]);
                var inBase = j < bn && bas![j].Id == id;
                switch (op)
                {
                    case OpFull:
                    {
                        var type = r.Var(); var owner = r.Var(); var len = (int)r.Var();
                        if (type > ushort.MaxValue || owner > int.MaxValue || len > MaxStateBytes) throw new MalformedException("full");
                        outList.Add(new Ent(id, (ushort)type, (int)owner, r.Bytes(len).ToArray()));
                        if (inBase) j++;
                        break;
                    }
                    case OpDespawn:
                        if (!inBase) throw new MalformedException("despawn");
                        j++;
                        break;
                    case OpDelta:
                    {
                        if (!inBase) throw new MalformedException("delta");
                        var b = bas![j++];
                        var len = b.State.Length;
                        var mask = r.Bytes((len + 7) >> 3);
                        var st = (byte[])b.State.Clone();
                        for (var k = 0; k < len; k++) if ((mask[k >> 3] >> (k & 7) & 1) != 0) st[k] = r.U8();
                        outList.Add(new Ent(id, b.Type, b.Owner, st));
                        break;
                    }
                    default: throw new MalformedException("op");
                }
            }
            while (j < bn) outList.Add(bas![j++]);
            if (r.Remaining != 0) throw new MalformedException("trailing");
            return new World(tick, outList);
        }

        // ---- input ---------------------------------------------------------------------------------------------

        /// <summary>
        /// inputs: newest first, consecutive sequence numbers newestSeq, newestSeq-1, ... Each entry is (viewTick256, bytes).
        /// </summary>
        public static byte[] EncodeInput(uint ack, uint newestSeq, IReadOnlyList<(ulong View256, byte[] Bytes)> newestFirst, int count, ByteWriter w)
        {
            w.Clear();
            Header(w, KindInput);
            w.Var(ack); w.Var(newestSeq); w.U8(count);
            for (var i = 0; i < count; i++)
            {
                var (view, bytes) = newestFirst[i];
                w.Var(view); w.Var((ulong)bytes.Length); w.Bytes(bytes);
            }
            return w.ToArray();
        }

        public static (uint Ack, uint NewestSeq, List<(uint Seq, ulong View256, byte[] Bytes)> Inputs) DecodeInput(ReadOnlySpan<byte> p)
        {
            var r = new ByteReader(p.Slice(3));
            var ack = r.Var32(); var newest = r.Var32(); int n = r.U8();
            if (n > newest) throw new MalformedException("seq");
            var list = new List<(uint, ulong, byte[])>(n);
            for (var i = 0; i < n; i++)
            {
                var view = r.Var(); var len = (int)Math.Min(r.Var(), int.MaxValue);
                list.Add(((uint)(newest - i), view, r.Bytes(len).ToArray()));
            }
            if (r.Remaining != 0) throw new MalformedException("trailing");
            return (ack, newest, list);
        }

        // ---- event ---------------------------------------------------------------------------------------------

        public static byte[] EncodeEvent(uint tick, ReadOnlySpan<byte> payload, ByteWriter w)
        {
            w.Clear();
            Header(w, KindEvent);
            w.Var(tick); w.Bytes(payload);
            return w.ToArray();
        }

        public static (uint Tick, byte[] Payload) DecodeEvent(ReadOnlySpan<byte> p)
        {
            var r = new ByteReader(p.Slice(3));
            var tick = r.Var32();
            return (tick, r.Rest().ToArray());
        }

        public static byte[] EncodeStreamEvent(uint tick, byte stream, uint seq, ReadOnlySpan<byte> payload, ByteWriter w)
        {
            w.Clear();
            Header(w, KindStreamEvent);
            w.Var(tick); w.U8(stream); w.Var(seq); w.Bytes(payload);
            return w.ToArray();
        }

        public static (uint Tick, byte Stream, uint Seq, byte[] Payload) DecodeStreamEvent(ReadOnlySpan<byte> p)
        {
            var r = new ByteReader(p.Slice(3));
            var tick = r.Var32();
            var stream = r.U8();
            if (stream == 0) throw new MalformedException("stream_0");
            var seq = r.Var32();
            if (seq == 0) throw new MalformedException("seq_0");
            return (tick, stream, seq, r.Rest().ToArray());
        }
    }
}
