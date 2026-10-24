using System.Net.Http;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Keepalive.Server.Tests;

/// <summary>End-to-end over real Kestrel and real WebSockets on a loopback ephemeral port.</summary>
public class WebSocketTests : IAsyncLifetime
{
    private WebApplication _app = null!;
    private string _http = "";
    private string _ws = "";

    public async Task InitializeAsync()
    {
        var o = new ServerOptions { RateScale = 20 };
        _app = ServerApp.Build(o, listenUrl: "http://127.0.0.1:0");
        await _app.StartAsync();
        _http = _app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        _ws = _http.Replace("http://", "ws://") + "/ws";
    }

    public async Task DisposeAsync() { await _app.StopAsync(); await _app.DisposeAsync(); }

    private sealed class Peer : IAsyncDisposable
    {
        public readonly ClientWebSocket Ws = new();
        public async Task ConnectAsync(string url) => await Ws.ConnectAsync(new Uri(url), CancellationToken.None);
        public Task SendAsync(string json) => Ws.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, true, CancellationToken.None);

        public async Task<JsonObject> RecvAsync(string? t = null)
        {
            var buf = new byte[32768];
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            while (true)
            {
                var r = await Ws.ReceiveAsync(buf, cts.Token);
                if (r.MessageType == WebSocketMessageType.Close) throw new InvalidOperationException("closed");
                var o = (JsonObject)JsonNode.Parse(Encoding.UTF8.GetString(buf, 0, r.Count))!;
                if (t is null || (string?)o["t"] == t) return o;
            }
        }

        public async ValueTask DisposeAsync() { Ws.Abort(); Ws.Dispose(); await Task.CompletedTask; }
    }

    private async Task<Peer> Hello(string name)
    {
        var p = new Peer();
        await p.ConnectAsync(_ws);
        await p.SendAsync($"{{\"t\":\"hello\",\"proto\":\"lk1\",\"gameId\":\"g\",\"netVersion\":\"1\",\"name\":\"{name}\",\"client\":{{\"lib\":\"t\",\"ver\":\"0\",\"platform\":\"t\"}}}}");
        await p.RecvAsync("welcome");
        return p;
    }

    [Fact]
    public async Task Create_list_join_and_signal_over_real_sockets()
    {
        await using var a = await Hello("A");
        await using var b = await Hello("B");
        await a.SendAsync("{\"t\":\"create\",\"name\":\"x\",\"maxPlayers\":4,\"visibility\":\"public\",\"mode\":\"raw\",\"tickRate\":20,\"lateJoin\":false,\"meta\":{}}");
        string code = (string)(await a.RecvAsync("lobby"))["code"]!;
        await b.SendAsync("{\"t\":\"list\",\"visibility\":\"public\"}");
        Assert.Equal(code, (string)(await b.RecvAsync("lobbies"))["items"]![0]!["code"]!);
        await b.SendAsync($"{{\"t\":\"join\",\"code\":\"{code}\"}}");
        await b.RecvAsync("lobby");
        await a.RecvAsync("peer_joined");
        await a.SendAsync("{\"t\":\"signal\",\"to\":2,\"sdp\":{\"type\":\"offer\",\"sdp\":\"v=0\"}}");
        var sig = await b.RecvAsync("signal");
        Assert.Equal(1, (int)sig["from"]!);
        Assert.Equal("offer", (string)sig["sdp"]!["type"]!);
    }

    [Fact]
    public async Task Health_and_metrics_endpoints()
    {
        using var http = new HttpClient();
        Assert.Equal("ok", (await http.GetStringAsync(_http + "/healthz")).Trim());
        await using var a = await Hello("A");
        await a.SendAsync("{\"t\":\"path\",\"path\":\"relayed\"}");
        await a.SendAsync("{\"t\":\"ping\",\"n\":1}");
        await a.RecvAsync("pong");
        string m = await http.GetStringAsync(_http + "/metrics");
        Assert.Contains("keepalive_path_total{path=\"relayed\"} 1", m);
        Assert.Contains("keepalive_sockets 1", m);
    }

    [Fact]
    public async Task Abrupt_close_detaches_and_oversize_closes()
    {
        await using var a = await Hello("A");
        await using var b = await Hello("B");
        await a.SendAsync("{\"t\":\"create\",\"maxPlayers\":4}");
        string code = (string)(await a.RecvAsync("lobby"))["code"]!;
        await b.SendAsync($"{{\"t\":\"join\",\"code\":\"{code}\"}}");
        await b.RecvAsync("lobby");
        a.Ws.Abort();
        var left = await b.RecvAsync("peer_left");
        Assert.Equal("timeout", (string)left["reason"]!);

        await b.SendAsync("{\"t\":\"ping\",\"n\":0,\"pad\":\"" + new string('x', 20000) + "\"}");
        var err = await b.RecvAsync("error");
        Assert.Equal("bad_request", (string)err["code"]!);
    }
}
