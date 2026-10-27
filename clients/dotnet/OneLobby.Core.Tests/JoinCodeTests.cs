using System.Text.Json;
using Xunit;

namespace OneLobby.Tests
{
    /// <summary>dc1 join codes against spec/vectors/joincode.json (docs/design/direct-ip.md s.2a).</summary>
    public class JoinCodeTests
    {
        private static JsonDocument Vectors() => Spec.Load("vectors/joincode.json");

        [Fact]
        public void ValidVectorsEncodeAndDecode()
        {
            using var doc = Vectors();
            foreach (var v in doc.RootElement.GetProperty("valid").EnumerateArray())
            {
                var ip = v.GetProperty("ip").GetString()!;
                var port = v.GetProperty("port").GetInt32();
                var code = v.GetProperty("code").GetString()!;
                Assert.Equal(code, JoinCode.Encode(ip, port));
                Assert.True(JoinCode.TryDecode(code, out var dip, out var dport, out var err), code + ": " + err);
                Assert.Equal(ip, dip);
                Assert.Equal(port, dport);
            }
        }

        [Fact]
        public void AliasesDecode()
        {
            using var doc = Vectors();
            foreach (var v in doc.RootElement.GetProperty("aliases").EnumerateArray())
            {
                Assert.True(JoinCode.TryDecode(v.GetProperty("input").GetString(), out var ip, out var port, out _));
                Assert.Equal(v.GetProperty("ip").GetString(), ip);
                Assert.Equal(v.GetProperty("port").GetInt32(), port);
            }
        }

        [Fact]
        public void InvalidVectorsFailWithTheirError()
        {
            using var doc = Vectors();
            foreach (var v in doc.RootElement.GetProperty("invalid").EnumerateArray())
            {
                Assert.False(JoinCode.TryDecode(v.GetProperty("input").GetString(), out _, out _, out var err));
                Assert.Equal(v.GetProperty("error").GetString(), err);
            }
        }

        [Fact]
        public void EverySingleCharacterTypoIsCaught()
        {
            using var doc = Vectors();
            var typos = doc.RootElement.GetProperty("singleTypos");
            var n = 0;
            foreach (var t in typos.GetProperty("inputs").EnumerateArray())
            {
                Assert.False(JoinCode.TryDecode(t.GetString(), out _, out _, out _), t.GetString());
                n++;
            }
            Assert.Equal(11 * 31, n);
        }

        [Fact]
        public void LooksLikeCodeTellsCodesFromAddresses()
        {
            Assert.True(JoinCode.LooksLikeCode("6B01-RGFE-P2B"));
            Assert.True(JoinCode.LooksLikeCode("6b01 rgfe p2x")); // a typo still looks like a code: bad_code, not a host name
            Assert.False(JoinCode.LooksLikeCode("192.168.1.20"));
            Assert.False(JoinCode.LooksLikeCode("[::1]:47810"));
            Assert.False(JoinCode.LooksLikeCode("mypc"));
        }
    }
}
