using System;
using System.Collections.Generic;

namespace Keepalive
{
    /// <summary>Voice codec (DESIGN s.9a): 48 kHz mono, 20 ms frames of <see cref="FrameSamples"/> samples.</summary>
    public interface IVoiceCodec : IDisposable
    {
        int SampleRate { get; }
        int FrameSamples { get; }
        /// <summary>Bits per second for the encoder (16000-40000, default 24000).</summary>
        int Bitrate { get; set; }
        /// <summary>Encode one frame; returns the number of bytes written to <paramref name="output"/>.</summary>
        int Encode(ReadOnlySpan<short> pcm, Span<byte> output);
        /// <summary>Decode one frame for the given speaker stream. An empty packet asks for loss concealment (PLC).</summary>
        int Decode(int streamId, ReadOnlySpan<byte> packet, Span<short> pcm);
        /// <summary>Forget a speaker's decoder state.</summary>
        void ReleaseStream(int streamId);
    }

    /// <summary>Microphone capture and speaker playback (Godot buses, Web Audio, or a test double).</summary>
    public interface IVoiceAudio : IDisposable
    {
        bool StartCapture();
        void StopCapture();
        /// <summary>Fills <paramref name="frame"/> with captured 48 kHz mono samples; false when a full frame is not ready.</summary>
        bool ReadCapture(Span<short> frame);
        void Play(int peerId, ReadOnlySpan<short> pcm, float gain);
    }

    /// <summary>Voice: capture, gate, encode, packetize (2 frames per packet), jitter buffer, decode, playback.</summary>
    public sealed class VoiceChannel
    {
        public const int FramesPerPacket = 2;
        public const int FrameMs = 20;
        public const int JitterFrames = 3;
        public const int HangoverMs = 300;
        public const int MaxPacketBytes = 1024;
        public const int MaxSpeakers = 8;
        public const int MaxPacketsPerSecond = 30;
        public const double VadThreshold = 0.015;

        private readonly Lobby _lobby;
        private bool _enabled;
        private bool _ptt;
        private bool _capturing;
        private bool _talking;
        private long _vadUntilMs;
        private int _seq;
        private readonly List<byte[]> _outFrames = new();
        private readonly byte[] _enc = new byte[1500];
        private readonly Dictionary<int, bool> _locallyMuted = new();
        private readonly Dictionary<int, float> _volume = new();
        private readonly Dictionary<int, Rx> _rx = new();
        private readonly Dictionary<int, HostTrack> _host = new();

        private sealed class Rx
        {
            public readonly Queue<byte[]?> Queue = new();
            public int ExpectSeq = -1;
            public bool Playing, Ended, Speaking;
            public long PlayStartMs, LastPacketMs;
            public int Played;
            public int LastPacketFrames = FramesPerPacket;
        }

        private sealed class HostTrack
        {
            public double Tokens = MaxPacketsPerSecond;
            public long LastMs, LastPacketMs;
            public bool Active;
        }

        internal VoiceChannel(Lobby lobby) { _lobby = lobby; }

        public bool Enabled
        {
            get => _enabled;
            set
            {
                if (_enabled == value) return;
                _enabled = value;
                if (!value) { StopTalking(false); StopCaptureIfRunning(); }
            }
        }

        public VoiceMode Mode { get; set; } = VoiceMode.PushToTalk;
        public bool Muted { get; set; }
        public float InputLevel { get; private set; }
        public IVoiceCodec? Codec { get; set; }
        public IVoiceAudio? Audio { get; set; }
        public event Action<int, bool>? Speaking;
        public event Action<string>? VoiceError;

        public void PushToTalk(bool down) => _ptt = down;

        public void SetMuted(int peerId, bool muted)
        {
            if (muted) _locallyMuted[peerId] = true; else _locallyMuted.Remove(peerId);
            if (muted && _rx.TryGetValue(peerId, out var rx)) { rx.Queue.Clear(); EndSpeaking(peerId, rx); }
        }

        public void SetVolume(int peerId, float gain) => _volume[peerId] = Math.Max(0f, Math.Min(2f, gain));

        internal bool IsMuted(int peerId) => _locallyMuted.ContainsKey(peerId);

        // ---- capture / send -------------------------------------------------------------------------------------

        private void StopCaptureIfRunning()
        {
            if (_capturing) { Audio?.StopCapture(); _capturing = false; }
        }

        private void StopTalking(bool sendEnd)
        {
            if (!_talking) return;
            _talking = false;
            FlushPackets(true);
            if (!sendEnd) _outFrames.Clear();
        }

        internal void Update(long nowMs)
        {
            UpdateCapture(nowMs);
            UpdatePlayback(nowMs);
        }

        private void UpdateCapture(long nowMs)
        {
            var codec = Codec;
            var audio = Audio;
            if (!_enabled || codec == null || audio == null) return;
            if (!_capturing)
            {
                if (!audio.StartCapture()) { VoiceError?.Invoke("capture_unavailable"); _enabled = false; return; }
                _capturing = true;
            }
            var pcm = new short[codec.FrameSamples];
            var guard = 0;
            while (guard++ < 10 && audio.ReadCapture(pcm))
            {
                var rms = Rms(pcm);
                InputLevel = (float)Math.Min(1.0, rms * 4);
                bool want;
                if (Muted) want = false;
                else if (Mode == VoiceMode.PushToTalk) want = _ptt;
                else
                {
                    if (rms > VadThreshold) _vadUntilMs = nowMs + HangoverMs;
                    want = nowMs <= _vadUntilMs;
                }
                if (want)
                {
                    int n;
                    try { n = codec.Encode(pcm, _enc); }
                    catch (Exception e) { VoiceError?.Invoke("encode_failed: " + e.Message); continue; }
                    _talking = true;
                    _outFrames.Add(_enc.AsSpan(0, n).ToArray());
                    if (_outFrames.Count >= FramesPerPacket) FlushPackets(false);
                }
                else if (_talking)
                {
                    _talking = false;
                    FlushPackets(true);
                }
            }
            if (!_talking && !_ptt && Mode == VoiceMode.PushToTalk) InputLevel = guard > 1 ? InputLevel : InputLevel * 0.9f;
        }

        private static double Rms(ReadOnlySpan<short> pcm)
        {
            if (pcm.Length == 0) return 0;
            double sum = 0;
            foreach (var s in pcm) sum += (double)s * s;
            return Math.Sqrt(sum / pcm.Length) / 32768.0;
        }

        private void FlushPackets(bool end)
        {
            if (_outFrames.Count == 0 && !end) return;
            var frames = new List<byte[]>(_outFrames);
            _outFrames.Clear();
            var packet = Wire.BuildVoice(_lobby.LocalPeerId, _seq++ & 0xFFFF, (byte)(end ? 1 : 0), frames);
            _lobby.SendVoiceFromLocal(packet);
        }

        // ---- host relay -----------------------------------------------------------------------------------------

        /// <summary>Host: validate a packet from <paramref name="from"/> (size, speakers, rate). True to forward.</summary>
        internal bool HostAdmit(int from, int packetBytes, byte flags, long nowMs)
        {
            if (packetBytes > MaxPacketBytes) return false;
            if (!_host.TryGetValue(from, out var t)) _host[from] = t = new HostTrack { LastMs = nowMs };
            t.Tokens = Math.Min(MaxPacketsPerSecond, t.Tokens + (nowMs - t.LastMs) * MaxPacketsPerSecond / 1000.0);
            t.LastMs = nowMs;
            if (t.Tokens < 1) return false;
            if (!t.Active)
            {
                var active = 0;
                foreach (var kv in _host) if (kv.Key != from && kv.Value.Active && nowMs - kv.Value.LastPacketMs < 500) active++;
                if (active >= MaxSpeakers) return false;
            }
            t.Tokens -= 1;
            t.Active = (flags & 1) == 0;
            t.LastPacketMs = nowMs;
            return true;
        }

        // ---- receive --------------------------------------------------------------------------------------------

        internal void OnPacket(int from, ReadOnlySpan<byte> body, long nowMs)
        {
            if (!_enabled || Codec == null || Audio == null || IsMuted(from)) return;
            var r = new Wire.Reader(body);
            var seq = r.U16();
            var flags = r.U8();
            int n = r.U8();
            var frames = new List<byte[]>(n);
            for (var i = 0; i < n; i++) { var len = r.U16(); frames.Add(r.Bytes(len).ToArray()); }
            if (!_rx.TryGetValue(from, out var rx)) _rx[from] = rx = new Rx();
            if (rx.ExpectSeq >= 0)
            {
                var diff = (seq - rx.ExpectSeq) & 0xFFFF;
                if (diff >= 0x8000) return; // late or duplicate
                if (diff > 0 && diff < 16)
                    for (var i = 0; i < diff * rx.LastPacketFrames; i++) rx.Queue.Enqueue(null); // PLC placeholders
            }
            rx.ExpectSeq = (seq + 1) & 0xFFFF;
            if (frames.Count > 0) rx.LastPacketFrames = frames.Count;
            foreach (var f in frames) rx.Queue.Enqueue(f);
            rx.LastPacketMs = nowMs;
            rx.Ended = (flags & 1) != 0;
            if (frames.Count > 0 && !rx.Speaking) { rx.Speaking = true; Speaking?.Invoke(from, true); }
        }

        private void UpdatePlayback(long nowMs)
        {
            var codec = Codec;
            var audio = Audio;
            if (codec == null || audio == null || _rx.Count == 0) return;
            List<int>? gone = null;
            var pcm = new short[codec.FrameSamples];
            foreach (var kv in _rx)
            {
                var rx = kv.Value;
                if (!rx.Playing && (rx.Queue.Count >= JitterFrames || (rx.Ended && rx.Queue.Count > 0)))
                {
                    rx.Playing = true; rx.PlayStartMs = nowMs; rx.Played = 0;
                }
                if (rx.Playing)
                {
                    var target = (int)((nowMs - rx.PlayStartMs) / FrameMs) + 1;
                    var gain = _volume.TryGetValue(kv.Key, out var g) ? g : 1f;
                    while (rx.Played < target && rx.Queue.Count > 0)
                    {
                        var packet = rx.Queue.Dequeue();
                        rx.Played++;
                        try
                        {
                            codec.Decode(kv.Key, packet ?? ReadOnlySpan<byte>.Empty, pcm);
                            audio.Play(kv.Key, pcm, gain);
                        }
                        catch (Exception e) { VoiceError?.Invoke("decode_failed: " + e.Message); }
                    }
                    if (rx.Queue.Count == 0 && rx.Played < target) rx.Playing = false; // underrun: rebuffer
                }
                if (rx.Speaking && rx.Queue.Count == 0 && (rx.Ended || nowMs - rx.LastPacketMs > 500)) EndSpeaking(kv.Key, rx);
                if (!rx.Speaking && rx.Queue.Count == 0 && nowMs - rx.LastPacketMs > 5000) (gone ??= new List<int>()).Add(kv.Key);
            }
            if (gone != null) foreach (var id in gone) { _rx.Remove(id); codec.ReleaseStream(id); }
        }

        private void EndSpeaking(int peerId, Rx rx)
        {
            rx.Playing = false;
            rx.ExpectSeq = -1;
            if (rx.Speaking) { rx.Speaking = false; Speaking?.Invoke(peerId, false); }
        }

        internal void OnPeerGone(int peerId)
        {
            if (_rx.TryGetValue(peerId, out var rx)) { EndSpeaking(peerId, rx); _rx.Remove(peerId); Codec?.ReleaseStream(peerId); }
            _host.Remove(peerId);
        }
    }
}
