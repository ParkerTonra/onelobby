using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace OneLobby
{
    /// <summary>What <see cref="ConnectionCheck.CheckAsync"/> measures with.</summary>
    public sealed class CheckOptions
    {
        /// <summary>STUN URLs to ask; default the two the clients connect with.</summary>
        public IReadOnlyList<string>? Stun { get; init; }
        /// <summary>The player's TURN entry (or entries); the first <c>turn:</c> one is tested. Default none.</summary>
        public IReadOnlyList<IceServer>? IceServers { get; init; }
        /// <summary>Give up on the whole check after this long (default 8000 ms).</summary>
        public int TimeoutMs { get; init; } = ConnectionCheck.WholeMs;
        /// <summary>How long each STUN or TURN server gets to answer, with one retransmit at a third of it (default 1500 ms).</summary>
        public int ServerTimeoutMs { get; init; } = ConnectionCheck.ServerMs;
        /// <summary>Bind the probe socket here (default: all interfaces, or 127.0.0.1 when every target is loopback).</summary>
        public string? BindAddress { get; init; }
        /// <summary>The clock seam: how a wait of <c>ms</c> milliseconds is spent (default <see cref="Task.Delay(int)"/>, the real clock). A test passes its own to control every timeout of the check (the whole-check limit, the retransmit, the per-server limit).</summary>
        public Func<int, Task>? Delay { get; init; }
    }

    /// <summary>STUN and TURN messages, hand-rolled (RFC 5389 / RFC 5766): what the check and the relay probe speak, and what test servers answer with.</summary>
    public static class StunMessages
    {
        private const uint Cookie = 0x2112a442;

        private static byte[] Header(int type, int bodyLen, byte[] tid)
        {
            var h = new byte[20];
            h[0] = (byte)(type >> 8); h[1] = (byte)type;
            h[2] = (byte)(bodyLen >> 8); h[3] = (byte)bodyLen;
            h[4] = 0x21; h[5] = 0x12; h[6] = 0xa4; h[7] = 0x42;
            Array.Copy(tid, 0, h, 8, 12);
            return h;
        }

        private static byte[] Attr(int type, byte[] value)
        {
            var padded = (value.Length + 3) & ~3;
            var a = new byte[4 + padded];
            a[0] = (byte)(type >> 8); a[1] = (byte)type;
            a[2] = (byte)(value.Length >> 8); a[3] = (byte)value.Length;
            Array.Copy(value, 0, a, 4, value.Length);
            return a;
        }

        private static byte[] Concat(params byte[][] parts)
        {
            var o = new byte[parts.Sum(p => p.Length)];
            var at = 0;
            foreach (var p in parts) { Array.Copy(p, 0, o, at, p.Length); at += p.Length; }
            return o;
        }

        /// <summary>An RFC 5389 Binding Request with transaction id <paramref name="tid"/> (12 bytes).</summary>
        public static byte[] BindingRequest(byte[] tid) => Header(0x0001, 0, tid);

        private sealed class Attribute { public int Type; public byte[] Value = Array.Empty<byte>(); }

        private static (int Type, List<Attribute> Attrs)? Parse(byte[] b, byte[]? tid)
        {
            if (b.Length < 20) return null;
            if (b[4] != 0x21 || b[5] != 0x12 || b[6] != 0xa4 || b[7] != 0x42) return null;
            var len = (b[2] << 8) | b[3];
            if (20 + len > b.Length) return null;
            if (tid != null) for (var i = 0; i < 12; i++) if (b[8 + i] != tid[i]) return null;
            var attrs = new List<Attribute>();
            var o = 20;
            while (o + 4 <= 20 + len)
            {
                var t = (b[o] << 8) | b[o + 1];
                var l = (b[o + 2] << 8) | b[o + 3];
                if (o + 4 + l > 20 + len) break;
                var v = new byte[l];
                Array.Copy(b, o + 4, v, 0, l);
                attrs.Add(new Attribute { Type = t, Value = v });
                o += 4 + ((l + 3) & ~3);
            }
            return ((b[0] << 8) | b[1], attrs);
        }

        /// <summary>The mapped address in a Binding success response for <paramref name="tid"/> (<c>XOR-MAPPED-ADDRESS</c>, else <c>MAPPED-ADDRESS</c>); null when there is none.</summary>
        public static (string Ip, int Port)? ParseBindingResponse(byte[] bytes, byte[] tid)
        {
            var m = Parse(bytes, tid);
            if (m == null || m.Value.Type != 0x0101) return null;
            foreach (var want in new[] { 0x0020, 0x0001 })
            {
                var a = m.Value.Attrs.FirstOrDefault(x => x.Type == want);
                if (a == null || a.Value.Length < 8 || a.Value[1] != 0x01) continue; // IPv4 only
                var v = a.Value;
                var port = (v[2] << 8) | v[3];
                var ip = new[] { (int)v[4], v[5], v[6], v[7] };
                if (want == 0x0020)
                {
                    port ^= (int)(Cookie >> 16);
                    ip[0] ^= 0x21; ip[1] ^= 0x12; ip[2] ^= 0xa4; ip[3] ^= 0x42;
                }
                return (string.Join(".", ip), port);
            }
            return null;
        }

        /// <summary>A Binding success response carrying <c>XOR-MAPPED-ADDRESS</c> <paramref name="ip"/>:<paramref name="port"/> (what test STUN servers answer).</summary>
        public static byte[] BindingResponse(byte[] tid, string ip, int port)
        {
            var v = new byte[8];
            v[1] = 0x01;
            var xp = port ^ (int)(Cookie >> 16);
            v[2] = (byte)(xp >> 8); v[3] = (byte)xp;
            var parts = ip.Split('.').Select(int.Parse).ToArray();
            var x = new[] { 0x21, 0x12, 0xa4, 0x42 };
            for (var i = 0; i < 4; i++) v[4 + i] = (byte)(parts[i] ^ x[i]);
            var a = Attr(0x0020, v);
            return Concat(Header(0x0101, a.Length, tid), a);
        }

        /// <summary>A TURN Allocate request for UDP. Without <paramref name="auth"/> it is the bare first request; with it, the long-term credential form.</summary>
        public static byte[] TurnAllocateRequest(byte[] tid, (string Username, string Realm, byte[] Nonce, string Password)? auth = null)
        {
            var transport = Attr(0x0019, new byte[] { 17, 0, 0, 0 });
            if (auth == null) return Concat(Header(0x0003, transport.Length, tid), transport);
            var a = auth.Value;
            var body = Concat(transport, Attr(0x0006, Encoding.UTF8.GetBytes(a.Username)), Attr(0x0014, Encoding.UTF8.GetBytes(a.Realm)), Attr(0x0015, a.Nonce));
            // MESSAGE-INTEGRITY covers the message up to itself, with the header length counting the 24-byte attribute
#pragma warning disable CA5351
            byte[] key;
            using (var md5 = MD5.Create()) key = md5.ComputeHash(Encoding.UTF8.GetBytes(a.Username + ":" + a.Realm + ":" + a.Password));
#pragma warning restore CA5351
            var pre = Concat(Header(0x0003, body.Length + 24, tid), body);
            byte[] mac;
            using (var h = new HMACSHA1(key)) mac = h.ComputeHash(pre);
            return Concat(pre, Attr(0x0008, mac));
        }

        /// <summary>What a TURN server answered: success, or an error code with the realm and nonce it wants (for the 401 round); null when it is not an answer for <paramref name="tid"/>.</summary>
        public static (bool Ok, int Code, string? Realm, byte[]? Nonce)? ParseTurnResponse(byte[] bytes, byte[] tid)
        {
            var m = Parse(bytes, tid);
            if (m == null) return null;
            if (m.Value.Type == 0x0103) return (true, 0, null, null);
            if (m.Value.Type != 0x0113) return null;
            var e = m.Value.Attrs.FirstOrDefault(a => a.Type == 0x0009);
            var code = e != null && e.Value.Length >= 4 ? (e.Value[2] & 7) * 100 + e.Value[3] : 0;
            var realm = m.Value.Attrs.FirstOrDefault(a => a.Type == 0x0014);
            var nonce = m.Value.Attrs.FirstOrDefault(a => a.Type == 0x0015);
            return (false, code, realm != null ? Encoding.UTF8.GetString(realm.Value) : null, nonce?.Value);
        }

        /// <summary>The transaction id of a STUN message (bytes 8..20), or null when it is too short.</summary>
        public static byte[]? TransactionId(byte[] bytes)
        {
            if (bytes.Length < 20) return null;
            var t = new byte[12];
            Array.Copy(bytes, 8, t, 0, 12);
            return t;
        }

        /// <summary>The message type (first two bytes).</summary>
        public static int TypeOf(byte[] bytes) => bytes.Length < 2 ? -1 : (bytes[0] << 8) | bytes[1];
    }

    /// <summary>
    /// The connection check (spec/diagnostics.md s.8): UDP, NAT type and relay login, measured with raw UDP from one
    /// socket against the STUN servers the client already uses and the player's own TURN entry, and nothing else.
    /// </summary>
    public static class ConnectionCheck
    {
        public const int ServerMs = 1500;
        public const int RetransmitMs = 500;
        public const int WholeMs = 8000;
        public static readonly IReadOnlyList<string> DefaultStun = new[] { "stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478" };

        /// <summary><c>host</c> and <c>port</c> of a <c>stun:</c> / <c>turn:</c> URL (UDP only: <c>stuns:</c>, <c>turns:</c> and a tcp transport give null).</summary>
        public static (string Host, int Port)? IceUrlTarget(string url)
        {
            var m = System.Text.RegularExpressions.Regex.Match(url.Trim(), @"^(stun|turn):([^:?\s/]+)(?::([0-9]+))?(\?\S*)?\z", System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant);
            if (!m.Success) return null;
            if (m.Groups[4].Success && m.Groups[4].Value.IndexOf("transport=tcp", StringComparison.OrdinalIgnoreCase) >= 0) return null;
            return (m.Groups[2].Value, m.Groups[3].Success ? int.Parse(m.Groups[3].Value) : 3478);
        }

        /// <summary>True when every target is a loopback address: such a check binds 127.0.0.1, not all interfaces (spec/diagnostics.md s.8).</summary>
        public static bool AllLoopback(IEnumerable<(string Host, int Port)> targets)
        {
            var list = targets.ToList();
            return list.Count > 0 && list.All(t =>
                string.Equals(t.Host, "localhost", StringComparison.OrdinalIgnoreCase)
                || (IPAddress.TryParse(t.Host.Trim('[', ']'), out var ip) && IPAddress.IsLoopback(ip)));
        }

        private static (string Host, int Port)? TurnTarget(IceServer s) =>
            s.Urls.Where(u => u.StartsWith("turn:", StringComparison.OrdinalIgnoreCase)).Select(IceUrlTarget).FirstOrDefault(t => t != null);

        /// <summary>A UDP socket with a receive loop; <see cref="Exchange"/> sends and waits for a parsed answer, with one retransmit.</summary>
        private sealed class Probe : IDisposable
        {
            private readonly UdpClient _udp;
            private readonly List<Action<byte[]>> _listeners = new List<Action<byte[]>>();
            private readonly object _lock = new object();
            private bool _closed;
            private readonly Func<int, Task> _delay;
            public int LocalPort { get; }
            public IReadOnlyList<string> LocalAddresses { get; }

            public Probe(string? bind, Func<int, Task>? delay = null)
            {
                _delay = delay ?? Task.Delay;
                var addr = bind == null ? IPAddress.Any : IPAddress.Parse(bind);
                _udp = new UdpClient(new IPEndPoint(addr, 0));
                LocalPort = ((IPEndPoint)_udp.Client.LocalEndPoint!).Port;
                LocalAddresses = bind != null && bind != "0.0.0.0" ? new[] { bind } : Locals();
                _ = Loop();
            }

            private static string[] Locals()
            {
                try
                {
                    return NetworkInterface.GetAllNetworkInterfaces()
                        .SelectMany(n => n.GetIPProperties().UnicastAddresses)
                        .Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork)
                        .Select(a => a.Address.ToString()).ToArray();
                }
                catch (Exception) { return Array.Empty<string>(); }
            }

            private async Task Loop()
            {
                while (!_closed)
                {
                    UdpReceiveResult r;
                    try { r = await _udp.ReceiveAsync().ConfigureAwait(false); }
                    catch (Exception) { if (_closed) return; continue; } // an ICMP error from a closed port: keep listening
                    Action<byte[]>[] ls;
                    lock (_lock) ls = _listeners.ToArray();
                    foreach (var l in ls) l(r.Buffer);
                }
            }

            public static async Task<IPAddress?> Resolve(string host)
            {
                if (IPAddress.TryParse(host.Trim('[', ']'), out var ip)) return ip;
                try
                {
                    var all = await Dns.GetHostAddressesAsync(host).ConfigureAwait(false);
                    return all.FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork);
                }
                catch (Exception) { return null; }
            }

            public async Task<T?> Exchange<T>((string Host, int Port) target, byte[] request, Func<byte[], T?> parse, int ms) where T : struct
            {
                var ip = await Resolve(target.Host).ConfigureAwait(false);
                if (ip == null) return null; // the name does not resolve: nothing can answer
                var ep = new IPEndPoint(ip, target.Port);
                var tcs = new TaskCompletionSource<T?>(TaskCreationOptions.RunContinuationsAsynchronously);
                void On(byte[] b)
                {
                    var v = parse(b);
                    if (v != null) tcs.TrySetResult(v);
                }
                lock (_lock) _listeners.Add(On);
                try
                {
                    void Send() { try { _udp.Client.SendTo(request, ep); } catch (Exception) { /* nothing listening: the timeout says so */ } }
                    Send();
                    var first = _delay(Math.Min(RetransmitMs, ms / 3));
                    if (await Task.WhenAny(tcs.Task, first).ConfigureAwait(false) != tcs.Task) Send();
                    var rest = _delay(ms);
                    await Task.WhenAny(tcs.Task, rest).ConfigureAwait(false);
                    return tcs.Task.IsCompleted ? tcs.Task.Result : null;
                }
                finally { lock (_lock) _listeners.Remove(On); }
            }

            public void Dispose()
            {
                if (_closed) return;
                _closed = true;
                try { _udp.Close(); } catch (Exception) { /* already closed */ }
            }
        }

        private static byte[] RandomBytes(int n)
        {
            var b = new byte[n];
            using (var r = RandomNumberGenerator.Create()) r.GetBytes(b);
            return b;
        }

        private static async Task<(string Ip, int Port)?> ProbeStun(Probe p, (string Host, int Port) t, int ms)
        {
            var tid = RandomBytes(12);
            var req = StunMessages.BindingRequest(tid);
            return await p.Exchange(t, req, b => StunMessages.ParseBindingResponse(b, tid), ms).ConfigureAwait(false);
        }

        /// <summary>The TURN login round trip (RFC 5766 long-term credentials) against a <c>turn:</c> entry: <c>ok</c>, <c>refused</c>, <c>unreachable</c>, or <c>unknown</c> (a <c>turns:</c> URL or tcp transport cannot be tested this way).</summary>
        private static async Task<string> ProbeTurn(Probe p, IceServer s, int ms)
        {
            var t = TurnTarget(s);
            if (t == null) return "unknown";
            var tid1 = RandomBytes(12);
            var first = StunMessages.TurnAllocateRequest(tid1);
            var r1 = await p.Exchange(t.Value, first, b => StunMessages.ParseTurnResponse(b, tid1), ms).ConfigureAwait(false);
            if (r1 == null) return "unreachable";
            if (r1.Value.Ok) return "ok"; // an open relay
            if (r1.Value.Code != 401 || r1.Value.Realm == null || r1.Value.Nonce == null) return "refused";
            if (string.IsNullOrEmpty(s.Username) || string.IsNullOrEmpty(s.Credential)) return "refused";
            var tid2 = RandomBytes(12);
            var second = StunMessages.TurnAllocateRequest(tid2, (s.Username!, r1.Value.Realm, r1.Value.Nonce, s.Credential!));
            var r2 = await p.Exchange(t.Value, second, b => StunMessages.ParseTurnResponse(b, tid2), ms).ConfigureAwait(false);
            if (r2 == null) return "unreachable";
            return r2.Value.Ok ? "ok" : "refused";
        }

        /// <summary>
        /// Probes a relay entry on its own (a fresh UDP socket): <c>ok</c>, <c>refused</c> (the server answered and turned the
        /// login down), <c>unreachable</c> (no answer) or <c>unknown</c>. A lobby uses it to tell <c>relay_refused</c> from
        /// <c>relay_unreachable</c> after a failed connect.
        /// </summary>
        public static async Task<string> ProbeRelayAsync(IceServer s, int ms = ServerMs, Func<int, Task>? delay = null)
        {
            try
            {
                var t = TurnTarget(s);
                if (t == null) return "unknown";
                using var p = new Probe(AllLoopback(new[] { t.Value }) ? "127.0.0.1" : null, delay);
                return await ProbeTurn(p, s, ms).ConfigureAwait(false);
            }
            catch (Exception) { return "unknown"; }
        }

        /// <summary>
        /// Checks what this network allows: whether UDP gets out, the NAT's behaviour, and whether a configured relay takes
        /// the login. Nothing is contacted but the STUN servers (default: the ones the client connects with) and the player's
        /// own TURN entry. Run it from a menu; the library never runs it by itself.
        /// </summary>
        public static async Task<CheckResult> CheckAsync(CheckOptions? options = null)
        {
            var o = options ?? new CheckOptions();
            var stun = o.Stun ?? DefaultStun;
            var turn = (o.IceServers ?? Array.Empty<IceServer>()).FirstOrDefault(s => s.Urls.Any(u => u.StartsWith("turn:", StringComparison.OrdinalIgnoreCase) || u.StartsWith("turns:", StringComparison.OrdinalIgnoreCase)));
            var findings = new CheckFindings("unknown", "unknown", turn != null ? "unknown" : "none");
            var whole = (o.Delay ?? Task.Delay)(o.TimeoutMs); // started before the run: a test's clock sees the whole-check limit first
            var run = Task.Run(() => CheckRaw(o, stun, turn));
            var winner = await Task.WhenAny(run, whole).ConfigureAwait(false);
            if (winner == run)
            {
                try { findings = await run.ConfigureAwait(false); } catch (Exception) { /* no socket: unknown */ }
            }
            var (verdict, message) = Diagnose.CheckVerdict(findings);
            return new CheckResult(findings.Udp, findings.NatType, findings.Relay, verdict, message);
        }

        private static async Task<CheckFindings> CheckRaw(CheckOptions o, IReadOnlyList<string> stun, IceServer? turn)
        {
            var targets = stun.Select(IceUrlTarget).Where(t => t != null).Select(t => t!.Value).ToList();
            var all = new List<(string Host, int Port)>(targets);
            if (turn != null && TurnTarget(turn) is { } tt) all.Add(tt);
            using var p = new Probe(o.BindAddress ?? (AllLoopback(all) ? "127.0.0.1" : null), o.Delay);
            // the servers are asked one after the other from the same socket: a NAT that maps by destination shows two ports
            var answers = new List<(string Ip, int Port)>();
            foreach (var t in targets)
            {
                var a = await ProbeStun(p, t, o.ServerTimeoutMs).ConfigureAwait(false);
                if (a != null) answers.Add(a.Value);
            }
            var mine = answers.Count > 0 && p.LocalAddresses.Contains(answers[0].Ip) ? (answers[0].Ip, p.LocalPort) : ("", p.LocalPort);
            var (udp, nat) = Diagnose.ClassifyNat(targets.Count, answers, mine);
            var relay = turn != null ? await ProbeTurn(p, turn, o.ServerTimeoutMs).ConfigureAwait(false) : "none";
            return new CheckFindings(udp, nat, relay);
        }
    }
}
