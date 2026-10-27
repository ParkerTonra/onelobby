using Xunit;

namespace OneLobby.DataChannel.Tests;

/// <summary>The remote IP read from the selected candidate (used to ban an address, not only a signaling identity).</summary>
public class RemoteAddressTests
{
    [Theory]
    [InlineData("a=candidate:1 1 UDP 2122252543 203.0.113.5 54321 typ srflx raddr 0.0.0.0 rport 0", "203.0.113.5")]
    [InlineData("candidate:2 1 UDP 2122 192.168.1.9 50000 typ host", "192.168.1.9")]
    [InlineData("candidate:3 1 UDP 2122 2001:db8::1 50000 typ host", "2001:db8::1")]
    [InlineData("candidate:4 1 UDP 2122 ::ffff:198.51.100.2 50000 typ host", "198.51.100.2")]
    [InlineData("candidate:5 1 UDP 2122 0a1b2c3d-1111-2222-3333-444455556666.local 50000 typ host", null)]
    [InlineData("candidate:6 1 UDP 2122 203.0.113.50 50000 typ relay raddr 1.2.3.4 rport 5", null)]
    [InlineData("", null)]
    [InlineData(null, null)]
    public void ParseRemoteAddress(string? candidate, string? expected) =>
        Assert.Equal(expected, DataChannelPeerLink.ParseRemoteAddress(candidate));
}
