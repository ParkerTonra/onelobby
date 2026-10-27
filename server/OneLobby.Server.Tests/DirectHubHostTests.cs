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
        using var host = new DirectHubHost(0, HubOptions.ForDirect(4, "pw"), bindAddress: System.Net.IPAddress.Loopback);
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

    private static async Task<(WebSocketCloseStatus? Status, string? Reason)> WaitClosed(ClientWebSocket ws)
    {
        var buf = new byte[65536];
        using var cts = new CancellationTokenSource(8000);
        while (true)
        {
            var r = await ws.ReceiveAsync(buf, cts.Token);
            if (r.MessageType == WebSocketMessageType.Close) return (r.CloseStatus, r.CloseStatusDescription);
        }
    }

    [Fact]
    public async Task The_33rd_loopback_socket_is_told_max_sockets_and_closed_with_1008()
    {
        using var host = new DirectHubHost(0, HubOptions.ForDirect(40, null), bindAddress: System.Net.IPAddress.Loopback);
        var open = new List<ClientWebSocket>();
        for (int i = 0; i < 32; i++)
        {
            var w = new ClientWebSocket();
            await w.ConnectAsync(new Uri($"ws://127.0.0.1:{host.Port}/"), CancellationToken.None);
            open.Add(w);
        }
        for (int i = 0; i < 100 && host.Hub.SocketCount < 32; i++) await Task.Delay(50);
        Assert.Equal(32, host.Hub.SocketCount);
        using var over = new ClientWebSocket();
        await over.ConnectAsync(new Uri($"ws://127.0.0.1:{host.Port}/"), CancellationToken.None);
        var err = await Next(over);
        Assert.Equal("rate_limited", (string?)err["code"]);
        Assert.Equal("max_sockets", (string?)err["data"]!["reason"]);
        var (status, reason) = await WaitClosed(over);
        Assert.Equal(WebSocketCloseStatus.PolicyViolation, status);
        Assert.Equal("too_many_sockets", reason);
        foreach (var w in open) w.Dispose();
    }

    [Fact]
    public async Task A_socket_that_does_not_drain_is_closed_1008_backpressure()
    {
        var o = HubOptions.ForDirect(4, null);
        o.MaxPendingWriteBytes = 8000;
        using var host = new DirectHubHost(0, o, bindAddress: System.Net.IPAddress.Loopback);
        using var h = await Hello(host.Port, "Host");
        await Send(h, "{\"t\":\"create\",\"name\":\"L\",\"maxPlayers\":4,\"visibility\":\"unlisted\",\"mode\":\"raw\"}");
        await Next(h);
        using var j = await Hello(host.Port, "Joe");
        await Send(j, "{\"t\":\"join\"}");
        await Next(j);
        await Next(h);
        // the host signals the joiner with a 12 KB description: more than the joiner's socket may hold unsent
        await Send(h, "{\"t\":\"signal\",\"to\":2,\"sdp\":{\"type\":\"offer\",\"sdp\":\"" + new string('a', 12000) + "\"}}");
        var (status, reason) = await WaitClosed(j);
        Assert.Equal(WebSocketCloseStatus.PolicyViolation, status);
        Assert.Equal("backpressure", reason);
    }

    [Fact]
    public async Task Dispose_closes_joiner_sockets()
    {
        var host = new DirectHubHost(0, HubOptions.ForDirect(4, null), bindAddress: System.Net.IPAddress.Loopback);
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
        using var host = new DirectHubHost(0, HubOptions.ForDirect(4, null), bindAddress: System.Net.IPAddress.Loopback);
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

    /// <summary>One plain GET over raw TCP; the host answers with Connection: close, so read to the end.</summary>
    private static async Task<string> RawGet(DirectHubHost host, string path)
    {
        using var tcp = new TcpClient();
        await tcp.ConnectAsync("127.0.0.1", host.Port);
        var s = tcp.GetStream();
        await s.WriteAsync(Encoding.ASCII.GetBytes($"GET {path} HTTP/1.1\r\nHost: x\r\n\r\n"));
        using var r = new StreamReader(s, Encoding.UTF8);
        using var cts = new CancellationTokenSource(5000);
        return await r.ReadToEndAsync(cts.Token);
    }

    [Fact]
    public async Task Healthz_answers_ok_and_other_paths_keep_the_400()
    {
        using var host = new DirectHubHost(0, HubOptions.ForDirect(4, null), bindAddress: System.Net.IPAddress.Loopback);
        var res = await RawGet(host, "/healthz");
        Assert.StartsWith("HTTP/1.1 200", res);
        Assert.Contains("Content-Type: text/plain\r\n", res);
        Assert.EndsWith("\r\n\r\nok\n", res);
        Assert.StartsWith("HTTP/1.1 400", await RawGet(host, "/anything"));
        Assert.Equal(0, host.Hub.SocketCount);
    }

    [Fact]
    public async Task Joininfo_is_404_until_the_host_sets_it_then_JSON()
    {
        using var host = new DirectHubHost(0, HubOptions.ForDirect(4, null), bindAddress: System.Net.IPAddress.Loopback);
        var none = await RawGet(host, "/joininfo");
        Assert.StartsWith("HTTP/1.1 404", none);
        Assert.EndsWith("no join code yet", none);
        host.JoinInfo = new DirectJoinInfo("6B01-RGFE-P2B", "internet", null, host.Port);
        var res = await RawGet(host, "/joininfo?x=1");
        Assert.StartsWith("HTTP/1.1 200", res);
        Assert.Contains("Content-Type: application/json\r\n", res);
        Assert.EndsWith("\r\n\r\n{\"joinCode\":\"6B01-RGFE-P2B\",\"joinCodeKind\":\"internet\",\"directCode\":\"6B01-RGFE-P2B\",\"directCodeKind\":\"internet\",\"joinUrl\":null,\"port\":" + host.Port + "}", res);
        host.JoinInfo = new DirectJoinInfo("0A00-0BSE-P3S", "same_network", null, host.Port);
        Assert.Contains("\"same_network\"", await RawGet(host, "/joininfo"));
    }

    [Fact]
    public async Task Joininfo_carries_the_nostr_join_code_and_the_ip_code()
    {
        using var host = new DirectHubHost(0, HubOptions.ForDirect(4, null), bindAddress: System.Net.IPAddress.Loopback);
        host.JoinInfo = new DirectJoinInfo("D1PB-1X9S-FPV", "nostr", null, host.Port, "6B01-RGFE-P2B", "same_network");
        var res = await RawGet(host, "/joininfo");
        Assert.Contains("\"directCode\":\"6B01-RGFE-P2B\",\"directCodeKind\":\"same_network\"", res);
        Assert.Contains("\"joinCodeKind\":\"nostr\"", res);
    }

    [Fact]
    public async Task Metrics_from_loopback_render_the_hub_counters()
    {
        using var host = new DirectHubHost(0, HubOptions.ForDirect(4, null), bindAddress: System.Net.IPAddress.Loopback);
        var before = await RawGet(host, "/metrics");
        Assert.StartsWith("HTTP/1.1 200", before);
        Assert.Contains("Content-Type: text/plain; version=0.0.4\r\n", before);
        Assert.Contains("onelobby_lobbies 0\n", before);
        Assert.DoesNotContain("onelobby_lobbies_created_total 1", before);

        using var h = await Hello(host.Port, "Host");
        await Send(h, "{\"t\":\"create\",\"name\":\"L\",\"maxPlayers\":4,\"visibility\":\"unlisted\",\"mode\":\"raw\"}");
        Assert.Equal("lobby", (string?)(await Next(h))["t"]);
        await Send(h, "{\"t\":\"create\",\"name\":\"L\",\"maxPlayers\":4}"); // already in a lobby: bad_request
        Assert.Equal("error", (string?)(await Next(h))["t"]);
        var after = await RawGet(host, "/metrics");
        Assert.Contains("onelobby_lobbies 1\n", after);
        Assert.Contains("onelobby_lobbies_created_total 1\n", after);
        Assert.Contains("onelobby_connections_total 1\n", after);
        Assert.Contains("onelobby_errors_total{code=\"bad_request\"} 1\n", after);
        // the JS hub (direct.test.ts) pins the same list for the same scenario
        var names = after.Split('\n').Where(l => l.StartsWith("# TYPE ")).Select(l => l.Split(' ')[2]).Order(StringComparer.Ordinal);
        Assert.Equal(new[]
        {
            "onelobby_connections_total", "onelobby_errors_total", "onelobby_lobbies", "onelobby_lobbies_created_total",
            "onelobby_lobbies_retired", "onelobby_messages_total", "onelobby_sockets",
        }, names);
    }

    [Fact]
    public void Metrics_are_loopback_only()
    {
        foreach (var ok in new[] { "127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1" })
            Assert.True(DirectHubHost.IsLoopback(System.Net.IPAddress.Parse(ok)), ok);
        foreach (var no in new[] { "192.168.1.5", "10.0.0.1", "8.8.8.8", "::2", "2001:db8::1", "::ffff:192.168.1.5" })
            Assert.False(DirectHubHost.IsLoopback(System.Net.IPAddress.Parse(no)), no);
        Assert.False(DirectHubHost.IsLoopback(null));
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
        using var host = new DirectHubHost(0, HubOptions.ForDirect(4, null), bindAddress: System.Net.IPAddress.Loopback, allowedOrigins: new[] { "https://play.example" });
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
        using var host = new DirectHubHost(0, HubOptions.ForDirect(4, null), bindAddress: System.Net.IPAddress.Loopback, allowedOrigins: new[] { "*" });
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
