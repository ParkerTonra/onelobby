#nullable enable
using System;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;

namespace OneLobby.Direct.Nostr
{
    /// <summary>
    /// The small crypto kit spec/nostr-signaling.md needs, with no packages: SHA-256, HKDF (RFC 5869 on HMAC-SHA256),
    /// AES-256-GCM (the platform's <c>AesGcm</c>, else a managed GCM for runtimes without it, e.g. Unity's Mono) and BIP340
    /// Schnorr signatures over secp256k1 on <see cref="BigInteger"/>.
    /// </summary>
    internal static class NostrCrypto
    {
        public static byte[] Sha256(byte[] data)
        {
            using var h = SHA256.Create();
            return h.ComputeHash(data);
        }

        public static byte[] Sha256(string utf8) => Sha256(Encoding.UTF8.GetBytes(utf8));

        public static byte[] HmacSha256(byte[] key, byte[] data)
        {
            using var h = new HMACSHA256(key);
            return h.ComputeHash(data);
        }

        /// <summary>HKDF-SHA256 for outputs of at most 32 bytes (a single expand block).</summary>
        public static byte[] Hkdf(byte[] ikm, byte[] salt, byte[] info, int length = 32)
        {
            if (length < 1 || length > 32) throw new ArgumentOutOfRangeException(nameof(length));
            var prk = HmacSha256(salt, ikm);
            var block = new byte[info.Length + 1];
            Buffer.BlockCopy(info, 0, block, 0, info.Length);
            block[info.Length] = 1;
            var t = HmacSha256(prk, block);
            if (length == 32) return t;
            var r = new byte[length];
            Buffer.BlockCopy(t, 0, r, 0, length);
            return r;
        }

        public static byte[] RandomBytes(int n)
        {
            var b = new byte[n];
            using var g = RandomNumberGenerator.Create();
            g.GetBytes(b);
            return b;
        }

        public static string Hex(byte[] b)
        {
            var sb = new StringBuilder(b.Length * 2);
            foreach (var x in b) sb.Append(x.ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
            return sb.ToString();
        }

        public static byte[] FromHex(string hex)
        {
            if (hex.Length % 2 != 0) throw new FormatException("odd hex length");
            var b = new byte[hex.Length / 2];
            for (var i = 0; i < b.Length; i++) b[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
            return b;
        }

        // ------------------------------------------------------------------ AES-256-GCM

        private static bool _noPlatformGcm;

        /// <summary>For tests and the Mono probe: skip the platform <c>AesGcm</c> and use the managed GCM only.</summary>
        internal static bool ForceManaged
        {
            get => _noPlatformGcm;
            set => _noPlatformGcm = value;
        }

        /// <summary>
        /// Called once, with a one-line reason, when the managed GCM takes over from the platform <c>AesGcm</c> (a runtime
        /// such as Unity's Mono that lacks or half-implements it). NostrCrypto has no logger of its own; wire this to yours.
        /// </summary>
        internal static Action<string>? FallbackLog;

        private static int _fallbackLogged;

        internal static void ResetFallbackLogForTests() => _fallbackLogged = 0;

        private static void PlatformGcmFailed(Exception e)
        {
            _noPlatformGcm = true;
            if (System.Threading.Interlocked.Exchange(ref _fallbackLogged, 1) == 0)
                FallbackLog?.Invoke("platform AES-GCM unavailable (" + e.GetType().Name + ": " + e.Message + "); using managed AES-GCM");
        }

        /// <summary>iv (12) || ciphertext || tag (16), no associated data.</summary>
        public static byte[] GcmSeal(byte[] key, byte[] iv, byte[] plain)
        {
            if (!_noPlatformGcm)
            {
                try
                {
#pragma warning disable SYSLIB0053, CS0618
                    using var g = new AesGcm(key);
#pragma warning restore SYSLIB0053, CS0618
                    var ct = new byte[plain.Length];
                    var tag = new byte[16];
                    g.Encrypt(iv, plain, ct, tag);
                    return Join(iv, ct, tag);
                }
                catch (Exception e)
                {
                    // Any failure of the platform ctor or Encrypt (Mono throws assorted types) falls back to the managed GCM,
                    // which writes the same bytes, so this cannot change what goes on the wire.
                    PlatformGcmFailed(e);
                }
            }
            var m =ManagedGcm.Seal(key, iv, plain, out var mtag);
            return Join(iv, m, mtag);
        }

        /// <summary>Opens what <see cref="GcmSeal"/> made; null when the tag does not match or the input is too short.</summary>
        public static byte[]? GcmOpen(byte[] key, byte[] sealedBlob)
        {
            if (sealedBlob.Length < 12 + 16) return null;
            var iv = new byte[12];
            Buffer.BlockCopy(sealedBlob, 0, iv, 0, 12);
            var ct = new byte[sealedBlob.Length - 28];
            Buffer.BlockCopy(sealedBlob, 12, ct, 0, ct.Length);
            var tag = new byte[16];
            Buffer.BlockCopy(sealedBlob, sealedBlob.Length - 16, tag, 0, 16);
            if (!_noPlatformGcm)
            {
                try
                {
#pragma warning disable SYSLIB0053, CS0618
                    using var g = new AesGcm(key);
#pragma warning restore SYSLIB0053, CS0618
                    var plain = new byte[ct.Length];
                    g.Decrypt(iv, ct, tag, plain);
                    return plain;
                }
                catch (CryptographicException) { return null; }
                catch (Exception e)
                {
                    // A wrong tag is the CryptographicException above; anything else is the platform failing, not the data.
                    PlatformGcmFailed(e);
                }
            }
            return ManagedGcm.Open(key, iv, ct, tag);
        }

        /// <summary>For tests: the managed implementation by itself.</summary>
        internal static byte[] ManagedSeal(byte[] key, byte[] iv, byte[] plain)
        {
            var c = ManagedGcm.Seal(key, iv, plain, out var tag);
            return Join(iv, c, tag);
        }

        private static byte[] Join(byte[] a, byte[] b, byte[] c)
        {
            var r = new byte[a.Length + b.Length + c.Length];
            Buffer.BlockCopy(a, 0, r, 0, a.Length);
            Buffer.BlockCopy(b, 0, r, a.Length, b.Length);
            Buffer.BlockCopy(c, 0, r, a.Length + b.Length, c.Length);
            return r;
        }

        /// <summary>AES-GCM (NIST SP 800-38D) with a 96-bit IV and no AAD, over AES-ECB single blocks.</summary>
        private static class ManagedGcm
        {
            public static byte[] Seal(byte[] key, byte[] iv, byte[] plain, out byte[] tag)
            {
                using var aes = Aes.Create();
                aes.Key = key;
                aes.Mode = CipherMode.ECB;
                aes.Padding = PaddingMode.None;
                using var enc = aes.CreateEncryptor();
                var ct = Ctr(enc, iv, plain);
                tag = Tag(enc, iv, ct);
                return ct;
            }

            public static byte[]? Open(byte[] key, byte[] iv, byte[] ct, byte[] tag)
            {
                using var aes = Aes.Create();
                aes.Key = key;
                aes.Mode = CipherMode.ECB;
                aes.Padding = PaddingMode.None;
                using var enc = aes.CreateEncryptor();
                var expect = Tag(enc, iv, ct);
                var diff = 0;
                for (var i = 0; i < 16; i++) diff |= expect[i] ^ tag[i];
                return diff == 0 ? Ctr(enc, iv, ct) : null;
            }

            private static byte[] Block(ICryptoTransform enc, byte[] input)
            {
                var o = new byte[16];
                enc.TransformBlock(input, 0, 16, o, 0);
                return o;
            }

            private static byte[] Counter(byte[] iv, uint n)
            {
                var c = new byte[16];
                Buffer.BlockCopy(iv, 0, c, 0, 12);
                c[12] = (byte)(n >> 24); c[13] = (byte)(n >> 16); c[14] = (byte)(n >> 8); c[15] = (byte)n;
                return c;
            }

            private static byte[] Ctr(ICryptoTransform enc, byte[] iv, byte[] data)
            {
                var o = new byte[data.Length];
                uint n = 2;
                for (var i = 0; i < data.Length; i += 16, n++)
                {
                    var ks = Block(enc, Counter(iv, n));
                    var len = Math.Min(16, data.Length - i);
                    for (var j = 0; j < len; j++) o[i + j] = (byte)(data[i + j] ^ ks[j]);
                }
                return o;
            }

            private static byte[] Tag(ICryptoTransform enc, byte[] iv, byte[] ct)
            {
                var h = Block(enc, new byte[16]);
                ulong hh = ReadBE(h, 0), hl = ReadBE(h, 8);
                ulong yh = 0, yl = 0;
                for (var i = 0; i < ct.Length; i += 16)
                {
                    var blk = new byte[16];
                    Buffer.BlockCopy(ct, i, blk, 0, Math.Min(16, ct.Length - i));
                    yh ^= ReadBE(blk, 0); yl ^= ReadBE(blk, 8);
                    Mul(ref yh, ref yl, hh, hl);
                }
                // length block: len(AAD)=0 bits || len(C) in bits
                yl ^= (ulong)ct.Length * 8;
                Mul(ref yh, ref yl, hh, hl);
                var j0 = Block(enc, Counter(iv, 1));
                var t = new byte[16];
                WriteBE(t, 0, yh); WriteBE(t, 8, yl);
                for (var i = 0; i < 16; i++) t[i] ^= j0[i];
                return t;
            }

            /// <summary>Y = Y * H in GF(2^128), GCM bit order (the block's first bit is the x^0 coefficient).</summary>
            private static void Mul(ref ulong yh, ref ulong yl, ulong hh, ulong hl)
            {
                ulong zh = 0, zl = 0, vh = hh, vl = hl;
                for (var i = 0; i < 128; i++)
                {
                    var bit = i < 64 ? (yh >> (63 - i)) & 1 : (yl >> (127 - i)) & 1;
                    if (bit != 0) { zh ^= vh; zl ^= vl; }
                    var lsb = vl & 1;
                    vl = (vl >> 1) | (vh << 63);
                    vh >>= 1;
                    if (lsb != 0) vh ^= 0xe100000000000000UL;
                }
                yh = zh; yl = zl;
            }

            private static ulong ReadBE(byte[] b, int o)
            {
                ulong v = 0;
                for (var i = 0; i < 8; i++) v = (v << 8) | b[o + i];
                return v;
            }

            private static void WriteBE(byte[] b, int o, ulong v)
            {
                for (var i = 7; i >= 0; i--) { b[o + i] = (byte)v; v >>= 8; }
            }
        }
    }

    /// <summary>BIP340 Schnorr signatures over secp256k1 (x-only public keys), on <see cref="BigInteger"/> with Jacobian points.</summary>
    internal static class Schnorr
    {
        private static readonly BigInteger P = BigInteger.Parse("0FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F", System.Globalization.NumberStyles.HexNumber);
        private static readonly BigInteger N = BigInteger.Parse("0FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141", System.Globalization.NumberStyles.HexNumber);
        private static readonly BigInteger Gx = BigInteger.Parse("079BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798", System.Globalization.NumberStyles.HexNumber);
        private static readonly BigInteger Gy = BigInteger.Parse("0483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8", System.Globalization.NumberStyles.HexNumber);

        // Jacobian point (X, Y, Z); Z == 0 is infinity.
        private readonly struct Pt
        {
            public readonly BigInteger X, Y, Z;
            public Pt(BigInteger x, BigInteger y, BigInteger z) { X = x; Y = y; Z = z; }
            public bool IsInf => Z.IsZero;
        }

        private static readonly Pt Inf = new Pt(BigInteger.One, BigInteger.One, BigInteger.Zero);
        private static readonly Pt G = new Pt(Gx, Gy, BigInteger.One);

        private static BigInteger Mod(BigInteger a, BigInteger m)
        {
            var r = a % m;
            return r.Sign < 0 ? r + m : r;
        }

        private static BigInteger Inv(BigInteger a) => BigInteger.ModPow(Mod(a, P), P - 2, P);

        private static Pt Double(Pt a)
        {
            if (a.IsInf || a.Y.IsZero) return Inf;
            var ysq = Mod(a.Y * a.Y, P);
            var s = Mod(4 * a.X * ysq, P);
            var m = Mod(3 * a.X * a.X, P);
            var x = Mod(m * m - 2 * s, P);
            var y = Mod(m * (s - x) - 8 * ysq * ysq, P);
            var z = Mod(2 * a.Y * a.Z, P);
            return new Pt(x, y, z);
        }

        private static Pt Add(Pt a, Pt b)
        {
            if (a.IsInf) return b;
            if (b.IsInf) return a;
            var z1z1 = Mod(a.Z * a.Z, P);
            var z2z2 = Mod(b.Z * b.Z, P);
            var u1 = Mod(a.X * z2z2, P);
            var u2 = Mod(b.X * z1z1, P);
            var s1 = Mod(a.Y * b.Z * z2z2, P);
            var s2 = Mod(b.Y * a.Z * z1z1, P);
            if (u1 == u2) return s1 == s2 ? Double(a) : Inf;
            var h = Mod(u2 - u1, P);
            var r = Mod(s2 - s1, P);
            var h2 = Mod(h * h, P);
            var h3 = Mod(h * h2, P);
            var v = Mod(u1 * h2, P);
            var x = Mod(r * r - h3 - 2 * v, P);
            var y = Mod(r * (v - x) - s1 * h3, P);
            var z = Mod(h * a.Z * b.Z, P);
            return new Pt(x, y, z);
        }

        private static Pt Mul(Pt p, BigInteger k)
        {
            var r = Inf;
            var addend = p;
            while (!k.IsZero)
            {
                if (!k.IsEven) r = Add(r, addend);
                addend = Double(addend);
                k >>= 1;
            }
            return r;
        }

        private static void Affine(Pt p, out BigInteger x, out BigInteger y)
        {
            var zi = Inv(p.Z);
            var zi2 = Mod(zi * zi, P);
            x = Mod(p.X * zi2, P);
            y = Mod(p.Y * zi2 * zi, P);
        }

        private static byte[] Be32(BigInteger v)
        {
            var b = v.ToByteArray(); // little endian, maybe with a sign byte
            var r = new byte[32];
            for (var i = 0; i < 32 && i < b.Length; i++) r[31 - i] = b[i];
            return r;
        }

        private static BigInteger Int(byte[] be, int offset = 0, int len = 32)
        {
            var le = new byte[len + 1];
            for (var i = 0; i < len; i++) le[i] = be[offset + len - 1 - i];
            return new BigInteger(le);
        }

        private static byte[] Tagged(string tag, params byte[][] parts)
        {
            var th = NostrCrypto.Sha256(tag);
            var total = 64;
            foreach (var p in parts) total += p.Length;
            var buf = new byte[total];
            Buffer.BlockCopy(th, 0, buf, 0, 32);
            Buffer.BlockCopy(th, 0, buf, 32, 32);
            var o = 64;
            foreach (var p in parts) { Buffer.BlockCopy(p, 0, buf, o, p.Length); o += p.Length; }
            return NostrCrypto.Sha256(buf);
        }

        /// <summary>A fresh secret key: 32 random bytes in [1, n-1].</summary>
        public static byte[] NewSecretKey()
        {
            while (true)
            {
                var k = NostrCrypto.RandomBytes(32);
                var v = Int(k);
                if (!v.IsZero && v < N) return k;
            }
        }

        /// <summary>A fresh key pair whose public point has an even y, so signing needs one scalar multiplication, not two.</summary>
        public static void NewKeyPair(out byte[] secretKey, out byte[] publicKey)
        {
            var k = NewSecretKey();
            var d = Int(k);
            Affine(Mul(G, d), out var x, out var y);
            if (!y.IsEven) k = Be32(N - d);
            secretKey = k;
            publicKey = Be32(x);
        }

        /// <summary>The x-only public key (32 bytes) of a secret key.</summary>
        public static byte[] PublicKey(byte[] secretKey)
        {
            var d = Int(secretKey);
            if (d.IsZero || d >= N) throw new ArgumentException("secret key out of range", nameof(secretKey));
            Affine(Mul(G, d), out var x, out _);
            return Be32(x);
        }

        public static byte[] Sign(byte[] message, byte[] secretKey, byte[]? aux = null, byte[]? evenYPublicKey = null)
        {
            if (message.Length != 32) throw new ArgumentException("message must be 32 bytes", nameof(message));
            var d0 = Int(secretKey);
            if (d0.IsZero || d0 >= N) throw new ArgumentException("secret key out of range", nameof(secretKey));
            // the secret is negated when its public point has an odd y; with a known x-only key that is still one lift
            BigInteger px, py;
            if (evenYPublicKey != null) { px = Int(evenYPublicKey); py = LiftY(px); }
            else Affine(Mul(G, d0), out px, out py);
            var d = py.IsEven ? d0 : N - d0;
            var pk = Be32(px);
            var a = aux ?? NostrCrypto.RandomBytes(32);
            var t = Be32(d);
            var th = Tagged("BIP0340/aux", a);
            for (var i = 0; i < 32; i++) t[i] ^= th[i];
            var k0 = Mod(Int(Tagged("BIP0340/nonce", t, pk, message)), N);
            if (k0.IsZero) throw new CryptographicException("nonce is zero");
            Affine(Mul(G, k0), out var rx, out var ry);
            var k = ry.IsEven ? k0 : N - k0;
            var rb = Be32(rx);
            var e = Mod(Int(Tagged("BIP0340/challenge", rb, pk, message)), N);
            var s = Mod(k + e * d, N);
            var sig = new byte[64];
            Buffer.BlockCopy(rb, 0, sig, 0, 32);
            Buffer.BlockCopy(Be32(s), 0, sig, 32, 32);
            return sig;
        }

        private static BigInteger LiftY(BigInteger x)
        {
            var y2 = Mod(BigInteger.ModPow(x, 3, P) + 7, P);
            var y = BigInteger.ModPow(y2, (P + 1) / 4, P);
            return y.IsEven ? y : P - y;
        }

        public static bool Verify(byte[] message, byte[] publicKey, byte[] sig)
        {
            if (message.Length != 32 || publicKey.Length != 32 || sig.Length != 64) return false;
            var px = Int(publicKey);
            if (px >= P) return false;
            var r = Int(sig, 0);
            var s = Int(sig, 32);
            if (r >= P || s >= N) return false;
            var y2 = Mod(BigInteger.ModPow(px, 3, P) + 7, P);
            var py = BigInteger.ModPow(y2, (P + 1) / 4, P);
            if (Mod(py * py, P) != y2) return false;
            if (!py.IsEven) py = P - py;
            var e = Mod(Int(Tagged("BIP0340/challenge", Be32(r), publicKey, message)), N);
            var sg = Mul(G, s);
            var ep = Mul(new Pt(px, py, BigInteger.One), Mod(N - e, N));
            var res = Add(sg, ep);
            if (res.IsInf) return false;
            Affine(res, out var rx, out var ry);
            return ry.IsEven && rx == r;
        }
    }
}
