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
                _partials[id] = p = new Partial { Parts = new byte[]?[count] };
            if (p.Parts[index] == null) { p.Parts[index] = bytes; p.Got++; p.Bytes += bytes.Length; }
            if (p.Bytes > Wire.MaxReassembled) { _partials.Remove(id); throw new FormatException("chunk set over 64 MiB"); }
            if (p.Got < count) return false;
            _partials.Remove(id);
            var all = new byte[p.Bytes];
            var pos = 0;
            foreach (var part in p.Parts) { Buffer.BlockCopy(part!, 0, all, pos, part!.Length); pos += part.Length; }
            complete = all;
            return true;
        }

        public void Clear() => _partials.Clear();
    }
}
