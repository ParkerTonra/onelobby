using System.Security.Cryptography;

#if !NET5_0_OR_GREATER
namespace System.Runtime.CompilerServices
{
    internal static class IsExternalInit { }
}
#endif

namespace OneLobby.Server
{
    /// <summary>The few .NET 5+ crypto and hex helpers the hub uses, so it also builds for netstandard2.1 (Unity).</summary>
    internal static class Compat
    {
        public static byte[] RandomBytes(int n)
        {
            var b = new byte[n];
            using var rng = RandomNumberGenerator.Create();
            rng.GetBytes(b);
            return b;
        }

        public static string Hex(byte[] b) => Hex(b, 0, b.Length);

        /// <summary>Uppercase hex, like Convert.ToHexString.</summary>
        public static string Hex(byte[] b, int offset, int count)
        {
            var c = new char[count * 2];
            for (int i = 0; i < count; i++)
            {
                int v = b[offset + i];
                c[2 * i] = "0123456789ABCDEF"[v >> 4];
                c[2 * i + 1] = "0123456789ABCDEF"[v & 15];
            }
            return new string(c);
        }

        public static byte[] Sha256(byte[] data)
        {
            using var h = SHA256.Create();
            return h.ComputeHash(data);
        }

        public static byte[] Sha1(byte[] data)
        {
            using var h = SHA1.Create();
            return h.ComputeHash(data);
        }

        public static byte[] HmacSha1(byte[] key, byte[] data)
        {
            using var h = new HMACSHA1(key);
            return h.ComputeHash(data);
        }
    }
}
