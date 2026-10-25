#nullable enable
using System;
using System.Collections.Generic;
using OneLobby.Opus;
using UnityEngine;

namespace OneLobby.Unity
{
    /// <summary>
    /// <see cref="IVoiceAudio"/> for Unity: <see cref="Microphone"/> capture resampled to 48 kHz mono 20 ms frames (960
    /// samples, what <see cref="VoiceChannel"/> expects), and one child <see cref="AudioSource"/> per speaker whose
    /// <see cref="VoiceSpeaker"/> component writes the decoded voice in <c>OnAudioFilterRead</c> (resampled to the output
    /// rate). Use <see cref="SpeakerCreated"/> to route a speaker to an AudioMixerGroup or to move it onto the player's
    /// avatar. Construct and use it from the main thread (Microphone and GameObject APIs are main-thread only).
    /// </summary>
    public sealed class UnityVoiceAudio : IVoiceAudio
    {
        private const int Rate = 48000;
        private const int Frame = 960;

        private readonly Transform _parent;
        private readonly Dictionary<int, VoiceSpeaker> _speakers = new Dictionary<int, VoiceSpeaker>();
        private readonly List<float> _acc = new List<float>();
        private AudioClip? _mic;
        private string? _device;
        private int _micRate;
        private int _readPos;
        private float[] _tmp = new float[4096];

        /// <summary>
        /// Microphone device name (one of <see cref="Devices"/>); null = the system default. Changing it while capturing
        /// switches microphones at once (no Dispose, no re-enabling voice).
        /// </summary>
        public string? Device
        {
            get => _deviceSetting;
            set
            {
                if (_deviceSetting == value) return;
                _deviceSetting = value;
                if (_mic != null) { StopCapture(); StartCapture(); }
            }
        }
        private string? _deviceSetting;

        /// <summary>Microphone names Unity can see (for a device picker).</summary>
        public static string[] Devices => Microphone.devices;
        /// <summary>Raised once per new remote speaker, with its AudioSource (2D by default).</summary>
        public event Action<int, AudioSource>? SpeakerCreated;

        public UnityVoiceAudio(Transform parent) { _parent = parent; }

        /// <summary>Convenience: enables voice on a lobby with the Opus codec (Concentus, managed) and this adapter.</summary>
        public static UnityVoiceAudio Attach(Transform parent, VoiceChannel voice)
        {
            var audio = new UnityVoiceAudio(parent);
            voice.Codec = new OpusVoiceCodec();
            voice.Audio = audio;
            return audio;
        }

        public bool StartCapture()
        {
            if (_mic != null) return true;
            if (Microphone.devices.Length == 0) return false;
            _device = _deviceSetting;
            Microphone.GetDeviceCaps(_device, out var min, out var max);
            _micRate = (min == 0 && max == 0) ? Rate : Mathf.Clamp(Rate, min, max);
            _mic = Microphone.Start(_device, true, 1, _micRate);
            if (_mic == null) return false;
            _readPos = 0;
            _acc.Clear();
            return true;
        }

        public void StopCapture()
        {
            if (_mic == null) return;
            Microphone.End(_device);
            UnityEngine.Object.Destroy(_mic);
            _mic = null;
            _acc.Clear();
        }

        public bool ReadCapture(Span<short> frame)
        {
            if (_mic == null) return false;
            var len = _mic.samples;
            var pos = Microphone.GetPosition(_device);
            if (pos < 0 || pos >= len) pos = 0;
            var avail = (pos - _readPos + len) % len;
            if (avail > 0)
            {
                // read up to the end of the ring, then from the start (GetData does not wrap reliably on all platforms)
                var first = Math.Min(avail, len - _readPos);
                Append(_readPos, first);
                if (avail > first) Append(0, avail - first);
                _readPos = pos;
            }
            var need = (int)Math.Ceiling(Frame * (double)_micRate / Rate);
            if (_acc.Count < need) return false;
            // linear resample mic rate -> 48 kHz for exactly one frame (same as GodotVoiceAudio)
            for (var i = 0; i < Frame; i++)
            {
                var p = i * (double)need / Frame;
                var i0 = (int)p;
                var i1 = Math.Min(i0 + 1, need - 1);
                var f = (float)(p - i0);
                var s = _acc[i0] * (1 - f) + _acc[i1] * f;
                frame[i] = (short)Math.Max(short.MinValue, Math.Min(short.MaxValue, s * 32767f));
            }
            _acc.RemoveRange(0, need);
            // never let capture lag more than ~200 ms behind the mic
            var cap = need * 10;
            if (_acc.Count > cap) _acc.RemoveRange(0, _acc.Count - cap);
            return true;
        }

        private void Append(int offset, int count)
        {
            if (_mic == null || count <= 0) return;
            if (_tmp.Length != count) _tmp = new float[count];
            _mic.GetData(_tmp, offset);
            _acc.AddRange(_tmp);
        }

        public void Play(int peerId, ReadOnlySpan<short> pcm, float gain)
        {
            if (!_speakers.TryGetValue(peerId, out var sp) || sp == null)
            {
                var go = new GameObject("OneLobbyVoice" + peerId);
                go.transform.SetParent(_parent, false);
                var src = go.AddComponent<AudioSource>();
                src.spatialBlend = 0f;
                src.loop = true;
                src.clip = AudioClip.Create("OneLobbyVoiceCarrier", AudioSettings.outputSampleRate / 10, 1, AudioSettings.outputSampleRate, false);
                sp = go.AddComponent<VoiceSpeaker>();
                _speakers[peerId] = sp;
                src.Play();
                SpeakerCreated?.Invoke(peerId, src);
            }
            sp.Push(pcm, gain);
        }

        public void Dispose()
        {
            StopCapture();
            foreach (var kv in _speakers)
                if (kv.Value != null) UnityEngine.Object.Destroy(kv.Value.gameObject);
            _speakers.Clear();
        }
    }
}
