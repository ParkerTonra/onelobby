using System;
using System.Collections.Generic;
using Godot;
using Keepalive.Opus;

namespace Keepalive.Godot
{
    /// <summary>
    /// Microphone capture (AudioStreamMicrophone into a muted bus with an AudioEffectCapture) and per-speaker playback
    /// (AudioStreamGenerator players on the "KeepaliveVoice" bus, so a game can duck its music against it).
    /// Needs the project setting <c>audio/driver/enable_input = true</c> for capture; with the Dummy audio driver
    /// (headless runs) capture simply yields no frames.
    /// </summary>
    public sealed class GodotVoiceAudio : IVoiceAudio
    {
        public const string MicBus = "KeepaliveMic";
        public const string VoiceBus = "KeepaliveVoice";
        private const int Rate = 48000;
        private const int Frame = 960;

        private readonly Node _parent;
        private AudioStreamPlayer? _mic;
        private AudioEffectCapture? _capture;
        private readonly List<float> _acc = new();
        private readonly Dictionary<int, (AudioStreamPlayer Player, AudioStreamGeneratorPlayback Playback)> _speakers = new();

        public GodotVoiceAudio(Node parent) { _parent = parent; }

        /// <summary>Convenience: enables voice on a lobby with the Opus codec and this audio adapter.</summary>
        public static GodotVoiceAudio Attach(Node parent, VoiceChannel voice)
        {
            var audio = new GodotVoiceAudio(parent);
            voice.Codec = new OpusVoiceCodec();
            voice.Audio = audio;
            return audio;
        }

        private static int EnsureBus(string name)
        {
            var idx = AudioServer.GetBusIndex(name);
            if (idx >= 0) return idx;
            AudioServer.AddBus();
            idx = AudioServer.BusCount - 1;
            AudioServer.SetBusName(idx, name);
            return idx;
        }

        public bool StartCapture()
        {
            if (_mic != null) return true;
            var bus = EnsureBus(MicBus);
            AudioServer.SetBusMute(bus, true); // the mic must not play back through the speakers
            var fx = new AudioEffectCapture { BufferLength = 0.5f };
            AudioServer.AddBusEffect(bus, fx);
            _capture = fx;
            _mic = new AudioStreamPlayer { Stream = new AudioStreamMicrophone(), Bus = MicBus, Name = "KeepaliveMicPlayer" };
            _parent.AddChild(_mic);
            _mic.Play();
            return true;
        }

        public void StopCapture()
        {
            if (_mic == null) return;
            _mic.Stop();
            _mic.QueueFree();
            _mic = null;
            var bus = AudioServer.GetBusIndex(MicBus);
            if (bus >= 0 && _capture != null)
                for (var i = AudioServer.GetBusEffectCount(bus) - 1; i >= 0; i--)
                    if (ReferenceEquals(AudioServer.GetBusEffect(bus, i), _capture)) AudioServer.RemoveBusEffect(bus, i);
            _capture = null;
            _acc.Clear();
        }

        public bool ReadCapture(Span<short> frame)
        {
            if (_capture == null) return false;
            var mix = AudioServer.GetMixRate();
            var need = (int)Math.Ceiling(Frame * mix / Rate);
            var avail = _capture.GetFramesAvailable();
            if (avail > 0)
            {
                foreach (var v in _capture.GetBuffer(avail)) _acc.Add((v.X + v.Y) * 0.5f);
            }
            if (_acc.Count < need) return false;
            // linear resample mix rate -> 48 kHz for exactly one frame
            for (var i = 0; i < Frame; i++)
            {
                var pos = i * (double)need / Frame;
                var i0 = (int)pos;
                var i1 = Math.Min(i0 + 1, need - 1);
                var f = (float)(pos - i0);
                var s = _acc[i0] * (1 - f) + _acc[i1] * f;
                frame[i] = (short)Math.Max(short.MinValue, Math.Min(short.MaxValue, s * 32767f));
            }
            _acc.RemoveRange(0, need);
            return true;
        }

        public void Play(int peerId, ReadOnlySpan<short> pcm, float gain)
        {
            if (!_speakers.TryGetValue(peerId, out var sp))
            {
                EnsureBus(VoiceBus);
                var player = new AudioStreamPlayer
                {
                    Stream = new AudioStreamGenerator { MixRate = Rate, BufferLength = 0.3f },
                    Bus = VoiceBus,
                    Name = "KeepaliveVoice" + peerId,
                };
                _parent.AddChild(player);
                player.Play();
                sp = (player, (AudioStreamGeneratorPlayback)player.GetStreamPlayback());
                _speakers[peerId] = sp;
            }
            var n = pcm.Length;
            if (sp.Playback.GetFramesAvailable() < n) return; // overrun: drop rather than lag
            var buf = new Vector2[n];
            for (var i = 0; i < n; i++)
            {
                var v = Math.Max(-1f, Math.Min(1f, pcm[i] / 32768f * gain));
                buf[i] = new Vector2(v, v);
            }
            sp.Playback.PushBuffer(buf);
        }

        public void Dispose()
        {
            StopCapture();
            foreach (var kv in _speakers) kv.Value.Player.QueueFree();
            _speakers.Clear();
        }
    }
}
