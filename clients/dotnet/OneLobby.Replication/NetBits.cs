using System;

#if !NET5_0_OR_GREATER
namespace System.Runtime.CompilerServices
{
    internal static class IsExternalInit { }
}
#endif

namespace OneLobby.Replication
{
    /// <summary>
    /// Bit-packed writer for one entity's state (spec/replication.md "State bits"). Bits are written LSB first: bit k of a
    /// value lands at stream bit p + k, stream bit p is bit (p &amp; 7) of byte (p &gt;&gt; 3). Reused by the session; do not
    /// keep a reference past <see cref="IReplicatedEntity.Write"/>.
    /// </summary>
    public sealed class NetWriter
    {
        private byte[] _buf = new byte[64];
        private int _bits;

        /// <summary>Bits written so far.</summary>
        public int BitCount => _bits;
        /// <summary>Bytes the state occupies (unused high bits of the last byte are zero).</summary>
        public int ByteCount => (_bits + 7) >> 3;

        public void Reset()
        {
            Array.Clear(_buf, 0, ByteCount);
            _bits = 0;
        }

        /// <summary>Write the low <paramref name="bits"/> (1..32) bits of <paramref name="value"/>.</summary>
        public void WriteBits(uint value, int bits)
        {
            if (bits < 1 || bits > 32) throw new ArgumentOutOfRangeException(nameof(bits));
            if (bits < 32) value &= (1u << bits) - 1;
            var need = (_bits + bits + 7) >> 3;
            if (need > _buf.Length) Array.Resize(ref _buf, Math.Max(need, _buf.Length * 2));
            for (var i = 0; i < bits; i++)
            {
                if ((value >> i & 1) != 0) _buf[_bits >> 3] |= (byte)(1 << (_bits & 7));
                _bits++;
            }
        }

        public void WriteBool(bool v) => WriteBits(v ? 1u : 0u, 1);
        public void WriteByte(byte v) => WriteBits(v, 8);
        public void WriteUInt16(ushort v) => WriteBits(v, 16);
        public void WriteUInt32(uint v) => WriteBits(v, 32);
        public void WriteInt32(int v) => WriteBits(unchecked((uint)v), 32);

        /// <summary>Full-precision float (32 bits). Prefer the quantized writers for anything that moves every tick.</summary>
        public void WriteFloat(float v) => WriteBits(Quantize.FloatBits(v), 32);

        /// <summary>Clamp to [min, max] and write in <paramref name="bits"/> bits (see <see cref="Quantize.Float"/>).</summary>
        public void WriteQuantized(float v, float min, float max, int bits) => WriteBits(Quantize.Float(v, min, max, bits), bits);

        /// <summary>An angle in degrees, wrapped to [0, 360), in <paramref name="bits"/> bits.</summary>
        public void WriteAngle(float degrees, int bits) => WriteBits(Quantize.Angle(degrees, bits), bits);

        /// <summary>Unit quaternion, smallest-three: 2 bits index + 3 x <paramref name="bitsPerComponent"/> (Gaffer: 2+9+9+9 = 29 bits).</summary>
        public void WriteQuaternion(float x, float y, float z, float w, int bitsPerComponent = 9)
        {
            var q = Quantize.SmallestThree(x, y, z, w, bitsPerComponent);
            WriteBits(q.Largest, 2);
            WriteBits(q.A, bitsPerComponent);
            WriteBits(q.B, bitsPerComponent);
            WriteBits(q.C, bitsPerComponent);
        }

        internal void CopyTo(Span<byte> dest) => _buf.AsSpan(0, ByteCount).CopyTo(dest);
        internal ReadOnlySpan<byte> Span => _buf.AsSpan(0, ByteCount);

        public byte[] ToArray() => _buf.AsSpan(0, ByteCount).ToArray();
    }

    /// <summary>Reads what <see cref="NetWriter"/> wrote, in the same order. Reading past the end returns zero bits.</summary>
    public sealed class NetReader
    {
        private byte[] _buf = Array.Empty<byte>();
        private int _len;
        private int _bits;

        public NetReader() { }
        public NetReader(byte[] data) { Reset(data, data.Length); }

        public void Reset(byte[] data, int length)
        {
            _buf = data; _len = length; _bits = 0;
        }

        /// <summary>True when a read went past the end of the state (a schema mismatch).</summary>
        public bool Overrun { get; private set; }

        public uint ReadBits(int bits)
        {
            if (bits < 1 || bits > 32) throw new ArgumentOutOfRangeException(nameof(bits));
            uint v = 0;
            for (var i = 0; i < bits; i++)
            {
                var byteIndex = _bits >> 3;
                if (byteIndex >= _len) { Overrun = true; _bits++; continue; }
                if ((_buf[byteIndex] >> (_bits & 7) & 1) != 0) v |= 1u << i;
                _bits++;
            }
            return v;
        }

        public bool ReadBool() => ReadBits(1) != 0;
        public byte ReadByte() => (byte)ReadBits(8);
        public ushort ReadUInt16() => (ushort)ReadBits(16);
        public uint ReadUInt32() => ReadBits(32);
        public int ReadInt32() => unchecked((int)ReadBits(32));
        public float ReadFloat() => Quantize.BitsFloat(ReadBits(32));
        public float ReadQuantized(float min, float max, int bits) => Quantize.Dequantize(ReadBits(bits), min, max, bits);
        public float ReadAngle(int bits) => Quantize.AngleFrom(ReadBits(bits), bits);

        public (float X, float Y, float Z, float W) ReadQuaternion(int bitsPerComponent = 9)
        {
            var largest = ReadBits(2);
            var a = ReadBits(bitsPerComponent);
            var b = ReadBits(bitsPerComponent);
            var c = ReadBits(bitsPerComponent);
            return Quantize.FromSmallestThree(largest, a, b, c, bitsPerComponent);
        }
    }

    /// <summary>
    /// Pure quantization functions (spec/replication.md "Quantization"). Host and client run the same math, so a value the
    /// client reads back is exactly <c>Dequantize(Quantize(v))</c> on both sides (Gaffer: "quantize the state on both sides").
    /// </summary>
    public static class Quantize
    {
        private static uint MaxOf(int bits) => bits >= 32 ? uint.MaxValue : (1u << bits) - 1;

        /// <summary>Clamp v to [min, max] and map linearly onto 0 .. 2^bits - 1, rounding to nearest.</summary>
        public static uint Float(float v, float min, float max, int bits)
        {
            if (!(max > min)) throw new ArgumentException("max must be greater than min");
            if (float.IsNaN(v)) v = min;
            var t = (Math.Min(Math.Max(v, min), max) - (double)min) / ((double)max - min);
            return (uint)Math.Round(t * MaxOf(bits), MidpointRounding.AwayFromZero);
        }

        public static float Dequantize(uint q, float min, float max, int bits) =>
            (float)(min + ((double)max - min) * Math.Min(q, MaxOf(bits)) / MaxOf(bits));

        /// <summary>Bits needed to cover [min, max] with a step no larger than <paramref name="precision"/>.</summary>
        public static int BitsFor(float min, float max, float precision)
        {
            var steps = Math.Ceiling(((double)max - min) / precision);
            var bits = 1;
            while (bits < 32 && MaxOf(bits) < steps) bits++;
            return bits;
        }

        /// <summary>Degrees wrapped to [0, 360) mapped onto 0 .. 2^bits - 1 (360 wraps to 0).</summary>
        public static uint Angle(float degrees, int bits)
        {
            var a = degrees % 360.0;
            if (a < 0) a += 360.0;
            var steps = (double)MaxOf(bits) + 1;
            return (uint)((ulong)Math.Round(a / 360.0 * steps, MidpointRounding.AwayFromZero) % (ulong)steps);
        }

        public static float AngleFrom(uint q, int bits) => (float)(q * 360.0 / ((double)MaxOf(bits) + 1));

        public static uint FloatBits(float v) => unchecked((uint)BitConverter.SingleToInt32Bits(v));
        public static float BitsFloat(uint v) => BitConverter.Int32BitsToSingle(unchecked((int)v));

        private const float InvSqrt2 = 0.70710678f;

        /// <summary>Smallest-three quaternion encoding (Gaffer, snapshot compression).</summary>
        public static (uint Largest, uint A, uint B, uint C) SmallestThree(float x, float y, float z, float w, int bits)
        {
            Span<float> q = stackalloc float[4] { x, y, z, w };
            var len = Math.Sqrt(x * x + y * y + z * z + w * w);
            if (len < 1e-6) { q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 1; len = 1; }
            uint largest = 0;
            for (var i = 0; i < 4; i++) { q[i] = (float)(q[i] / len); if (Math.Abs(q[i]) > Math.Abs(q[(int)largest])) largest = (uint)i; }
            var sign = q[(int)largest] < 0 ? -1f : 1f;
            Span<uint> o = stackalloc uint[3];
            var k = 0;
            for (var i = 0; i < 4; i++) if (i != largest) o[k++] = Float(q[i] * sign, -InvSqrt2, InvSqrt2, bits);
            return (largest, o[0], o[1], o[2]);
        }

        public static (float X, float Y, float Z, float W) FromSmallestThree(uint largest, uint a, uint b, uint c, int bits)
        {
            Span<float> q = stackalloc float[4];
            var src = new[] { a, b, c };
            var k = 0;
            double sum = 0;
            for (var i = 0; i < 4; i++)
            {
                if (i == (int)(largest & 3)) continue;
                q[i] = Dequantize(src[k++], -InvSqrt2, InvSqrt2, bits);
                sum += q[i] * q[i];
            }
            q[(int)(largest & 3)] = (float)Math.Sqrt(Math.Max(0, 1 - sum));
            return (q[0], q[1], q[2], q[3]);
        }
    }

    /// <summary>Small interpolation helpers for <see cref="IReplicatedState{T}.Interpolate"/> implementations.</summary>
    public static class NetMath
    {
        public static float Lerp(float a, float b, float t) => a + (b - a) * t;

        /// <summary>
        /// Lerp, but return <paramref name="b"/> when the two samples are more than <paramref name="maxDistance"/> apart:
        /// a teleport or blink between two snapshots is drawn as a jump, not a one-tick streak. Pick a distance longer
        /// than anything moves legally in one tick.
        /// </summary>
        public static float LerpOrSnap(float a, float b, float t, float maxDistance) =>
            Math.Abs(b - a) > maxDistance ? b : Lerp(a, b, t);

        /// <inheritdoc cref="LerpOrSnap(float, float, float, float)"/>
        public static (float X, float Y, float Z) LerpOrSnap((float X, float Y, float Z) a, (float X, float Y, float Z) b, float t, float maxDistance)
        {
            float dx = b.X - a.X, dy = b.Y - a.Y, dz = b.Z - a.Z;
            if (dx * dx + dy * dy + dz * dz > maxDistance * maxDistance) return b;
            return (Lerp(a.X, b.X, t), Lerp(a.Y, b.Y, t), Lerp(a.Z, b.Z, t));
        }

        /// <summary>Lerp between two angles in degrees along the shorter arc; result in [0, 360).</summary>
        public static float LerpAngle(float a, float b, float t)
        {
            var d = (b - a) % 360f;
            if (d > 180f) d -= 360f;
            if (d < -180f) d += 360f;
            var r = (a + d * t) % 360f;
            return r < 0 ? r + 360f : r;
        }

        /// <summary>Normalized lerp of two unit quaternions (takes the short way round).</summary>
        public static (float X, float Y, float Z, float W) Nlerp((float X, float Y, float Z, float W) a, (float X, float Y, float Z, float W) b, float t)
        {
            var dot = a.X * b.X + a.Y * b.Y + a.Z * b.Z + a.W * b.W;
            var s = dot < 0 ? -1f : 1f;
            var x = Lerp(a.X, b.X * s, t); var y = Lerp(a.Y, b.Y * s, t); var z = Lerp(a.Z, b.Z * s, t); var w = Lerp(a.W, b.W * s, t);
            var len = (float)Math.Sqrt(x * x + y * y + z * z + w * w);
            return len < 1e-6f ? (0, 0, 0, 1) : (x / len, y / len, z / len, w / len);
        }
    }
}
