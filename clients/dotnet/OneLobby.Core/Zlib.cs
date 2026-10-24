using System;
using System.IO;
using System.IO.Compression;

namespace OneLobby
{
    /// <summary>zlib (RFC 1950) streams on top of DeflateStream, so netstandard2.1 needs no ZLibStream.</summary>
    internal static class Zlib
    {
        public static byte[] Deflate(byte[] data)
        {
            using var ms = new MemoryStream();
            ms.WriteByte(0x78); ms.WriteByte(0x9C);
            using (var z = new DeflateStream(ms, CompressionLevel.Optimal, true)) z.Write(data, 0, data.Length);
            uint a = 1, b = 0;
            foreach (var x in data) { a = (a + x) % 65521; b = (b + a) % 65521; }
            var adler = (b << 16) | a;
            ms.WriteByte((byte)(adler >> 24)); ms.WriteByte((byte)(adler >> 16)); ms.WriteByte((byte)(adler >> 8)); ms.WriteByte((byte)adler);
            return ms.ToArray();
        }

        public static byte[] Inflate(byte[] data)
        {
            if (data.Length < 6 || (data[0] & 0x0F) != 8) throw new FormatException("not a zlib stream");
            using var input = new MemoryStream(data, 2, data.Length - 2);
            using var z = new DeflateStream(input, CompressionMode.Decompress);
            using var output = new MemoryStream();
            z.CopyTo(output);
            return output.ToArray();
        }
    }
}
