using System;
using System.Collections.Generic;
using Concentus;
using Concentus.Enums;

namespace Keepalive.Opus
{
    /// <summary>
    /// Opus 48 kHz mono, 20 ms frames, VBR, in-band FEC on, 24 kbit/s by default (DESIGN s.9a), using the managed
    /// Concentus port. Each speaker gets its own decoder (Opus decoders are stateful).
    /// </summary>
    public sealed class OpusVoiceCodec : IVoiceCodec
    {
        private readonly IOpusEncoder _encoder;
        private readonly Dictionary<int, IOpusDecoder> _decoders = new();
        private int _bitrate = 24000;

        public OpusVoiceCodec()
        {
            _encoder = OpusCodecFactory.CreateEncoder(SampleRate, 1, OpusApplication.OPUS_APPLICATION_VOIP);
            _encoder.Bitrate = _bitrate;
            _encoder.UseVBR = true;
            _encoder.UseInbandFEC = true;
            _encoder.PacketLossPercent = 5;
        }

        public int SampleRate => 48000;
        public int FrameSamples => 960;

        public int Bitrate
        {
            get => _bitrate;
            set { _bitrate = Math.Max(16000, Math.Min(40000, value)); _encoder.Bitrate = _bitrate; }
        }

        public int Encode(ReadOnlySpan<short> pcm, Span<byte> output) =>
            _encoder.Encode(pcm.Slice(0, FrameSamples), FrameSamples, output, output.Length);

        public int Decode(int streamId, ReadOnlySpan<byte> packet, Span<short> pcm)
        {
            if (!_decoders.TryGetValue(streamId, out var dec))
                _decoders[streamId] = dec = OpusCodecFactory.CreateDecoder(SampleRate, 1);
            // an empty packet asks Opus for packet loss concealment
            return dec.Decode(packet, pcm.Slice(0, FrameSamples), FrameSamples, false);
        }

        public void ReleaseStream(int streamId) => _decoders.Remove(streamId);

        public void Dispose() => _decoders.Clear();
    }
}
