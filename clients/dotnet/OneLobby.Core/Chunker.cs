using System;
using System.Collections.Generic;

namespace OneLobby
{
    /// <summary>Splits big payloads into chunk frames (DESIGN s.8) and reassembles them.</summary>
    public static class Chunker
    {
        public static IEnumerable<byte[]> Split(uint id, ReadOnlyMemory<byte> data, int maxPayload = Wire.ChunkPayload)
        {
            var count = Math.Max(1, (data.Length + maxPayload - 1) / maxPayload);
            for (var i = 0; i < count; i++)
            {
                var off = i * maxPayload;
                var len = Math.Max(0, Math.Min(maxPayload, data.Length - off));
                yield return Wire.BuildChunk(id, i, count, data.Span.Slice(off, len));
            }
        }
    }

    public sealed class ChunkAssembler
    {
        private sealed class Partial { public byte[]?[] Parts = Array.Empty<byte[]>(); public int Got; public long Bytes; }
        private readonly Dictionary<uint, Partial> _partials = new();
        private readonly List<uint> _order = new(); // oldest first, for eviction

        /// <summary>Most incomplete chunk sets one assembler (one peer) holds at once; a new id past this evicts the oldest.</summary>
        public const int MaxPartialSets = 8;

        /// <summary>Incomplete chunk sets held right now.</summary>
        public int PendingSets => _partials.Count;

        /// <summary>Bytes held across incomplete chunk sets right now.</summary>
        public long PendingBytes { get { long n = 0; foreach (var p in _partials.Values) n += p.Bytes; return n; } }

        private void Drop(uint id) { _partials.Remove(id); _order.Remove(id); }

        /// <summary>Feeds one chunk body (after the 3-byte header). True with the whole payload when the last piece arrives.</summary>
        public bool TryAdd(ReadOnlySpan<byte> body, out uint id, out byte[] complete)
        {
            var r = new Wire.Reader(body);
            id = r.U32();
            int index = r.U16(), count = r.U16();
            var bytes = r.Rest().ToArray();
            complete = Array.Empty<byte>();
            if (count == 0 || index >= count || count > 8192) throw new FormatException("bad chunk");
            if (!_partials.TryGetValue(id, out var p) || p.Parts.Length != count)
            {
                Drop(id);
                while (_order.Count >= MaxPartialSets) Drop(_order[0]);
                _partials[id] = p = new Partial { Parts = new byte[]?[count] };
                _order.Add(id);
            }
            if (p.Parts[index] == null) { p.Parts[index] = bytes; p.Got++; p.Bytes += bytes.Length; }
            if (p.Bytes > Wire.MaxReassembled) { Drop(id); throw new FormatException("chunk set over 64 MiB"); }
            if (p.Got < count) { EvictOverBudget(id); return false; }
            Drop(id);
            var all = new byte[p.Bytes];
            var pos = 0;
            foreach (var part in p.Parts) { Buffer.BlockCopy(part!, 0, all, pos, part!.Length); pos += part.Length; }
            complete = all;
            return true;
        }

        // Many half-sent sets must not add up to more than one whole message: the oldest others go first.
        private void EvictOverBudget(uint keep)
        {
            while (PendingBytes > Wire.MaxReassembled && _order.Count > 1)
                Drop(_order[0] == keep ? _order[1] : _order[0]);
        }

        public void Clear() { _partials.Clear(); _order.Clear(); }
    }
}
