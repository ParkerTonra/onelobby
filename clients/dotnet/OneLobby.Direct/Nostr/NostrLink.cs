#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace OneLobby.Direct.Nostr
{
    /// <summary>
    /// The reliable, ordered layer over Nostr's unreliable fan-out (spec s.4) for one pair of keys. It mirrors the JS
    /// <c>ReliableLink</c> (clients/js/packages/client/src/nostr/link.ts) rule for rule: 30 ms batching, up to 30,000 UTF-8
    /// bytes of messages per frame, seq/ack, a 250 ms housekeeping tick that resends after 3 s (6 sends in all, then
    /// <c>timeout</c>), beats after 10 s of quiet, ack-only beats within the batch window, a 30 s silence timeout. Not
    /// thread-safe (the owner locks) and clock-driven: everything happens in <see cref="Receive"/>, <see cref="Queue"/>,
    /// <see cref="Close"/> and <see cref="Tick"/>, so tests drive it with a fake clock.
    /// </summary>
    internal sealed class NostrLink
    {
        public const int BatchMs = NostrLimits.BatchMs;
        public const int ResendMs = NostrLimits.ResendMs;
        public const int MaxResends = NostrLimits.MaxResends;
        public const int BeatMs = NostrLimits.BeatMs;
        public const int SilenceMs = NostrLimits.SilenceMs;
        public const int MaxHeld = NostrLimits.MaxHeld;
        /// <summary>UTF-8 bytes of messages per frame: under the 32 KiB content limit, room for the JSON envelope.</summary>
        public const int MaxFrameBytes = NostrLimits.MaxFrameBytes;
        public const int TickMs = NostrLimits.TickMs;
        /// <summary>Outbound cap (spec s.4 "Outbound queue"): unacknowledged frames, and bytes queued or unacknowledged. Over either, a text is dropped.</summary>
        public const int MaxOutFrames = NostrLimits.MaxOutFrames;
        public const int MaxOutBytes = NostrLimits.MaxOutBytes;

        private sealed class Sent
        {
            public NostrFrame Frame = null!;
            public long LastSend;
            public int Resends;
            public int Bytes;
        }

        private readonly Func<long> _now;
        private readonly string _peer;
        private readonly Action<NostrFrame> _emit;
        private readonly List<string> _queue = new List<string>();
        private readonly SortedDictionary<long, Sent> _unacked = new SortedDictionary<long, Sent>();
        private readonly Dictionary<long, List<string>> _held = new Dictionary<long, List<string>>();
        private long _nextSeq = 1;
        private long _rcvNext = 1; // next seq to deliver
        private bool _ackOwed;
        private long _flushAt = -1;
        private long _tickAt;
        private long _lastSent;
        private long _lastHeard;
        private bool _done;
        private int _heldBytes; // queued + unacknowledged hub text bytes

        /// <summary>Texts dropped because the outbound cap was reached.</summary>
        public int Dropped { get; private set; }

        /// <summary>The other side's pubkey; every frame this link emits is addressed to it.</summary>
        public string Peer => _peer;
        /// <summary>True once the peer closed it, it timed out, or <see cref="Close"/> / <see cref="Stop"/> ran.</summary>
        public bool IsClosed => _done;
        public int Unacked => _unacked.Count;

        /// <summary>An in-order hub protocol text from the peer.</summary>
        public event Action<string>? Message;
        /// <summary>The peer sent <c>close</c> (its reason, possibly empty). Fires once, from <see cref="Receive"/>.</summary>
        public event Action<string>? PeerClosed;
        /// <summary>Gave up: five resends unanswered, or 30 s of silence (reason <c>timeout</c>). Fires once, from <see cref="Tick"/>.</summary>
        public event Action<string>? Dead;

        public NostrLink(Func<long> now, string peer, Action<NostrFrame> emit)
        {
            _now = now;
            _peer = peer;
            _emit = emit;
            _lastSent = _lastHeard = now();
            _tickAt = _lastSent + TickMs;
        }

        /// <summary>Queues a hub text; it leaves within 30 ms, packed with its neighbours.</summary>
        public void Queue(string msg)
        {
            if (_done) return;
            var n = Encoding.UTF8.GetByteCount(msg);
            if (_unacked.Count >= MaxOutFrames || _heldBytes + n > MaxOutBytes) { Dropped++; return; } // a stuck peer: the link stays, the excess goes
            _heldBytes += n;
            _queue.Add(msg);
            ScheduleFlush();
        }

        /// <summary>Any frame arrived from the peer (including <c>open</c>, which only proves it is alive).</summary>
        public void Heard() => _lastHeard = _now();

        /// <summary><c>data</c>, <c>beat</c> and <c>close</c> frames from the peer.</summary>
        public void Receive(NostrFrame f)
        {
            if (_done) return;
            Heard();
            if (f.Type == "close")
            {
                Stop();
                PeerClosed?.Invoke(f.Reason ?? "");
                return;
            }
            if (f.Type != "data" && f.Type != "beat") return;
            foreach (var k in _unacked.Keys.Where(k => k <= f.Ack).ToList())
            {
                _heldBytes -= _unacked[k].Bytes;
                _unacked.Remove(k);
            }
            if (f.Type == "beat") return;
            var msgs = f.Msgs ?? new List<string>();
            if (f.Seq < 1) return;
            _ackOwed = true;
            if (f.Seq == _rcvNext)
            {
                _rcvNext++;
                Deliver(msgs);
                while (!_done && _held.TryGetValue(_rcvNext, out var next))
                {
                    _held.Remove(_rcvNext);
                    _rcvNext++;
                    Deliver(next);
                }
            }
            else if (f.Seq > _rcvNext && f.Seq <= _rcvNext + MaxHeld) _held[f.Seq] = msgs;
            // f.Seq < _rcvNext: a duplicate; the ack below tells the sender to stop resending
            ScheduleFlush();
        }

        private void Deliver(List<string> msgs)
        {
            foreach (var m in msgs)
            {
                if (_done) return;
                Message?.Invoke(m);
            }
        }

        /// <summary>Sends what is queued, then <c>close</c> (once), and stops.</summary>
        public void Close(string? reason = "")
        {
            if (_done) return;
            Flush();
            Emit(new NostrFrame { Type = "close", Seq = 0, Ack = _rcvNext - 1, Reason = string.IsNullOrEmpty(reason) ? null : reason });
            Stop();
        }

        /// <summary>Stops without telling the peer.</summary>
        public void Stop()
        {
            _done = true;
            _flushAt = -1;
            _unacked.Clear();
            _held.Clear();
            _queue.Clear();
            _heldBytes = 0;
        }

        private void ScheduleFlush()
        {
            if (_flushAt >= 0 || _done) return;
            _flushAt = _now() + BatchMs;
        }

        private void Flush()
        {
            if (_done) return;
            _flushAt = -1;
            var now = _now();
            if (_queue.Count == 0)
            {
                if (_ackOwed) Emit(new NostrFrame { Type = "beat", Seq = 0, Ack = _rcvNext - 1 });
                return;
            }
            var batch = new List<string>();
            var bytes = 0;
            void Ship()
            {
                if (batch.Count == 0) return;
                var frame = new NostrFrame { Type = "data", Seq = _nextSeq++, Ack = _rcvNext - 1, Msgs = batch };
                _unacked[frame.Seq] = new Sent { Frame = frame, LastSend = now, Bytes = bytes };
                Emit(frame);
                batch = new List<string>();
                bytes = 0;
            }
            var all = _queue.ToArray();
            _queue.Clear();
            foreach (var m in all)
            {
                var n = Encoding.UTF8.GetByteCount(m);
                if (batch.Count > 0 && bytes + n > MaxFrameBytes) Ship();
                batch.Add(m);
                bytes += n;
            }
            Ship();
        }

        private void Emit(NostrFrame f)
        {
            _lastSent = _now();
            _ackOwed = false;
            f.To = _peer;
            _emit(f);
        }

        /// <summary>Runs the flush timer (30 ms) and, every 250 ms, resends, beats and the silence check.</summary>
        public void Tick()
        {
            if (_done) return;
            var now = _now();
            if (_flushAt >= 0 && now >= _flushAt) Flush();
            if (_done || now < _tickAt) return;
            _tickAt = now + TickMs;
            if (now - _lastHeard >= SilenceMs) { Die(); return; }
            foreach (var s in _unacked.Values.ToArray())
            {
                if (now - s.LastSend < ResendMs) continue;
                if (s.Resends >= MaxResends) { Die(); return; }
                s.Resends++;
                s.LastSend = now;
                s.Frame.Ack = _rcvNext - 1;
                s.Frame.To = _peer;
                _emit(s.Frame);
                _lastSent = now;
            }
            if (now - _lastSent >= BeatMs) Emit(new NostrFrame { Type = "beat", Seq = 0, Ack = _rcvNext - 1 });
        }

        private void Die()
        {
            Stop();
            Dead?.Invoke("timeout");
        }
    }
}
