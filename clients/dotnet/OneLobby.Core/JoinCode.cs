using System;
using System.Globalization;

namespace OneLobby
{
    /// <summary>
    /// <c>dc1</c> join codes (docs/direct-ip.md s.2a, spec/reference/joincode.mjs): a direct-IP host's IPv4 address and
    /// port in 11 Crockford characters, shown <c>K3J7-X9QA-2MT</c>. The code is the address in disguise, so decoding
    /// needs nothing outside the game. Bits, most significant first: version:2 (0 = IPv4) | ipv4:32 | port:16 | crc:5,
    /// CRC-5 with polynomial 0x05 over the 50 bits before it, which catches every single mistyped character.
    /// </summary>
    public static class JoinCode
    {
        public const int Length = 11;

        /// <summary>Canonical code without hyphens.</summary>
        public static string EncodeRaw(uint ipv4, int port)
        {
            if (port < 1 || port > 65535) throw new ArgumentOutOfRangeException(nameof(port));
            ulong data = ((ulong)ipv4 << 16) | (uint)port; // version 0
            ulong v = (data << 5) | Crc5(data, 50);
            var chars = new char[Length];
            for (var i = Length - 1; i >= 0; i--) { chars[i] = Crockford.Alphabet[(int)(v & 31)]; v >>= 5; }
            return new string(chars);
        }

        /// <summary>Display form for an IPv4 address in dotted form, e.g. <c>6B01-RGFE-P2B</c>.</summary>
        public static string Encode(string ipv4, int port)
        {
            if (!TryParseIPv4(ipv4, out var ip)) throw new ArgumentException("not an IPv4 address: " + ipv4, nameof(ipv4));
            return Group(EncodeRaw(ip, port));
        }

        /// <summary>
        /// Version 1 (spec/nostr-signaling.md s.1): <c>version:2 = 1 | room:48 | crc:5</c>. <paramref name="room"/> is the
        /// 48-bit random room; the result is grouped, e.g. <c>XXXX-XXXX-XXX</c>.
        /// </summary>
        public static string EncodeRoom(ulong room)
        {
            if (room >> 48 != 0) throw new ArgumentOutOfRangeException(nameof(room), "a room is 48 bits");
            ulong data = (1UL << 48) | room;
            ulong v = (data << 5) | Crc5(data, 50);
            var chars = new char[Length];
            for (var i = Length - 1; i >= 0; i--) { chars[i] = Crockford.Alphabet[(int)(v & 31)]; v >>= 5; }
            return Group(new string(chars));
        }

        /// <summary>
        /// Decodes a version 1 (Nostr) code to its 12 lower-case hex digit room. False for anything else; use
        /// <see cref="TryDecode"/> for version 0 codes (it answers <c>unknown_version</c> for version 1).
        /// </summary>
        public static bool TryDecodeRoom(string? input, out string roomHex)
        {
            roomHex = "";
            var s = Normalize(input);
            if (s == null) return false;
            ulong v = 0;
            foreach (var c in s) v = (v << 5) | (uint)Crockford.Alphabet.IndexOf(c);
            var data = v >> 5;
            if (Crc5(data, 50) != (v & 31) || (data >> 48) != 1) return false;
            roomHex = (data & 0xffffffffffffUL).ToString("x12", CultureInfo.InvariantCulture);
            return true;
        }

        /// <summary><c>6B01RGFEP2B</c> -> <c>6B01-RGFE-P2B</c>.</summary>
        public static string Group(string raw) => raw.Substring(0, 4) + "-" + raw.Substring(4, 4) + "-" + raw.Substring(8);

        /// <summary>Upper case, spaces and hyphens dropped, i/l -> 1, o -> 0; null unless 11 alphabet characters.</summary>
        public static string? Normalize(string? input)
        {
            if (input == null) return null;
            var chars = new char[Length];
            var n = 0;
            foreach (var raw in input)
            {
                if (raw == ' ' || raw == '-') continue;
                var c = raw >= 'a' && raw <= 'z' ? (char)(raw - 32) : raw;
                if (c == 'I' || c == 'L') c = '1';
                else if (c == 'O') c = '0';
                if (Crockford.Alphabet.IndexOf(c) < 0 || n == Length) return null;
                chars[n++] = c;
            }
            return n == Length ? new string(chars) : null;
        }

        /// <summary>
        /// Decodes a code to <c>ip</c> (dotted IPv4) and <c>port</c>. On failure <paramref name="error"/> is
        /// <c>bad_code</c> (malformed or a typo) or <c>unknown_version</c> (a newer kind of code).
        /// </summary>
        public static bool TryDecode(string? input, out string ip, out int port, out string? error)
        {
            ip = ""; port = 0; error = "bad_code";
            var s = Normalize(input);
            if (s == null) return false;
            ulong v = 0;
            foreach (var c in s) v = (v << 5) | (uint)Crockford.Alphabet.IndexOf(c);
            var data = v >> 5;
            if (Crc5(data, 50) != (v & 31)) return false;
            if ((data >> 48) != 0) { error = "unknown_version"; return false; }
            port = (int)(data & 0xffff);
            if (port == 0) return false;
            var a = (uint)(data >> 16);
            ip = (a >> 24).ToString(CultureInfo.InvariantCulture) + "." + ((a >> 16) & 255).ToString(CultureInfo.InvariantCulture) + "."
                 + ((a >> 8) & 255).ToString(CultureInfo.InvariantCulture) + "." + (a & 255).ToString(CultureInfo.InvariantCulture);
            error = null;
            return true;
        }

        /// <summary>
        /// True when the input is shaped like a join code (11 alphabet characters once separators go, no dots or colons),
        /// so a failed decode should say <c>bad_code</c> rather than be tried as a host name.
        /// </summary>
        public static bool LooksLikeCode(string? input) =>
            input != null && input.IndexOf('.') < 0 && input.IndexOf(':') < 0 && Normalize(input) != null;

        private static ulong Crc5(ulong value, int bits)
        {
            uint crc = 0;
            for (var i = bits - 1; i >= 0; i--)
            {
                var bit = (uint)(value >> i) & 1;
                var top = (crc >> 4) & 1;
                crc = (crc << 1) & 0x1f;
                if ((top ^ bit) != 0) crc ^= 0x05;
            }
            return crc;
        }

        private static bool TryParseIPv4(string s, out uint ip)
        {
            ip = 0;
            var parts = s.Split('.');
            if (parts.Length != 4) return false;
            foreach (var p in parts)
            {
                if (!byte.TryParse(p, NumberStyles.None, CultureInfo.InvariantCulture, out var b)) return false;
                ip = (ip << 8) | b;
            }
            return true;
        }
    }
}
