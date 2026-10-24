using System.Security.Cryptography;
using System.Text;

namespace Keepalive.Server;

/// <summary>TURN REST credentials (draft-uberti-behave-turn-rest, coturn use-auth-secret). DESIGN s.10.</summary>
public static class TurnCredentials
{
    public static (string Username, string Credential) Mint(string secret, long expiryUnixSeconds, string peerId)
    {
        string username = expiryUnixSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + peerId;
        return (username, Sign(secret, username));
    }

    public static string Sign(string secret, string username)
    {
        byte[] mac = HMACSHA1.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(username));
        return Convert.ToBase64String(mac);
    }
}
