using System;
using System.Collections.Generic;
using System.Linq;

namespace OneLobby
{
    /// <summary>
    /// Host-ordered lockstep (DESIGN s.8). Joiners submit commands; the host places them in the next frame it has not yet
    /// emitted and broadcasts one frame per tick. Every peer (host included) consumes frames through <see cref="TryNextFrame"/>.
    /// </summary>
    public sealed class LockstepSession
    {
        public const int MaxCommandBytes = 12 * 1024;

        private readonly Lobby _lobby;
        private readonly SortedDictionary<long, Frame> _buf = new();
        private readonly SortedDictionary<long, Frame> _log = new();
        private readonly List<(int Peer, byte[] Cmd)> _pending = new();
        private readonly Dictionary<long, ulong> _ownHash = new();
        private readonly Dictionary<long, ulong> _hostHash = new();
        private readonly Dictionary<(int, long), ulong> _peerHash = new();
        private uint _cmdSeq;
        private long _head;
        private bool _emitting;
        private long _emitStartMs;
        private long _emitStartTick;
        private long _lastSnapshotReqMs = -100_000;
        private bool _graceFix;

        internal LockstepSession(Lobby lobby) { _lobby = lobby; }

        /// <summary>Last tick handed out by <see cref="TryNextFrame"/>.</summary>
        public long Tick { get; private set; }

        /// <summary>Frames received and not yet consumed. More than 2 means "run without rendering" (catch-up).</summary>
        public int FramesBuffered => _buf.Count;

        /// <summary>Highest tick for which this peer holds every frame (consumed or buffered).</summary>
        public long LastReceivedTick => _head;

        public Func<byte[]>? Snapshot { get; set; }
        public Action<long, ReadOnlyMemory<byte>>? Restore { get; set; }
        public event Action<DesyncInfo>? Desync;

        /// <summary>Queue my command. The host assigns the tick; I get it back through a frame like everyone else.</summary>
        public void Submit(ReadOnlySpan<byte> command)
        {
            if (command.Length > MaxCommandBytes) throw new ArgumentException("command too large (max " + MaxCommandBytes + " bytes)");
            if (_lobby.IsHost) _pending.Add((_lobby.LocalPeerId, command.ToArray()));
            else _lobby.SendToHost(PeerChannel.Reliable, Wire.BuildCmd(++_cmdSeq, command));
        }

        public bool TryNextFrame(out Frame frame)
        {
            if (_buf.TryGetValue(Tick + 1, out frame))
            {
                _buf.Remove(Tick + 1);
                Tick++;
                return true;
            }
            frame = default;
            return false;
        }

        /// <summary>Report the game's state hash for a tick (call every HashEveryTicks).</summary>
        public void ReportHash(long tick, ulong hash)
        {
            _ownHash[tick] = hash;
            Prune(_ownHash, tick);
            if (_lobby.IsHost)
            {
                _hostHash[tick] = hash;
                Prune(_hostHash, tick);
                foreach (var rec in _lobby.PeerRecords())
                {
                    if (rec.Id == _lobby.LocalPeerId) continue;
                    if (_peerHash.TryGetValue((rec.Id, tick), out var theirs))
                    {
                        _peerHash.Remove((rec.Id, tick));
                        _lobby.CompareHash(rec, tick, hash, theirs);
                    }
                }
            }
            else _lobby.SendToHost(PeerChannel.Reliable, Wire.BuildHash(tick, hash));
        }

        private static void Prune(Dictionary<long, ulong> d, long newest)
        {
            if (d.Count < 256) return;
            foreach (var k in d.Keys.Where(k => k < newest - 200).ToList()) d.Remove(k);
        }

        // ---- internals used by Lobby --------------------------------------------------------------------------

        internal long Head => _head;

        internal bool AcceptFrame(Frame f)
        {
            if (f.Tick <= Tick || _buf.ContainsKey(f.Tick)) return false;
            _buf[f.Tick] = f;
            _log[f.Tick] = f;
            while (_buf.ContainsKey(_head + 1)) _head++;
            var cap = Math.Max(200, _lobby.TickRate * 15);
            while (_log.Count > cap) _log.Remove(_log.Keys.First());
            return true;
        }

        internal bool LogCovers(long afterTick)
        {
            if (afterTick >= _head) return true;
            return _log.ContainsKey(afterTick + 1);
        }

        internal IEnumerable<Frame> LogAfter(long tick)
        {
            foreach (var kv in _log) if (kv.Key > tick) yield return kv.Value;
        }

        /// <summary>Snapshot restored: forget everything up to <paramref name="tick"/>.</summary>
        internal void ResetTo(long tick)
        {
            Tick = tick;
            foreach (var k in _buf.Keys.Where(k => k <= tick).ToList()) _buf.Remove(k);
            _head = tick;
            while (_buf.ContainsKey(_head + 1)) _head++;
        }

        internal void BeginEmitting(long nowMs, long afterGraceMs = 0)
        {
            _emitting = true;
            _emitStartMs = nowMs + afterGraceMs;
            _emitStartTick = _head;
            _graceFix = afterGraceMs > 0;
        }

        internal bool Emitting => _emitting;

        internal void ShortenGrace(long startMs) { if (_graceFix && startMs < _emitStartMs) _emitStartMs = startMs; }

        internal void StopEmitting() => _emitting = false;

        internal void QueueRemote(int peer, byte[] cmd)
        {
            if (cmd.Length <= MaxCommandBytes) _pending.Add((peer, cmd));
        }

        internal void DropPending(int peer) => _pending.RemoveAll(p => p.Peer == peer);

        internal void StorePeerHash(int peer, long tick, ulong hash)
        {
            _peerHash[(peer, tick)] = hash;
            if (_peerHash.Count > 4096)
                foreach (var k in _peerHash.Keys.Where(k => k.Item2 < tick - 400).ToList()) _peerHash.Remove(k);
        }

        internal bool TryHostHash(long tick, out ulong h) => _hostHash.TryGetValue(tick, out h);
        internal bool TryOwnHash(long tick, out ulong h) => _ownHash.TryGetValue(tick, out h);

        /// <summary>Host: emit all frames due on the clock. Returns frames emitted.</summary>
        internal void EmitDue(long nowMs)
        {
            if (!_emitting || nowMs < _emitStartMs) return;
            if (_graceFix) { _graceFix = false; _emitStartTick = _head; }
            var rate = _lobby.TickRate;
            var burst = 0;
            while (true)
            {
                var n = _head - _emitStartTick + 1;
                var due = _emitStartMs + n * 1000 / rate;
                if (due > nowMs) break;
                if (++burst > rate * 2)
                {
                    // far behind the wall clock (a long stall): drop the backlog instead of racing
                    _emitStartMs = nowMs;
                    _emitStartTick = _head;
                    break;
                }
                EmitOne();
            }
        }

        private void EmitOne()
        {
            var tick = _head + 1;
            var take = new List<(int, ReadOnlyMemory<byte>)>();
            var size = 11;
            var sorted = _pending.Select((p, i) => (p.Peer, p.Cmd, i)).OrderBy(x => x.Peer).ThenBy(x => x.i).ToList();
            var used = 0;
            foreach (var x in sorted)
            {
                if (take.Count > 0 && size + 4 + x.Cmd.Length > Wire.MaxFrame - 64) break;
                take.Add((x.Peer, x.Cmd));
                size += 4 + x.Cmd.Length;
                used++;
            }
            // remove exactly the commands taken (lowest peer ids first, arrival order within a peer)
            var takenIdx = new HashSet<int>(sorted.Take(used).Select(x => x.i));
            var rest = new List<(int, byte[])>();
            for (var i = 0; i < _pending.Count; i++) if (!takenIdx.Contains(i)) rest.Add(_pending[i]);
            _pending.Clear();
            _pending.AddRange(rest);
            var frame = new Frame(tick, take);
            AcceptFrame(frame);
            _lobby.BroadcastFrame(frame);
        }

        internal void RaiseDesync(DesyncInfo info) => Desync?.Invoke(info);

        internal bool ShouldRequestSnapshot(long nowMs)
        {
            if (nowMs - _lastSnapshotReqMs < 2000) return false;
            _lastSnapshotReqMs = nowMs;
            return true;
        }
    }
}
