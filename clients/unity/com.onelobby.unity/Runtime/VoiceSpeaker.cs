#nullable enable
using System;
using UnityEngine;

namespace OneLobby.Unity
{
    /// <summary>
    /// Per-speaker playback buffer: <see cref="Push"/> on the main thread, <c>OnAudioFilterRead</c> on the audio thread
    /// (replaces the carrier clip's silence with the voice, resampled 48 kHz to the output rate, on every channel).
    /// </summary>
    [AddComponentMenu("")]
    public sealed class VoiceSpeaker : MonoBehaviour
    {
        private const int Capacity = 48000 / 2; // 500 ms at 48 kHz
        private readonly float[] _ring = new float[Capacity];
        private readonly object _gate = new object();
        private int _head, _count;
        private double _phase;
        private double _step = 1.0;

        private void Awake() { _step = 48000.0 / AudioSettings.outputSampleRate; }

        internal void Push(ReadOnlySpan<short> pcm, float gain)
        {
            lock (_gate)
            {
                if (_count + pcm.Length > Capacity) return; // overrun: drop rather than lag
                for (var i = 0; i < pcm.Length; i++)
                {
                    _ring[(_head + _count) % Capacity] = Mathf.Clamp(pcm[i] / 32768f * gain, -1f, 1f);
                    _count++;
                }
            }
        }

        private void OnAudioFilterRead(float[] data, int channels)
        {
            lock (_gate)
            {
                for (var i = 0; i < data.Length; i += channels)
                {
                    float v = 0;
                    if (_count >= 2)
                    {
                        var a = _ring[_head];
                        var b = _ring[(_head + 1) % Capacity];
                        v = (float)(a + (b - a) * _phase);
                        _phase += _step;
                        while (_phase >= 1.0 && _count >= 2) { _phase -= 1.0; _head = (_head + 1) % Capacity; _count--; }
                    }
                    for (var c = 0; c < channels; c++) data[i + c] = v;
                }
            }
        }
    }
}
