using System;
using System.Collections.Generic;
using System.Diagnostics;

namespace OneLobby.DataChannel
{
    /// <summary>
    /// Engine-agnostic <see cref="ITransport"/>: WebRTC peer links over libdatachannel (native, MPL-2.0) with the three
    /// negotiated channels of DESIGN s.8, and <see cref="WebSocketSignalingSocket"/> (ClientWebSocket) for signaling.
    /// Works in a console app, a server, Unity (Mono and IL2CPP) or any engine that can load a native library.
    /// <para>
    /// Threading: libdatachannel calls back on its own threads; those callbacks only copy data into lock-free queues.
    /// The core sees it all in <see cref="Poll"/> (called by <c>LobbyClient.Pump</c> / <c>Lobby.Pump</c>), on whatever
    /// thread pumps, so pump from one thread (the game's main thread).
    /// </para>
    /// </summary>
    public sealed class DataChannelTransport : ITransport
    {
        private static readonly Stopwatch Clock = Stopwatch.StartNew();
        private readonly List<WebSocketSignalingSocket> _sockets = new List<WebSocketSignalingSocket>();
        private readonly List<DataChannelPeerLink> _links = new List<DataChannelPeerLink>();

        /// <summary>Fallback STUN server when the lobby server offers no ICE servers (same as the other transports).</summary>
        public static string DefaultStun = "stun:stun.l.google.com:19302";

        /// <summary>
        /// libdatachannel log lines at <see cref="NativeLogLevel"/> or more severe, raised on a native thread. Set both
        /// before the first transport is created. No subscriber: native logging stays off.
        /// </summary>
        public static event Action<string>? NativeLog
        {
            add { lock (LogGate) { _nativeLog += value; } DataChannelPeerLink.EnsureLogger(); }
            remove { lock (LogGate) { _nativeLog -= value; } }
        }
        /// <summary>1 fatal ... 6 verbose (rtcLogLevel). Default 3, warnings.</summary>
        public static int NativeLogLevel = 3;
        private static readonly object LogGate = new object();
        private static Action<string>? _nativeLog;
        internal static void RaiseNativeLog(string line) { Action<string>? h; lock (LogGate) h = _nativeLog; h?.Invoke(line); }
        internal static bool HasNativeLog { get { lock (LogGate) return _nativeLog != null; } }

        /// <summary>Test seam: bind the ICE sockets to this one local address (e.g. 127.0.0.1) instead of every interface. Null (default) = all.</summary>
        internal string? BindAddress { get; set; }

        public long NowMs => Clock.ElapsedMilliseconds;

        /// <summary>Live links (diagnostics and tests).</summary>
        internal IReadOnlyList<DataChannelPeerLink> Links => _links;

        public ISignalingSocket ConnectSignaling(Uri url)
        {
            var s = new WebSocketSignalingSocket(url);
            _sockets.Add(s);
            return s;
        }

        public IPeerLink CreatePeerLink(PeerLinkOptions options)
        {
            var l = new DataChannelPeerLink(options, this);
            _links.Add(l);
            return l;
        }

        public void Poll()
        {
            for (var i = _sockets.Count - 1; i >= 0; i--)
                if (_sockets[i].Disposed) _sockets.RemoveAt(i);
            for (var i = _links.Count - 1; i >= 0; i--)
            {
                if (_links[i].Disposed) { _links.RemoveAt(i); continue; }
                _links[i].Poll();
            }
        }
    }
}
