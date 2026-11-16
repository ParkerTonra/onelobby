using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace OneLobby
{
    /// <summary>One step in the net log (spec/diagnostics.md s.5).</summary>
    /// <param name="Seq">From 1, never reused: a reader sees how many entries the ring dropped.</param>
    /// <param name="T">Milliseconds since the log was created.</param>
    /// <param name="Kind"><c>sig</c>, <c>lobby</c>, <c>sdp</c>, <c>cand</c>, <c>ice</c>, <c>chan</c>, <c>route</c>, <c>retry</c>, <c>error</c>, <c>diag</c> or <c>info</c>.</param>
    /// <param name="Text">At most 200 characters; no address, credential or password.</param>
    /// <param name="Addr">The address the step belongs to, in memory only: printed by <c>Export(includeAddresses: true)</c> (credentials in it still hidden).</param>
    /// <param name="Code">The error code, for <c>error</c> entries.</param>
    public sealed record NetLogEntry(long Seq, long T, string Kind, string Text, string? Addr = null, string? Code = null);

    /// <summary>Client, protocol and platform lines of the export header.</summary>
    public sealed record NetLogMeta(string Client, string Protocol, string Platform);

    /// <summary>
    /// The net log (spec/diagnostics.md s.5-6): a ring buffer of connection steps with timings, a text export with a stable
    /// line format, and the masking rule. The log stays on the player's machine; nothing here sends anything.
    /// </summary>
    public sealed class NetLog : IDisposable
    {
        public const int DefaultCapacity = 500;
        public const int MinCapacity = 50;
        public const int MaxCapacity = 5000;
        public const int TextMax = 200;

        private const string Hidden = "<hidden>";
        private static readonly RegexOptions Ro = RegexOptions.CultureInvariant;
        // 1. credentials, always
        private static readonly Regex Keyed = new Regex(@"\b(username|credential|password|pwd|token|secret)=([^\s,""]*)", Ro);
        private static readonly Regex KeyedJson = new Regex(@"(""(?:username|credential|password|pwd|token|secret)""\s*:\s*"")([^""]*)("")", Ro);
        private static readonly Regex IceSecret = new Regex(@"(a=ice-(?:ufrag|pwd):)(\S+)", Ro);
        private static readonly Regex TurnLine = new Regex(@"\b(turns?:[^\s?]+(?:\?\S*)?)\s+\S+\s+\S+", Ro);
        private static readonly Regex UrlUser = new Regex(@"(\b[A-Za-z][A-Za-z0-9+.-]*://)[^\s/@]*:[^\s/@]*@", Ro);
        // 2. addresses
        private static readonly Regex Ipv6Bracket = new Regex(@"\[[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*\](?::[0-9]{1,5})?", Ro);
        private static readonly Regex Ipv6Bare = new Regex(@"(?<![0-9A-Za-z:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Za-z:])", Ro);
        private static readonly Regex Mdns = new Regex(@"\b[0-9A-Fa-f-]{8,}\.local\b", Ro);
        private const string Octet = "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])";
        private static readonly Regex Ipv4 = new Regex(@"\b" + Octet + "(?:\\." + Octet + @"){3}(?::[0-9]{1,5})?\b", Ro);
        private static readonly Regex BracketStrip = new Regex(@"^\[|\](?::[0-9]+)?$", Ro);

        private static bool LooksLikeIpv6(string s)
        {
            var colons = s.Split(':').Length - 1;
            return colons >= 2 && (s.Contains("::") || (colons == 7 && !s.StartsWith(":") && !s.EndsWith(":")));
        }

        /// <summary>
        /// Masks one line of log text. Credentials and ICE secrets are always hidden; IPv4, IPv6 and mDNS names are replaced by
        /// <c>&lt;ip4&gt;</c>, <c>&lt;ip6&gt;</c> and <c>&lt;mdns&gt;</c> unless <paramref name="includeAddresses"/> (spec/diagnostics.md s.6).
        /// </summary>
        public static string Mask(string text, bool includeAddresses = false)
        {
            var s = Keyed.Replace(text, m => m.Groups[1].Value + "=" + Hidden);
            s = KeyedJson.Replace(s, m => m.Groups[1].Value + Hidden + m.Groups[3].Value);
            s = IceSecret.Replace(s, m => m.Groups[1].Value + Hidden);
            s = TurnLine.Replace(s, m => m.Groups[1].Value + " " + Hidden + " " + Hidden);
            s = UrlUser.Replace(s, m => m.Groups[1].Value + Hidden + "@");
            if (includeAddresses) return s;
            s = Ipv6Bracket.Replace(s, m => LooksLikeIpv6(BracketStrip.Replace(m.Value, "")) ? "<ip6>" : m.Value);
            s = Ipv6Bare.Replace(s, m => LooksLikeIpv6(m.Value) ? "<ip6>" : m.Value);
            s = Mdns.Replace(s, "<mdns>");
            return Ipv4.Replace(s, "<ip4>");
        }

        private readonly List<NetLogEntry> _ring = new List<NetLogEntry>();
        private readonly object _lock = new object();
        private long _nextSeq = 1;
        private readonly int _cap;
        private readonly Func<long> _now;
        private readonly long _t0;
        private NetLogMeta _meta;
        private bool _hooked;

        /// <summary>Where <see cref="Save"/> writes when given no path, and where the log is flushed on exit; null: nowhere.</summary>
        public string? Path { get; set; }

        /// <summary>Ring size <paramref name="capacity"/> (default 500, clamped to 50..5000; <paramref name="raw"/> skips the clamp: tests); <paramref name="clock"/> is monotonic milliseconds (the transport's clock, default a stopwatch).</summary>
        public NetLog(int capacity = DefaultCapacity, Func<long>? clock = null, NetLogMeta? meta = null, string? path = null, bool raw = false)
        {
            _cap = raw ? Math.Max(1, capacity) : Math.Min(MaxCapacity, Math.Max(MinCapacity, capacity <= 0 ? DefaultCapacity : capacity));
            if (clock != null) _now = clock;
            else { var sw = System.Diagnostics.Stopwatch.StartNew(); _now = () => sw.ElapsedMilliseconds; }
            _t0 = _now();
            _meta = meta ?? new NetLogMeta("onelobby", "lk1", "unknown");
            Path = path;
        }

        /// <summary>Adds a step. <paramref name="text"/> is cut to 200 characters; keep addresses in <paramref name="addr"/>, never in the text.</summary>
        public void Add(string kind, string text, string? addr = null, string? code = null)
        {
            lock (_lock)
            {
                var t = text ?? "";
                if (t.Length > TextMax) t = t.Substring(0, TextMax);
                _ring.Add(new NetLogEntry(_nextSeq++, Math.Max(0, _now() - _t0), kind, t, string.IsNullOrEmpty(addr) ? null : addr, string.IsNullOrEmpty(code) ? null : code));
                if (_ring.Count > _cap) _ring.RemoveAt(0);
            }
        }

        /// <summary>The entries kept, oldest first (a copy).</summary>
        public IReadOnlyList<NetLogEntry> Entries { get { lock (_lock) return _ring.ToArray(); } }

        /// <summary>How many entries the ring dropped.</summary>
        public long Dropped { get { lock (_lock) return _nextSeq - 1 - _ring.Count; } }

        /// <summary>Sets the header facts (client, protocol, platform).</summary>
        public void SetMeta(NetLogMeta meta) => _meta = meta;

        public void Clear() { lock (_lock) _ring.Clear(); }

        /// <summary>
        /// The log as text (spec/diagnostics.md s.5): a header, then one line per entry, oldest first. Addresses are masked
        /// unless <paramref name="includeAddresses"/>; credentials never print either way.
        /// </summary>
        public string Export(bool includeAddresses = false)
        {
            NetLogEntry[] list;
            long dropped;
            lock (_lock) { list = _ring.ToArray(); dropped = _nextSeq - 1 - _ring.Count; }
            return Render(list, _meta, dropped, includeAddresses);
        }

        /// <summary>Writes the export to a file and returns the path: <paramref name="path"/>, else <see cref="Path"/>. Throws when there is none.</summary>
        public string Save(string? path = null, bool includeAddresses = false)
        {
            var target = path ?? Path;
            if (string.IsNullOrEmpty(target)) throw new InvalidOperationException("no log path: pass one, or set DiagnosticsOptions.LogPath");
            var dir = System.IO.Path.GetDirectoryName(target);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(target, Export(includeAddresses), new UTF8Encoding(false));
            return target!;
        }

        /// <summary>Writes the masked log to <see cref="Path"/> now, swallowing errors (the exit and crash flush).</summary>
        public void Flush()
        {
            if (string.IsNullOrEmpty(Path)) return;
            try { Save(); }
            catch (Exception) { /* the log is a courtesy: a failed write never matters */ }
        }

        /// <summary>
        /// Flush to <paramref name="path"/> when the process exits and when it dies from an unhandled exception. The crash
        /// hook only observes (the process still crashes as it would have).
        /// </summary>
        public void FlushOnExit(string? path = null)
        {
            if (path != null) Path = path;
            if (_hooked) return;
            _hooked = true;
            AppDomain.CurrentDomain.ProcessExit += OnExit;
            AppDomain.CurrentDomain.UnhandledException += OnCrash;
        }

        private void OnExit(object? s, EventArgs e) => Flush();
        private void OnCrash(object? s, UnhandledExceptionEventArgs e) => Flush();

        /// <summary>Removes the exit and crash hooks.</summary>
        public void Dispose()
        {
            if (!_hooked) return;
            _hooked = false;
            AppDomain.CurrentDomain.ProcessExit -= OnExit;
            AppDomain.CurrentDomain.UnhandledException -= OnCrash;
        }

        private static string Render(NetLogEntry[] entries, NetLogMeta meta, long dropped, bool includeAddresses)
        {
            var sb = new StringBuilder();
            sb.Append("# onelobby netlog v1\n");
            sb.Append("# client ").Append(meta.Client).Append(" protocol ").Append(meta.Protocol).Append(" platform ").Append(meta.Platform).Append('\n');
            sb.Append("# entries ").Append(entries.Length.ToString(CultureInfo.InvariantCulture)).Append(" dropped ").Append(dropped.ToString(CultureInfo.InvariantCulture)).Append('\n');
            sb.Append(includeAddresses ? "# addresses included\n" : "# addresses masked\n");
            foreach (var e in entries)
            {
                sb.Append(Mask("#" + e.Seq.ToString(CultureInfo.InvariantCulture) + " +" + e.T.ToString(CultureInfo.InvariantCulture) + "ms " + e.Kind + " " + e.Text, includeAddresses));
                // the address goes through the credential step too: a signaling URL with ?token= or user:pass@ never prints a secret
                if (includeAddresses && e.Addr != null) sb.Append(" addr=").Append(Mask(e.Addr, true));
                sb.Append('\n');
            }
            return sb.ToString();
        }
    }
}
