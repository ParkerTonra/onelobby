using System;
using System.Collections.Generic;

namespace OneLobby
{
    /// <summary>One ICE server entry from the server's <c>welcome</c>.</summary>
    public sealed record IceServer(IReadOnlyList<string> Urls, string? Username = null, string? Credential = null);

    public enum PeerChannel : byte { Reliable = 0, Fast = 1, Voice = 2 }

    public enum SocketState { Connecting, Open, Closed }

    /// <summary>A locally produced signaling blob for a peer connection (SDP or one ICE candidate).</summary>
    public sealed record PeerSignal(string? SdpType, string? Sdp, string? Candidate, string? SdpMid, int SdpMLineIndex)
    {
        public static PeerSignal Description(string type, string sdp) => new(type, sdp, null, null, 0);
        public static PeerSignal Ice(string candidate, string mid, int index) => new(null, null, candidate, mid, index);
    }

    /// <summary>The signaling WebSocket (text frames). Pull-based: the library polls, never the other way round.</summary>
    public interface ISignalingSocket : IDisposable
    {
        SocketState State { get; }
        string? CloseReason { get; }
        void Send(string text);
        bool TryReceive(out string text);
    }

    /// <summary>One WebRTC connection with the three negotiated data channels (reliable 0, fast 1, voice 2).</summary>
    public interface IPeerLink : IDisposable
    {
        /// <summary>True once all three channels are open.</summary>
        bool IsOpen { get; }
        /// <summary>True when the connection failed or closed after being created.</summary>
        bool IsFailed { get; }
        int PingMs { get; }
        bool Relayed { get; }
        /// <summary>Initiator side: create the offer (signals appear through <see cref="TryTakeSignal"/>).</summary>
        void StartOffer();
        void ApplySignal(PeerSignal signal);
        bool TryTakeSignal(out PeerSignal signal);
        /// <summary>
        /// Queue one frame. Contract every transport keeps: <see cref="PeerChannel.Reliable"/> frames arrive complete, in
        /// send order, exactly once, for as long as the link is open (WebRTC: an ordered reliable SCTP channel). Fast and
        /// Voice frames may be lost or reordered, never corrupted or duplicated.
        /// </summary>
        void Send(PeerChannel channel, ReadOnlySpan<byte> frame);
        bool TryReceive(out PeerChannel channel, out byte[] frame);
    }

    /// <summary>What a transport needs to build one peer link.</summary>
    /// <param name="RemotePeerId">The peer at the other end.</param>
    /// <param name="Initiator">True: this side creates the offer.</param>
    /// <param name="IceServers">STUN/TURN servers from the hub's <c>welcome</c>.</param>
    /// <param name="RelayOnly">Only relay candidates (TURN).</param>
    /// <param name="PortRangeBegin">First local UDP port ICE may bind (0 = any). Direct-IP hosts pin
    /// <c>PortRangeBegin = PortRangeEnd = P</c> so one forwarded port carries every peer (docs/direct-ip.md s.2).</param>
    /// <param name="PortRangeEnd">Last local UDP port ICE may bind (0 = any).</param>
    /// <param name="ExtraRemoteCandidates">ICE candidate lines the link adds for the remote side once the remote
    /// description is set, e.g. <c>candidate:1 1 UDP 2122317823 203.0.113.7 47810 typ host</c>: a direct-IP joiner adds
    /// the address it typed, because the host only knows and offers its private LAN addresses.</param>
    /// <param name="NoIceServers">Use exactly <paramref name="IceServers"/>, even when empty: no default STUN server
    /// (direct IP talks to no outside server).</param>
    public sealed record PeerLinkOptions(int RemotePeerId, bool Initiator, IReadOnlyList<IceServer> IceServers, bool RelayOnly,
        int PortRangeBegin = 0, int PortRangeEnd = 0, IReadOnlyList<string>? ExtraRemoteCandidates = null, bool NoIceServers = false);

    /// <summary>Engine-specific plumbing. OneLobby.Godot and <c>InMemoryNetwork</c> implement it.</summary>
    public interface ITransport
    {
        /// <summary>Monotonic milliseconds. Tests drive it by hand.</summary>
        long NowMs { get; }
        ISignalingSocket ConnectSignaling(Uri url);
        IPeerLink CreatePeerLink(PeerLinkOptions options);
        /// <summary>Called at the start of every Pump (Godot: poll WebSocketPeer and WebRtcPeerConnection).</summary>
        void Poll();
    }
}
