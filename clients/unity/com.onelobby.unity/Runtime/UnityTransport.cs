#nullable enable
using System;
using System.Collections.Generic;
using System.Diagnostics;

namespace OneLobby.Unity
{
    /// <summary>
    /// <see cref="ITransport"/> for Unity: <c>com.unity.webrtc</c> (<c>RTCPeerConnection</c> with the three negotiated data
    /// channels of DESIGN s.8) for peer links and <see cref="System.Net.WebSockets.ClientWebSocket"/> for signaling.
    /// <para>
    /// Threading: Unity WebRTC posts its callbacks (channel open, message, ICE candidate, async-op completion) to the main
    /// thread's <c>SynchronizationContext</c>; the WebSocket runs on the thread pool. Both only fill queues. Everything the
    /// core sees happens in <see cref="Poll"/> (called by <c>LobbyClient.Pump</c> / <c>Lobby.Pump</c>), so call Pump from
    /// the main thread once per frame (<see cref="OneLobbyRunner"/> does). <c>WebRTC.Update()</c> is not needed: it only
    /// copies video textures.
    /// </para>
    /// </summary>
    public sealed class UnityTransport : ITransport
    {
        private static readonly Stopwatch Clock = Stopwatch.StartNew();
        private readonly List<UnitySignalingSocket> _sockets = new List<UnitySignalingSocket>();
        private readonly List<UnityPeerLink> _links = new List<UnityPeerLink>();

        /// <summary>Fallback STUN server used when the lobby server offers no ICE servers (same as GodotTransport).</summary>
        public static string DefaultStun = "stun:stun.l.google.com:19302";

        public long NowMs => Clock.ElapsedMilliseconds;

        public ISignalingSocket ConnectSignaling(Uri url)
        {
            var s = new UnitySignalingSocket(url);
            _sockets.Add(s);
            return s;
        }

        public IPeerLink CreatePeerLink(PeerLinkOptions options)
        {
            var l = new UnityPeerLink(options, this);
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
