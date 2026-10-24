using System;
using System.Linq;
using OneLobby;

// join-direct --only-typed: the joiner throws away every ICE candidate the host offers (SDP a=candidate lines and
// trickled ice), so the typed address (added inside the link as ExtraRemoteCandidates) is the only way to reach the host.
// That is what a joiner on the internet sees when the host is behind a forwarded port: the host's own candidates are
// private and unreachable. One machine can then prove the docs/direct-ip.md s.2 candidate rule without a second network.
internal sealed class OnlyTypedTransport : ITransport
{
    private readonly ITransport _inner;
    public int Dropped { get; private set; }

    public OnlyTypedTransport(ITransport inner) => _inner = inner;

    public long NowMs => _inner.NowMs;
    public ISignalingSocket ConnectSignaling(Uri url) => _inner.ConnectSignaling(url);
    public IPeerLink CreatePeerLink(PeerLinkOptions options) => new Link(_inner.CreatePeerLink(options), this);
    public void Poll() => _inner.Poll();

    private sealed class Link : IPeerLink
    {
        private readonly IPeerLink _l;
        private readonly OnlyTypedTransport _t;
        public Link(IPeerLink l, OnlyTypedTransport t) { _l = l; _t = t; }

        public bool IsOpen => _l.IsOpen;
        public bool IsFailed => _l.IsFailed;
        public int PingMs => _l.PingMs;
        public bool Relayed => _l.Relayed;
        public void StartOffer() => _l.StartOffer();
        public bool TryTakeSignal(out PeerSignal signal) => _l.TryTakeSignal(out signal);
        public void Send(PeerChannel channel, ReadOnlySpan<byte> frame) => _l.Send(channel, frame);
        public bool TryReceive(out PeerChannel channel, out byte[] frame) => _l.TryReceive(out channel, out frame);
        public void Dispose() => _l.Dispose();

        public void ApplySignal(PeerSignal signal)
        {
            if (signal.Candidate != null) { _t.Dropped++; return; }
            if (signal.Sdp != null)
            {
                var lines = signal.Sdp.Split('\n');
                var kept = lines.Where(x => !x.StartsWith("a=candidate", StringComparison.Ordinal)).ToArray();
                _t.Dropped += lines.Length - kept.Length;
                signal = signal with { Sdp = string.Join("\n", kept) };
            }
            _l.ApplySignal(signal);
        }
    }
}
