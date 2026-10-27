using System.Globalization;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Xml.Linq;

namespace OneLobby.Server;

public enum PortMapMethod { None, Upnp, NatPmp }

/// <summary>What <see cref="PortMapper.OpenAsync"/> found. <see cref="Mapped"/> means TCP and UDP <c>P</c> both forward here.</summary>
public sealed class PortMapResult
{
    public bool Mapped { get; init; }
    public PortMapMethod Method { get; init; }
    /// <summary>The router's WAN address as it reports it (may itself be private or carrier-grade NAT).</summary>
    public string? ExternalIPv4 { get; init; }
    /// <summary>This PC's address on the router's network, when the router was found.</summary>
    public string? LocalIPv4 { get; init; }
    /// <summary>Why nothing was mapped, for logs ("no UPnP or NAT-PMP answer", "UPnP error 718 ConflictInMappingEntry").</summary>
    public string Detail { get; init; } = "";
}

/// <summary>Seams for tests (a fake gateway on loopback) and the few knobs a game might want.</summary>
public sealed class PortMapperOptions
{
    /// <summary>Where the SSDP M-SEARCH goes; default the UPnP multicast group.</summary>
    public IPEndPoint SsdpEndpoint { get; set; } = new(IPAddress.Parse("239.255.255.250"), 1900);
    /// <summary>NAT-PMP server; null = this PC's default IPv4 gateways, port 5351.</summary>
    public IPEndPoint? NatPmpEndpoint { get; set; }
    public TimeSpan DiscoveryTimeout { get; set; } = TimeSpan.FromSeconds(2);
    public TimeSpan RequestTimeout { get; set; } = TimeSpan.FromSeconds(3);
    /// <summary>Lease asked for; renewed at half of it while hosting. Routers that only allow permanent leases get 0.</summary>
    public int LeaseSeconds { get; set; } = 7200;
    public string Description { get; set; } = "OneLobby";
    public bool TryUpnp { get; set; } = true;
    public bool TryNatPmp { get; set; } = true;
    /// <summary>
    /// Direct host only (<c>HostDirectAsync</c>): when nothing was mapped, ask the router again after this many ms, doubling up
    /// to 5 minutes, until it answers or the host quits (a router still booting after a power cut, UPnP switched back on).
    /// Default 30000; 0 never asks again.
    /// </summary>
    public int RetryMs { get; set; } = 30000;
    /// <summary>
    /// Optional log hook; null (default) stays quiet. Gets one line when the host quits and its mappings are deleted:
    /// <c>direct host mapping deleted port=47810 protocols=TCP,UDP mapping=UPnP</c>.
    /// </summary>
    public Action<string>? Log { get; set; }
}

/// <summary>
/// Opens TCP and UDP <c>P</c> on the home router for a direct-IP host (docs/design/direct-ip.md s.2a): UPnP IGD (SSDP, then
/// <c>GetExternalIPAddress</c> + <c>AddPortMapping</c>), then NAT-PMP (RFC 6886; most PCP routers answer it too).
/// These are requests from inside the home to the player's own router; CERT VU#357851 is about routers that accept
/// them from the WAN. Same external and internal port or nothing: a join code carries one port number. Leases renew
/// at half-life; <see cref="Dispose"/> deletes the mappings (best effort, about two seconds), even mid-<see cref="OpenAsync"/>.
/// </summary>
public sealed class PortMapper : IDisposable
{
    private static readonly string[] SearchTargets =
    {
        "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
        "urn:schemas-upnp-org:device:InternetGatewayDevice:2",
        "urn:schemas-upnp-org:service:WANIPConnection:1",
    };
    private static readonly string[] ServiceTypes =
    {
        "urn:schemas-upnp-org:service:WANIPConnection:2",
        "urn:schemas-upnp-org:service:WANIPConnection:1",
        "urn:schemas-upnp-org:service:WANPPPConnection:1",
    };

    private readonly int _port;
    private readonly PortMapperOptions _o;
    private readonly HttpClient _http;
    private readonly CancellationTokenSource _cts = new();
    private PortMapResult? _result;
    private Uri? _control;
    private string _service = "";
    private int _lease;
    private IPEndPoint? _natPmp;
    private Task? _renewer;
    private Task? _opening;
    // Every mapping a request was sent for and the router did not refuse ("upnp TCP", "pmp 1", ...): what Dispose
    // deletes. Added before the request goes out, so a host that quits mid-request still undoes it.
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, byte> _maybeMapped = new();

    public int Port => _port;
    public PortMapResult? Result => _result;
    /// <summary>True once <see cref="Dispose"/> ran: no more requests go out.</summary>
    public bool Closed => _cts.IsCancellationRequested;

    public PortMapper(int port, PortMapperOptions? options = null)
    {
        if (port < 1 || port > 65535) throw new ArgumentOutOfRangeException(nameof(port));
        _port = port;
        _o = options ?? new PortMapperOptions();
        _http = new HttpClient { Timeout = _o.RequestTimeout };
        // One connection per request: some routers close after each reply without saying so, and a
        // pooled connection then fails every second request.
        _http.DefaultRequestHeaders.ConnectionClose = true;
    }

    /// <summary>Finds the router and maps TCP + UDP <c>P</c>. Never throws for network trouble: see <see cref="PortMapResult.Detail"/>. May run again after an unmapped result.</summary>
    public Task<PortMapResult> OpenAsync(CancellationToken ct = default)
    {
        var t = OpenCoreAsync(ct);
        _opening = t;
        return t;
    }

    private async Task<PortMapResult> OpenCoreAsync(CancellationToken outer)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(outer, _cts.Token);
        try { return await TryBothAsync(linked.Token).ConfigureAwait(false); }
        catch (OperationCanceledException) when (_cts.IsCancellationRequested && !outer.IsCancellationRequested)
        {
            return new PortMapResult { Detail = "closed before the router answered" };
        }
    }

    private async Task<PortMapResult> TryBothAsync(CancellationToken ct)
    {
        var notes = new List<string>();
        if (_o.TryUpnp)
        {
            try
            {
                var r = await TryUpnpAsync(ct).ConfigureAwait(false);
                if (r != null) return Done(r);
                notes.Add("no UPnP gateway answered");
            }
            catch (Exception e) when (!ct.IsCancellationRequested) { notes.Add("UPnP: " + e.Message); }
        }
        if (_o.TryNatPmp)
        {
            try
            {
                var r = await TryNatPmpAsync(ct).ConfigureAwait(false);
                if (r != null) return Done(r);
                notes.Add("no NAT-PMP answer");
            }
            catch (Exception e) when (!ct.IsCancellationRequested) { notes.Add("NAT-PMP: " + e.Message); }
        }
        return _result = new PortMapResult { Detail = string.Join("; ", notes), LocalIPv4 = _result?.LocalIPv4 };
    }

    private PortMapResult Done(PortMapResult r)
    {
        _result = r;
        if (r.Mapped && _renewer == null && !_cts.IsCancellationRequested)
        {
            var every = TimeSpan.FromSeconds(Math.Max(30, (_lease > 0 ? _lease : _o.LeaseSeconds) / 2));
            if (_lease > 0 || r.Method == PortMapMethod.NatPmp) _renewer = Task.Run(() => RenewLoop(every));
        }
        return r;
    }

    private async Task RenewLoop(TimeSpan every)
    {
        while (!_cts.IsCancellationRequested)
        {
            try { await Task.Delay(every, _cts.Token).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }
            try
            {
                if (_result?.Method == PortMapMethod.Upnp) await AddUpnpBoth(_result.LocalIPv4!, _lease, _cts.Token).ConfigureAwait(false);
                else if (_result?.Method == PortMapMethod.NatPmp) await NatPmpMapBoth(_o.LeaseSeconds, _cts.Token).ConfigureAwait(false);
            }
            catch (Exception) { /* the next round tries again; the old lease still has half its life */ }
        }
    }

    // ------------------------------------------------------------------------------------------------ UPnP IGD

    private async Task<PortMapResult?> TryUpnpAsync(CancellationToken ct)
    {
        var location = await DiscoverAsync(ct).ConfigureAwait(false);
        if (location == null) return null;
        var desc = ParseXml(await _http.GetByteArrayAsync(location).ConfigureAwait(false));
        XNamespace ns = desc.Root?.Name.Namespace ?? XNamespace.None;
        var baseText = desc.Root?.Element(ns + "URLBase")?.Value;
        var baseUri = !string.IsNullOrWhiteSpace(baseText) && Uri.TryCreate(baseText, UriKind.Absolute, out var bu) ? bu : location;
        foreach (var type in ServiceTypes)
        {
            var svc = desc.Descendants(ns + "service").FirstOrDefault(s => (s.Element(ns + "serviceType")?.Value ?? "").Trim() == type);
            var ctl = svc?.Element(ns + "controlURL")?.Value?.Trim();
            if (string.IsNullOrEmpty(ctl)) continue;
            _control = new Uri(baseUri, ctl);
            _service = type;
            break;
        }
        if (_control == null) return new PortMapResult { Detail = "UPnP gateway has no WANIPConnection service" };

        var local = LocalAddressToward(_control.Host, _control.Port);
        string? external = null;
        try
        {
            var reply = await SoapAsync("GetExternalIPAddress", Array.Empty<(string, string)>(), ct).ConfigureAwait(false);
            external = reply.Descendants().FirstOrDefault(e => e.Name.LocalName == "NewExternalIPAddress")?.Value?.Trim();
        }
        catch (UpnpException) { /* some routers refuse this but still map */ }

        _lease = _o.LeaseSeconds;
        try { await AddUpnpBoth(local, _lease, ct).ConfigureAwait(false); }
        catch (UpnpException e) when (e.Code == 725) // OnlyPermanentLeasesSupported
        {
            _lease = 0;
            await AddUpnpBoth(local, 0, ct).ConfigureAwait(false);
        }
        catch (UpnpException e)
        {
            return new PortMapResult { Method = PortMapMethod.Upnp, ExternalIPv4 = external, LocalIPv4 = local, Detail = "UPnP " + e.Message };
        }
        return new PortMapResult { Mapped = true, Method = PortMapMethod.Upnp, ExternalIPv4 = external, LocalIPv4 = local, Detail = "UPnP" };
    }

    private async Task AddUpnpBoth(string local, int lease, CancellationToken ct)
    {
        foreach (var proto in new[] { "TCP", "UDP" })
        {
            ct.ThrowIfCancellationRequested();
            _maybeMapped["upnp " + proto] = 0;
            try
            {
                await SoapAsync("AddPortMapping", new[]
                {
                    ("NewRemoteHost", ""), ("NewExternalPort", P()), ("NewProtocol", proto), ("NewInternalPort", P()),
                    ("NewInternalClient", local), ("NewEnabled", "1"), ("NewPortMappingDescription", _o.Description),
                    ("NewLeaseDuration", lease.ToString(CultureInfo.InvariantCulture)),
                }, ct).ConfigureAwait(false);
            }
            catch (UpnpException)
            {
                // refused (e.g. 718: another device holds the port): not ours, so Dispose must not delete it
                _maybeMapped.TryRemove("upnp " + proto, out _);
                throw;
            }
        }
    }

    private string P() => _port.ToString(CultureInfo.InvariantCulture);

    /// <summary>
    /// SSDP search. Multicast goes out once per interface that has an IPv4 gateway (so a Hyper-V, WSL or Docker adapter
    /// cannot swallow it) and once more unicast to each gateway. Windows Firewall drops the replies on a network marked
    /// Public; the mapper then finds nothing and the host gets a same-network code.
    /// </summary>
    private async Task<Uri?> DiscoverAsync(CancellationToken ct)
    {
        var sockets = new List<UdpClient>();
        try
        {
            var multicast = _o.SsdpEndpoint.Address.GetAddressBytes()[0] >= 224;
            var locals = multicast ? GatewayInterfaces().ToList() : new List<(IPAddress Local, IPAddress Gateway)>();
            if (locals.Count == 0) locals.Add((IPAddress.Any, IPAddress.None));
            foreach (var (local, gw) in locals)
            {
                UdpClient udp;
                try { udp = new UdpClient(new IPEndPoint(local, 0)); }
                catch (SocketException) { continue; }
                sockets.Add(udp);
                try
                {
                    udp.Client.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.MulticastTimeToLive, 2);
                    if (!local.Equals(IPAddress.Any))
                        udp.Client.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.MulticastInterface, local.GetAddressBytes());
                }
                catch (SocketException) { /* not fatal: the OS default interface is used */ }
                foreach (var st in SearchTargets)
                {
                    var bytes = Encoding.ASCII.GetBytes("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: " + st + "\r\n\r\n");
                    try
                    {
                        await udp.SendAsync(bytes, bytes.Length, _o.SsdpEndpoint).ConfigureAwait(false);
                        if (!gw.Equals(IPAddress.None)) await udp.SendAsync(bytes, bytes.Length, new IPEndPoint(gw, 1900)).ConfigureAwait(false);
                    }
                    catch (SocketException) { /* this interface cannot send; the others may */ }
                }
            }
            var deadline = DateTime.UtcNow + _o.DiscoveryTimeout;
            var pending = sockets.ToDictionary(s => (Task)s.ReceiveAsync(), s => s);
            while (pending.Count > 0)
            {
                var left = deadline - DateTime.UtcNow;
                if (left <= TimeSpan.Zero) return null;
                var delay = Task.Delay(left, ct);
                var done = await Task.WhenAny(pending.Keys.Append(delay)).ConfigureAwait(false);
                if (done == delay)
                {
                    ct.ThrowIfCancellationRequested();
                    return null;
                }
                var udp = pending[done];
                pending.Remove(done);
                UdpReceiveResult got;
                try { got = await ((Task<UdpReceiveResult>)done).ConfigureAwait(false); }
                catch (SocketException) { pending[udp.ReceiveAsync()] = udp; continue; } // ICMP noise on Windows
                pending[udp.ReceiveAsync()] = udp;
                if (ParseSsdp(Encoding.ASCII.GetString(got.Buffer)) is { } uri) return uri;
            }
            return null;
        }
        finally
        {
            foreach (var s in sockets) s.Dispose();
        }
    }

    private static Uri? ParseSsdp(string text)
    {
        string? location = null;
        var gateway = false;
        foreach (var line in text.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries))
        {
            var colon = line.IndexOf(':');
            if (colon < 0) continue;
            var name = line.Substring(0, colon).Trim();
            var value = line.Substring(colon + 1).Trim();
            if (name.Equals("LOCATION", StringComparison.OrdinalIgnoreCase)) location = value;
            if ((name.Equals("ST", StringComparison.OrdinalIgnoreCase) || name.Equals("USN", StringComparison.OrdinalIgnoreCase))
                && (value.Contains("InternetGatewayDevice") || value.Contains("WANIPConnection"))) gateway = true;
        }
        return gateway && location != null && Uri.TryCreate(location, UriKind.Absolute, out var uri) ? uri : null;
    }

    /// <summary>Each up interface's IPv4 address paired with its IPv4 default gateway.</summary>
    private static IEnumerable<(IPAddress Local, IPAddress Gateway)> GatewayInterfaces()
    {
        NetworkInterface[] nics;
        try { nics = NetworkInterface.GetAllNetworkInterfaces(); }
        catch (Exception) { yield break; }
        foreach (var nic in nics)
        {
            if (nic.OperationalStatus != OperationalStatus.Up) continue;
            IPInterfaceProperties props;
            try { props = nic.GetIPProperties(); }
            catch (Exception) { continue; }
            var gw = props.GatewayAddresses.Select(g => g.Address)
                .FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork && !a.Equals(IPAddress.Any));
            if (gw == null) continue;
            foreach (var ua in props.UnicastAddresses)
                if (ua.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(ua.Address))
                    yield return (ua.Address, gw);
        }
    }

    private sealed class UpnpException : Exception
    {
        public int Code { get; }
        public UpnpException(int code, string message) : base(message) { Code = code; }
    }

    private async Task<XDocument> SoapAsync(string action, (string Name, string Value)[] args, CancellationToken ct)
    {
        var body = new StringBuilder();
        body.Append("<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" ")
            .Append("s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:").Append(action)
            .Append(" xmlns:u=\"").Append(_service).Append("\">");
        foreach (var (name, value) in args)
            body.Append('<').Append(name).Append('>').Append(System.Security.SecurityElement.Escape(value)).Append("</").Append(name).Append('>');
        body.Append("</u:").Append(action).Append("></s:Body></s:Envelope>");
        using var req = new HttpRequestMessage(HttpMethod.Post, _control) { Content = new StringContent(body.ToString(), Encoding.UTF8, "text/xml") };
        req.Headers.TryAddWithoutValidation("SOAPAction", "\"" + _service + "#" + action + "\"");
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        var bytes = await res.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
        XDocument doc;
        try { doc = ParseXml(bytes); }
        catch (System.Xml.XmlException) { throw new UpnpException(0, action + " answered HTTP " + (int)res.StatusCode); }
        if (!res.IsSuccessStatusCode)
        {
            var code = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "errorCode")?.Value;
            var desc = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "errorDescription")?.Value;
            int.TryParse(code, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n);
            throw new UpnpException(n, action + " error " + (code ?? ((int)res.StatusCode).ToString(CultureInfo.InvariantCulture)) + " " + (desc ?? ""));
        }
        return doc;
    }

    /// <summary>
    /// Parses a router's XML from raw bytes, so the encoding comes from the BOM or XML declaration (UTF-8 by default),
    /// never from the Content-Type charset: Mono throws on a quoted <c>charset="utf-8"</c>, and some routers send
    /// names no runtime knows.
    /// </summary>
    private static XDocument ParseXml(byte[] bytes)
    {
        using var stream = new System.IO.MemoryStream(bytes);
        return XDocument.Load(stream);
    }

    /// <summary>The local IPv4 the OS would use to reach the router (UDP connect sends nothing).</summary>
    private static string LocalAddressToward(string host, int port)
    {
        using var s = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
        var ip = IPAddress.TryParse(host, out var a) ? a : Dns.GetHostAddresses(host).First(x => x.AddressFamily == AddressFamily.InterNetwork);
        s.Connect(new IPEndPoint(ip, port > 0 ? port : 80));
        return ((IPEndPoint)s.LocalEndPoint!).Address.ToString();
    }

    // ------------------------------------------------------------------------------------------------ NAT-PMP

    private async Task<PortMapResult?> TryNatPmpAsync(CancellationToken ct)
    {
        foreach (var gw in NatPmpCandidates())
        {
            var ext = await NatPmpRequest(gw, new byte[] { 0, 0 }, 12, ct).ConfigureAwait(false);
            if (ext == null) continue;
            _natPmp = gw;
            var local = LocalAddressToward(gw.Address.ToString(), gw.Port);
            var external = ResultCode(ext) == 0 ? new IPAddress(new[] { ext[8], ext[9], ext[10], ext[11] }).ToString() : null;
            var err = await NatPmpMapBoth(_o.LeaseSeconds, ct).ConfigureAwait(false);
            if (err != null) return new PortMapResult { Method = PortMapMethod.NatPmp, ExternalIPv4 = external, LocalIPv4 = local, Detail = "NAT-PMP " + err };
            return new PortMapResult { Mapped = true, Method = PortMapMethod.NatPmp, ExternalIPv4 = external, LocalIPv4 = local, Detail = "NAT-PMP" };
        }
        return null;
    }

    private IEnumerable<IPEndPoint> NatPmpCandidates()
    {
        if (_o.NatPmpEndpoint != null) { yield return _o.NatPmpEndpoint; yield break; }
        foreach (var g in DefaultGateways()) yield return new IPEndPoint(g, 5351);
    }

    /// <summary>Maps UDP then TCP; null on success, else why. A different external port counts as failure (and is undone).</summary>
    private async Task<string?> NatPmpMapBoth(int lifetime, CancellationToken ct)
    {
        foreach (var op in new byte[] { 1, 2 })
        {
            ct.ThrowIfCancellationRequested();
            var key = "pmp " + op;
            _maybeMapped[key] = 0;
            var reply = await NatPmpRequest(_natPmp!, MapRequest(op, lifetime), 16, ct).ConfigureAwait(false);
            if (reply == null) return "no answer to the mapping request";
            if (ResultCode(reply) != 0)
            {
                _maybeMapped.TryRemove(key, out _);
                return "result code " + ResultCode(reply);
            }
            var mapped = (reply[10] << 8) | reply[11];
            if (lifetime > 0 && mapped != _port)
            {
                await NatPmpRequest(_natPmp!, MapRequest(op, 0), 16, ct).ConfigureAwait(false);
                _maybeMapped.TryRemove(key, out _);
                return "router offered port " + mapped + " instead of " + _port;
            }
        }
        return null;
    }

    private byte[] MapRequest(byte op, int lifetime) => new byte[]
    {
        0, op, 0, 0, (byte)(_port >> 8), (byte)_port, (byte)(lifetime > 0 ? _port >> 8 : 0), (byte)(lifetime > 0 ? _port : 0),
        (byte)(lifetime >> 24), (byte)(lifetime >> 16), (byte)(lifetime >> 8), (byte)lifetime,
    };

    private static int ResultCode(byte[] r) => (r[2] << 8) | r[3];

    /// <summary>RFC 6886 s.3.1 retransmission: 250 ms, doubling, 3 tries here (under 2 s). Null when nobody answers.</summary>
    private async Task<byte[]?> NatPmpRequest(IPEndPoint to, byte[] req, int replyLength, CancellationToken ct)
    {
        using var udp = new UdpClient(AddressFamily.InterNetwork);
        var wait = 250;
        for (var attempt = 0; attempt < 3; attempt++, wait *= 2)
        {
            await udp.SendAsync(req, req.Length, to).ConfigureAwait(false);
            var until = DateTime.UtcNow.AddMilliseconds(wait);
            while (DateTime.UtcNow < until)
            {
                var recv = udp.ReceiveAsync();
                var left = until - DateTime.UtcNow;
                if (left <= TimeSpan.Zero || await Task.WhenAny(recv, Task.Delay(left, ct)).ConfigureAwait(false) != recv) break;
                UdpReceiveResult got;
                try { got = await recv.ConfigureAwait(false); }
                catch (SocketException) { break; } // ICMP port unreachable on Windows: nobody listens
                var b = got.Buffer;
                if (b.Length >= replyLength && b[0] == 0 && b[1] == (byte)(req[1] + 128)) return b;
            }
            ct.ThrowIfCancellationRequested();
        }
        return null;
    }

    private static IEnumerable<IPAddress> DefaultGateways()
    {
        var seen = new HashSet<string>();
        NetworkInterface[] nics;
        try { nics = NetworkInterface.GetAllNetworkInterfaces(); }
        catch (Exception) { yield break; }
        foreach (var nic in nics)
        {
            if (nic.OperationalStatus != OperationalStatus.Up) continue;
            GatewayIPAddressInformationCollection gws;
            try { gws = nic.GetIPProperties().GatewayAddresses; }
            catch (Exception) { continue; }
            foreach (var g in gws)
                if (g.Address.AddressFamily == AddressFamily.InterNetwork && !g.Address.Equals(IPAddress.Any) && seen.Add(g.Address.ToString()))
                    yield return g.Address;
        }
    }

    // ------------------------------------------------------------------------------------------------ helpers

    /// <summary>
    /// True for an address the internet can route to: not private (RFC 1918), carrier-grade NAT (100.64/10), loopback,
    /// link-local, 0/8, or multicast/reserved (224+). A router that reports a non-public WAN address is itself behind NAT.
    /// </summary>
    public static bool IsPublicIPv4(string? address)
    {
        if (address == null || !IPAddress.TryParse(address, out var ip) || ip.AddressFamily != AddressFamily.InterNetwork) return false;
        var b = ip.GetAddressBytes();
        if (b[0] == 0 || b[0] == 10 || b[0] == 127 || b[0] >= 224) return false;
        if (b[0] == 100 && b[1] >= 64 && b[1] < 128) return false;
        if (b[0] == 169 && b[1] == 254) return false;
        if (b[0] == 172 && b[1] >= 16 && b[1] < 32) return false;
        if (b[0] == 192 && b[1] == 168) return false;
        return true;
    }

    /// <summary>
    /// Stops renewing, cancels an <see cref="OpenAsync"/> still in progress and deletes every mapping it may have made
    /// (best effort, bounded to about two seconds; blocks the caller, so a game can call it as it quits).
    /// </summary>
    public void Dispose()
    {
        if (_cts.IsCancellationRequested) return;
        _cts.Cancel();
        // let a cancelled open unwind first, so no mapping request goes out after the deletes
        try { _opening?.Wait(TimeSpan.FromMilliseconds(500)); } catch (Exception) { }
        var undo = _maybeMapped.Keys.ToList();
        if (undo.Count > 0)
        {
            using var quick = new CancellationTokenSource(TimeSpan.FromMilliseconds(1500));
            try
            {
                Task.WhenAll(undo.Select(k => k.StartsWith("upnp ", StringComparison.Ordinal)
                    ? (Task)SoapAsync("DeletePortMapping", new[] { ("NewRemoteHost", ""), ("NewExternalPort", P()), ("NewProtocol", k.Substring(5)) }, quick.Token)
                    : NatPmpOnce(MapRequest(byte.Parse(k.Substring(4), CultureInfo.InvariantCulture), 0))))
                    .Wait(TimeSpan.FromMilliseconds(1500));
            }
            catch (Exception) { /* the lease expires on its own */ }
            LogDeleted(undo);
        }
        _http.Dispose();
    }

    /// <summary>One line per mapping kind, e.g. <c>direct host mapping deleted port=47810 protocols=TCP,UDP mapping=UPnP</c>.</summary>
    private void LogDeleted(IEnumerable<string> keys)
    {
        if (_o.Log == null) return;
        foreach (var kind in keys.GroupBy(k => k.StartsWith("upnp ", StringComparison.Ordinal)))
        {
            var protos = kind.Select(k => kind.Key ? k.Substring(5) : k == "pmp 2" ? "TCP" : "UDP").Distinct().OrderBy(x => x, StringComparer.Ordinal);
            try { _o.Log("direct host mapping deleted port=" + P() + " protocols=" + string.Join(",", protos) + " mapping=" + (kind.Key ? "UPnP" : "NAT-PMP")); }
            catch (Exception) { /* a game's logger must not stop the quit */ }
        }
    }

    private async Task NatPmpOnce(byte[] req)
    {
        using var udp = new UdpClient(AddressFamily.InterNetwork);
        await udp.SendAsync(req, req.Length, _natPmp!).ConfigureAwait(false);
    }
}
