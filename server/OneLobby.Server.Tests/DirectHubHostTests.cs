using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;

namespace OneLobby.Server.Tests;

/// <summary>The in-game listener (docs/direct-ip.md s.5 step 3) over real loopback TCP.</summary>
public class DirectHubHostTests
{
    [Fact]
    public void Accept_key_matches_rfc6455_example()
    {
        // RFC 6455 s.1.3
        Assert.Equal("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", DirectHubHost.AcceptKey("dGhlIHNhbXBsZSBub25jZQ=="));
    }

    private static async Task<JsonObject> Next(ClientWebSocket ws)
    {
        var buf = new byte[16384];
        using var cts = new CancellationTokenSource(5000);
        var r = await ws.ReceiveAsync(buf, cts.Token);
        return (JsonObject)JsonNode.Parse(Encoding.UTF8.GetString(buf, 0, r.Count))!;
    }

    private static Task Send(ClientWebSocket ws, string json) =>
        ws.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, true, CancellationToken.None);

    private static async Task<ClientWebSocket> Hello(int port, string name)
    {
        var ws = new ClientWebSocket();
        await ws.ConnectAsync(new Uri($"ws://127.0.0.1:{port}/"), CancellationToken.None);
        await Send(ws, $"{{\"t\":\"hello\",\"proto\":\"lk1\",\"gameId\":\"g\",\"netVersion\":\"1\",\"name\":\"{name}\"}}");
        Assert.Equal("welcome", (string?)(await Next(ws))["t"]);
        return ws;
    }

    [Fact]
    public async Task Websocket_joiner_reaches_the_embedded_hub()
    {
        using var host = new DirectHubHost(0, HubOptions.ForDirect(4, "pw"));
        Assert.True(host.Port > 0);
        using var h = await Hello(host.Port, "Host");
        await Send(h, "{\"t\":\"create\",\"name\":\"L\",\"maxPlayers\":4,\"visibility\":\"unlisted\",\"mode\":\"raw\"}");
        var lobby = await Next(h);
        Assert.Equal("lobby", (string?)lobby["t"]);
        Assert.Equal("", (string?)lobby["code"]);

        using var j = await Hello(host.Port, "Joe");
        await Send(j, "{\"t\":\"join\",\"password\":\"nope\"}");
        Assert.Equal("bad_password", (string?)(await Next(j))["code"]);
        await Send(j, "{\"t\":\"join\",\"password\":\"pw\"}");
        var joined = await Next(j);
        Assert.Equal("lobby", (string?)joined["t"]);
        Assert.Equal(2, (int)joined["you"]!);
        Assert.Equal("peer_joined", (string?)(await Next(h))["t"]);
        Assert.Equal(2, host.ConnectionCount);
        Assert.Equal(2, host.Hub.SocketCount);
    }

    [Fact]
    public async Task Dispose_closes_joiner_sockets()
    {
        var host = new DirectHubHost(0, HubOptions.ForDirect(4, null));
        using var j = await Hello(host.Port, "Joe");
        host.Dispose();
        var buf = new byte[256];
        using var cts = new CancellationTokenSource(5000);
        try
        {
            var r = await j.ReceiveAsync(buf, cts.Token);
            Assert.Equal(WebSocketMessageType.Close, r.MessageType);
        }
        catch (WebSocketException) { /* cut before the close frame: also closed */ }
    }

    [Fact]
    public async Task Plain_http_gets_400_and_no_session()
    {
        using var host = new DirectHubHost(0, HubOptions.ForDirect(4, null));
        using var tcp = new TcpClient();
        await tcp.ConnectAsync("127.0.0.1", host.Port);
        var s = tcp.GetStream();
        var req = Encoding.ASCII.GetBytes("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
        await s.WriteAsync(req);
        var buf = new byte[512];
        int n = await s.ReadAsync(buf);
        Assert.StartsWith("HTTP/1.1 400", Encoding.ASCII.GetString(buf, 0, n));
        Assert.Equal(0, host.Hub.SocketCount);
    }

    private static async Task<string> UpgradeStatus(DirectHubHost host, string? origin, string hostHeader = "game.example:47810")
    {
        using var tcp = new TcpClient();
        await tcp.ConnectAsync("127.0.0.1", host.Port);
        var s = tcp.GetStream();
        var req = "GET / HTTP/1.1\r\nHost: " + hostHeader + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" +
                  (origin is null ? "" : "Origin: " + origin + "\r\n") + "\r\n";
        await s.WriteAsync(Encoding.ASCII.GetBytes(req));
        var buf = new byte[512];
        int n = await s.ReadAsync(buf);
        return Encoding.ASCII.GetString(buf, 0, n).Split("\r\n")[0];
    }

    [Fact]
    public async Task Origin_must_be_absent_the_hosts_own_page_loopback_or_allowed()
    {
        using var host = new DirectHubHost(0, HubOptions.ForDirect(4, null), allowedOrigins: new[] { "https://play.example" });
        Assert.StartsWith("HTTP/1.1 101", await UpgradeStatus(host, null));                                  // native client
        Assert.StartsWith("HTTP/1.1 101", await UpgradeStatus(host, "http://game.example:47810"));           // the page this host serves
        Assert.StartsWith("HTTP/1.1 101", await UpgradeStatus(host, "http://localhost:5173"));
        Assert.StartsWith("HTTP/1.1 101", await UpgradeStatus(host, "http://127.0.0.1:3000"));
        Assert.StartsWith("HTTP/1.1 101", await UpgradeStatus(host, "http://[::1]:3000"));
        Assert.StartsWith("HTTP/1.1 101", await UpgradeStatus(host, "https://play.example"));                // allowedOrigins
        Assert.StartsWith("HTTP/1.1 403", await UpgradeStatus(host, "https://evil.example"));
        Assert.StartsWith("HTTP/1.1 403", await UpgradeStatus(host, "https://play.example.evil.example"));
        Assert.StartsWith("HTTP/1.1 403", await UpgradeStatus(host, "null"));
        Assert.StartsWith("HTTP/1.1 403", await UpgradeStatus(host, "http://game.example:9999"));            // other port
        Assert.Equal(0, host.Hub.SocketCount);
    }

    [Fact]
    public async Task Star_allows_every_origin()
    {
        using var host = new DirectHubHost(0, HubOptions.ForDirect(4, null), allowedOrigins: new[] { "*" });
        Assert.StartsWith("HTTP/1.1 101", await UpgradeStatus(host, "https://evil.example"));
    }

    [Fact]
    public void Port_in_use_throws()
    {
        using var a = new DirectHubHost(0, HubOptions.ForDirect(4, null));
        Assert.ThrowsAny<SocketException>(() => new DirectHubHost(a.Port, HubOptions.ForDirect(4, null)));
    }

    [Fact]
    public void Port_held_by_another_program_on_ipv4_only_is_in_use()
    {
        // e.g. a Node server listening on 0.0.0.0: Windows lets a dual-stack [::] socket bind the same port, and then
        // every IPv4 joiner reaches the other program
        var other = new TcpListener(System.Net.IPAddress.Any, 0);
        other.Start();
        try
        {
            var port = ((System.Net.IPEndPoint)other.LocalEndpoint).Port;
            var e = Assert.ThrowsAny<SocketException>(() => new DirectHubHost(port, HubOptions.ForDirect(4, null)));
            Assert.Equal(SocketError.AddressAlreadyInUse, e.SocketErrorCode);
        }
        finally { other.Stop(); }
    }

    [Fact]
    public void Udp_port_held_by_another_program_is_in_use()
    {
        // peer links share UDP P (ICE UDP mux): a port whose UDP half is taken cannot host either
        using var other = new UdpClient(new System.Net.IPEndPoint(System.Net.IPAddress.Any, 0));
        var port = ((System.Net.IPEndPoint)other.Client.LocalEndPoint!).Port;
        var e = Assert.ThrowsAny<SocketException>(() => new DirectHubHost(port, HubOptions.ForDirect(4, null)));
        Assert.Equal(SocketError.AddressAlreadyInUse, e.SocketErrorCode);
    }
}
