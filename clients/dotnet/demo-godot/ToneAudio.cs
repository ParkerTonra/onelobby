using System;
using System.Diagnostics;
using Keepalive;

namespace KeepaliveDemo;

/// <summary>Test audio: capture is a 440 Hz sine at real-time pace; playback only counts frames (works under the Dummy driver).</summary>
public sealed class ToneAudio : IVoiceAudio
{
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private long _frames;
    private bool _on;
    public Action? Started;
    public Action<int>? FirstFrameFrom;
    private readonly System.Collections.Generic.HashSet<int> _heard = new();

    public bool StartCapture() { _on = true; _clock.Restart(); _frames = 0; Started?.Invoke(); return true; }
    public void StopCapture() { _on = false; }

    public bool ReadCapture(Span<short> frame)
    {
        if (!_on || _clock.ElapsedMilliseconds < _frames * 20) return false;
        for (var i = 0; i < frame.Length; i++)
            frame[i] = (short)(12000 * Math.Sin(2 * Math.PI * 440 * (_frames * 960 + i) / 48000.0));
        _frames++;
        return true;
    }

    public void Play(int peerId, ReadOnlySpan<short> pcm, float gain)
    {
        if (_heard.Add(peerId)) FirstFrameFrom?.Invoke(peerId);
    }

    public void Dispose() { }
}
