#nullable enable
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Text.Json;

namespace OneLobby.Direct.Nostr
{
    /// <summary>
    /// One side's connection to a room (spec s.3): a fresh key pair, frames sealed into signed kind 25050 events published to
    /// every relay, and the relays' events opened, filtered (own events, old events, repeats, wrong sender) and queued for
    /// the owner to drain on its own thread with <see cref="TryTake"/>.
    /// </summary>
    internal sealed class NostrChannel : IDisposable
    {
        private const long MaxAgeSeconds = 120;

        private readonly INostrRelays _relays;
        private readonly NostrRoomKeys _keys;
        private readonly Func<long> _unixSeconds;
        private readonly byte[] _secret;
        private readonly byte[] _pub;
        private readonly ConcurrentQueue<NostrFrame> _in = new ConcurrentQueue<NostrFrame>();
        private readonly Dictionary<string, long> _seen = new Dictionary<string, long>(StringComparer.Ordinal);
        private long _lastPrune;

        /// <summary>This side's public key, lower-case hex.</summary>
        public string Pubkey { get; }
        public INostrRelays Relays => _relays;

        private readonly bool _secretIsEven;

        public NostrChannel(INostrRelays relays, NostrRoomKeys keys, Func<long> unixSeconds, byte[]? secret = null)
        {
            _relays = relays;
            _keys = keys;
            _unixSeconds = unixSeconds;
            if (secret != null)
            {
                _secret = secret;
                _pub = Schnorr.PublicKey(secret);
            }
            else { Schnorr.NewKeyPair(out _secret, out _pub); _secretIsEven = true; }
            Pubkey = NostrCrypto.Hex(_pub);
            _relays.EventReceived += OnEvent;
        }

        public void Start() => _relays.Start();

        /// <summary>Seals <paramref name="frame"/> (its <c>From</c> is set here) and publishes it to every relay.</summary>
        public void Publish(NostrFrame frame)
        {
            frame.From = Pubkey;
            var content = NostrEvents.Seal(_keys, frame.ToJson());
            _relays.Publish(NostrEvents.Build(_secret, Pubkey, _unixSeconds(), _keys.Topic, content, evenYPublicKey: _secretIsEven ? _pub : null));
        }

        public bool TryTake(out NostrFrame frame) => _in.TryDequeue(out frame!);

        /// <summary>Called on relay threads with one event object; test code may call it too.</summary>
        public void OnEvent(string eventJson)
        {
            try
            {
                using var doc = JsonDocument.Parse(eventJson);
                var e = doc.RootElement;
                if (e.ValueKind != JsonValueKind.Object) return;
                var id = Str(e, "id");
                var pub = Str(e, "pubkey");
                var content = Str(e, "content");
                if (id == null || pub == null || content == null) return;
                if (!e.TryGetProperty("kind", out var kind) || kind.ValueKind != JsonValueKind.Number || kind.GetInt32() != NostrEvents.Kind) return;
                if (!e.TryGetProperty("created_at", out var ca) || !ca.TryGetInt64(out var created)) return;
                var now = _unixSeconds();
                if (now - created > MaxAgeSeconds) return;
                if (pub == Pubkey) return;
                if (!HasTopic(e)) return;
                lock (_seen)
                {
                    if (_seen.ContainsKey(id)) return;
                    _seen[id] = created;
                    if (now - _lastPrune > 60)
                    {
                        _lastPrune = now;
                        var old = new List<string>();
                        foreach (var kv in _seen) if (now - kv.Value > MaxAgeSeconds + 60) old.Add(kv.Key);
                        foreach (var k in old) _seen.Remove(k);
                    }
                }
                var plain = NostrEvents.Open(_keys, content);
                if (plain == null) return;
                var frame = NostrFrame.Parse(plain);
                if (frame == null || frame.From != pub || frame.From == Pubkey) return;
                if (frame.To.Length != 0 && frame.To != Pubkey) return; // spec s.4: addressed to nobody in particular, or to us
                _in.Enqueue(frame);
            }
            catch (Exception ex) when (ex is JsonException || ex is InvalidOperationException || ex is FormatException) { /* not ours */ }
        }

        private bool HasTopic(JsonElement e)
        {
            if (!e.TryGetProperty("tags", out var tags) || tags.ValueKind != JsonValueKind.Array) return false;
            foreach (var t in tags.EnumerateArray())
                if (t.ValueKind == JsonValueKind.Array && t.GetArrayLength() >= 2 && t[0].GetString() == "t" && t[1].GetString() == _keys.Topic) return true;
            return false;
        }

        private static string? Str(JsonElement e, string name) =>
            e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        public void Dispose() => _relays.EventReceived -= OnEvent;
    }
}
