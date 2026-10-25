using System.Threading.Tasks;
using OneLobby.Direct;
using Xunit;

namespace OneLobby.DataChannel.Tests;

public class BlueprintDirectTests
{
    [Fact]
    public void ToDirectHostOptionsMapsHostingAndLobby()
    {
        var bp = Blueprint.Parse(@"{ ""game"": {""id"":""a""}, ""hosting"": {""directPort"":47812,""openPort"":false,""allowedOrigins"":[""https://a.test""]},
            ""lobby"": {""maxPlayers"":5,""lateJoin"":false,""meta"":{""k"":""v""}}, ""session"": {""rateLimit"":{""messages"":30,""perMs"":500}} }");
        var o = bp.ToDirectHostOptions(displayName: "Ann");
        Assert.Equal(47812, o.Port);
        Assert.Equal(DirectLobby.DefaultFallbackPorts, o.FallbackPorts);
        Assert.False(o.OpenPort);
        Assert.Equal(new[] { "https://a.test" }, o.AllowedOrigins);
        Assert.Equal(5, o.MaxPlayers);
        Assert.False(o.LateJoin);
        Assert.Equal("v", o.Meta!["k"]);
        Assert.Equal("Ann's game", o.Name);
        Assert.Equal(new RateLimit(30, 500), o.RateLimit);
    }

    [Fact]
    public async Task HostDirectAsyncRefusesABlueprintWithDirectOff()
    {
        var bp = Blueprint.Parse(@"{ ""game"": {""id"":""a""}, ""hosting"": {""direct"":false,""server"":true,""lobbyServer"":""ws://x.test/ws""} }");
        var client = LobbyClient.FromBlueprint(bp, new InMemoryNetwork().CreateTransport(), "Ann");
        var ex = await Assert.ThrowsAsync<BlueprintException>(() => client.HostDirectAsync());
        Assert.Equal("bad_config", ex.Code);
    }
}
