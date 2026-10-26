using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using Microsoft.Extensions.Logging;

namespace OneLobby.Server;

/// <summary>
/// Runs a <see cref="Hub"/> inside the host's game and listens for joiners' signaling WebSockets on TCP <see cref="Port"/>
/// (docs/direct-ip.md s.2, s.5 step 3). Managed only: a <see cref="TcpListener"/>, a minimal HTTP/1.1 upgrade (RFC 6455
/// s.4.2) and <see cref="WebSocket.CreateFromStream(Stream, bool, string, TimeSpan)"/>. Not HttpListener (a non-localhost
/// prefix needs a URL ACL on Windows) and not libdatachannel's WebSocket server (the natives are built with NO_WEBSOCKET).
/// <para>
/// Sockets run on thread-pool tasks and feed the hub directly (the hub is single-locked). Call <see cref="Pump"/> from the
/// game loop: it runs <see cref="Hub.Tick"/> once a second. The host's own client talks to <see cref="Hub"/> in memory.
/// </para>
/// </summary>
public sealed class DirectHubHost : IDisposable
{
    public const string WebSocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private const int MaxHeaderBytes = 8192;
    private const int HandshakeTimeoutMs = 5000;

    private readonly TcpListener _listener;
    private readonly CancellationTokenSource _cts = new();
    private readonly ConcurrentDictionary<Conn, byte> _conns = new();
    private readonly HubOptions _o;
    private readonly string[] _allowedOrigins;
    private readonly ILogger _log;
    private readonly Stopwatch _sw = Stopwatch.StartNew();
    private long _nextTickMs = 1000;
    private int _handshakes;

    public Hub Hub { get; }
    /// <summary>The bound TCP port (the requested one, or the one the OS picked for port 0).</summary>
    public int Port { get; }
    public bool Disposed { get; private set; }
    private volatile DirectJoinInfo? _joinInfo;
    /// <summary>
    /// Served as JSON at <c>GET /joininfo</c> (404 while null); the direct host keeps it current as the join code changes.
    /// </summary>
    public DirectJoinInfo? JoinInfo { get => _joinInfo; set => _joinInfo = value; }
    /// <summary>Joiner sockets currently open.</summary>
    public int ConnectionCount => _conns.Count;

    private sealed class Conn
    {
        public TcpClient Tcp = null!;
        public WebSocket? Ws;
        public readonly ConcurrentQueue<string> Out = new();
        public readonly SemaphoreSlim OutSignal = new(0);
        public volatile bool Closing;
    }

    /// <summary>Binds TCP <paramref name="port"/> on every interface (IPv6 dual-stack where available) and starts accepting.</summary>
    /// <exception cref="SocketException">The port is taken or cannot be bound.</exception>
    /// <param name="allowedOrigins">
    /// Browser <c>Origin</c> values allowed to open a signaling socket besides the always-allowed ones (no Origin header,
    /// an Origin equal to the request's Host, loopback origins); exact match, "*" allows every origin.
    /// </param>
    public DirectHubHost(int port, HubOptions options, ILogger? logger = null, IClock? clock = null, IEnumerable<string>? allowedOrigins = null)
    {
        _o = options;
        _allowedOrigins = allowedOrigins?.ToArray() ?? Array.Empty<string>();
        _log = logger ?? Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance;
        Hub = new Hub(options, clock, _log);
        _listener = Bind(port);
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        Task.Run(AcceptLoop);
    }

    private static TcpListener Bind(int port)
    {
        if (port != 0) ProbeIPv4(port);
        if (Socket.OSSupportsIPv6)
        {
            var l = new TcpListener(IPAddress.IPv6Any, port);
            try
            {
                l.Server.DualMode = true;
                l.Start();
                return l;
            }
            catch (SocketException e) when (e.SocketErrorCode != SocketError.AddressAlreadyInUse)
            {
                l.Stop(); // IPv6 present but unusable: fall back to IPv4
            }
        }
        var v4 = new TcpListener(IPAddress.Any, port);
        v4.Start();
        return v4;
    }

    /// <summary>
    /// Throws AddressAlreadyInUse when another program holds IPv4 TCP or UDP <paramref name="port"/>. Windows lets the
    /// dual-stack listener bind over a program on 0.0.0.0 (every IPv4 joiner would then reach that program), and the
    /// peer links need UDP <paramref name="port"/> too, so both are tried and released before the real bind.
    /// </summary>
    private static void ProbeIPv4(int port)
    {
        foreach (var (type, proto) in new[] { (SocketType.Stream, ProtocolType.Tcp), (SocketType.Dgram, ProtocolType.Udp) })
        {
            using var s = new Socket(AddressFamily.InterNetwork, type, proto);
            s.Bind(new IPEndPoint(IPAddress.Any, port));
        }
    }

    /// <summary>Call from the game loop (any rate): runs the hub's once-a-second housekeeping.</summary>
    public void Pump()
    {
        if (Disposed) return;
        long now = _sw.ElapsedMilliseconds;
        if (now < _nextTickMs) return;
        _nextTickMs = now + 1000;
        Hub.Tick();
    }

    private async Task AcceptLoop()
    {
        while (!_cts.IsCancellationRequested)
        {
            TcpClient tcp;
            try { tcp = await _listener.AcceptTcpClientAsync().ConfigureAwait(false); }
            catch (Exception) when (_cts.IsCancellationRequested) { return; }
            catch (SocketException) { continue; }
            catch (ObjectDisposedException) { return; }
            // bounded: a flood of half-open connections cannot pile up handshakes
            if (Interlocked.Increment(ref _handshakes) > _o.MaxPeers + 16 || _conns.Count >= _o.MaxPeers + 16)
            {
                Interlocked.Decrement(ref _handshakes);
                tcp.Dispose();
                continue;
            }
            _ = Task.Run(() => Serve(tcp));
        }
    }

    private async Task Serve(TcpClient tcp)
    {
        var c = new Conn { Tcp = tcp };
        Session? session = null;
        Task? writer = null;
        try
        {
            tcp.NoDelay = true;
            var stream = tcp.GetStream();
            bool upgraded;
            using (var hs = new CancellationTokenSource(HandshakeTimeoutMs))
            using (hs.Token.Register(() => tcp.Dispose()))
            {
                try { upgraded = await Handshake(stream, (tcp.Client.RemoteEndPoint as IPEndPoint)?.Address, hs.Token).ConfigureAwait(false); }
                finally { Interlocked.Decrement(ref _handshakes); }
            }
            if (!upgraded) return;
            c.Ws = WebSocket.CreateFromStream(stream, isServer: true, subProtocol: null, keepAliveInterval: TimeSpan.FromSeconds(20));
            _conns[c] = 0;
            if (Disposed) return;

            var ep = tcp.Client.RemoteEndPoint as IPEndPoint;
            var addr = ep?.Address;
            if (addr is not null && addr.IsIPv4MappedToIPv6) addr = addr.MapToIPv4();
            session = Hub.Connect(addr?.ToString() ?? "unknown",
                send: text => { if (!c.Closing) { c.Out.Enqueue(text); c.OutSignal.Release(); } },
                close: () => { c.Closing = true; c.OutSignal.Release(); });
            writer = Task.Run(() => WriteLoop(c));
            if (session is not null) await ReadLoop(c, session).ConfigureAwait(false);
        }
        catch (Exception e)
        {
            _log.LogDebug("direct socket ended: {Error}", e.Message);
        }
        finally
        {
            if (session is not null) Hub.Disconnect(session);
            c.Closing = true;
            c.OutSignal.Release();
            if (writer is not null)
            {
                try { await Task.WhenAny(writer, Task.Delay(2000)).ConfigureAwait(false); } catch (Exception) { }
            }
            _conns.TryRemove(c, out _);
            c.Ws?.Dispose();
            tcp.Dispose();
        }
    }

    private async Task ReadLoop(Conn c, Session session)
    {
        var ws = c.Ws!;
        var buf = new byte[_o.MaxMessageBytes + 1];
        while (ws.State == WebSocketState.Open && !_cts.IsCancellationRequested && !c.Closing)
        {
            int len = 0;
            WebSocketReceiveResult r;
            do
            {
                r = await ws.ReceiveAsync(new ArraySegment<byte>(buf, len, buf.Length - len), _cts.Token).ConfigureAwait(false);
                len += r.Count;
                if (r.MessageType == WebSocketMessageType.Close) return;
            } while (!r.EndOfMessage && len < buf.Length);
            if (len > _o.MaxMessageBytes || !r.EndOfMessage)
            {
                Hub.Receive(session, new string('x', _o.MaxMessageBytes + 1)); // oversize: hub replies bad_request and closes
                return;
            }
            if (r.MessageType != WebSocketMessageType.Text) continue;
            Hub.Receive(session, Encoding.UTF8.GetString(buf, 0, len));
        }
    }

    private async Task WriteLoop(Conn c)
    {
        var ws = c.Ws!;
        try
        {
            while (true)
            {
                await c.OutSignal.WaitAsync(_cts.Token).ConfigureAwait(false);
                while (c.Out.TryDequeue(out var text))
                    await ws.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(text)), WebSocketMessageType.Text, true, _cts.Token).ConfigureAwait(false);
                if (c.Closing) break;
            }
            if (ws.State == WebSocketState.Open)
            {
                using var t = new CancellationTokenSource(1000);
                await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", t.Token).ConfigureAwait(false);
            }
        }
        catch (Exception) { /* socket gone; the read loop ends too */ }
        finally
        {
            c.Closing = true;
            try { c.Tcp.Client.Shutdown(SocketShutdown.Both); } catch (Exception) { }
        }
    }

    /// <summary>
    /// Reads the HTTP/1.1 request head byte by byte (nothing past the blank line is consumed) and answers 101 with
    /// Sec-WebSocket-Accept, or 400/426 for anything that is not a WebSocket upgrade. <c>GET /healthz</c>, <c>GET /joininfo</c> and <c>GET /metrics</c>
    /// are answered first, as onelobby-server does; /metrics only to a loopback <paramref name="remote"/>, since this port faces the internet.
    /// </summary>
    private async Task<bool> Handshake(Stream stream, IPAddress? remote, CancellationToken ct)
    {
        var head = new byte[MaxHeaderBytes];
        int n = 0;
        var one = new byte[1];
        while (true)
        {
            if (n == head.Length) { await Reply(stream, "431 Request Header Fields Too Large", null, ct).ConfigureAwait(false); return false; }
            int r = await stream.ReadAsync(one, 0, 1, ct).ConfigureAwait(false);
            if (r == 0) return false;
            head[n++] = one[0];
            if (n >= 4 && head[n - 4] == '\r' && head[n - 3] == '\n' && head[n - 2] == '\r' && head[n - 1] == '\n') break;
        }
        var lines = Encoding.ASCII.GetString(head, 0, n).Split(new[] { "\r\n" }, StringSplitOptions.None);
        var request = lines[0].Split(' ');
        if (request.Length < 3 || request[0] != "GET" || !request[2].StartsWith("HTTP/1.1", StringComparison.Ordinal))
        { await Reply(stream, "400 Bad Request", null, ct).ConfigureAwait(false); return false; }
        string path = request[1].Split('?')[0];
        if (path == "/healthz") { await Reply(stream, "200 OK", null, ct, "ok\n").ConfigureAwait(false); return false; }
        if (path == "/joininfo")
        {
            var info = _joinInfo;
            if (info != null) await Reply(stream, "200 OK", null, ct, info.ToJson(), "application/json").ConfigureAwait(false);
            else await Reply(stream, "404 Not Found", null, ct, "no join code yet").ConfigureAwait(false);
            return false;
        }
        if (path == "/metrics")
        {
            if (IsLoopback(remote)) await Reply(stream, "200 OK", null, ct, Hub.Metrics.Render(), "text/plain; version=0.0.4").ConfigureAwait(false);
            else await Reply(stream, "403 Forbidden", null, ct, "metrics are local only (OneLobby direct host)\n").ConfigureAwait(false);
            return false;
        }
        var h = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 1; i < lines.Length; i++)
        {
            int colon = lines[i].IndexOf(':');
            if (colon > 0) h[lines[i].Substring(0, colon).Trim()] = lines[i].Substring(colon + 1).Trim();
        }
        bool upgrade = h.TryGetValue("Upgrade", out var up) && up.IndexOf("websocket", StringComparison.OrdinalIgnoreCase) >= 0
                       && h.TryGetValue("Connection", out var conn) && conn.IndexOf("upgrade", StringComparison.OrdinalIgnoreCase) >= 0;
        if (!upgrade || !h.TryGetValue("Sec-WebSocket-Key", out var key) || key.Length == 0)
        { await Reply(stream, "400 Bad Request", null, ct).ConfigureAwait(false); return false; }
        // A web page can open a WebSocket to any address it can reach, so a browser's Origin must be one we expect.
        if (h.TryGetValue("Origin", out var origin) && !OriginAllowed(origin, h.TryGetValue("Host", out var hostHeader) ? hostHeader : null, _allowedOrigins))
        { await Reply(stream, "403 Forbidden", null, ct).ConfigureAwait(false); return false; }
        if (!h.TryGetValue("Sec-WebSocket-Version", out var ver) || ver != "13")
        { await Reply(stream, "426 Upgrade Required", "Sec-WebSocket-Version: 13\r\n", ct).ConfigureAwait(false); return false; }

        string accept = AcceptKey(key);
        var ok = Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
        await stream.WriteAsync(ok, 0, ok.Length, ct).ConfigureAwait(false);
        return true;
    }

    /// <summary>
    /// Whether a handshake carrying <paramref name="origin"/> is accepted: it is in <paramref name="allowed"/> ("*" = all), its
    /// host:port equals the request's <paramref name="host"/> header (the page this host serves itself), or it is a loopback
    /// origin (localhost, 127.0.0.1, [::1], any port). A request with no Origin header is a native client and never gets here.
    /// </summary>
    public static bool OriginAllowed(string origin, string? host, IReadOnlyCollection<string> allowed)
    {
        foreach (var a in allowed) if (a == "*" || a == origin) return true;
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var u) || (u.Scheme != "http" && u.Scheme != "https")) return false;
        if (u.Host == "localhost" || u.Host == "127.0.0.1" || u.Host == "[::1]") return true;
        return host != null && string.Equals(u.Authority, host.Trim(), StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>RFC 6455 s.4.2.2: base64(SHA-1(key + GUID)).</summary>
    public static string AcceptKey(string key) =>
        Convert.ToBase64String(Compat.Sha1(Encoding.ASCII.GetBytes(key.Trim() + WebSocketGuid)));

    /// <summary>127.0.0.0/8, ::1 or an IPv4-mapped loopback address (a dual-stack listener reports IPv4 callers as mapped).</summary>
    public static bool IsLoopback(IPAddress? a)
    {
        if (a is null) return false;
        if (a.IsIPv4MappedToIPv6) a = a.MapToIPv4();
        return IPAddress.IsLoopback(a);
    }

    private static async Task Reply(Stream stream, string status, string? extraHeaders, CancellationToken ct,
                                    string body = "OneLobby direct host (lk1): connect over WebSocket\n", string contentType = "text/plain")
    {
        var bytes = Encoding.UTF8.GetBytes("HTTP/1.1 " + status + "\r\nContent-Type: " + contentType + "\r\nConnection: close\r\n" + (extraHeaders ?? "")
                                           + "Content-Length: " + Encoding.UTF8.GetByteCount(body) + "\r\n\r\n" + body);
        try { await stream.WriteAsync(bytes, 0, bytes.Length, ct).ConfigureAwait(false); } catch (Exception) { }
    }

    /// <summary>Stops listening and closes every joiner socket.</summary>
    /// <summary>The router mapping started by <see cref="OpenPortAsync"/>, if any; removed on <see cref="Dispose"/>.</summary>
    public PortMapper? PortMapper { get; private set; }

    /// <summary>
    /// Asks the home router to forward TCP and UDP <see cref="Port"/> here (UPnP, then NAT-PMP; docs/direct-ip.md s.2a).
    /// Runs off the game thread; the mapping is renewed while hosting and deleted on <see cref="Dispose"/>.
    /// </summary>
    public Task<PortMapResult> OpenPortAsync(PortMapperOptions? options = null, CancellationToken ct = default)
    {
        if (PortMapper != null) throw new InvalidOperationException("the port is already being opened");
        PortMapper = new PortMapper(Port, options);
        return Task.Run(() => PortMapper.OpenAsync(ct), ct);
    }

    public void Dispose()
    {
        if (Disposed) return;
        Disposed = true;
        try { PortMapper?.Dispose(); } catch (Exception) { }
        try { _listener.Stop(); } catch (Exception) { }
        foreach (var c in _conns.Keys)
        {
            c.Closing = true;
            c.OutSignal.Release();
        }
        // give the write loops a moment to send their close frames, then cut everything
        Task.Delay(300).ContinueWith(_ =>
        {
            _cts.Cancel();
            foreach (var c in _conns.Keys) { try { c.Tcp.Dispose(); } catch (Exception) { } }
        });
    }
}

/// <summary>What a direct host answers at <c>GET /joininfo</c>: the current join code and where it works (same shape as the JS host).</summary>
/// <param name="JoinCode">Ungrouped-or-grouped code as shown to players; empty when there is none.</param>
/// <param name="JoinCodeKind"><c>"internet"</c>, <c>"same_network"</c> or <c>"none"</c>.</param>
/// <param name="JoinUrl">A page link when the host serves pages; null otherwise (C# hosts do not serve pages).</param>
public sealed record DirectJoinInfo(string JoinCode, string JoinCodeKind, string? JoinUrl, int Port)
{
    public string ToJson() => System.Text.Json.JsonSerializer.Serialize(new Dictionary<string, object?>
    {
        ["joinCode"] = JoinCode, ["joinCodeKind"] = JoinCodeKind, ["joinUrl"] = JoinUrl, ["port"] = Port,
    });
}
