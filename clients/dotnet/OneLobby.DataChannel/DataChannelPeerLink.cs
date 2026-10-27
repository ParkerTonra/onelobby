using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace OneLobby.DataChannel
{
    /// <summary>
    /// One libdatachannel peer connection with the three negotiated channels of DESIGN s.8, identical to the JS client and
    /// GodotTransport: <c>reliable</c> stream 0 ordered; <c>fast</c> stream 1 and <c>voice</c> stream 2 unordered,
    /// maxRetransmits 0. Auto-negotiation is off: the initiator creates the offer in <see cref="StartOffer"/>, the other
    /// side answers when the offer arrives.
    /// <para>
    /// Native callbacks are static methods (IL2CPP requirement) that find the link through a registry keyed by the
    /// native pc/dc id; the link is removed from the registry before its native objects are deleted, so a late callback
    /// finds nothing and is dropped. No GCHandle is needed: native code only ever holds ids, never managed pointers.
    /// </para>
    /// </summary>
    internal sealed unsafe class DataChannelPeerLink : IPeerLink, IBufferedPeerLink, IRemoteAddressPeerLink
    {
        private const int DisconnectGraceMs = 4000;
        private static readonly string[] Labels = { "reliable", "fast", "voice" };
        private static readonly ConcurrentDictionary<int, DataChannelPeerLink> ById = new ConcurrentDictionary<int, DataChannelPeerLink>();

        // Delegates live in static fields so the GC never collects what native code calls.
        private static readonly Rtc.DescriptionCallback DescriptionCb = OnDescription;
        private static readonly Rtc.CandidateCallback CandidateCb = OnCandidate;
        private static readonly Rtc.StateCallback StateCb = OnState;
        private static readonly Rtc.OpenCallback OpenCb = OnOpen;
        private static readonly Rtc.ClosedCallback ClosedCb = OnClosed;
        private static readonly Rtc.ErrorCallback ErrorCb = OnError;
        private static readonly Rtc.MessageCallback MessageCb = OnMessage;
        private static readonly Rtc.LogCallback LogCb = OnLog;
        private static int _loggerInit;

        private readonly DataChannelTransport _transport;
        private readonly PeerLinkOptions _opts;
        private readonly int _pc = -1;
        private readonly int[] _dc = { -1, -1, -1 };
        private readonly int[] _open = new int[3];
        private readonly ConcurrentQueue<PeerSignal> _out = new ConcurrentQueue<PeerSignal>();
        private readonly ConcurrentQueue<(PeerChannel, byte[])> _in = new ConcurrentQueue<(PeerChannel, byte[])>();
        private readonly Queue<(string Cand, string? Mid)> _pendingIce = new Queue<(string, string?)>();
        private volatile int _state;
        private volatile string? _nativeError;
        private bool _remoteSet;
        private long _disconnectedSince = -1;
        private int _pathTries;
        private long _nextPathMs;
        private bool _relayed;
        /// <summary>The selected ICE pair once known (diagnostics and tests), e.g. "a=candidate:... 47810 typ host".</summary>
        internal string? LocalCandidate { get; private set; }
        internal string? RemoteCandidate { get; private set; }

        /// <summary>The remote end of the selected candidate pair, when it is a direct path with a literal IP address.</summary>
        public string? RemoteAddress => ParseRemoteAddress(RemoteCandidate);

        /// <summary>The address field of a candidate line (<c>candidate:1 1 UDP 2122 203.0.113.5 54321 typ srflx</c>); null for relay, mDNS names and junk.</summary>
        internal static string? ParseRemoteAddress(string? candidate)
        {
            if (string.IsNullOrEmpty(candidate) || candidate!.Contains(" typ relay")) return null;
            var parts = candidate.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 6) return null;
            return System.Net.IPAddress.TryParse(parts[4], out var ip) ? (ip.IsIPv4MappedToIPv6 ? ip.MapToIPv4() : ip).ToString() : null;
        }
        internal PeerLinkOptions Options => _opts;

        public bool Disposed { get; private set; }
        public bool IsFailed { get; private set; }
        public string? FailReason { get; private set; }
        /// <summary>Not measured here; the core measures RTT itself with ping/pong on the fast channel.</summary>
        public int PingMs => 0;
        /// <summary>The selected candidate pair has a relay candidate on either side (or the lobby is relay-only).</summary>
        public bool Relayed => _relayed || _opts.RelayOnly;
        public bool IsOpen => !Disposed && !IsFailed && Volatile.Read(ref _open[0]) == 1 && Volatile.Read(ref _open[1]) == 1 && Volatile.Read(ref _open[2]) == 1;

        internal static void EnsureLogger()
        {
            if (!DataChannelTransport.HasNativeLog || Interlocked.Exchange(ref _loggerInit, 1) == 1) return;
            try { Rtc.rtcInitLogger((Rtc.LogLevel)DataChannelTransport.NativeLogLevel, LogCb); }
            catch (Exception) { Interlocked.Exchange(ref _loggerInit, 0); }
        }

        public DataChannelPeerLink(PeerLinkOptions options, DataChannelTransport transport)
        {
            _opts = options;
            _transport = transport;
            EnsureLogger();

            var urls = new List<string>();
            foreach (var s in options.IceServers)
                foreach (var u in s.Urls)
                    if (ToLibUrl(u, s.Username, s.Credential) is { } lu) urls.Add(lu);
            if (urls.Count == 0 && !options.NoIceServers) urls.Add(DataChannelTransport.DefaultStun);

            var strings = new List<IntPtr>();
            try
            {
                foreach (var u in urls)
                {
                    var b = Rtc.Utf8z(u);
                    var mem = Marshal.AllocHGlobal(b.Length);
                    Marshal.Copy(b, 0, mem, b.Length);
                    strings.Add(mem);
                }
                var arr = stackalloc IntPtr[strings.Count];
                for (var i = 0; i < strings.Count; i++) arr[i] = strings[i];
                var iceCount = strings.Count;
                var bindMem = IntPtr.Zero;
                if (!string.IsNullOrEmpty(transport.BindAddress))
                {
                    var bb = Rtc.Utf8z(transport.BindAddress!);
                    bindMem = Marshal.AllocHGlobal(bb.Length);
                    Marshal.Copy(bb, 0, bindMem, bb.Length);
                    strings.Add(bindMem); // freed with the ICE server strings
                }
                var config = new Rtc.Configuration
                {
                    BindAddress = bindMem,
                    IceServers = (IntPtr)arr,
                    IceServersCount = iceCount,
                    IceTransportPolicy = options.RelayOnly ? 1 : 0,
                    DisableAutoNegotiation = 1,
                    PortRangeBegin = (ushort)options.PortRangeBegin,
                    PortRangeEnd = (ushort)options.PortRangeEnd,
                    // one pinned port shared by every peer connection (direct-IP host): libjuice's UDP mux
                    EnableIceUdpMux = (byte)(options.PortRangeBegin > 0 && options.PortRangeBegin == options.PortRangeEnd ? 1 : 0),
                };
                try { _pc = Rtc.rtcCreatePeerConnection(ref config); }
                catch (Exception e) when (e is DllNotFoundException || e is EntryPointNotFoundException || e is BadImageFormatException)
                {
                    Fail("libdatachannel not loadable: " + e.Message);
                    return;
                }
            }
            finally
            {
                foreach (var p in strings) Marshal.FreeHGlobal(p);
            }
            if (_pc < 0) { Fail("rtcCreatePeerConnection " + _pc); return; }
            ById[_pc] = this;
            Rtc.rtcSetLocalDescriptionCallback(_pc, DescriptionCb);
            Rtc.rtcSetLocalCandidateCallback(_pc, CandidateCb);
            Rtc.rtcSetStateChangeCallback(_pc, StateCb);

            // negotiated channels with fixed ids, identical on both ends (DESIGN s.8)
            for (var i = 0; i < 3; i++)
            {
                var init = new Rtc.DataChannelInit
                {
                    Reliability = new Rtc.Reliability { Unordered = (byte)(i == 0 ? 0 : 1), Unreliable = (byte)(i == 0 ? 0 : 1), MaxRetransmits = 0 },
                    Negotiated = 1,
                    ManualStream = 1,
                    Stream = (ushort)i,
                };
                var label = Rtc.Utf8z(Labels[i]);
                int dc;
                fixed (byte* l = label) dc = Rtc.rtcCreateDataChannelEx(_pc, l, ref init);
                if (dc < 0) { Fail("rtcCreateDataChannelEx " + Labels[i] + " " + dc); return; }
                _dc[i] = dc;
                ById[dc] = this;
                Rtc.rtcSetOpenCallback(dc, OpenCb);
                Rtc.rtcSetClosedCallback(dc, ClosedCb);
                Rtc.rtcSetErrorCallback(dc, ErrorCb);
                Rtc.rtcSetMessageCallback(dc, MessageCb);
            }
        }

        /// <summary>"turn:host:3478?transport=udp" + credentials into libdatachannel's "turn:user:pass@host:3478?transport=udp".</summary>
        internal static string? ToLibUrl(string url, string? user, string? pass)
        {
            var colon = url.IndexOf(':');
            if (colon <= 0) return null;
            var scheme = url.Substring(0, colon).ToLowerInvariant();
            var rest = url.Substring(colon + 1);
            if (scheme == "stun" || scheme == "stuns") return "stun:" + rest;
            if (scheme != "turn" && scheme != "turns") return null;
            if (string.IsNullOrEmpty(user)) return url;
            return scheme + ":" + Uri.EscapeDataString(user) + ":" + Uri.EscapeDataString(pass ?? "") + "@" + rest;
        }

        private void Fail(string reason)
        {
            if (IsFailed) return;
            IsFailed = true;
            FailReason = reason;
        }

        private int IndexOf(int dc)
        {
            for (var i = 0; i < 3; i++) if (_dc[i] == dc) return i;
            return -1;
        }

        // ---- native callbacks (libdatachannel threads): copy and queue only ----------------------------------------

        [MonoPInvokeCallback(typeof(Rtc.DescriptionCallback))]
        private static void OnDescription(int pc, IntPtr sdp, IntPtr type, IntPtr ptr)
        {
            if (ById.TryGetValue(pc, out var l))
                l._out.Enqueue(PeerSignal.Description(Rtc.FromUtf8z(type) ?? "", Rtc.FromUtf8z(sdp) ?? ""));
        }

        [MonoPInvokeCallback(typeof(Rtc.CandidateCallback))]
        private static void OnCandidate(int pc, IntPtr cand, IntPtr mid, IntPtr ptr)
        {
            if (ById.TryGetValue(pc, out var l))
                l._out.Enqueue(PeerSignal.Ice(Rtc.FromUtf8z(cand) ?? "", Rtc.FromUtf8z(mid) ?? "", 0));
        }

        [MonoPInvokeCallback(typeof(Rtc.StateCallback))]
        private static void OnState(int pc, Rtc.State state, IntPtr ptr)
        {
            if (ById.TryGetValue(pc, out var l)) l._state = (int)state;
        }

        [MonoPInvokeCallback(typeof(Rtc.OpenCallback))]
        private static void OnOpen(int dc, IntPtr ptr)
        {
            if (ById.TryGetValue(dc, out var l) && l.IndexOf(dc) is var i && i >= 0) Volatile.Write(ref l._open[i], 1);
        }

        [MonoPInvokeCallback(typeof(Rtc.ClosedCallback))]
        private static void OnClosed(int dc, IntPtr ptr)
        {
            if (ById.TryGetValue(dc, out var l) && l.IndexOf(dc) is var i && i >= 0 && Volatile.Read(ref l._open[i]) == 1)
                l._nativeError ??= "channel " + Labels[i] + " closed";
        }

        [MonoPInvokeCallback(typeof(Rtc.ErrorCallback))]
        private static void OnError(int dc, IntPtr error, IntPtr ptr)
        {
            if (ById.TryGetValue(dc, out var l)) l._nativeError ??= "channel error: " + Rtc.FromUtf8z(error);
        }

        [MonoPInvokeCallback(typeof(Rtc.MessageCallback))]
        private static void OnMessage(int dc, IntPtr message, int size, IntPtr ptr)
        {
            if (!ById.TryGetValue(dc, out var l)) return;
            var i = l.IndexOf(dc);
            if (i < 0) return;
            // size < 0: a text message of -size bytes including the terminator; OneLobby only sends binary, keep the bytes
            var n = size >= 0 ? size : -size - 1;
            var bytes = new byte[n];
            if (n > 0) Marshal.Copy(message, bytes, 0, n);
            l._in.Enqueue(((PeerChannel)i, bytes));
        }

        [MonoPInvokeCallback(typeof(Rtc.LogCallback))]
        private static void OnLog(Rtc.LogLevel level, IntPtr message)
        {
            try { DataChannelTransport.RaiseNativeLog("[libdatachannel " + level + "] " + Rtc.FromUtf8z(message)); }
            catch (Exception) { /* never throw into native code */ }
        }

        // ---- main thread ------------------------------------------------------------------------------------------

        public void Poll()
        {
            if (Disposed || IsFailed) return;
            if (_nativeError != null) { Fail(_nativeError); return; }
            var st = (Rtc.State)_state;
            var now = _transport.NowMs;
            if (st == Rtc.State.Failed || st == Rtc.State.Closed) { Fail("connection " + st); return; }
            if (st == Rtc.State.Disconnected)
            {
                if (_disconnectedSince < 0) _disconnectedSince = now;
                else if (now - _disconnectedSince >= DisconnectGraceMs) { Fail("disconnected"); return; }
            }
            else _disconnectedSince = -1;
            if (IsOpen && _pathTries < 10 && now >= _nextPathMs) ReadPath(now);
        }

        private void ReadPath(long now)
        {
            _pathTries++;
            _nextPathMs = now + 300;
            var local = stackalloc byte[512];
            var remote = stackalloc byte[512];
            if (Rtc.rtcGetSelectedCandidatePair(_pc, local, 512, remote, 512) < 0) return;
            var l = Rtc.FromUtf8z((IntPtr)local) ?? "";
            var r = Rtc.FromUtf8z((IntPtr)remote) ?? "";
            _relayed = l.Contains(" typ relay") || r.Contains(" typ relay");
            LocalCandidate = l;
            RemoteCandidate = r;
            _pathTries = int.MaxValue; // known: stop asking
        }

        public void StartOffer()
        {
            if (Disposed || IsFailed) return;
            var t = Rtc.Utf8z("offer");
            int r;
            fixed (byte* p = t) r = Rtc.rtcSetLocalDescription(_pc, p);
            if (r < 0) Fail("rtcSetLocalDescription offer " + r);
        }

        public void ApplySignal(PeerSignal s)
        {
            if (Disposed || IsFailed) return;
            if (s.Sdp != null)
            {
                var type = s.SdpType ?? "";
                var sdp = Rtc.Utf8z(s.Sdp);
                var tb = Rtc.Utf8z(type);
                int r;
                fixed (byte* ps = sdp) fixed (byte* pt = tb) r = Rtc.rtcSetRemoteDescription(_pc, ps, pt);
                if (r < 0) { Fail("rtcSetRemoteDescription " + type + " " + r); return; }
                _remoteSet = true;
                // e.g. the address a direct-IP joiner typed (docs/design/direct-ip.md s.2), tagged with the remote's media id
                if (_opts.ExtraRemoteCandidates != null)
                    foreach (var extra in _opts.ExtraRemoteCandidates) AddIce(extra, MidOf(s.Sdp));
                while (_pendingIce.Count > 0) { var (c, m) = _pendingIce.Dequeue(); AddIce(c, m); }
                if (type == "offer")
                {
                    var a = Rtc.Utf8z("answer");
                    fixed (byte* pa = a) r = Rtc.rtcSetLocalDescription(_pc, pa);
                    if (r < 0) Fail("rtcSetLocalDescription answer " + r);
                }
            }
            else if (!string.IsNullOrEmpty(s.Candidate))
            {
                if (_remoteSet) AddIce(s.Candidate!, s.SdpMid);
                else _pendingIce.Enqueue((s.Candidate!, s.SdpMid));
            }
        }

        /// <summary>The first <c>a=mid:</c> of an SDP (OneLobby offers one bundled data-channel section).</summary>
        internal static string? MidOf(string sdp)
        {
            var i = sdp.IndexOf("a=mid:", StringComparison.Ordinal);
            if (i < 0) return null;
            i += 6;
            var end = i;
            while (end < sdp.Length && sdp[end] != '\r' && sdp[end] != '\n') end++;
            return sdp.Substring(i, end - i).Trim();
        }

        private void AddIce(string cand, string? mid)
        {
            var c = Rtc.Utf8z(cand);
            var m = string.IsNullOrEmpty(mid) ? null : Rtc.Utf8z(mid);
            fixed (byte* pc = c) fixed (byte* pm = m)
                Rtc.rtcAddRemoteCandidate(_pc, pc, m == null ? null : pm); // a bad or late candidate is not fatal
        }

        public bool TryTakeSignal(out PeerSignal signal)
        {
            if (_out.TryDequeue(out var s)) { signal = s; return true; }
            signal = null!;
            return false;
        }

        public void Send(PeerChannel channel, ReadOnlySpan<byte> frame)
        {
            if (Disposed || IsFailed || frame.Length == 0) return;
            var i = (int)channel;
            if (Volatile.Read(ref _open[i]) != 1) return;
            fixed (byte* p = frame) Rtc.rtcSendMessage(_dc[i], p, frame.Length); // < 0: closing; the state check catches it
        }

        public long ReliableBufferedBytes
        {
            get
            {
                if (Disposed || IsFailed || _dc[0] < 0) return 0;
                try { return Math.Max(0, Rtc.rtcGetBufferedAmount(_dc[0])); }
                catch (DllNotFoundException) { return 0; }
            }
        }

        public bool TryReceive(out PeerChannel channel, out byte[] frame)
        {
            if (_in.TryDequeue(out var m)) { (channel, frame) = m; return true; }
            channel = PeerChannel.Reliable;
            frame = Array.Empty<byte>();
            return false;
        }

        public void Dispose()
        {
            if (Disposed) return;
            Disposed = true;
            // unregister first: callbacks racing with the delete below find nothing and return
            for (var i = 0; i < 3; i++) if (_dc[i] >= 0) ById.TryRemove(_dc[i], out _);
            if (_pc >= 0) ById.TryRemove(_pc, out _);
            // A zero bufferedAmount only means libdatachannel handed the bytes to SCTP; deleting the peer connection now
            // would drop what SCTP has not delivered yet. Close the channels (each stream reset goes out after its queued
            // data, so the far side sees the link close after the last message) and delete everything a moment later.
            var dc = (int[])_dc.Clone();
            var pc = _pc;
            try { for (var i = 0; i < 3; i++) if (dc[i] >= 0) Rtc.rtcClose(dc[i]); }
            catch (DllNotFoundException) { return; /* never loaded */ }
            System.Threading.Tasks.Task.Delay(CloseGraceMs).ContinueWith(_ =>
            {
                for (var i = 0; i < 3; i++) if (dc[i] >= 0) Rtc.rtcDeleteDataChannel(dc[i]);
                if (pc >= 0) Rtc.rtcDeletePeerConnection(pc);
            }, System.Threading.Tasks.TaskScheduler.Default);
        }

        /// <summary>How long a disposed link's peer connection stays up so SCTP can deliver what was already sent.</summary>
        public const int CloseGraceMs = 2000;
    }
}
