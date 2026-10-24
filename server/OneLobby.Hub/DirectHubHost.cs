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
    private readonly ILogger _log;
    private readonly Stopwatch _sw = Stopwatch.StartNew();
    private long _nextTickMs = 1000;
    private int _handshakes;

    public Hub Hub { get; }
    /// <summary>The bound TCP port (the requested one, or the one the OS picked for port 0).</summary>
    public int Port { get; }
    public bool Disposed { get; private set; }
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
    public DirectHubHost(int port, HubOptions options, ILogger? logger = null, IClock? clock = null)
    {
        _o = options;
        _log = logger ?? Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance;
        Hub = new Hub(options, clock, _log);
        _listener = Bind(port);
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        Task.Run(AcceptLoop);
    }

    private static TcpListener Bind(int port)
    {
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
                try { upgraded = await Handshake(stream, hs.Token).ConfigureAwait(false); }
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
    /// Sec-WebSocket-Accept, or 400/426 for anything that is not a WebSocket upgrade.
    /// </summary>
    private static async Task<bool> Handshake(Stream stream, CancellationToken ct)
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
        if (!h.TryGetValue("Sec-WebSocket-Version", out var ver) || ver != "13")
        { await Reply(stream, "426 Upgrade Required", "Sec-WebSocket-Version: 13\r\n", ct).ConfigureAwait(false); return false; }

        string accept = AcceptKey(key);
        var ok = Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
        await stream.WriteAsync(ok, 0, ok.Length, ct).ConfigureAwait(false);
        return true;
    }

    /// <summary>RFC 6455 s.4.2.2: base64(SHA-1(key + GUID)).</summary>
    public static string AcceptKey(string key) =>
        Convert.ToBase64String(Compat.Sha1(Encoding.ASCII.GetBytes(key.Trim() + WebSocketGuid)));

    private static async Task Reply(Stream stream, string status, string? extraHeaders, CancellationToken ct)
    {
        const string body = "OneLobby direct host (lk1): connect over WebSocket\n";
        var bytes = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + "\r\nContent-Type: text/plain\r\nConnection: close\r\n" + (extraHeaders ?? "")
                                            + "Content-Length: " + body.Length + "\r\n\r\n" + body);
        try { await stream.WriteAsync(bytes, 0, bytes.Length, ct).ConfigureAwait(false); } catch (Exception) { }
    }

    /// <summary>Stops listening and closes every joiner socket.</summary>
    public void Dispose()
    {
        if (Disposed) return;
        Disposed = true;
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
