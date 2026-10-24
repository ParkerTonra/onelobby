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
        void Send(PeerChannel channel, ReadOnlySpan<byte> frame);
        bool TryReceive(out PeerChannel channel, out byte[] frame);
    }

    public sealed record PeerLinkOptions(int RemotePeerId, bool Initiator, IReadOnlyList<IceServer> IceServers, bool RelayOnly);

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
