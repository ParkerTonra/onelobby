#nullable enable
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using OneLobby;
using OneLobby.DataChannel;
using OneLobby.Direct;
using OneLobby.Direct.Nostr;
using PortMapper = OneLobby.Server.PortMapper;
using PortMapperOptions = OneLobby.Server.PortMapperOptions;

// Runs the managed + native half of com.onelobby.unity on Unity's own Mono (unityjit profile), with no Unity licence:
// OneLobby.Core, OneLobby.DataChannel, the shipped System.Text.Json DLLs and the libdatachannel native plugin. Two peers
// host/join through a real onelobby-server and exchange reliable + fast messages over real WebRTC data channels.
// With the argument "direct" there is no server: OneLobby.Direct + the embedded hub (OneLobby.Hub) host by IP on
// loopback (no router request) and the joiner joins by address, the path Unity's HostDirectAsync / JoinDirectAsync take.
static class Probe
{
    static void PumpUntil(Func<bool> done, Action pump, string what)
    {
        var sw = Stopwatch.StartNew();
        while (!done()) { pump(); Thread.Sleep(2); if (sw.ElapsedMilliseconds > 20000) throw new TimeoutException(what); }
    }

    static int Main(string[] args)
    {
        Console.WriteLine("runtime: " + typeof(object).Assembly.Location + " | " + Type.GetType("Mono.Runtime")?.GetMethod("GetDisplayName", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)?.Invoke(null, null));
        Console.WriteLine("System.Text.Json: " + typeof(System.Text.Json.JsonDocument).Assembly.Location);
        if (args.Length > 0 && args[0] == "crypto") return CryptoCheck();
        if (Environment.GetEnvironmentVariable("ONELOBBY_PROBE_LOG") is { Length: > 0 } lv)
        {
            DataChannelTransport.NativeLogLevel = int.Parse(lv);
            DataChannelTransport.NativeLog += line => Console.WriteLine(line);
        }
        {
            var link = new DataChannelTransport().CreatePeerLink(new PeerLinkOptions(9, true, Array.Empty<IceServer>(), false));
            var reason = link.GetType().GetProperty("FailReason")?.GetValue(link);
            Console.WriteLine($"peer link self-check: failed={link.IsFailed} {reason}");
            link.Dispose();
        }
        if (args.Length > 0 && args[0] == "upnp") return UpnpCheck();
        var direct = args.Length > 0 && args[0] == "direct";
        const int directPort = 47831;
        var url = new Uri(args.Length > 0 && !direct ? args[0] : "ws://127.0.0.1:8080/ws");
        var cfg = new OneLobbyConfig("com.onelobby.monoprobe", "1", url, SyncMode.Raw);
        var a = new LobbyClient(cfg with { DisplayName = "MonoHost" }, new DataChannelTransport());
        var b = new LobbyClient(cfg with { DisplayName = "MonoJoiner" }, new DataChannelTransport());
        Lobby? host = null, joiner = null;
        void Pump() { if (host != null) host.Pump(); else a.Pump(); if (joiner != null) joiner.Pump(); else b.Pump(); }
        var sw = Stopwatch.StartNew();

        var ht = direct
            ? a.HostDirectAsync(new DirectHostOptions { Nostr = new OneLobby.Direct.Nostr.NostrOptions { Enabled = false }, Port = directPort, MaxPlayers = 2, OpenPort = false })
            : a.HostAsync(new LobbyOptions("mono probe", 2, Visibility.Public));
        PumpUntil(() => ht.IsCompleted, Pump, "host");
        host = ht.GetAwaiter().GetResult();
        var got = new List<(Channel, string)>();
        host.MessageReceived += (f, p, c) => got.Add((c, Encoding.UTF8.GetString(p.ToArray())));
        Console.WriteLine(direct ? $"hosted direct, join code {host.JoinCode} ({host.JoinCodeKind})" : $"hosted {host.Code}");

        var listed = direct; // direct lobbies are never listed
        if (!direct)
        {
            var lt = b.ListAsync();
            PumpUntil(() => lt.IsCompleted, Pump, "list");
            foreach (var s in lt.GetAwaiter().GetResult()) if (s.Code == host.Code && s.HostName == "MonoHost") listed = true;
            Console.WriteLine("listed: " + listed);
        }

        var jt = direct ? b.JoinDirectAsync("127.0.0.1:" + directPort) : b.JoinAsync(host.Code);
        PumpUntil(() => jt.IsCompleted, Pump, "join");
        joiner = jt.GetAwaiter().GetResult();
        PumpUntil(() => joiner.ReadyAsync.IsCompleted, Pump, "WebRTC link");
        Console.WriteLine($"WebRTC data channels open after {sw.ElapsedMilliseconds} ms");

        joiner.Send(host.LocalPeerId, Encoding.UTF8.GetBytes("hello from Unity's Mono"));
        var n = 0;
        PumpUntil(() =>
        {
            if (n++ % 20 == 0) joiner.Send(host.LocalPeerId, Encoding.UTF8.GetBytes("fast"), Channel.Fast);
            return got.Exists(m => m.Item1 == Channel.Reliable) && got.Exists(m => m.Item1 == Channel.Fast);
        }, Pump, "messages at host");
        var ok = listed && got.Exists(m => m.Item1 == Channel.Reliable && m.Item2 == "hello from Unity's Mono");
        Console.WriteLine($"host got reliable + fast after {sw.ElapsedMilliseconds} ms");

        joiner.LeaveAsync();
        host.LeaveAsync();
        a.DisposeAsync().AsTask().Wait();
        b.DisposeAsync().AsTask().Wait();
        Thread.Sleep(200);
        Console.WriteLine(ok ? "PASS" : "FAIL");
        return ok ? 0 : 1;
    }

    // "crypto": NostrCrypto's AES-256-GCM on Mono. Every Nostr frame goes through it; if Mono's AesGcm is missing or half-built
    // and the managed fallback did not engage, GcmOpen returns null and all frames drop silently. Prints which path ran.
    static int CryptoCheck()
    {
        NostrCrypto.FallbackLog = l => Console.WriteLine("fallback log: " + l);
        var key = new byte[32];
        for (var i = 0; i < key.Length; i++) key[i] = (byte)(i * 7 + 3);
        var iv = new byte[12];
        for (var i = 0; i < iv.Length; i++) iv[i] = (byte)(i + 1);
        var plain = Encoding.UTF8.GetBytes("a nostr frame {\"k\":1} on Unity's Mono, longer than one 16-byte block");

        bool Same(byte[]? a, byte[] b) => a != null && Convert.ToBase64String(a) == Convert.ToBase64String(b);

        var blob = NostrCrypto.GcmSeal(key, iv, plain);
        var opened = NostrCrypto.GcmOpen(key, blob);
        var path = NostrCrypto.ForceManaged ? "managed (platform AesGcm failed)" : "platform AesGcm";
        var ok = Same(opened, plain);
        Console.WriteLine("default path: " + path + ", round trip " + (ok ? "ok" : "FAILED"));

        NostrCrypto.ForceManaged = true;
        var managedBlob = NostrCrypto.GcmSeal(key, iv, plain);
        var managedOk = Same(NostrCrypto.GcmOpen(key, managedBlob), plain) && Same(NostrCrypto.GcmOpen(key, blob), plain);
        Console.WriteLine("forced managed: seal/open " + (managedOk ? "ok" : "FAILED") + ", opens the default path's frame");
        ok &= managedOk;
        var same = Convert.ToBase64String(managedBlob) == Convert.ToBase64String(blob);
        Console.WriteLine("managed frame equals default frame: " + same);
        ok &= same;
        var tampered = (byte[])managedBlob.Clone();
        tampered[tampered.Length - 1] ^= 1;
        var rejected = NostrCrypto.GcmOpen(key, tampered) == null;
        Console.WriteLine("tampered tag rejected: " + rejected);
        ok &= rejected;
        NostrCrypto.ForceManaged = false;
        Console.WriteLine(ok ? "ok" : "FAIL");
        return ok ? 0 : 1;
    }

    // "upnp": the router request path on Mono, against a fake IGD on loopback that answers with a quoted charset
    // (Content-Type: text/xml; charset="utf-8"), which real routers send and Mono's HttpContent cannot decode.
    static int UpnpCheck()
    {
        var ssdp = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        var http = new TcpListener(IPAddress.Loopback, 0);
        http.Start();
        var httpPort = ((IPEndPoint)http.LocalEndpoint).Port;
        var mapped = new List<string>();
        new Thread(() =>
        {
            try
            {
                while (true)
                {
                    IPEndPoint? from = null;
                    ssdp.Receive(ref from);
                    var reply = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n" +
                        $"LOCATION: http://127.0.0.1:{httpPort}/desc.xml\r\nUSN: uuid:probe\r\n\r\n");
                    ssdp.Send(reply, reply.Length, from);
                }
            }
            catch (Exception) { }
        }) { IsBackground = true }.Start();
        new Thread(() =>
        {
            try
            {
                while (true)
                {
                    using var c = http.AcceptTcpClient();
                    var s = c.GetStream();
                    var buf = new byte[65536];
                    var got = 0;
                    string head;
                    while (true)
                    {
                        got += s.Read(buf, got, buf.Length - got);
                        var t = Encoding.ASCII.GetString(buf, 0, got);
                        var end = t.IndexOf("\r\n\r\n", StringComparison.Ordinal);
                        if (end < 0) continue;
                        head = t.Substring(0, end);
                        var lm = System.Text.RegularExpressions.Regex.Match(head, @"Content-Length:\s*(\d+)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                        var len = lm.Success ? int.Parse(lm.Groups[1].Value) : 0;
                        while (got < end + 4 + len) got += s.Read(buf, got, buf.Length - got);
                        break;
                    }
                    const string env = "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body>{0}</s:Body></s:Envelope>";
                    string xml;
                    if (head.StartsWith("GET /desc.xml"))
                        xml = "<?xml version=\"1.0\"?><root xmlns=\"urn:schemas-upnp-org:device-1-0\"><device><serviceList><service>" +
                              "<serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl</controlURL></service></serviceList></device></root>";
                    else if (head.Contains("#GetExternalIPAddress"))
                        xml = string.Format(env, "<u:GetExternalIPAddressResponse xmlns:u=\"urn:schemas-upnp-org:service:WANIPConnection:1\"><NewExternalIPAddress>203.0.113.7</NewExternalIPAddress></u:GetExternalIPAddressResponse>");
                    else
                    {
                        if (head.Contains("#AddPortMapping")) lock (mapped) mapped.Add("add");
                        if (head.Contains("#DeletePortMapping")) lock (mapped) mapped.Add("delete");
                        xml = string.Format(env, "<u:Response xmlns:u=\"urn:schemas-upnp-org:service:WANIPConnection:1\"/>");
                    }
                    var body = Encoding.UTF8.GetBytes(xml);
                    var resp = Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: text/xml; charset=\"utf-8\"\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
                    s.Write(resp, 0, resp.Length);
                    s.Write(body, 0, body.Length);
                }
            }
            catch (Exception) { }
        }) { IsBackground = true }.Start();

        var m = new PortMapper(47832, new PortMapperOptions
        {
            SsdpEndpoint = (IPEndPoint)ssdp.Client.LocalEndPoint!, TryNatPmp = false, DiscoveryTimeout = TimeSpan.FromSeconds(1),
        });
        var r = m.OpenAsync().GetAwaiter().GetResult();
        Console.WriteLine($"upnp: mapped={r.Mapped} method={r.Method} external={r.ExternalIPv4} detail={r.Detail}");
        m.Dispose(); // blocks until the router deletes are answered, as OneLobbyRunner.OnDestroy does on quit
        int adds, deletes;
        lock (mapped) { adds = mapped.FindAll(x => x == "add").Count; deletes = mapped.FindAll(x => x == "delete").Count; }
        Console.WriteLine($"upnp: {adds} adds, {deletes} deletes");
        var ok = r.Mapped && r.ExternalIPv4 == "203.0.113.7" && adds == 2 && deletes == 2;
        ssdp.Close();
        http.Stop();
        Console.WriteLine(ok ? "PASS" : "FAIL");
        return ok ? 0 : 1;
    }
}
