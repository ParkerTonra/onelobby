#nullable enable
using System;
using System.Collections.Generic;

namespace OneLobby.Direct.Nostr
{
    /// <summary>
    /// The reliable, ordered layer over Nostr's unreliable fan-out (spec s.4) for one pair of keys: 30 ms batching, 32 KiB
    /// frames, seq/ack, resend after 3 s (5 times), beats after 10 s of quiet, a 30 s silence timeout. Not thread-safe (the
    /// owner locks) and clock-driven: everything happens in <see cref="Receive"/>, <see cref="Queue"/>, <see cref="Close"/>
    /// and <see cref="Tick"/>, so tests drive it with a fake clock.
    /// </summary>
    internal sealed class NostrLink
    {
        public const int BatchMs = 30;
        public const int ResendMs = 3000;
        public const int MaxResends = 5;
        public const int BeatMs = 10_000;
        public const int SilenceMs = 30_000;
        public const int MaxFrameBytes = 32 * 1024;
        public const int MaxHeld = 64;
        private const int FrameOverhead = 256;

        private sealed class Sent
        {
            public NostrFrame Frame = null!;
            public long LastSend;
            public int Resends;
        }

        private readonly Func<long> _now;
        private readonly Action<NostrFrame> _emit;
        private readonly List<string> _out = new List<string>();
        private readonly SortedDictionary<long, Sent> _unacked = new SortedDictionary<long, Sent>();
        private readonly Dictionary<long, List<string>> _held = new Dictionary<long, List<string>>();
        private long _sendSeq;
        private long _delivered;
        private long _flushAt = -1;
        private long _ackAt = -1;
        private long _lastSend;
        private long _lastHeard;
        private string _peer = "";

        /// <summary>The other side's pubkey, set once known; nothing is sent before.</summary>
        public string Peer
        {
            get => _peer;
            set { _peer = value; _lastHeard = _now(); _lastSend = _now(); }
        }

        public bool IsClosed { get; private set; }
        /// <summary>Why it closed: the other side's reason, or <c>timeout</c>, or what <see cref="Close"/> was given.</summary>
        public string? CloseReason { get; private set; }
        /// <summary>True when the other side closed it or it timed out (the socket reads as lost); false for a local close.</summary>
        public bool ClosedByPeerOrTimeout { get; private set; }

        public event Action<string>? Message;
        /// <summary>(reason, local): fires once, from <see cref="Receive"/>, <see cref="Tick"/> or <see cref="Close"/>.</summary>
        public event Action<string, bool>? Ended;

        public NostrLink(Func<long> now, Action<NostrFrame> emit)
        {
            _now = now;
            _emit = emit;
            _lastHeard = now();
            _lastSend = now();
        }

        public int Unacked => _unacked.Count;

        /// <summary>Queues a hub text; it leaves within 30 ms, packed with the others.</summary>
        public void Queue(string msg)
        {
            if (IsClosed) return;
            _out.Add(msg);
            if (_flushAt < 0) _flushAt = _now() + BatchMs;
        }

        /// <summary>Sends what is queued and a close frame (once), then the link is closed.</summary>
        public void Close(string? reason)
        {
            if (IsClosed) return;
            if (_peer.Length > 0)
            {
                Flush();
                Send(new NostrFrame { Type = "close", To = _peer, Seq = _sendSeq, Ack = _delivered, Reason = reason });
            }
            Finish(reason ?? "closed", true, false);
        }

        public void Receive(NostrFrame f)
        {
            if (IsClosed) return;
            _lastHeard = _now();
            switch (f.Type)
            {
                case "close":
                    Finish(string.IsNullOrEmpty(f.Reason) ? "closed" : f.Reason!, false, true);
                    return;
                case "beat":
                    Acked(f.Ack);
                    return;
                case "data":
                    Acked(f.Ack);
                    OnData(f);
                    return;
            }
        }

        private void OnData(NostrFrame f)
        {
            _ackAt = _now() + BatchMs; // answer with an ack unless a data frame goes out first
            var msgs = f.Msgs ?? new List<string>();
            if (f.Seq <= _delivered) return; // a repeat: the ack above tells the sender
            if (f.Seq == _delivered + 1)
            {
                Deliver(msgs);
                _delivered = f.Seq;
                while (!IsClosed && _held.TryGetValue(_delivered + 1, out var next))
                {
                    _held.Remove(_delivered + 1);
                    Deliver(next);
                    _delivered++;
                }
                return;
            }
            if (f.Seq - _delivered > MaxHeld || _held.Count >= MaxHeld) return;
            if (!_held.ContainsKey(f.Seq)) _held[f.Seq] = msgs;
        }

        private void Deliver(List<string> msgs)
        {
            foreach (var m in msgs)
            {
                if (IsClosed) return;
                Message?.Invoke(m);
            }
        }

        private void Acked(long ack)
        {
            if (_unacked.Count == 0) return;
            var done = new List<long>();
            foreach (var k in _unacked.Keys) { if (k <= ack) done.Add(k); else break; }
            foreach (var k in done) _unacked.Remove(k);
        }

        public void Tick()
        {
            if (IsClosed || _peer.Length == 0) return;
            var now = _now();
            if (now - _lastHeard >= SilenceMs) { Finish("timeout", false, true); return; }
            if (_flushAt >= 0 && now >= _flushAt) Flush();
            foreach (var s in _unacked.Values)
            {
                if (now - s.LastSend < ResendMs) continue;
                if (s.Resends >= MaxResends) { Finish("timeout", false, true); return; }
                s.Resends++;
                s.LastSend = now;
                s.Frame.Ack = _delivered;
                Send(s.Frame);
            }
            if (_ackAt >= 0 && now >= _ackAt) SendBeat();
            else if (now - _lastSend >= BeatMs) SendBeat();
        }

        private void SendBeat() => Send(new NostrFrame { Type = "beat", To = _peer, Seq = _sendSeq, Ack = _delivered });

        private void Send(NostrFrame f)
        {
            _lastSend = _now();
            _ackAt = -1;
            f.Ack = _delivered;
            _emit(f);
        }

        private void Flush()
        {
            _flushAt = -1;
            if (_out.Count == 0) return;
            var batch = new List<string>();
            var size = FrameOverhead;
            foreach (var m in _out)
            {
                var s = NostrFrame.MsgSize(m);
                if (batch.Count > 0 && size + s > MaxFrameBytes)
                {
                    SendData(batch);
                    batch = new List<string>();
                    size = FrameOverhead;
                }
                batch.Add(m);
                size += s;
            }
            if (batch.Count > 0) SendData(batch);
            _out.Clear();
        }

        private void SendData(List<string> msgs)
        {
            var f = new NostrFrame { Type = "data", To = _peer, Seq = ++_sendSeq, Msgs = msgs };
            _unacked[f.Seq] = new Sent { Frame = f, LastSend = _now() };
            Send(f);
        }

        private void Finish(string reason, bool local, bool byPeerOrTimeout)
        {
            if (IsClosed) return;
            IsClosed = true;
            CloseReason = reason;
            ClosedByPeerOrTimeout = byPeerOrTimeout;
            _out.Clear();
            _unacked.Clear();
            _held.Clear();
            Ended?.Invoke(reason, local);
        }
    }
}
