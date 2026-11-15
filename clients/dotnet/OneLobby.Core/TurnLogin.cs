using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Security.Cryptography;
using System.Text;

namespace OneLobby
{
    /// <summary>
    /// TURN logins in the coturn shared-secret scheme (spec/turn-rest.md, vectors in spec/vectors/turn-rest.json): username =
    /// <c>"&lt;expiry unix seconds&gt;:&lt;userId&gt;"</c>, credential = base64(HMAC-SHA1(secret, username)). For a TURN server that hands
    /// out logins this way, mint one per session and give it to <c>DirectHostOptions.IceServers</c>:
    /// <code>
    /// var (user, cred) = TurnLogin.Mint(secret, "p1", TimeSpan.FromHours(6));
    /// options.IceServers = new[] { new IceServer(new[] { "turn:turn.example.com:3478" }, user, cred) };
    /// </code>
    /// The secret ships inside your game, so anyone with the build can mint logins: use a server whose secret you may
    /// share, or one with a spend cap.
    /// </summary>
    public static class TurnLogin
    {
        /// <summary>A login valid for <paramref name="ttl"/> from <paramref name="now"/> (null = the system clock). A <c>:</c> in <paramref name="userId"/> is dropped.</summary>
        public static (string Username, string Credential) Mint(string secret, string userId, TimeSpan ttl, DateTimeOffset? now = null)
            => Mint(secret, userId, (long)ttl.TotalSeconds, (now ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds());

        /// <summary>As above, in unix seconds: expiry = <paramref name="nowSeconds"/> + <paramref name="ttlSeconds"/>.</summary>
        public static (string Username, string Credential) Mint(string secret, string userId, long ttlSeconds, long nowSeconds)
        {
            if (secret == null) throw new ArgumentNullException(nameof(secret));
            var username = (nowSeconds + ttlSeconds).ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + (userId ?? "").Replace(":", "");
            return (username, Credential(secret, username));
        }

        /// <summary>base64(HMAC-SHA1(secret, username)), both as UTF-8.</summary>
        public static string Credential(string secret, string username)
        {
            using (var h = new HMACSHA1(Encoding.UTF8.GetBytes(secret)))
                return Convert.ToBase64String(h.ComputeHash(Encoding.UTF8.GetBytes(username)));
        }

        static readonly Regex IceUrl = new Regex(@"^(stuns?|turns?):[^\s?]+(\?\S*)?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        static readonly Regex TurnUrl = new Regex(@"^turns?:", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        /// <summary>
        /// Turn what a player pastes into a "my TURN relay" settings field into one ice server entry. Format: the URL, the username,
        /// the credential, split on any whitespace (<c>turn:relay.example.com:3478 alice s3cret</c>), or a JSON object
        /// <c>{"urls": ..., "username": ..., "credential": ...}</c>. <c>turn:</c>/<c>turns:</c> need both username and credential;
        /// <c>stun:</c>/<c>stuns:</c> need none. Throws <see cref="FormatException"/> with a message fit to show the player.
        /// Vectors: spec/vectors/turn-paste.json. Add the result after the host's entries in <c>IceServers</c>; never commit what the player typed.
        /// </summary>
        public static IceServer Parse(string? text)
        {
            if (!TryParse(text, out var server, out var error)) throw new FormatException(error);
            return server!;
        }

        /// <summary>As <see cref="Parse"/>, without the exception: false and a message in <paramref name="error"/>.</summary>
        public static bool TryParse(string? text, out IceServer? server, out string? error)
        {
            server = null;
            error = null;
            var t = (text ?? "").Trim();
            if (t.Length == 0) { error = "Paste a relay as: turn:host:3478 username credential"; return false; }
            List<string> urls;
            string? username, credential;
            if (t.StartsWith("{", StringComparison.Ordinal))
            {
                try
                {
                    using var doc = JsonDocument.Parse(t);
                    var o = doc.RootElement;
                    urls = new List<string>();
                    if (o.ValueKind == JsonValueKind.Object && o.TryGetProperty("urls", out var u))
                    {
                        if (u.ValueKind == JsonValueKind.String) urls.Add(u.GetString()!);
                        else if (u.ValueKind == JsonValueKind.Array) urls.AddRange(u.EnumerateArray().Select(x => x.ToString()));
                    }
                    username = Str(o, "username");
                    credential = Str(o, "credential");
                }
                catch (JsonException) { error = "That is not valid JSON. Paste a relay as: turn:host:3478 username credential"; return false; }
                if (urls.Count == 0) { error = "The JSON needs \"urls\" (a turn: or stun: URL, or a list of them)."; return false; }
            }
            else
            {
                var parts = Regex.Split(t, @"\s+");
                if (parts.Length > 3) { error = "Too many parts. Use: URL username credential (the credential cannot contain spaces)."; return false; }
                urls = new List<string> { parts[0] };
                username = parts.Length > 1 ? parts[1] : null;
                credential = parts.Length > 2 ? parts[2] : null;
            }
            foreach (var u in urls)
                if (!IceUrl.IsMatch(u)) { error = "\"" + u + "\" is not a stun:, stuns:, turn: or turns: URL (for example turn:relay.example.com:3478)."; return false; }
            if (urls.Any(u => TurnUrl.IsMatch(u)) && (string.IsNullOrEmpty(username) || string.IsNullOrEmpty(credential)))
            { error = "A turn: relay needs a username and a credential after the URL: turn:host:3478 username credential"; return false; }
            server = new IceServer(urls, username, credential);
            return true;
        }

        static string? Str(JsonElement o, string name)
        {
            if (o.ValueKind != JsonValueKind.Object || !o.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.String) return null;
            var s = v.GetString();
            return string.IsNullOrEmpty(s) ? null : s;
        }
    }
}
