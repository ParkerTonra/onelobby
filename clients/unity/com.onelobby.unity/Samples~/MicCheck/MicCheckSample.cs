#nullable enable
using System;
using OneLobby.Opus;
using OneLobby.Unity;
using UnityEngine;

/// <summary>
/// Microphone check (IMGUI, no lobby, no server): add this to an empty GameObject and press Play. Pick a microphone
/// (switches live, no restart), watch the level meter, and turn on Loopback to hear yourself through the same path voice
/// chat uses: Unity Microphone, 48 kHz 20 ms frames, Opus encode and decode, a VoiceSpeaker AudioSource. Wear headphones
/// for loopback. A settings screen's mic test can do the same with UnityVoiceAudio and OpusVoiceCodec.
/// Done when: the meter moves when you speak, switching devices moves it with the new mic, and loopback sounds clean
/// (about 100 ms late, no crackle) on real hardware.
/// </summary>
public sealed class MicCheckSample : MonoBehaviour
{
    UnityVoiceAudio _audio = null!;
    OpusVoiceCodec _codec = null!;
    readonly short[] _pcm = new short[960];
    readonly short[] _out = new short[960];
    readonly byte[] _packet = new byte[1500];
    bool _capturing, _loopback;
    float _level, _peak;
    int _frames;
    string _status = "";

    void Awake()
    {
        _audio = new UnityVoiceAudio(transform);
        _codec = new OpusVoiceCodec();
        Restart();
    }

    void Restart()
    {
        _audio.StopCapture();
        _capturing = _audio.StartCapture();
        _status = _capturing ? "capturing from " + (_audio.Device ?? "the default microphone") : "no microphone found";
    }

    void Update()
    {
        if (!_capturing) return;
        while (_audio.ReadCapture(_pcm))
        {
            _frames++;
            double sum = 0;
            foreach (var s in _pcm) sum += (double)s * s;
            _level = (float)Math.Min(1.0, Math.Sqrt(sum / _pcm.Length) / 32768.0 * 4); // same scale as VoiceChannel.InputLevel
            _peak = Math.Max(_level, _peak * 0.995f);
            if (!_loopback) continue;
            var n = _codec.Encode(_pcm, _packet);
            _codec.Decode(0, _packet.AsSpan(0, n), _out);
            _audio.Play(0, _out, 1f);
        }
    }

    void OnGUI()
    {
        GUILayout.BeginArea(new Rect(10, 10, 420, 600), GUI.skin.box);
        GUILayout.Label("OneLobby mic check: " + _status);
        GUILayout.Label("Microphones:");
        if (GUILayout.Toggle(_audio.Device == null, "System default")) SetDevice(null);
        foreach (var d in UnityVoiceAudio.Devices)
            if (GUILayout.Toggle(_audio.Device == d, d)) SetDevice(d);
        GUILayout.Space(8);
        GUILayout.Label($"Level {_level:0.00}   peak {_peak:0.00}   frames {_frames}");
        var r = GUILayoutUtility.GetRect(400, 18);
        GUI.Box(r, "");
        GUI.Box(new Rect(r.x, r.y, r.width * _level, r.height), "");
        GUILayout.Space(8);
        _loopback = GUILayout.Toggle(_loopback, "Loopback through Opus (headphones!)");
        GUILayout.EndArea();
    }

    void SetDevice(string? device)
    {
        if (_audio.Device == device) return;
        _audio.Device = device; // switches while capturing
        if (!_capturing) Restart();
        _status = "capturing from " + (device ?? "the default microphone");
    }

    void OnDestroy()
    {
        _audio.Dispose();
        _codec.Dispose();
    }
}
