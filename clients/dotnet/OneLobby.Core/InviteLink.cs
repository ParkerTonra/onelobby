using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;

namespace OneLobby
{
    /// <summary>
    /// Invite links: a web address that opens a game straight into a lobby, e.g. <c>https://game.example/?join=7HQ-4K2</c>.
    /// Same format and behaviour as the JS client's <c>shareUrl</c> / <c>codeFromUrl</c> (spec/vectors/invite-link.json is the
    /// shared test). Only the lobby code of a server lobby travels in a link; registering the link with the operating
    /// system (a deep link) is the game's job. Nothing here touches the network.
    /// </summary>
    public static class InviteLink
    {
        private static readonly Regex Absolute = new Regex(@"^(https?)://([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$",
            RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.CultureInvariant);

        /// <summary>
        /// A link that opens the game into lobby <paramref name="code"/>: <paramref name="baseUrl"/> (an absolute http or https
        /// address) with any existing <paramref name="param"/> replaced by the code in display form with a hyphen
        /// (<c>7HQ-4K2</c>), so the link survives chat apps that turn a space into <c>+</c> or <c>%20</c>. The fragment is kept.
        /// Throws <see cref="ArgumentException"/> for a code that is not a lobby code or a base that is not absolute http(s).
        /// </summary>
        public static string Make(string code, string baseUrl, string param = "join")
        {
            var norm = Crockford.Normalize(code) ?? throw new ArgumentException("\"" + code + "\" is not a valid lobby code", nameof(code));
            var m = Absolute.Match(Trim(baseUrl ?? ""));
            if (!m.Success) throw new ArgumentException("\"" + baseUrl + "\" is not an absolute http(s) address", nameof(baseUrl));
            var pairs = ParseQuery(m.Groups[4].Success ? m.Groups[4].Value : "");
            pairs.RemoveAll(p => p.Key == param);
            pairs.Add(new KeyValuePair<string, string>(param, Crockford.Format(norm).Replace(' ', '-')));
            var path = m.Groups[3].Value.Length == 0 ? "/" : m.Groups[3].Value;
            var fragment = m.Groups[5].Success ? "#" + m.Groups[5].Value : "";
            return m.Groups[1].Value.ToLowerInvariant() + "://" + m.Groups[2].Value.ToLowerInvariant() + path + "?" + SerializeQuery(pairs) + fragment;
        }

        /// <summary>
        /// The lobby code (canonical form, <c>7HQ4K2</c>) carried by a pasted link, or null when there is none or it is not
        /// a code. Reads the first <paramref name="param"/> entry of the query, else (only when the query has no such key)
        /// of the fragment; <c>+</c> and <c>%20</c> are spaces, case and i / l / o look-alikes are forgiven, surrounding
        /// whitespace is trimmed. A relative link (<c>?join=...</c>) works too. Nothing else is cleaned: a trailing dot or
        /// angle brackets make the code invalid.
        /// </summary>
        public static string? Parse(string? text, string param = "join")
        {
            if (string.IsNullOrEmpty(text)) return null;
            var s = Trim(text!);
            var hash = s.IndexOf('#');
            var fragment = hash >= 0 ? s.Substring(hash + 1) : "";
            var before = hash >= 0 ? s.Substring(0, hash) : s;
            var q = before.IndexOf('?');
            var query = q >= 0 ? before.Substring(q + 1) : "";
            var v = First(ParseQuery(query), param) ?? First(ParseQuery(fragment), param);
            return string.IsNullOrEmpty(v) ? null : Crockford.Normalize(v);
        }

        private static string? First(List<KeyValuePair<string, string>> pairs, string key)
        {
            foreach (var p in pairs) if (p.Key == key) return p.Value;
            return null;
        }

        /// <summary>What a URL parser does with its input: drop surrounding control characters and spaces, and tabs and line breaks anywhere.</summary>
        private static string Trim(string s)
        {
            var sb = new StringBuilder(s.Length);
            foreach (var c in s) if (c != '\t' && c != '\r' && c != '\n') sb.Append(c);
            var t = sb.ToString();
            int a = 0, b = t.Length;
            while (a < b && t[a] <= ' ') a++;
            while (b > a && t[b - 1] <= ' ') b--;
            return t.Substring(a, b - a);
        }

        // application/x-www-form-urlencoded, as URLSearchParams reads and writes it
        private static List<KeyValuePair<string, string>> ParseQuery(string q)
        {
            var list = new List<KeyValuePair<string, string>>();
            foreach (var seg in q.Split('&'))
            {
                if (seg.Length == 0) continue;
                var eq = seg.IndexOf('=');
                var k = eq >= 0 ? seg.Substring(0, eq) : seg;
                var v = eq >= 0 ? seg.Substring(eq + 1) : "";
                list.Add(new KeyValuePair<string, string>(Decode(k), Decode(v)));
            }
            return list;
        }

        private static string Decode(string s)
        {
            var bytes = new List<byte>(s.Length);
            for (var i = 0; i < s.Length; i++)
            {
                var c = s[i];
                if (c == '+') bytes.Add((byte)' ');
                else if (c == '%' && i + 2 < s.Length && Hex(s[i + 1]) >= 0 && Hex(s[i + 2]) >= 0)
                {
                    bytes.Add((byte)(Hex(s[i + 1]) * 16 + Hex(s[i + 2])));
                    i += 2;
                }
                else bytes.AddRange(Encoding.UTF8.GetBytes(c.ToString()));
            }
            return Encoding.UTF8.GetString(bytes.ToArray());
        }

        private static int Hex(char c) => c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;

        private static string SerializeQuery(List<KeyValuePair<string, string>> pairs)
        {
            var sb = new StringBuilder();
            foreach (var p in pairs)
            {
                if (sb.Length > 0) sb.Append('&');
                Encode(sb, p.Key);
                sb.Append('=');
                Encode(sb, p.Value);
            }
            return sb.ToString();
        }

        private static void Encode(StringBuilder sb, string s)
        {
            foreach (var b in Encoding.UTF8.GetBytes(s))
            {
                var c = (char)b;
                if (c == ' ') sb.Append('+');
                else if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '*' || c == '-' || c == '.' || c == '_') sb.Append(c);
                else sb.Append('%').Append("0123456789ABCDEF"[b >> 4]).Append("0123456789ABCDEF"[b & 15]);
            }
        }
    }
}
