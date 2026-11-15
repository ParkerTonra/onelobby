using System;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace OneLobby.Tests
{
    /// <summary>TurnLogin against spec/vectors/turn-rest.json, the vectors the server and the other clients use.</summary>
    public class TurnLoginTests
    {
        [Fact]
        public void Credential_matches_every_vector()
        {
            using var doc = Spec.Load("vectors/turn-rest.json");
            foreach (var v in doc.RootElement.GetProperty("vectors").EnumerateArray())
                Assert.Equal(v.GetProperty("credential").GetString(), TurnLogin.Credential(v.GetProperty("secret").GetString()!, v.GetProperty("username").GetString()!));
        }

        [Fact]
        public void Mint_matches_the_pinned_login()
        {
            using var doc = Spec.Load("vectors/turn-rest.json");
            var m = doc.RootElement.GetProperty("mint");
            var (user, cred) = TurnLogin.Mint(m.GetProperty("secret").GetString()!, m.GetProperty("userId").GetString()!, m.GetProperty("ttl").GetInt64(), m.GetProperty("nowSeconds").GetInt64());
            Assert.Equal(m.GetProperty("expectUsername").GetString(), user);
            Assert.Equal(m.GetProperty("expectCredential").GetString(), cred);
            var (u2, c2) = TurnLogin.Mint(m.GetProperty("secret").GetString()!, m.GetProperty("userId").GetString()!, TimeSpan.FromSeconds(m.GetProperty("ttl").GetInt64()), DateTimeOffset.FromUnixTimeSeconds(m.GetProperty("nowSeconds").GetInt64()));
            Assert.Equal((user, cred), (u2, c2));
        }

        [Fact]
        public void Colons_in_the_user_id_are_dropped_and_the_clock_is_the_default()
        {
            Assert.Equal("160:ab", TurnLogin.Mint("s", "a:b", 60, 100).Username);
            var (u, _) = TurnLogin.Mint("s", "p", TimeSpan.FromMinutes(1));
            Assert.True(long.Parse(u.Split(':')[0]) > DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        }

        [Fact]
        public void Parse_matches_the_paste_vectors()
        {
            using var doc = Spec.Load("vectors/turn-paste.json");
            foreach (var c in doc.RootElement.GetProperty("cases").EnumerateArray())
            {
                var input = c.GetProperty("input").GetString()!;
                var ok = TurnLogin.TryParse(input, out var s, out var err);
                if (c.TryGetProperty("error", out _))
                {
                    Assert.False(ok, input);
                    Assert.False(string.IsNullOrEmpty(err));
                    Assert.Throws<FormatException>(() => TurnLogin.Parse(input));
                    continue;
                }
                Assert.True(ok, input + " -> " + err);
                var e = c.GetProperty("ok");
                Assert.Equal(e.GetProperty("urls").EnumerateArray().Select(x => x.GetString()), s!.Urls);
                Assert.Equal(e.TryGetProperty("username", out var u) ? u.GetString() : null, s.Username);
                Assert.Equal(e.TryGetProperty("credential", out var cr) ? cr.GetString() : null, s.Credential);
            }
        }
    }
}
