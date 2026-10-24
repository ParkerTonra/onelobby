using System;
using System.Text;

namespace OneLobby
{
    /// <summary>Crockford Base32 join codes (DESIGN s.6): no I L O U, case-insensitive, i/l -> 1, o -> 0.</summary>
    public static class Crockford
    {
        public const string Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        public const int CodeLength = 6;

        /// <summary>Normalises user input ("7hq 4k2", "7HQ-4K2") to the canonical upper-case code, or null if invalid.</summary>
        public static string? Normalize(string? input)
        {
            if (input == null) return null;
            var sb = new StringBuilder(CodeLength);
            foreach (var raw in input)
            {
                if (raw == ' ' || raw == '-') continue;
                var c = raw >= 'a' && raw <= 'z' ? (char)(raw - 32) : raw;
                if (c == 'I' || c == 'L') c = '1';
                else if (c == 'O') c = '0';
                if (Alphabet.IndexOf(c) < 0) return null;
                sb.Append(c);
            }
            return sb.Length == CodeLength ? sb.ToString() : null;
        }

        public static bool TryNormalize(string? input, out string code)
        {
            var n = Normalize(input);
            code = n ?? "";
            return n != null;
        }

        /// <summary>"7HQ4K2" -> "7HQ 4K2".</summary>
        public static string Format(string code)
        {
            var n = Normalize(code) ?? code;
            return n.Length == CodeLength ? n.Substring(0, 3) + " " + n.Substring(3) : n;
        }

        /// <summary>The 30-bit value of a code (6 x 5 bits, first character most significant).</summary>
        public static uint ToValue(string code)
        {
            var n = Normalize(code) ?? throw new ArgumentException("not a join code: " + code, nameof(code));
            uint v = 0;
            foreach (var c in n) v = (v << 5) | (uint)Alphabet.IndexOf(c);
            return v;
        }

        public static string FromValue(uint value)
        {
            var chars = new char[CodeLength];
            for (var i = CodeLength - 1; i >= 0; i--) { chars[i] = Alphabet[(int)(value & 31)]; value >>= 5; }
            return new string(chars);
        }
    }
}
