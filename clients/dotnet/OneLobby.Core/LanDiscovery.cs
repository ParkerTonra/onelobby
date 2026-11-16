using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace OneLobby
{
    // LAN discovery (spec/lan-discovery.md). A host answers a broadcast question on the local network; the player's game
    // (the finder) lists the answers. Question and answer only, never an announcement. Opt-in: nothing here opens a socket
    // unless the game turned it on (blueprint hosting.lan, or DirectHostOptions.Lan).

    /// <summary>The two datagrams of spec/lan-discovery.md, and the limits every client shares.</summary>
    public static class LanWire
    {
        public const int DefaultPort = 47840;
        public const int WireVersion = 1;
        public const int MaxDatagram = 512;
        public const int NameUnits = 24;
        /// <summary>Finder timers.</summary>
        public const int AskIntervalMs = 1000, MinGapMs = 400, RowTimeoutMs = 4000, MaxRows = 64, NoncesKept = 8;
        /// <summary>Host limits: answers per source address and in total per <see cref="RateWindowMs"/>; duplicate memory.</summary>
        public const int RatePerSource = 3, RateTotal = 50, RateWindowMs = 1000, DuplicateMs = 5000, DuplicatesKept = 32;

        private static readonly byte[] Magic = { 0x4f, 0x4c, 0x41, 0x4e };
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

        /// <summary>Byte limits (min, max) per string field.</summary>
        public static (int Min, int Max) GameIdLimit => (1, 64);
        public static (int Min, int Max) NetVersionLimit => (1, 32);
        public static (int Min, int Max) NameLimit => (0, 72);

        public static bool Fits(string s, (int Min, int Max) limit)
        {
            var n = Utf8.GetByteCount(s);
            return n >= limit.Min && n <= limit.Max;
        }

        public static byte[] EncodeQuestion(byte[] nonce, string gameId)
        {
            var w = Header(nonce, 1);
            Str(w, gameId, GameIdLimit);
            return w.ToArray();
        }

        public static byte[] EncodeAnswer(LanAnswerMessage a)
        {
            if (a.Port < 1 || a.Port > 65535) throw new ArgumentOutOfRangeException(nameof(a), "port");
            if (a.MaxPlayers < 1 || a.MaxPlayers > 255 || a.Players < 0 || a.Players > a.MaxPlayers) throw new ArgumentOutOfRangeException(nameof(a), "players");
            var w = Header(a.Nonce, 2);
            w.Add((byte)(a.Port >> 8)); w.Add((byte)(a.Port & 255)); w.Add((byte)a.Players); w.Add((byte)a.MaxPlayers); w.Add((byte)(a.Password ? 1 : 0));
            Str(w, a.GameId, GameIdLimit); Str(w, a.NetVersion, NetVersionLimit); Str(w, a.LobbyName, NameLimit); Str(w, a.HostName, NameLimit);
            return w.ToArray();
        }

        private static List<byte> Header(byte[] nonce, int type)
        {
            if (nonce == null || nonce.Length != 8) throw new ArgumentException("nonce is 8 bytes", nameof(nonce));
            var w = new List<byte>(Magic) { (byte)WireVersion, (byte)type };
            w.AddRange(nonce);
            return w;
        }

        private static void Str(List<byte> w, string s, (int Min, int Max) limit)
        {
            var b = Utf8.GetBytes(s);
            if (b.Length < limit.Min || b.Length > limit.Max) throw new ArgumentOutOfRangeException(nameof(s), "string of " + b.Length + " bytes is outside " + limit.Min + ".." + limit.Max);
            w.Add((byte)b.Length);
            w.AddRange(b);
        }

        private static byte[]? ReadHeader(byte[] b, int type)
        {
            if (b == null || b.Length < 14 || b.Length > MaxDatagram) return null;
            for (var i = 0; i < 4; i++) if (b[i] != Magic[i]) return null;
            if (b[4] != WireVersion || b[5] != type) return null;
            var nonce = new byte[8];
            Array.Copy(b, 6, nonce, 0, 8);
            return nonce;
        }

        private static bool ReadStr(byte[] b, ref int at, (int Min, int Max) limit, out string s)
        {
            s = "";
            if (at >= b.Length) return false;
            int n = b[at];
            if (n < limit.Min || n > limit.Max || at + 1 + n > b.Length) return false;
            try { s = Utf8.GetString(b, at + 1, n); }
            catch (ArgumentException) { return false; } // DecoderFallbackException: invalid UTF-8
            at += 1 + n;
            return true;
        }

        public static bool TryDecodeQuestion(byte[] b, out LanQuestion q)
        {
            q = default;
            var nonce = ReadHeader(b, 1);
            if (nonce == null) return false;
            var at = 14;
            if (!ReadStr(b, ref at, GameIdLimit, out var gid) || at != b.Length) return false;
            q = new LanQuestion(nonce, gid);
            return true;
        }

        public static bool TryDecodeAnswer(byte[] b, out LanAnswerMessage a)
        {
            a = default;
            var nonce = ReadHeader(b, 2);
            if (nonce == null || b.Length < 19) return false;
            var port = (b[14] << 8) | b[15];
            int players = b[16], max = b[17];
            if (port < 1 || max < 1 || players > max) return false;
            var at = 19;
            if (!ReadStr(b, ref at, GameIdLimit, out var gid) || !ReadStr(b, ref at, NetVersionLimit, out var nv)
                || !ReadStr(b, ref at, NameLimit, out var ln) || !ReadStr(b, ref at, NameLimit, out var hn) || at != b.Length) return false;
            a = new LanAnswerMessage(nonce, port, players, max, (b[18] & 1) != 0, gid, nv, ln, hn);
            return true;
        }

        /// <summary>"loopback", "private" or "link_local" for an IPv4 address; null for a public (or non-IPv4) one.</summary>
        public static string? SourceClass(string ip)
        {
            // four dotted decimals only: IPAddress.TryParse would also take "1" or "1.2"
            var parts = (ip ?? "").Split('.');
            if (parts.Length != 4 || parts.Any(p => p.Length == 0 || p.Length > 3 || !p.All(c => c >= '0' && c <= '9'))) return null;
            var n = parts.Select(int.Parse).ToArray();
            if (n.Any(x => x > 255)) return null;
            if (n[0] == 127) return "loopback";
            if (n[0] == 10 || (n[0] == 172 && n[1] >= 16 && n[1] <= 31) || (n[0] == 192 && n[1] == 168)) return "private";
            if (n[0] == 169 && n[1] == 254) return "link_local";
            return null;
        }

        /// <summary>Control characters and bidi overrides out, at most 24 UTF-16 units without splitting a pair (the hub's name rule).</summary>
        public static string CleanName(string s)
        {
            var r = new StringBuilder();
            foreach (var c in s ?? "")
            {
                if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) continue;
                r.Append(c);
            }
            if (r.Length > NameUnits)
            {
                r.Length = NameUnits;
                if (char.IsHighSurrogate(r[r.Length - 1])) r.Length--;
            }
            return r.ToString();
        }

        /// <summary>
        /// Where a finder asks by default: the limited broadcast 255.255.255.255 plus the directed broadcast of every network
        /// card that has a private or link-local IPv4 address (a PC with several cards sends the limited one out of one card only).
        /// </summary>
        public static IReadOnlyList<string> BroadcastTargets()
        {
            var targets = new List<string> { "255.255.255.255" };
            try
            {
                foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (nic.OperationalStatus != OperationalStatus.Up) continue;
                    foreach (var ua in nic.GetIPProperties().UnicastAddresses)
                    {
                        if (ua.Address.AddressFamily != AddressFamily.InterNetwork || ua.IPv4Mask == null) continue;
                        var c = SourceClass(ua.Address.ToString());
                        if (c != "private" && c != "link_local") continue;
                        var ip = ua.Address.GetAddressBytes(); var mask = ua.IPv4Mask.GetAddressBytes();
                        var b = new byte[4];
                        for (var i = 0; i < 4; i++) b[i] = (byte)(ip[i] | ~mask[i]);
                        var s = new IPAddress(b).ToString();
                        if (!targets.Contains(s)) targets.Add(s);
                    }
                }
            }
            catch (Exception) { /* no interface list here: the limited broadcast alone */ }
            return targets;
        }
    }

    public readonly struct LanQuestion
    {
        public LanQuestion(byte[] nonce, string gameId) { Nonce = nonce; GameId = gameId; }
        public byte[] Nonce { get; }
        public string GameId { get; }
    }

    public readonly struct LanAnswerMessage
    {
        public LanAnswerMessage(byte[] nonce, int port, int players, int maxPlayers, bool password, string gameId, string netVersion, string lobbyName, string hostName)
        { Nonce = nonce; Port = port; Players = players; MaxPlayers = maxPlayers; Password = password; GameId = gameId; NetVersion = netVersion; LobbyName = lobbyName; HostName = hostName; }
        public byte[] Nonce { get; }
        public int Port { get; }
        public int Players { get; }
        public int MaxPlayers { get; }
        public bool Password { get; }
        public string GameId { get; }
        public string NetVersion { get; }
        public string LobbyName { get; }
        public string HostName { get; }
    }

    /// <summary>What a host tells a finder (spec s.2). <see cref="Port"/> is the direct TCP port a joiner connects to.</summary>
    public sealed record LanHostInfo(string LobbyName, string HostName, int Players, int MaxPlayers, bool Password, int Port);

    /// <summary>A UDP socket as the LAN code uses it: a seam so tests run with no socket. Receiving is polled (no events).</summary>
    public interface ILanUdp : IDisposable
    {
        /// <summary>Binds <c>address:port</c> (port 0: the system picks); throws a <see cref="SocketException"/> when it cannot. Returns the bound port.</summary>
        int Bind(IPAddress address, int port, bool broadcast);
        void Send(byte[] data, IPAddress to, int port);
        /// <summary>Waits up to <paramref name="waitMs"/> for one datagram; false when none came or the socket is closed.</summary>
        bool TryReceive(int waitMs, out byte[] data, out IPAddress from, out int fromPort);
    }

    /// <summary><see cref="ILanUdp"/> over a System.Net.Sockets.Socket. The bind is exclusive: a taken port throws.</summary>
    public sealed class SystemLanUdp : ILanUdp
    {
        private readonly Socket _s = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
        private volatile bool _closed;
        private readonly byte[] _buf = new byte[2048];

        public int Bind(IPAddress address, int port, bool broadcast)
        {
            _s.ExclusiveAddressUse = true;
            if (broadcast) _s.EnableBroadcast = true;
            _s.Bind(new IPEndPoint(address, port));
            return ((IPEndPoint)_s.LocalEndPoint!).Port;
        }

        public void Send(byte[] data, IPAddress to, int port)
        {
            if (_closed) return;
            try { _s.SendTo(data, new IPEndPoint(to, port)); }
            catch (SocketException) { /* no route: an unanswered question */ }
            catch (ObjectDisposedException) { }
        }

        public bool TryReceive(int waitMs, out byte[] data, out IPAddress from, out int fromPort)
        {
            data = Array.Empty<byte>(); from = IPAddress.None; fromPort = 0;
            if (_closed) return false;
            try
            {
                if (!_s.Poll(Math.Max(0, waitMs) * 1000, SelectMode.SelectRead)) return false;
                EndPoint ep = new IPEndPoint(IPAddress.Any, 0);
                var n = _s.ReceiveFrom(_buf, ref ep);
                data = new byte[n];
                Array.Copy(_buf, data, n);
                var r = (IPEndPoint)ep;
                from = r.Address; fromPort = r.Port;
                return true;
            }
            catch (SocketException) { return false; }
            catch (ObjectDisposedException) { return false; }
        }

        public void Dispose()
        {
            if (_closed) return;
            _closed = true;
            try { _s.Close(); } catch (Exception) { }
        }
    }

    /// <summary>The host's answering rules (spec s.3), with no socket: <see cref="Handle"/> gets a datagram and the address it came from.</summary>
    public sealed class LanAnswerer
    {
        private readonly Dictionary<string, int> _stats = new Dictionary<string, int> { ["answered"] = 0, ["bad_source"] = 0, ["malformed"] = 0, ["wrong_game"] = 0, ["duplicate"] = 0, ["rate_limited"] = 0 };
        private readonly object _lock = new object();
        private readonly string _gameId, _netVersion;
        private readonly Func<LanHostInfo?> _info;
        private readonly Action<byte[], string, int> _reply;
        private readonly Func<long> _nowMs;
        private readonly List<(string Key, long At)> _seen = new List<(string, long)>();
        private long _winStart;
        private int _winTotal;
        private readonly Dictionary<string, int> _winBySource = new Dictionary<string, int>();

        /// <summary>Counters: answered, bad_source, malformed, wrong_game, duplicate, rate_limited.</summary>
        public IReadOnlyDictionary<string, int> Stats { get { lock (_lock) return new Dictionary<string, int>(_stats); } }

        public LanAnswerer(string gameId, string netVersion, Func<LanHostInfo?> info, Action<byte[], string, int> reply, Func<long>? nowMs = null)
        {
            _gameId = gameId; _netVersion = netVersion; _info = info; _reply = reply;
            var sw = System.Diagnostics.Stopwatch.StartNew();
            _nowMs = nowMs ?? (() => sw.ElapsedMilliseconds);
        }

        /// <summary>"answer" when an answer was sent, the drop counter's name when the datagram was dropped, "no_lobby" when none is open.</summary>
        public string Handle(byte[] bytes, string address, int port)
        {
            lock (_lock)
            {
                string Drop(string k) { _stats[k]++; return k; }
                if (LanWire.SourceClass(address) == null) return Drop("bad_source");
                if (!LanWire.TryDecodeQuestion(bytes, out var q)) return Drop("malformed");
                if (!string.Equals(q.GameId, _gameId, StringComparison.Ordinal)) return Drop("wrong_game");
                var info = _info();
                if (info == null) return "no_lobby";
                var now = _nowMs();
                var key = address + "/" + BitConverter.ToString(q.Nonce);
                _seen.RemoveAll(e => now - e.At >= LanWire.DuplicateMs);
                if (_seen.Any(e => e.Key == key)) return Drop("duplicate");
                if (now - _winStart >= LanWire.RateWindowMs || now < _winStart) { _winStart = now; _winTotal = 0; _winBySource.Clear(); }
                _winBySource.TryGetValue(address, out var bySource);
                if (bySource >= LanWire.RatePerSource || _winTotal >= LanWire.RateTotal) return Drop("rate_limited");
                _winBySource[address] = bySource + 1;
                _winTotal++;
                _seen.Add((key, now));
                if (_seen.Count > LanWire.DuplicatesKept) _seen.RemoveAt(0);
                var max = Math.Min(255, Math.Max(1, info.MaxPlayers));
                var answer = LanWire.EncodeAnswer(new LanAnswerMessage(q.Nonce, info.Port, Math.Min(Math.Max(0, info.Players), max), max, info.Password,
                    _gameId, _netVersion, LanWire.CleanName(info.LobbyName), LanWire.CleanName(info.HostName)));
                _stats["answered"]++;
                _reply(answer, address, port);
                return "answer";
            }
        }
    }

    /// <summary>
    /// The host's answering socket. <see cref="Start"/> returns true when it listens; false (with a log line) when it cannot, and the
    /// host goes on without LAN discovery. A background thread reads the socket; <see cref="Dispose"/> closes it.
    /// </summary>
    public sealed class LanHost : IDisposable
    {
        private readonly Func<ILanUdp> _udpFactory;
        private readonly Action<string>? _log;
        private readonly int _port;
        private readonly IPAddress _bind;
        private readonly string _gameId, _netVersion;
        private ILanUdp? _udp;
        private Thread? _thread;
        private volatile bool _closed;

        public LanAnswerer Answerer { get; }
        public bool Listening => _udp != null && !_closed;
        public int Port { get; private set; }

        /// <summary>A loopback <c>bindAddress</c> makes the socket bind 127.0.0.1 only; anything else (or null) binds every interface.</summary>
        public LanHost(string gameId, string netVersion, Func<LanHostInfo?> info, int port = LanWire.DefaultPort, IPAddress? bindAddress = null, Func<ILanUdp>? udp = null, Action<string>? log = null, Func<long>? nowMs = null)
        {
            _port = port > 0 ? port : LanWire.DefaultPort;
            _bind = bindAddress != null && IPAddress.IsLoopback(bindAddress) ? IPAddress.Loopback : IPAddress.Any;
            _udpFactory = udp ?? (() => new SystemLanUdp());
            _log = log;
            _gameId = gameId; _netVersion = netVersion;
            Answerer = new LanAnswerer(gameId, netVersion, info, (b, a, p) => _udp?.Send(b, IPAddress.Parse(a), p), nowMs);
        }

        public bool Start()
        {
            var bad = !LanWire.Fits(_gameId, LanWire.GameIdLimit) ? "game id is not 1 to 64 bytes" : !LanWire.Fits(_netVersion, LanWire.NetVersionLimit) ? "net version is not 1 to 32 bytes" : null;
            if (bad != null) { _log?.Invoke("LAN discovery is off for this lobby: " + bad); return false; }
            var udp = _udpFactory();
            try { Port = udp.Bind(_bind, _port, false); }
            catch (SocketException e)
            {
                udp.Dispose();
                _log?.Invoke("LAN discovery is off for this lobby: UDP port " + _port + (e.SocketErrorCode == SocketError.AddressAlreadyInUse ? " is taken" : " could not be opened (" + e.SocketErrorCode + ")"));
                return false;
            }
            _udp = udp;
            _thread = new Thread(Loop) { IsBackground = true, Name = "onelobby-lan-host" };
            _thread.Start();
            _log?.Invoke("LAN discovery: answering questions for this lobby on UDP " + Port);
            return true;
        }

        private void Loop()
        {
            var udp = _udp!;
            while (!_closed)
            {
                try
                {
                    if (udp.TryReceive(200, out var data, out var from, out var port) && !_closed) Answerer.Handle(data, from.ToString(), port);
                }
                catch (Exception) { /* a bad datagram never ends the loop */ }
            }
        }

        public void Dispose()
        {
            if (_closed) return;
            _closed = true;
            _udp?.Dispose();
            _thread?.Join(1000);
        }
    }

    /// <summary>One row of the list a menu draws (one per host), as <see cref="LobbySummary"/> is for the lobby browser.</summary>
    public sealed record LanGame(string Address, int Port, string LobbyName, string HostName, int Players, int MaxPlayers, bool HasPassword, bool SameVersion, string NetVersion, long LastSeenMs);

    public enum LanFinderStatus { Idle, Running, Off, SocketFailed }

    public sealed class LanFinderOptions
    {
        /// <summary>Where to ask; null = <see cref="LanWire.BroadcastTargets"/>. A test or a <c>--local</c> game passes <c>127.0.0.1</c>.</summary>
        public IReadOnlyList<string>? Targets { get; set; }
        /// <summary>The hosts' answering port (default 47840).</summary>
        public int Port { get; set; } = LanWire.DefaultPort;
        /// <summary>False: <see cref="LanFinder.Start"/> does nothing (<c>hosting.lan</c> is false in the blueprint).</summary>
        public bool Enabled { get; set; } = true;
        public int AskIntervalMs { get; set; } = LanWire.AskIntervalMs;
        public int MinGapMs { get; set; } = LanWire.MinGapMs;
        public int RowTimeoutMs { get; set; } = LanWire.RowTimeoutMs;
        public Func<ILanUdp>? Udp { get; set; }
        public Func<long>? NowMs { get; set; }
        public Action<string>? Log { get; set; }
    }

    /// <summary>
    /// Finds LAN hosts. <see cref="Start"/> opens one UDP socket on a port the system picks; call <see cref="Pump"/> every frame
    /// (it reads answers, asks on its timer, drops stale rows and raises <see cref="Changed"/> on the calling thread);
    /// <see cref="Stop"/> closes the socket and empties the list. <see cref="Games"/> is the list.
    /// </summary>
    public sealed class LanFinder : IDisposable
    {
        private readonly string _gameId, _netVersion;
        private readonly LanFinderOptions _o;
        private readonly Func<long> _now;
        private readonly List<LanGame> _rows = new List<LanGame>();
        private readonly List<string> _nonces = new List<string>();
        private ILanUdp? _udp;
        private long _lastAsk = long.MinValue / 2;
        private bool _askHeld;

        /// <summary>Counters: kept, malformed, bad_source, wrong_nonce, wrong_game, full.</summary>
        public Dictionary<string, int> Stats { get; } = new Dictionary<string, int> { ["kept"] = 0, ["malformed"] = 0, ["bad_source"] = 0, ["wrong_nonce"] = 0, ["wrong_game"] = 0, ["full"] = 0 };
        public LanFinderStatus Status { get; private set; } = LanFinderStatus.Idle;
        public string StatusReason { get; private set; } = "";
        public IReadOnlyList<LanGame> Games => _rows.ToList();
        public bool Running => Status == LanFinderStatus.Running;
        /// <summary>Fires inside <see cref="Pump"/> (and <see cref="Stop"/>) when a row appears, goes or changes.</summary>
        public event Action<IReadOnlyList<LanGame>>? Changed;

        public LanFinder(string gameId, string netVersion, LanFinderOptions? options = null)
        {
            _gameId = gameId; _netVersion = netVersion; _o = options ?? new LanFinderOptions();
            var sw = System.Diagnostics.Stopwatch.StartNew();
            _now = _o.NowMs ?? (() => sw.ElapsedMilliseconds);
        }

        private IReadOnlyList<string> Targets => _o.Targets ?? LanWire.BroadcastTargets();

        public LanFinderStatus Start()
        {
            if (Status == LanFinderStatus.Running) return Status;
            if (!_o.Enabled) { Status = LanFinderStatus.Off; StatusReason = "hosting.lan is off"; return Status; }
            var targets = Targets;
            var local = targets.Count > 0 && targets.All(t => t.StartsWith("127.", StringComparison.Ordinal));
            var udp = (_o.Udp ?? (() => new SystemLanUdp()))();
            try { udp.Bind(local ? IPAddress.Loopback : IPAddress.Any, 0, !local); }
            catch (SocketException e)
            {
                udp.Dispose();
                Status = LanFinderStatus.SocketFailed; StatusReason = e.SocketErrorCode.ToString();
                _o.Log?.Invoke("LAN finder could not open its socket: " + e.SocketErrorCode);
                return Status;
            }
            _udp = udp;
            Status = LanFinderStatus.Running; StatusReason = "";
            _o.Log?.Invoke("LAN finder started (asking " + string.Join(", ", targets) + ")");
            Ask();
            return Status;
        }

        public void Stop()
        {
            var was = _udp != null;
            _udp?.Dispose();
            _udp = null;
            _nonces.Clear();
            _askHeld = false;
            if (was) { Status = LanFinderStatus.Idle; _o.Log?.Invoke("LAN finder stopped"); }
            if (_rows.Count > 0) { _rows.Clear(); Changed?.Invoke(Array.Empty<LanGame>()); }
        }

        public void Dispose() => Stop();

        /// <summary>Asks at once (held until MinGapMs after the last question when that is sooner).</summary>
        public void AskNow()
        {
            if (_udp == null) return;
            if (_now() - _lastAsk < _o.MinGapMs) { _askHeld = true; return; }
            Ask();
        }

        /// <summary>Test seam: treat this nonce (16 hex characters) as one this finder sent.</summary>
        public void RememberNonce(string hex)
        {
            _nonces.Add(hex);
            if (_nonces.Count > LanWire.NoncesKept) _nonces.RemoveAt(0);
        }

        private void Ask()
        {
            if (_udp == null) return;
            _lastAsk = _now();
            _askHeld = false;
            var nonce = new byte[8];
            using (var rng = System.Security.Cryptography.RandomNumberGenerator.Create()) rng.GetBytes(nonce);
            RememberNonce(Hex(nonce));
            var q = LanWire.EncodeQuestion(nonce, _gameId);
            foreach (var t in Targets)
                if (IPAddress.TryParse(t, out var ip)) _udp.Send(q, ip, _o.Port);
        }

        private static string Hex(byte[] b) => string.Concat(b.Select(x => x.ToString("x2")));

        /// <summary>Reads answers, asks on the timer, drops stale rows. Events fire here.</summary>
        public void Pump()
        {
            if (_udp == null) return;
            while (_udp != null && _udp.TryReceive(0, out var data, out var from, out var port)) Receive(data, from.ToString(), port);
            if (_udp == null) return;
            var now = _now();
            if ((_askHeld || now - _lastAsk >= _o.AskIntervalMs) && now - _lastAsk >= _o.MinGapMs) Ask();
            if (_rows.RemoveAll(r => now - r.LastSeenMs >= _o.RowTimeoutMs) > 0) Changed?.Invoke(Games);
        }

        /// <summary>The finder's rules for one datagram (spec s.4): "ok", "other_version" or the drop reason.</summary>
        public string Receive(byte[] bytes, string address, int port)
        {
            string Drop(string k) { Stats[k]++; return k; }
            if (!LanWire.TryDecodeAnswer(bytes, out var a)) return Drop("malformed");
            if (LanWire.SourceClass(address) == null) return Drop("bad_source");
            if (!_nonces.Contains(Hex(a.Nonce))) return Drop("wrong_nonce");
            if (!string.Equals(a.GameId, _gameId, StringComparison.Ordinal)) return Drop("wrong_game");
            var same = a.NetVersion == _netVersion;
            var row = new LanGame(address, a.Port, LanWire.CleanName(a.LobbyName), LanWire.CleanName(a.HostName), a.Players, a.MaxPlayers, a.Password, same, a.NetVersion, _now());
            var i = _rows.FindIndex(r => r.Address == address && r.Port == a.Port);
            var changed = false;
            if (i >= 0)
            {
                var o = _rows[i];
                changed = o.LobbyName != row.LobbyName || o.HostName != row.HostName || o.Players != row.Players || o.MaxPlayers != row.MaxPlayers || o.HasPassword != row.HasPassword || o.SameVersion != row.SameVersion || o.NetVersion != row.NetVersion;
                _rows[i] = row;
            }
            else if (_rows.Count < LanWire.MaxRows) { _rows.Add(row); changed = true; }
            else { Stats["full"]++; return "ok"; }
            Stats["kept"]++;
            if (changed) Changed?.Invoke(Games);
            return same ? "ok" : "other_version";
        }
    }

    public static class LanClientExtensions
    {
        /// <summary>
        /// A finder for LAN games with this client's game id, net version and net log. With a blueprint whose <c>hosting.lan</c> is
        /// false it stays off. Nothing is opened before <see cref="LanFinder.Start"/>.
        /// </summary>
        public static LanFinder CreateLanFinder(this LobbyClient client, LanFinderOptions? options = null)
        {
            if (client == null) throw new ArgumentNullException(nameof(client));
            var o = options ?? new LanFinderOptions();
            if (client.Blueprint != null && !client.Blueprint.Hosting.Lan) o.Enabled = false;
            o.Log ??= line => client.NetLog.Add("info", line);
            return new LanFinder(client.Config.GameId, client.Config.NetVersion, o);
        }
    }
}
