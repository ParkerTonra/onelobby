#nullable enable
using System;
using System.Collections.Generic;
using Unity.WebRTC;

namespace OneLobby.Unity
{
    /// <summary>
    /// One <c>RTCPeerConnection</c> with the three negotiated channels of DESIGN s.8, identical to the JS client and
    /// GodotTransport: <c>reliable</c> id 0 ordered; <c>fast</c> id 1 unordered, maxRetransmits 0; <c>voice</c> id 2 unordered,
    /// maxRetransmits 0. Unity WebRTC's async operations (CreateOffer, SetLocal/RemoteDescription) are polled for
    /// <c>IsDone</c> from <see cref="Poll"/> instead of being yielded in a coroutine, so no MonoBehaviour is needed.
    /// </summary>
    internal sealed class UnityPeerLink : IPeerLink
    {
        private const int DisconnectGraceMs = 4000;
        private const int StatsEveryMs = 2000;

        private readonly UnityTransport _transport;
        private readonly PeerLinkOptions _opts;
        private readonly RTCPeerConnection? _pc;
        private readonly RTCDataChannel?[] _ch = new RTCDataChannel?[3];
        private readonly bool[] _chOpen = new bool[3];
        private readonly Queue<PeerSignal> _out = new Queue<PeerSignal>();
        private readonly Queue<(PeerChannel, byte[])> _in = new Queue<(PeerChannel, byte[])>();
        private readonly Queue<RTCIceCandidateInit> _pendingIce = new Queue<RTCIceCandidateInit>();
        // SDP work runs one async op at a time, in order: (start the op, continue when it is done).
        private readonly Queue<Action> _work = new Queue<Action>();
        private AsyncOperationBase? _op;
        private Action<AsyncOperationBase>? _then;
        private bool _remoteSet;
        private long _disconnectedSince = -1;
        private RTCStatsReportAsyncOperation? _statsOp;
        private long _nextStatsMs;
        private bool _relayed;
        private int _pingMs;

        public bool Disposed { get; private set; }
        public bool IsFailed { get; private set; }
        public string? FailReason { get; private set; }
        public int PingMs => _pingMs;
        /// <summary>From the selected candidate pair's candidate types (refreshed every 2 s); relay-only lobbies count as relayed.</summary>
        public bool Relayed => _relayed || _opts.RelayOnly;
        public bool IsOpen => !Disposed && !IsFailed && _chOpen[0] && _chOpen[1] && _chOpen[2];

        public UnityPeerLink(PeerLinkOptions options, UnityTransport transport)
        {
            _opts = options;
            _transport = transport;
            var servers = new List<RTCIceServer>();
            foreach (var s in options.IceServers)
            {
                var urls = new string[s.Urls.Count];
                for (var i = 0; i < urls.Length; i++) urls[i] = s.Urls[i];
                servers.Add(new RTCIceServer
                {
                    urls = urls,
                    username = s.Username ?? "",
                    credential = s.Credential ?? "",
                    credentialType = RTCIceCredentialType.Password,
                });
            }
            if (servers.Count == 0) servers.Add(new RTCIceServer { urls = new[] { UnityTransport.DefaultStun } });
            var config = new RTCConfiguration
            {
                iceServers = servers.ToArray(),
                iceTransportPolicy = options.RelayOnly ? RTCIceTransportPolicy.Relay : RTCIceTransportPolicy.All,
            };
            try
            {
                _pc = new RTCPeerConnection(ref config);
            }
            catch (Exception e)
            {
                Fail("peer connection: " + e.Message);
                return;
            }
            _pc.OnIceCandidate = c =>
            {
                if (Disposed || c == null || string.IsNullOrEmpty(c.Candidate)) return;
                _out.Enqueue(PeerSignal.Ice(c.Candidate, c.SdpMid ?? "", c.SdpMLineIndex ?? 0));
            };
            _pc.OnConnectionStateChange = st =>
            {
                if (st == RTCPeerConnectionState.Failed || st == RTCPeerConnectionState.Closed) Fail("connection " + st);
                else if (st == RTCPeerConnectionState.Disconnected) { if (_disconnectedSince < 0) _disconnectedSince = _transport.NowMs; }
                else _disconnectedSince = -1;
            };

            // negotiated channels with fixed ids, identical on both ends (DESIGN s.8)
            _ch[0] = Create("reliable", 0, true, null);
            _ch[1] = Create("fast", 1, false, 0);
            _ch[2] = Create("voice", 2, false, 0);
        }

        private RTCDataChannel? Create(string label, int id, bool ordered, int? maxRetransmits)
        {
            if (_pc == null) return null;
            var init = new RTCDataChannelInit { negotiated = true, id = id, ordered = ordered };
            if (maxRetransmits.HasValue) init.maxRetransmits = maxRetransmits.Value;
            var ch = _pc.CreateDataChannel(label, init);
            var pc = (PeerChannel)id;
            ch.OnOpen = () => _chOpen[id] = true;
            ch.OnClose = () => { if (_chOpen[id]) Fail("channel " + label + " closed"); };
            ch.OnMessage = bytes => { if (!Disposed && !IsFailed) _in.Enqueue((pc, bytes)); };
            return ch;
        }

        private void Fail(string reason)
        {
            if (IsFailed) return;
            IsFailed = true;
            FailReason = reason;
        }

        public void Poll()
        {
            if (Disposed || IsFailed || _pc == null) return;
            var now = _transport.NowMs;
            if (_disconnectedSince >= 0 && now - _disconnectedSince >= DisconnectGraceMs) { Fail("disconnected"); return; }

            // advance the SDP pipeline: finish the running op, then start the next queued step
            for (var guard = 0; guard < 8; guard++)
            {
                if (_op != null)
                {
                    if (!_op.IsDone) break;
                    var op = _op;
                    var then = _then;
                    _op = null;
                    _then = null;
                    if (op.IsError) { Fail("sdp: " + op.Error.message); return; }
                    then?.Invoke(op);
                    continue;
                }
                if (_work.Count == 0) break;
                _work.Dequeue()();
            }

            if (IsOpen) PollStats(now);
        }

        private void Run(AsyncOperationBase op, Action<AsyncOperationBase> then)
        {
            _op = op;
            _then = then;
        }

        public void StartOffer()
        {
            if (Disposed || IsFailed || _pc == null) return;
            _work.Enqueue(() => Run(_pc.CreateOffer(), o =>
            {
                var desc = ((RTCSessionDescriptionAsyncOperation)o).Desc;
                Run(_pc.SetLocalDescription(ref desc), _ => _out.Enqueue(PeerSignal.Description("offer", desc.sdp)));
            }));
        }

        public void ApplySignal(PeerSignal s)
        {
            if (Disposed || IsFailed || _pc == null) return;
            if (s.Sdp != null)
            {
                if (!TryParseType(s.SdpType, out var type)) return;
                var remote = new RTCSessionDescription { type = type, sdp = s.Sdp };
                _work.Enqueue(() =>
                {
                    RTCSetSessionDescriptionAsyncOperation op;
                    try { op = _pc.SetRemoteDescription(ref remote); }
                    catch (Exception e) { Fail("remote sdp: " + e.Message); return; }
                    Run(op, _ =>
                    {
                        _remoteSet = true;
                        while (_pendingIce.Count > 0) AddIce(_pendingIce.Dequeue());
                        if (type != RTCSdpType.Offer) return;
                        Run(_pc.CreateAnswer(), a =>
                        {
                            var answer = ((RTCSessionDescriptionAsyncOperation)a).Desc;
                            Run(_pc.SetLocalDescription(ref answer), _ => _out.Enqueue(PeerSignal.Description("answer", answer.sdp)));
                        });
                    });
                });
            }
            else if (s.Candidate != null)
            {
                var init = new RTCIceCandidateInit { candidate = s.Candidate, sdpMid = s.SdpMid, sdpMLineIndex = s.SdpMLineIndex };
                if (_remoteSet) AddIce(init); else _pendingIce.Enqueue(init);
            }
        }

        private void AddIce(RTCIceCandidateInit init)
        {
            try { _pc?.AddIceCandidate(new RTCIceCandidate(init)); }
            catch (Exception) { /* a malformed or late candidate is not fatal; ICE uses the others */ }
        }

        private static bool TryParseType(string? t, out RTCSdpType type)
        {
            switch (t)
            {
                case "offer": type = RTCSdpType.Offer; return true;
                case "answer": type = RTCSdpType.Answer; return true;
                case "pranswer": type = RTCSdpType.Pranswer; return true;
                case "rollback": type = RTCSdpType.Rollback; return true;
                default: type = RTCSdpType.Offer; return false;
            }
        }

        private void PollStats(long now)
        {
            if (_statsOp != null)
            {
                if (!_statsOp.IsDone) return;
                var op = _statsOp;
                _statsOp = null;
                if (!op.IsError && op.Value != null)
                {
                    using var report = op.Value;
                    ReadPath(report);
                }
                return;
            }
            if (now < _nextStatsMs) return;
            _nextStatsMs = now + StatsEveryMs;
            try { _statsOp = _pc!.GetStats(); } catch (Exception) { _statsOp = null; }
        }

        /// <summary>Selected candidate pair has a relay candidate on either side: relayed (same rule as the JS client).</summary>
        private void ReadPath(RTCStatsReport report)
        {
            RTCIceCandidatePairStats? pair = null;
            foreach (var st in report.Stats.Values)
                if (st is RTCTransportStats t && !string.IsNullOrEmpty(t.selectedCandidatePairId) &&
                    report.TryGetValue(t.selectedCandidatePairId, out var p) && p is RTCIceCandidatePairStats ps) pair = ps;
            if (pair == null)
                foreach (var st in report.Stats.Values)
                    if (st is RTCIceCandidatePairStats ps && ps.nominated && ps.state == "succeeded") { pair = ps; break; }
            if (pair == null) return;
            if (pair.currentRoundTripTime > 0) _pingMs = (int)(pair.currentRoundTripTime * 1000);
            var relay = false;
            if (report.TryGetValue(pair.localCandidateId, out var l) && l is RTCIceCandidateStats lc && lc.candidateType == "relay") relay = true;
            if (report.TryGetValue(pair.remoteCandidateId, out var r) && r is RTCIceCandidateStats rc && rc.candidateType == "relay") relay = true;
            _relayed = relay;
        }

        public bool TryTakeSignal(out PeerSignal signal)
        {
            if (_out.Count > 0) { signal = _out.Dequeue(); return true; }
            signal = null!;
            return false;
        }

        public unsafe void Send(PeerChannel channel, ReadOnlySpan<byte> frame)
        {
            if (Disposed || IsFailed) return;
            var i = (int)channel;
            var c = _ch[i];
            if (c == null || !_chOpen[i] || frame.Length == 0) return;
            try
            {
                fixed (byte* p = frame) c.Send((IntPtr)p, frame.Length);
            }
            catch (InvalidOperationException) { /* channel closed between the check and the send */ }
        }

        public bool TryReceive(out PeerChannel channel, out byte[] frame)
        {
            if (_in.Count > 0) { (channel, frame) = _in.Dequeue(); return true; }
            channel = PeerChannel.Reliable;
            frame = Array.Empty<byte>();
            return false;
        }

        public void Dispose()
        {
            if (Disposed) return;
            Disposed = true;
            for (var i = 0; i < 3; i++)
            {
                var c = _ch[i];
                if (c == null) continue;
                c.OnOpen = null;
                c.OnClose = null;
                c.OnMessage = null;
                try { c.Close(); c.Dispose(); } catch (Exception) { /* already torn down */ }
                _ch[i] = null;
            }
            if (_pc != null)
            {
                _pc.OnIceCandidate = null;
                _pc.OnConnectionStateChange = null;
                try { _pc.Close(); _pc.Dispose(); } catch (Exception) { /* already torn down */ }
            }
        }
    }
}
