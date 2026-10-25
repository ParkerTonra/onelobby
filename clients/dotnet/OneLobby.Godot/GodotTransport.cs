using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using Godot;


namespace OneLobby.Godot
{
    /// <summary>
    /// <see cref="ITransport"/> over Godot's engine classes: <c>WebSocketPeer</c> for signaling and
    /// <c>WebRtcPeerConnection</c>/<c>WebRtcDataChannel</c> for the peer links. Desktop builds need the webrtc-native
    /// GDExtension (see demo-godot/fetch-webrtc.ps1); a future web export supplies the classes itself.
    /// All Godot objects are touched only from <see cref="Poll"/> and the calling thread, so call Pump on the main thread.
    /// </summary>
    public sealed class GodotTransport : ITransport
    {
        private static readonly Stopwatch Clock = Stopwatch.StartNew();
        private readonly List<GodotSignalingSocket> _sockets = new();
        private readonly List<GodotPeerLink> _links = new();

        public long NowMs => Clock.ElapsedMilliseconds;

        public ISignalingSocket ConnectSignaling(Uri url)
        {
            var s = new GodotSignalingSocket(url);
            _sockets.Add(s);
            return s;
        }

        public IPeerLink CreatePeerLink(PeerLinkOptions options)
        {
            var l = new GodotPeerLink(options);
            _links.Add(l);
            return l;
        }

        public void Poll()
        {
            for (var i = _sockets.Count - 1; i >= 0; i--)
            {
                if (_sockets[i].Disposed) { _sockets.RemoveAt(i); continue; }
                _sockets[i].Poll();
            }
            for (var i = _links.Count - 1; i >= 0; i--)
            {
                if (_links[i].Disposed) { _links.RemoveAt(i); continue; }
                _links[i].Poll();
            }
        }
    }

    internal sealed class GodotSignalingSocket : ISignalingSocket
    {
        private readonly WebSocketPeer _ws = new();
        private readonly Queue<string> _inbox = new();
        private bool _everOpen;
        public bool Disposed { get; private set; }
        public SocketState State { get; private set; } = SocketState.Connecting;
        public string? CloseReason { get; private set; }

        public GodotSignalingSocket(Uri url)
        {
            var err = _ws.ConnectToUrl(url.ToString());
            if (err != Error.Ok) { State = SocketState.Closed; CloseReason = "connect failed: " + err; }
        }

        public void Poll()
        {
            if (State == SocketState.Closed) return;
            _ws.Poll();
            switch (_ws.GetReadyState())
            {
                case WebSocketPeer.State.Connecting: State = SocketState.Connecting; break;
                case WebSocketPeer.State.Open:
                    _everOpen = true;
                    State = SocketState.Open;
                    while (_ws.GetAvailablePacketCount() > 0)
                    {
                        var bytes = _ws.GetPacket();
                        if (_ws.WasStringPacket()) _inbox.Enqueue(Encoding.UTF8.GetString(bytes));
                    }
                    break;
                case WebSocketPeer.State.Closing: State = SocketState.Open; break;
                case WebSocketPeer.State.Closed:
                    State = SocketState.Closed;
                    CloseReason = _everOpen ? "closed " + _ws.GetCloseCode() + " " + _ws.GetCloseReason() : "could not connect";
                    break;
            }
        }

        public void Send(string text)
        {
            if (State == SocketState.Open) _ws.SendText(text);
        }

        public bool TryReceive(out string text)
        {
            if (_inbox.Count > 0) { text = _inbox.Dequeue(); return true; }
            text = "";
            return false;
        }

        public void Dispose()
        {
            if (Disposed) return;
            Disposed = true;
            State = SocketState.Closed;
            _ws.Close();
            _ws.Dispose();
        }
    }

    internal sealed class GodotPeerLink : IPeerLink, IBufferedPeerLink
    {
        private readonly WebRtcPeerConnection _pc = new();
        private readonly WebRtcDataChannel[] _ch = new WebRtcDataChannel[3];
        private readonly Queue<PeerSignal> _out = new();
        private readonly Queue<(PeerChannel, byte[])> _in = new();
        private readonly PeerLinkOptions _opts;
        private bool _everConnected;
        private long _lastState;

        public bool Disposed { get; private set; }
        public bool IsFailed { get; private set; }
        public int PingMs => 0;

        /// <summary>
        /// Godot's WebRtcPeerConnection does not expose the selected candidate pair, so this reports a relay only when the
        /// lobby was created relay-only (the server's path telemetry then counts it as relayed).
        /// </summary>
        public bool Relayed => _opts.RelayOnly;

        public bool IsOpen
        {
            get
            {
                if (Disposed || IsFailed) return false;
                foreach (var c in _ch) if (c.GetReadyState() != WebRtcDataChannel.ChannelState.Open) return false;
                return true;
            }
        }

        public GodotPeerLink(PeerLinkOptions options)
        {
            _opts = options;
            var servers = new global::Godot.Collections.Array<global::Godot.Collections.Dictionary>();
            foreach (var s in options.IceServers)
            {
                var d = new global::Godot.Collections.Dictionary();
                d["urls"] = new global::Godot.Collections.Array<string>(s.Urls);
                if (s.Username != null) d["username"] = s.Username;
                if (s.Credential != null) d["credential"] = s.Credential;
                servers.Add(d);
            }
            if (servers.Count == 0)
            {
                var d = new global::Godot.Collections.Dictionary();
                d["urls"] = new global::Godot.Collections.Array<string> { "stun:stun.l.google.com:19302" };
                servers.Add(d);
            }
            var config = new global::Godot.Collections.Dictionary();
            config["iceServers"] = servers;
            if (options.RelayOnly) config["iceTransportPolicy"] = "relay";
            var err = _pc.Initialize(config);
            if (err != Error.Ok) { IsFailed = true; return; }

            // negotiated channels with fixed ids, identical on both ends (DESIGN s.8)
            _ch[0] = Create("reliable", 0, true, null);
            _ch[1] = Create("fast", 1, false, 0);
            _ch[2] = Create("voice", 2, false, 0);

            _pc.SessionDescriptionCreated += (type, sdp) =>
            {
                _pc.SetLocalDescription(type, sdp);
                _out.Enqueue(PeerSignal.Description(type, sdp));
            };
            _pc.IceCandidateCreated += (media, index, name) => _out.Enqueue(PeerSignal.Ice(name, media, (int)index));
        }

        private WebRtcDataChannel Create(string label, int id, bool ordered, int? maxRetransmits)
        {
            var o = new global::Godot.Collections.Dictionary { ["negotiated"] = true, ["id"] = id, ["ordered"] = ordered };
            if (maxRetransmits.HasValue) o["maxRetransmits"] = maxRetransmits.Value;
            return _pc.CreateDataChannel(label, o);
        }

        public void Poll()
        {
            if (Disposed || IsFailed) return;
            _pc.Poll();
            var st = _pc.GetConnectionState();
            if (st == WebRtcPeerConnection.ConnectionState.Connected) _everConnected = true;
            if (st == WebRtcPeerConnection.ConnectionState.Failed || st == WebRtcPeerConnection.ConnectionState.Closed ||
                (_everConnected && st == WebRtcPeerConnection.ConnectionState.Disconnected))
            {
                IsFailed = true;
                return;
            }
            for (var i = 0; i < 3; i++)
            {
                var c = _ch[i];
                while (c.GetAvailablePacketCount() > 0) _in.Enqueue(((PeerChannel)i, c.GetPacket()));
            }
            _lastState = (long)st;
        }

        public void StartOffer() => _pc.CreateOffer();

        public void ApplySignal(PeerSignal s)
        {
            if (Disposed || IsFailed) return;
            if (s.Sdp != null) _pc.SetRemoteDescription(s.SdpType ?? "", s.Sdp);
            else if (s.Candidate != null) _pc.AddIceCandidate(s.SdpMid ?? "", s.SdpMLineIndex, s.Candidate);
        }

        public bool TryTakeSignal(out PeerSignal signal)
        {
            if (_out.Count > 0) { signal = _out.Dequeue(); return true; }
            signal = null!;
            return false;
        }

        public long ReliableBufferedBytes =>
            Disposed || IsFailed || _ch[0] == null ? 0 : _ch[0].GetBufferedAmount();

        public void Send(PeerChannel channel, ReadOnlySpan<byte> frame)
        {
            if (Disposed || IsFailed) return;
            var c = _ch[(int)channel];
            if (c.GetReadyState() == WebRtcDataChannel.ChannelState.Open) c.PutPacket(frame.ToArray());
        }

        public bool TryReceive(out PeerChannel channel, out byte[] frame)
        {
            if (_in.Count > 0) { (channel, frame) = _in.Dequeue(); return true; }
            channel = PeerChannel.Reliable; frame = System.Array.Empty<byte>();
            return false;
        }

        public void Dispose()
        {
            if (Disposed) return;
            Disposed = true;
            _pc.Close();
            _pc.Dispose();
        }
    }
}
