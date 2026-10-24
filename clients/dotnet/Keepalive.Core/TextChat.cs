using System;
using System.Collections.Generic;
using System.Text;

namespace Keepalive
{
    /// <summary>Text chat (DESIGN s.9b): sender to host to all on the reliable channel, host stamps id and ts.</summary>
    public sealed class TextChat
    {
        public const int MaxBytes = 256;
        public const int HistoryLimit = 100;
        public const int RateWindowMs = 5000;
        public const int RateBurst = 3;
        public const int RatePer5s = 5;

        private readonly Lobby _lobby;
        private readonly List<ChatLine> _history = new();
        private readonly HashSet<int> _hostMuted = new();
        private readonly Dictionary<int, Bucket> _buckets = new();
        private uint _localId;
        private uint _hostId;

        private sealed class Bucket { public double Tokens = RateBurst; public long LastMs; }

        internal TextChat(Lobby lobby) { _lobby = lobby; }

        public IReadOnlyList<ChatLine> History => _history;
        public Func<string, string>? Filter { get; set; }
        public event Action<ChatLine>? Received;
        public event Action<uint, string>? Rejected;

        /// <summary>Send a line (at most 256 UTF-8 bytes). Over-long text is rejected locally with reason "length".</summary>
        public void Send(string text)
        {
            var id = ++_localId;
            if (Encoding.UTF8.GetByteCount(text) > MaxBytes) { Rejected?.Invoke(id, "length"); return; }
            if (_lobby.IsHost) HostHandle(_lobby.LocalPeerId, id, text);
            else _lobby.SendToHost(PeerChannel.Reliable, Wire.BuildChat(0, id, 0, text));
        }

        public void HostMute(int peerId, bool muted)
        {
            if (!_lobby.IsHost) return;
            if (muted) _hostMuted.Add(peerId); else _hostMuted.Remove(peerId);
        }

        // ---- internals ------------------------------------------------------------------------------------------

        /// <summary>Host side: validate a line from <paramref name="from"/>, stamp it, broadcast it (sender included).</summary>
        internal void HostHandle(int from, uint senderId, string text)
        {
            if (_hostMuted.Contains(from)) { Reject(from, senderId, Wire.ChatMuted); return; }
            if (Encoding.UTF8.GetByteCount(text) > MaxBytes) { Reject(from, senderId, Wire.ChatLength); return; }
            if (!TakeToken(from)) { Reject(from, senderId, Wire.ChatRate); return; }
            text = Wire.SanitizeChat(text);
            if (text.Length == 0) return;
            var ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var line = new ChatLine(from, ++_hostId, ts, text);
            _lobby.BroadcastAll(PeerChannel.Reliable, Wire.BuildChat(from, line.Id, ts, text));
            Deliver(line);
        }

        private bool TakeToken(int peer)
        {
            var now = _lobby.NowMs;
            if (!_buckets.TryGetValue(peer, out var b)) _buckets[peer] = b = new Bucket { LastMs = now };
            b.Tokens = Math.Min(RateBurst, b.Tokens + (now - b.LastMs) * RatePer5s / (double)RateWindowMs);
            b.LastMs = now;
            if (b.Tokens < 1) return false;
            b.Tokens -= 1;
            return true;
        }

        private void Reject(int to, uint id, byte reason)
        {
            if (to == _lobby.LocalPeerId) Rejected?.Invoke(id, ReasonName(reason));
            else _lobby.SendToPeer(to, PeerChannel.Reliable, Wire.BuildChatReject(id, reason));
        }

        internal static string ReasonName(byte r) => r switch { Wire.ChatRate => "rate", Wire.ChatLength => "length", Wire.ChatMuted => "muted_by_host", _ => "unknown" };

        internal void OnReject(uint id, byte reason) => Rejected?.Invoke(id, ReasonName(reason));

        /// <summary>A stamped line arrived (or was produced by the host itself).</summary>
        internal void Deliver(ChatLine line)
        {
            _history.Add(line);
            while (_history.Count > HistoryLimit) _history.RemoveAt(0);
            if (_lobby.IsLocallyMuted(line.PeerId)) return;
            var text = Filter != null ? Filter(line.Text) : line.Text;
            Received?.Invoke(text == line.Text ? line : line with { Text = text });
        }

        internal void SetHistory(IEnumerable<ChatLine> lines)
        {
            _history.Clear();
            _history.AddRange(lines);
            while (_history.Count > HistoryLimit) _history.RemoveAt(0);
        }

        internal void AdoptHostCounter()
        {
            uint max = 0;
            foreach (var l in _history) if (l.Id > max) max = l.Id;
            if (max > _hostId) _hostId = max;
        }
    }
}
