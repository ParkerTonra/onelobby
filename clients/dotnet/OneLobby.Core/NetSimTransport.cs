using System;
using System.Collections.Generic;

namespace OneLobby
{
    /// <summary>Bad-network settings for <see cref="NetSimTransport"/>.</summary>
    /// <param name="LatencyMs">Added round trip in ms, split evenly between this peer's sends and receives.</param>
    /// <param name="JitterMs">Up to this much extra random delay per frame, each way.</param>
    /// <param name="LossPercent">Chance (0-100) to lose a Fast or Voice frame, each way. Reliable frames are never lost.</param>
    /// <param name="Seed">Random seed, for repeatable runs.</param>
    public sealed record NetSimOptions(double LatencyMs = 0, double JitterMs = 0, double LossPercent = 0, int Seed = 1);

    /// <summary>
    /// Wraps any transport and makes its peer links worse on purpose: <c>--fakelag / --fakejitter / --fakeloss</c> for
    /// dev builds. Only data channel frames are affected (signaling is not). Reliable frames are delayed but stay in order
    /// and are never lost (the <see cref="IPeerLink"/> contract); Fast and Voice frames can also be lost or reordered by
    /// jitter. Settings can change while running (<see cref="Options"/>). Delayed frames go out on <see cref="Poll"/>,
    /// which every Pump calls.
    /// </summary>
    public sealed class NetSimTransport : ITransport
    {
        private readonly ITransport _inner;
        private readonly List<SimLink> _links = new();
        private Random _rng;

        public NetSimTransport(ITransport inner, NetSimOptions options)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
            Options = options ?? throw new ArgumentNullException(nameof(options));
            _rng = new Random(options.Seed);
        }

        /// <summary>Current settings; assign to change them on the fly (the seed is only read at construction).</summary>
        public NetSimOptions Options { get; set; }
        public ITransport Inner => _inner;

        public long NowMs => _inner.NowMs;
        public ISignalingSocket ConnectSignaling(Uri url) => _inner.ConnectSignaling(url);

        public IPeerLink CreatePeerLink(PeerLinkOptions options)
        {
            var l = new SimLink(this, _inner.CreatePeerLink(options));
            _links.Add(l);
            return l;
        }

        public void Poll()
        {
            _inner.Poll();
            _links.RemoveAll(l => l.Disposed);
            foreach (var l in _links) l.Flush();
        }

        private long Delay(PeerChannel ch)
        {
            var o = Options;
            var d = o.LatencyMs / 2 + (o.JitterMs > 0 ? _rng.NextDouble() * o.JitterMs : 0);
            return (long)Math.Max(0, d);
        }

        private bool Lose(PeerChannel ch) =>
            ch != PeerChannel.Reliable && Options.LossPercent > 0 && _rng.NextDouble() * 100 < Options.LossPercent;

        private sealed class SimLink : IPeerLink
        {
            private readonly NetSimTransport _t;
            private readonly IPeerLink _inner;
            private readonly List<(long At, PeerChannel Ch, byte[] Frame)> _out = new(), _in = new();
            private long _lastReliableOut, _lastReliableIn;
            public bool Disposed;

            public SimLink(NetSimTransport t, IPeerLink inner) { _t = t; _inner = inner; }

            public bool IsOpen => _inner.IsOpen;
            public bool IsFailed => _inner.IsFailed;
            public int PingMs => _inner.PingMs;
            public bool Relayed => _inner.Relayed;
            public void StartOffer() => _inner.StartOffer();
            public void ApplySignal(PeerSignal signal) => _inner.ApplySignal(signal);
            public bool TryTakeSignal(out PeerSignal signal) => _inner.TryTakeSignal(out signal);

            public void Send(PeerChannel channel, ReadOnlySpan<byte> frame)
            {
                if (_t.Lose(channel)) return;
                var at = _t.NowMs + _t.Delay(channel);
                if (channel == PeerChannel.Reliable) { at = Math.Max(at, _lastReliableOut); _lastReliableOut = at; }
                if (at <= _t.NowMs && _out.Count == 0) { _inner.Send(channel, frame); return; }
                _out.Add((at, channel, frame.ToArray()));
            }

            public bool TryReceive(out PeerChannel channel, out byte[] frame)
            {
                while (_inner.TryReceive(out var ch, out var f))
                {
                    if (_t.Lose(ch)) continue;
                    var at = _t.NowMs + _t.Delay(ch);
                    if (ch == PeerChannel.Reliable) { at = Math.Max(at, _lastReliableIn); _lastReliableIn = at; }
                    _in.Add((at, ch, f));
                }
                return Take(_in, out channel, out frame);
            }

            public void Flush()
            {
                while (Take(_out, out var ch, out var f)) _inner.Send(ch, f);
            }

            // earliest due frame; ties keep insertion order, so reliable frames (non-decreasing times) stay in order
            private bool Take(List<(long At, PeerChannel Ch, byte[] Frame)> q, out PeerChannel channel, out byte[] frame)
            {
                var now = _t.NowMs;
                var best = -1;
                for (var i = 0; i < q.Count; i++)
                    if (q[i].At <= now && (best < 0 || q[i].At < q[best].At)) best = i;
                if (best < 0) { channel = PeerChannel.Reliable; frame = Array.Empty<byte>(); return false; }
                (_, channel, frame) = q[best];
                q.RemoveAt(best);
                return true;
            }

            public void Dispose()
            {
                Disposed = true;
                _out.Clear(); _in.Clear();
                _inner.Dispose();
            }
        }
    }
}
