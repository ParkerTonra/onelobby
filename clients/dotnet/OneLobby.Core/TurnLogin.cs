using System;
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
    }
}
