using Xunit;

namespace OneLobby.Tests;

/// <summary>The relay-only candidate test and SDP filter shared by the C# transports.</summary>
public class RelayCandidatesTests
{
    private const string Host = "a=candidate:1 1 UDP 2122 10.0.0.1 5000 typ host";
    private const string Relay = "a=candidate:2 1 UDP 100 1.2.3.4 6000 typ relay raddr 0.0.0.0 rport 0";

    [Fact]
    public void Only_typ_relay_counts()
    {
        Assert.True(RelayCandidates.IsRelay(Relay));
        Assert.False(RelayCandidates.IsRelay(Host));
        Assert.False(RelayCandidates.IsRelay("candidate:3 1 UDP 1 5.5.5.5 1 typ srflx raddr 1.1.1.1 rport 1"));
    }

    [Fact]
    public void FilterSdp_drops_non_relay_candidate_lines_and_keeps_the_rest_and_the_line_endings()
    {
        var sdp = string.Join("\r\n", "v=0", Host, Relay, "a=mid:0", "");
        Assert.Equal(string.Join("\r\n", "v=0", Relay, "a=mid:0", ""), RelayCandidates.FilterSdp(sdp));
        Assert.Equal("v=0\na=mid:0\n", RelayCandidates.FilterSdp("v=0\n" + Host + "\na=mid:0\n"));
        Assert.Equal("", RelayCandidates.FilterSdp(""));
        Assert.Null(RelayCandidates.FilterSdp(null!));
    }
}
