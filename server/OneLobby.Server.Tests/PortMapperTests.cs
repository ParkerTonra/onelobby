using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using OneLobby.Server;
using Xunit;

namespace OneLobby.Server.Tests;

/// <summary>PortMapper against fake gateways on loopback (docs/design/direct-ip.md s.5 step 8).</summary>
public class PortMapperTests
{
    /// <summary>SSDP responder + IGD description + WANIPConnection SOAP control, all on 127.0.0.1.</summary>
    private sealed class FakeUpnp : IDisposable
    {
        public readonly UdpClient Ssdp = new(new IPEndPoint(IPAddress.Loopback, 0));
        public readonly TcpListener Http = new(IPAddress.Loopback, 0);
        public readonly ConcurrentDictionary<string, string> Mappings = new(); // "TCP 47810" -> internal client
        public readonly ConcurrentQueue<string> Actions = new();
        public string External = "203.0.113.7";
        public int AddError; // UPnP error code to answer AddPortMapping with (0 = ok); 725 is cleared after one use
        public string ContentType = "text/xml";
        public int AddDelayMs; // a slow router: AddPortMapping takes effect at once but the reply comes this late
        private readonly CancellationTokenSource _cts = new();

        public IPEndPoint SsdpEndpoint => (IPEndPoint)Ssdp.Client.LocalEndPoint!;
        private int HttpPort => ((IPEndPoint)Http.LocalEndpoint).Port;

        public FakeUpnp()
        {
            Http.Start();
            _ = Task.Run(SsdpLoop);
            _ = Task.Run(HttpLoop);
        }

        private async Task SsdpLoop()
        {
            while (!_cts.IsCancellationRequested)
            {
                UdpReceiveResult r;
                try { r = await Ssdp.ReceiveAsync(_cts.Token); } catch (Exception) { return; }
                var text = Encoding.ASCII.GetString(r.Buffer);
                if (!text.StartsWith("M-SEARCH") || !text.Contains("InternetGatewayDevice:1")) continue;
                var reply = "HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n" +
                            $"LOCATION: http://127.0.0.1:{HttpPort}/desc.xml\r\nUSN: uuid:fake::urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n";
                var b = Encoding.ASCII.GetBytes(reply);
                await Ssdp.SendAsync(b, b.Length, r.RemoteEndPoint);
            }
        }

        private async Task HttpLoop()
        {
            while (!_cts.IsCancellationRequested)
            {
                TcpClient c;
                try { c = await Http.AcceptTcpClientAsync(_cts.Token); } catch (Exception) { return; }
                _ = Task.Run(() => Serve(c));
            }
        }

        private async Task Serve(TcpClient c)
        {
            using var _ = c;
            var s = c.GetStream();
            var buf = new byte[65536];
            var got = 0;
            int headerEnd;
            while ((headerEnd = IndexOf(buf, got)) < 0) got += await s.ReadAsync(buf.AsMemory(got));
            var head = Encoding.ASCII.GetString(buf, 0, headerEnd);
            var len = Regex.Match(head, @"Content-Length:\s*(\d+)", RegexOptions.IgnoreCase) is { Success: true } m ? int.Parse(m.Groups[1].Value) : 0;
            while (got < headerEnd + 4 + len) got += await s.ReadAsync(buf.AsMemory(got));
            var body = Encoding.UTF8.GetString(buf, headerEnd + 4, len);
            var (status, xml) = Handle(head, body);
            if (AddDelayMs > 0 && head.Contains("#AddPortMapping\"")) await Task.Delay(AddDelayMs);
            var bytes = Encoding.UTF8.GetBytes(xml);
            var resp = $"HTTP/1.1 {status}\r\nContent-Type: {ContentType}\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n";
            await s.WriteAsync(Encoding.ASCII.GetBytes(resp));
            await s.WriteAsync(bytes);
        }

        private static int IndexOf(byte[] b, int n)
        {
            for (var i = 0; i + 3 < n; i++) if (b[i] == 13 && b[i + 1] == 10 && b[i + 2] == 13 && b[i + 3] == 10) return i;
            return -1;
        }

        private static string Arg(string body, string name) => Regex.Match(body, $"<{name}>(.*?)</{name}>").Groups[1].Value;

        private (string, string) Handle(string head, string body)
        {
            if (head.StartsWith("GET /desc.xml"))
                return ("200 OK", "<?xml version=\"1.0\"?><root xmlns=\"urn:schemas-upnp-org:device-1-0\"><device><deviceList><device><deviceList><device>" +
                                  "<serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>" +
                                  "<controlURL>/ctl/IPConn</controlURL></service></serviceList></device></deviceList></device></deviceList></device></root>");
            var action = Regex.Match(head, "#(\\w+)\"").Groups[1].Value;
            Actions.Enqueue(action);
            const string env = "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body>{0}</s:Body></s:Envelope>";
            switch (action)
            {
                case "GetExternalIPAddress":
                    return ("200 OK", string.Format(env, $"<u:GetExternalIPAddressResponse xmlns:u=\"urn:schemas-upnp-org:service:WANIPConnection:1\"><NewExternalIPAddress>{External}</NewExternalIPAddress></u:GetExternalIPAddressResponse>"));
                case "AddPortMapping":
                    if (AddError != 0 && !(AddError == 725 && Arg(body, "NewLeaseDuration") == "0"))
                        return ("500 Internal Server Error", string.Format(env,
                            $"<s:Fault><detail><UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\"><errorCode>{AddError}</errorCode><errorDescription>nope</errorDescription></UPnPError></detail></s:Fault>"));
                    Mappings[Arg(body, "NewProtocol") + " " + Arg(body, "NewExternalPort")] = Arg(body, "NewInternalClient") + " lease " + Arg(body, "NewLeaseDuration");
                    return ("200 OK", string.Format(env, "<u:AddPortMappingResponse xmlns:u=\"urn:schemas-upnp-org:service:WANIPConnection:1\"/>"));
                case "DeletePortMapping":
                    Mappings.TryRemove(Arg(body, "NewProtocol") + " " + Arg(body, "NewExternalPort"), out _);
                    return ("200 OK", string.Format(env, "<u:DeletePortMappingResponse xmlns:u=\"urn:schemas-upnp-org:service:WANIPConnection:1\"/>"));
                default:
                    return ("500 Internal Server Error", "");
            }
        }

        public void Dispose()
        {
            _cts.Cancel();
            Ssdp.Dispose();
            Http.Stop();
        }
    }

    /// <summary>RFC 6886 responder: external address op 0, map ops 1 (UDP) and 2 (TCP).</summary>
    private sealed class FakeNatPmp : IDisposable
    {
        public readonly UdpClient Udp = new(new IPEndPoint(IPAddress.Loopback, 0));
        public readonly ConcurrentDictionary<string, int> Mappings = new(); // "op internalPort" -> lifetime (RFC 6886 keys by internal port)
        public int OfferPortDelta; // nonzero: answer with a different external port
        private readonly CancellationTokenSource _cts = new();
        public IPEndPoint Endpoint => (IPEndPoint)Udp.Client.LocalEndPoint!;

        public FakeNatPmp() => _ = Task.Run(Loop);

        private async Task Loop()
        {
            while (!_cts.IsCancellationRequested)
            {
                UdpReceiveResult r;
                try { r = await Udp.ReceiveAsync(_cts.Token); }
                catch (SocketException) { continue; } // Windows: ICMP from a client that already closed
                catch (Exception) { return; }
                var q = r.Buffer;
                byte[] reply;
                if (q[1] == 0) reply = new byte[] { 0, 128, 0, 0, 0, 0, 0, 1, 198, 51, 100, 9 };
                else
                {
                    var internalPort = (q[4] << 8) | q[5];
                    var life = (q[8] << 24) | (q[9] << 16) | (q[10] << 8) | q[11];
                    var ext = life == 0 ? 0 : internalPort + OfferPortDelta;
                    if (life == 0) Mappings.TryRemove(q[1] + " " + internalPort, out _);
                    else Mappings[q[1] + " " + internalPort] = life;
                    reply = new byte[] { 0, (byte)(128 + q[1]), 0, 0, 0, 0, 0, 1, q[4], q[5], (byte)(ext >> 8), (byte)ext, q[8], q[9], q[10], q[11] };
                }
                await Udp.SendAsync(reply, reply.Length, r.RemoteEndPoint);
            }
        }

        public void Dispose()
        {
            _cts.Cancel();
            Udp.Dispose();
        }
    }

    private static PortMapperOptions Opts(FakeUpnp? u = null, FakeNatPmp? n = null) => new()
    {
        SsdpEndpoint = u?.SsdpEndpoint ?? new IPEndPoint(IPAddress.Loopback, 9), // discard port: nobody answers
        NatPmpEndpoint = n?.Endpoint ?? new IPEndPoint(IPAddress.Loopback, 9),
        TryUpnp = u != null,
        TryNatPmp = n != null,
        DiscoveryTimeout = TimeSpan.FromMilliseconds(800),
        Description = "OneLobby test",
    };

    [Fact]
    public async Task UpnpMapsTcpAndUdpAndDeletesOnDispose()
    {
        using var gw = new FakeUpnp();
        var log = new List<string>();
        var o = Opts(gw);
        o.Log = log.Add;
        var m = new PortMapper(47810, o);
        var r = await m.OpenAsync();
        Assert.True(r.Mapped, r.Detail);
        Assert.Empty(log);
        Assert.Equal(PortMapMethod.Upnp, r.Method);
        Assert.Equal("203.0.113.7", r.ExternalIPv4);
        Assert.Equal("127.0.0.1", r.LocalIPv4);
        Assert.Equal("127.0.0.1 lease 7200", gw.Mappings["TCP 47810"]);
        Assert.Equal("127.0.0.1 lease 7200", gw.Mappings["UDP 47810"]);
        m.Dispose();
        Assert.Empty(gw.Mappings);
        Assert.Equal(new[] { "direct host mapping deleted port=47810 protocols=TCP,UDP mapping=UPnP" }, log);
    }

    [Theory]
    [InlineData("text/xml; charset=\"utf-8\"")] // quoted (legal, RFC 9110): Mono's ReadAsStringAsync throws on it
    [InlineData("text/xml; charset=not-a-real-encoding")]
    public async Task UpnpIgnoresTheResponseCharset(string contentType)
    {
        using var gw = new FakeUpnp { ContentType = contentType };
        using var m = new PortMapper(47810, Opts(gw));
        var r = await m.OpenAsync();
        Assert.True(r.Mapped, r.Detail);
        Assert.Equal("203.0.113.7", r.ExternalIPv4);
        Assert.Equal("127.0.0.1 lease 7200", gw.Mappings["TCP 47810"]);
    }

    [Fact]
    public async Task UpnpFallsBackToAPermanentLeaseOn725()
    {
        using var gw = new FakeUpnp { AddError = 725 };
        using var m = new PortMapper(47810, Opts(gw));
        var r = await m.OpenAsync();
        Assert.True(r.Mapped, r.Detail);
        Assert.Equal("127.0.0.1 lease 0", gw.Mappings["UDP 47810"]);
    }

    [Fact]
    public async Task UpnpConflictIsReportedNotThrown()
    {
        using var gw = new FakeUpnp { AddError = 718 };
        using var m = new PortMapper(47810, Opts(gw));
        var r = await m.OpenAsync();
        Assert.False(r.Mapped);
        Assert.Contains("718", r.Detail);
        Assert.Equal("203.0.113.7", r.ExternalIPv4);
    }

    [Fact]
    public async Task UpnpDisposeMidOpenStillDeletesWhatTheRouterMapped()
    {
        using var gw = new FakeUpnp { AddDelayMs = 3000 };
        var m = new PortMapper(47810, Opts(gw));
        var open = m.OpenAsync();
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (!gw.Mappings.ContainsKey("TCP 47810")) { Assert.True(sw.ElapsedMilliseconds < 5000, "no AddPortMapping"); await Task.Delay(10); }
        m.Dispose(); // the game quits while the router has not answered yet
        var r = await open;
        Assert.False(r.Mapped);
        Assert.Empty(gw.Mappings);
        await Task.Delay(300);
        Assert.Empty(gw.Mappings); // and nothing was mapped after the delete
        Assert.Single(gw.Actions, a => a == "AddPortMapping"); // the UDP request never went out
    }

    [Fact]
    public async Task UpnpDisposeLeavesAMappingTheRouterRefusedAlone()
    {
        using var gw = new FakeUpnp { AddError = 718 };
        gw.Mappings["TCP 47810"] = "192.168.1.50 lease 0"; // another device on the network holds the port
        var log = new List<string>();
        var o = Opts(gw);
        o.Log = log.Add;
        var m = new PortMapper(47810, o);
        Assert.False((await m.OpenAsync()).Mapped);
        m.Dispose();
        Assert.DoesNotContain("DeletePortMapping", gw.Actions);
        Assert.Empty(log); // nothing of ours was deleted
        Assert.Equal("192.168.1.50 lease 0", gw.Mappings["TCP 47810"]);
    }

    [Fact]
    public async Task NatPmpMapsBothAndReportsTheExternalAddress()
    {
        using var gw = new FakeNatPmp();
        var log = new List<string>();
        var o = Opts(n: gw);
        o.Log = log.Add;
        var m = new PortMapper(47810, o);
        var r = await m.OpenAsync();
        Assert.True(r.Mapped, r.Detail);
        Assert.Equal(PortMapMethod.NatPmp, r.Method);
        Assert.Equal("198.51.100.9", r.ExternalIPv4);
        Assert.Equal(7200, gw.Mappings["1 47810"]);
        Assert.Equal(7200, gw.Mappings["2 47810"]);
        m.Dispose();
        await Task.Delay(200);
        Assert.Empty(gw.Mappings);
        Assert.Equal(new[] { "direct host mapping deleted port=47810 protocols=TCP,UDP mapping=NAT-PMP" }, log);
    }

    [Fact]
    public async Task NatPmpWithADifferentExternalPortIsAFailure()
    {
        using var gw = new FakeNatPmp { OfferPortDelta = 1 };
        using var m = new PortMapper(47810, Opts(n: gw));
        var r = await m.OpenAsync();
        Assert.False(r.Mapped);
        Assert.Contains("47811", r.Detail);
        Assert.Empty(gw.Mappings);
    }

    [Fact]
    public async Task NoGatewayGivesAnUnmappedResultQuickly()
    {
        using var m = new PortMapper(47810, new PortMapperOptions
        {
            SsdpEndpoint = new IPEndPoint(IPAddress.Loopback, 9), NatPmpEndpoint = new IPEndPoint(IPAddress.Loopback, 9),
            DiscoveryTimeout = TimeSpan.FromMilliseconds(300),
        });
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var r = await m.OpenAsync();
        Assert.False(r.Mapped);
        Assert.Equal(PortMapMethod.None, r.Method);
        Assert.True(sw.ElapsedMilliseconds < 6000, sw.ElapsedMilliseconds + " ms");
    }

    [Theory]
    [InlineData("203.0.113.7", true)]
    [InlineData("8.8.8.8", true)]
    [InlineData("192.168.1.1", false)]
    [InlineData("10.0.0.1", false)]
    [InlineData("172.20.0.1", false)]
    [InlineData("100.64.0.1", false)]
    [InlineData("100.127.255.255", false)]
    [InlineData("100.128.0.1", true)]
    [InlineData("127.0.0.1", false)]
    [InlineData("169.254.1.1", false)]
    [InlineData("0.0.0.0", false)]
    [InlineData(null, false)]
    public void PublicAddressRule(string? ip, bool expected) => Assert.Equal(expected, PortMapper.IsPublicIPv4(ip));

    /// <summary>Against the real router: set ONELOBBY_LIVE_UPNP=1. Maps a high test port, prints what it found, removes it.</summary>
    [Fact]
    public async Task LiveRouter()
    {
        if (Environment.GetEnvironmentVariable("ONELOBBY_LIVE_UPNP") != "1") return;
        var m = new PortMapper(47819, new PortMapperOptions { Description = "OneLobby live test" });
        var r = await m.OpenAsync();
        Console.WriteLine($"LIVE mapped={r.Mapped} method={r.Method} external={r.ExternalIPv4} local={r.LocalIPv4} public={PortMapper.IsPublicIPv4(r.ExternalIPv4)} detail={r.Detail}");
        m.Dispose();
        Assert.True(r.Mapped, r.Detail);
    }
}
