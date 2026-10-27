using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using OneLobby.Direct;
using OneLobby.Direct.Nostr;
using OneLobby.Server;
using Xunit;

namespace OneLobby.DataChannel.Tests;

/// <summary>An in-memory relay network: every event published by one pool reaches every pool on the same topic (the sender too, like a real relay).</summary>
internal sealed class FakeRelayNet
{
    private readonly List<FakeRelays> _all = new();
    /// <summary>Return false to drop an event on its way (per delivery), to test the frame layer.</summary>
    public Func<string, bool>? Keep;
    public bool Duplicate;
    public int Published;
    /// <summary>The pool created last (tests change its relay count).</summary>
    public FakeRelays? Last;

    public INostrRelays Create(string topic)
    {
        var r = new FakeRelays(this, topic);
        lock (_all) _all.Add(r);
        Last = r;
        return r;
    }

    internal void Deliver(FakeRelays from, string ev)
    {
        Published++;
        FakeRelays[] targets;
        lock (_all) targets = _all.Where(r => r.Topic == from.Topic).ToArray();
        foreach (var t in targets)
        {
            if (Keep != null && !Keep(ev)) continue;
            t.Raise(ev);
            if (Duplicate) t.Raise(ev);
        }
    }
}

internal sealed class FakeRelays : INostrRelays
{
    private readonly FakeRelayNet _net;
    public string Topic { get; }
    public bool Up = true;
    public int Total { get; set; } = 3;
    public int Connected => Up ? Total : 0;
    public bool Settled => true;
    public bool Disposed { get; private set; }
    public event Action<string>? EventReceived;

    public FakeRelays(FakeRelayNet net, string topic) { _net = net; Topic = topic; }
    public void Start() { }
    public void Publish(string eventJson) { if (Up && !Disposed) _net.Deliver(this, eventJson); }
    internal void Raise(string ev) { if (!Disposed) EventReceived?.Invoke(ev); }
    public void Dispose() => Disposed = true;
}

public sealed class NostrCryptoTests
{
    private static byte[] H(string hex) => NostrCrypto.FromHex(hex);

    public static IEnumerable<object[]> SignVectors() => new[]
    {
        // BIP340 test-vectors.csv rows 0 and 1: secret key, public key, aux, message, signature
        new object[] { "0000000000000000000000000000000000000000000000000000000000000003", "F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9",
            "0000000000000000000000000000000000000000000000000000000000000000", "0000000000000000000000000000000000000000000000000000000000000000",
            "E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0" },
        new object[] { "B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659",
            "0000000000000000000000000000000000000000000000000000000000000001", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
            "6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE33418906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A" },
    };

    [Theory]
    [MemberData(nameof(SignVectors))]
    public void Bip340_signing_vectors(string sk, string pk, string aux, string msg, string sig)
    {
        Assert.Equal(pk.ToLowerInvariant(), NostrCrypto.Hex(Schnorr.PublicKey(H(sk))));
        Assert.Equal(sig.ToLowerInvariant(), NostrCrypto.Hex(Schnorr.Sign(H(msg), H(sk), H(aux))));
        Assert.True(Schnorr.Verify(H(msg), H(pk), H(sig)));
    }

    [Fact]
    public void Bip340_verify_only_vectors()
    {
        // row 4 (valid, message not 0 or sk-derived) and rows with a flipped bit / wrong message must fail
        var pk = H("D69C3509BB99E412E68B0FE8544E72837DFA30746D8BE2AA65975F29D22DC7B9");
        var msg = H("4DF3C3F68FCC83B27E9D42C90431A72499F17875C81A599B566C9889B9696703");
        var sig = H("00000000000000000000003B78CE563F89A0ED9414F5AA28AD0D96D6795F9C6376AFB1548AF603B3EB45C9F8207DEE1060CB71C04E80F593060B07D28308D7F4");
        Assert.True(Schnorr.Verify(msg, pk, sig));
        var bad = (byte[])sig.Clone();
        bad[63] ^= 1;
        Assert.False(Schnorr.Verify(msg, pk, bad));
        var other = (byte[])msg.Clone();
        other[0] ^= 1;
        Assert.False(Schnorr.Verify(other, pk, sig));
        Assert.False(Schnorr.Verify(msg, new byte[32], sig));
    }

    [Fact]
    public void Random_keys_sign_and_verify_and_even_y_keys_sign_with_one_multiplication()
    {
        for (var i = 0; i < 6; i++)
        {
            Schnorr.NewKeyPair(out var sk, out var pk);
            Assert.Equal(NostrCrypto.Hex(Schnorr.PublicKey(sk)), NostrCrypto.Hex(pk));
            var msg = NostrCrypto.RandomBytes(32);
            Assert.True(Schnorr.Verify(msg, pk, Schnorr.Sign(msg, sk, null, pk)));
            Assert.True(Schnorr.Verify(msg, pk, Schnorr.Sign(msg, sk)));
        }
    }

    [Fact]
    public void Hkdf_matches_rfc5869_case_1()
    {
        var okm = NostrCrypto.Hkdf(Enumerable.Repeat((byte)0x0b, 22).ToArray(), H("000102030405060708090a0b0c"), H("f0f1f2f3f4f5f6f7f8f9"));
        Assert.Equal("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf", NostrCrypto.Hex(okm));
    }

    [Fact]
    public void Aes_gcm_nist_vector_and_managed_matches_the_platform()
    {
        var zeroKey = new byte[32];
        var zeroIv = new byte[12];
        var sealedZero = NostrCrypto.ManagedSeal(zeroKey, zeroIv, new byte[16]);
        Assert.Equal("cea7403d4d606b6e074ec5d3baf39d18", NostrCrypto.Hex(sealedZero.Skip(12).Take(16).ToArray()));
        Assert.Equal("d0d1c8a799996bf0265b98b5d48ab919", NostrCrypto.Hex(sealedZero.Skip(28).ToArray()));
        foreach (var len in new[] { 0, 1, 15, 16, 17, 31, 100, 1000 })
        {
            var key = NostrCrypto.RandomBytes(32);
            var iv = NostrCrypto.RandomBytes(12);
            var plain = NostrCrypto.RandomBytes(len);
            var managed = NostrCrypto.ManagedSeal(key, iv, plain);
            var platform = NostrCrypto.GcmSeal(key, iv, plain);
            Assert.Equal(NostrCrypto.Hex(platform), NostrCrypto.Hex(managed));
            Assert.Equal(NostrCrypto.Hex(plain), NostrCrypto.Hex(NostrCrypto.GcmOpen(key, managed)!));
            if (managed.Length > 0) { managed[^1] ^= 1; Assert.Null(NostrCrypto.GcmOpen(key, managed)); }
        }
    }

    [Fact]
    public void Join_code_rooms_match_the_shared_vectors()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(SpecDir(), "joincode.json")));
        var rooms = doc.RootElement.GetProperty("rooms");
        Assert.True(rooms.GetArrayLength() >= 3);
        foreach (var r in rooms.EnumerateArray())
        {
            var room = r.GetProperty("room").GetString()!;
            var code = r.GetProperty("code").GetString()!;
            Assert.Equal(code, JoinCode.EncodeRoom(Convert.ToUInt64(room, 16)));
            Assert.True(JoinCode.TryDecodeRoom(code, out var back));
            Assert.Equal(room, back);
            Assert.False(JoinCode.TryDecode(code, out _, out _, out var err));
            Assert.Equal("unknown_version", err);
        }
        foreach (var a in doc.RootElement.GetProperty("roomAliases").EnumerateArray())
        {
            Assert.True(JoinCode.TryDecodeRoom(a.GetProperty("input").GetString(), out var room));
            Assert.Equal(a.GetProperty("room").GetString(), room);
        }
        // version 0 codes are not rooms; version 2 is unknown; a typo is bad_code
        Assert.False(JoinCode.TryDecodeRoom("6B01-RGFE-P2B", out _));
        Assert.False(JoinCode.TryDecodeRoom("PB01-RGFE-P24", out _));
        Assert.False(JoinCode.TryDecodeRoom("D1PB-1X9S-FPW", out _));
        Assert.False(JoinCode.TryDecode("PB01-RGFE-P24", out _, out _, out var e2));
        Assert.Equal("unknown_version", e2);
    }

    [Fact]
    public void Key_and_topic_vectors()
    {
        foreach (var file in new[] { "nostr-cs-check.json" })
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(SpecDir(), file)));
            foreach (var k in doc.RootElement.GetProperty("keys").EnumerateArray())
            {
                var keys = NostrRoomKeys.Derive(JoinCode.Normalize(k.GetProperty("code").GetString())!);
                Assert.Equal(k.GetProperty("key").GetString(), NostrCrypto.Hex(keys.Key));
                Assert.Equal(k.GetProperty("topic").GetString(), keys.Topic);
                Assert.Equal(k.GetProperty("ikm").GetString(), JoinCode.Normalize(k.GetProperty("code").GetString()));
            }
        }
    }

    [Fact]
    public void Limits_and_timers_match_the_shared_vector()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(SpecDir(), "nostr-limits.json")));
        var expected = new Dictionary<string, Dictionary<string, int>>
        {
            ["link"] = new()
            {
                ["batchMs"] = NostrLimits.BatchMs, ["resendMs"] = NostrLimits.ResendMs, ["maxResends"] = NostrLimits.MaxResends, ["beatMs"] = NostrLimits.BeatMs,
                ["silenceMs"] = NostrLimits.SilenceMs, ["maxHeld"] = NostrLimits.MaxHeld, ["maxOutFrames"] = NostrLimits.MaxOutFrames,
                ["maxOutBytes"] = NostrLimits.MaxOutBytes, ["maxFrameBytes"] = NostrLimits.MaxFrameBytes, ["tickMs"] = NostrLimits.TickMs,
            },
            ["host"] = new()
            {
                ["newSessionBurst"] = NostrLimits.NewSessionBurst, ["maxSessionBurst"] = NostrLimits.MaxSessionBurst,
                ["newSessionRefillMs"] = NostrLimits.NewSessionRefillMs, ["waitingMax"] = NostrLimits.WaitingMax, ["waitingStaleMs"] = NostrLimits.WaitingStaleMs,
            },
            ["socket"] = new() { ["openEveryMs"] = NostrLimits.OpenEveryMs, ["giveUpMs"] = NostrLimits.GiveUpMs },
            ["relays"] = new()
            {
                ["hostFirstRelayMs"] = NostrLimits.HostFirstRelayMs, ["hostNostrFirstRelayMs"] = NostrLimits.HostNostrFirstRelayMs,
                ["joinerFirstRelayMs"] = NostrLimits.JoinerFirstRelayMs, ["restWaitMs"] = NostrLimits.RestWaitMs, ["restPollMs"] = NostrLimits.RestPollMs,
            },
        };
        var groups = doc.RootElement.EnumerateObject().Where(p => p.Name != "$comment").ToList();
        Assert.Equal(expected.Keys.OrderBy(k => k), groups.Select(g => g.Name).OrderBy(k => k));
        foreach (var g in groups)
        {
            var vec = g.Value.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetInt32());
            Assert.Equal(expected[g.Name].OrderBy(p => p.Key), vec.OrderBy(p => p.Key));
        }
    }

    [Fact]
    public void Shared_nostr_vectors_from_the_js_lane_match()
    {
        var path = Path.Combine(SpecDir(), "nostr.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var root = doc.RootElement;
        var k = root.GetProperty("keys");
        var keys = NostrRoomKeys.Derive(k.GetProperty("normalized").GetString()!);
        Assert.Equal(k.GetProperty("key").GetString(), NostrCrypto.Hex(keys.Key));
        Assert.Equal(k.GetProperty("topic").GetString(), keys.Topic);
        Assert.Equal(k.GetProperty("room").GetString(), JoinCode.TryDecodeRoom(k.GetProperty("code").GetString(), out var room) ? room : null);

        var c = root.GetProperty("crypto");
        var plain = Encoding.UTF8.GetBytes(c.GetProperty("plaintext").GetString()!);
        var sealedBlob = NostrCrypto.GcmSeal(H(c.GetProperty("key").GetString()!), H(c.GetProperty("iv").GetString()!), plain);
        Assert.Equal(c.GetProperty("content").GetString(), Convert.ToBase64String(sealedBlob));
        Assert.Equal(c.GetProperty("plaintext").GetString(), NostrEvents.Open(keys, c.GetProperty("content").GetString()!));

        var e = root.GetProperty("event");
        var id = NostrCrypto.Hex(NostrCrypto.Sha256(Encoding.UTF8.GetBytes(NostrEvents.Serialize(e.GetProperty("pubkey").GetString()!, e.GetProperty("created_at").GetInt64(),
            e.GetProperty("tags")[0][1].GetString()!, e.GetProperty("content").GetString()!))));
        Assert.Equal(e.GetProperty("id").GetString(), id);

        foreach (var v in root.GetProperty("bip340").EnumerateArray())
        {
            var sk = H(v.GetProperty("secretKey").GetString()!);
            var msg = H(v.GetProperty("message").GetString()!);
            Assert.Equal(v.GetProperty("publicKey").GetString()!.ToLowerInvariant(), NostrCrypto.Hex(Schnorr.PublicKey(sk)));
            Assert.Equal(v.GetProperty("signature").GetString()!.ToLowerInvariant(), NostrCrypto.Hex(Schnorr.Sign(msg, sk, H(v.GetProperty("auxRand").GetString()!))));
        }
    }

    internal static string SpecDir([System.Runtime.CompilerServices.CallerFilePath] string here = "")
    {
        var d = new DirectoryInfo(Path.GetDirectoryName(here)!);
        while (d != null && !Directory.Exists(Path.Combine(d.FullName, "spec", "vectors"))) d = d.Parent;
        return Path.Combine(d!.FullName, "spec", "vectors");
    }
}

public sealed class NostrLinkTests
{
    /// <summary>Two links wired back to back with a fake clock; the "wire" keeps every frame so a test can drop, delay or reorder them.</summary>
    private sealed class Pair
    {
        public long Now;
        public readonly NostrLink A, B;
        public readonly List<NostrFrame> ToB = new(), ToA = new();
        public readonly List<string> AtA = new(), AtB = new();
        public string? EndA, EndB;
        public Func<NostrFrame, bool> DeliverToB = _ => true, DeliverToA = _ => true;
        public readonly List<NostrFrame> SentByA = new(), SentByB = new();

        public Pair()
        {
            A = new NostrLink(() => Now, "b", f => { var c = Clone(f); SentByA.Add(c); if (DeliverToB(c)) ToB.Add(c); });
            B = new NostrLink(() => Now, "a", f => { var c = Clone(f); SentByB.Add(c); if (DeliverToA(c)) ToA.Add(c); });
            A.Message += m => AtA.Add(m);
            B.Message += m => AtB.Add(m);
            A.PeerClosed += r => EndA = "closed:" + r;
            B.PeerClosed += r => EndB = "closed:" + r;
            A.Dead += r => EndA = "dead:" + r;
            B.Dead += r => EndB = "dead:" + r;
        }

        private static NostrFrame Clone(NostrFrame f) => NostrFrame.Parse(f.ToJson())!;

        public void Run(int ms)
        {
            for (var t = 0; t < ms; t += 10)
            {
                Now += 10;
                A.Tick();
                B.Tick();
                var toB = ToB.ToArray(); ToB.Clear();
                var toA = ToA.ToArray(); ToA.Clear();
                foreach (var f in toB) B.Receive(f);
                foreach (var f in toA) A.Receive(f);
            }
        }
    }

    [Fact]
    public void Messages_are_batched_for_30_ms_into_one_frame_and_arrive_in_order()
    {
        var p = new Pair();
        p.Run(100);
        p.SentByA.Clear();
        p.A.Queue("one"); p.A.Queue("two"); p.A.Queue("three");
        p.Run(20);
        Assert.DoesNotContain(p.SentByA, f => f.Type == "data");
        p.Run(30);
        var data = p.SentByA.Where(f => f.Type == "data").ToList();
        Assert.Single(data);
        Assert.Equal(1, data[0].Seq);
        Assert.Equal(new[] { "one", "two", "three" }, data[0].Msgs);
        Assert.Equal(new[] { "one", "two", "three" }, p.AtB);
    }

    [Fact]
    public void Frames_arriving_out_of_order_or_twice_are_delivered_once_in_order()
    {
        var p = new Pair();
        p.DeliverToB = _ => false; // hold everything back, then hand it over reversed and doubled
        for (var i = 1; i <= 5; i++) { p.A.Queue("m" + i); p.Run(40); }
        var held = p.SentByA.Where(f => f.Type == "data").ToList();
        Assert.Equal(5, held.Count);
        foreach (var f in Enumerable.Reverse(held)) { p.B.Receive(f); p.B.Receive(f); }
        Assert.Equal(new[] { "m1", "m2", "m3", "m4", "m5" }, p.AtB);
    }

    [Fact]
    public void An_unacknowledged_frame_is_resent_after_3_s_and_acked_once_it_lands()
    {
        var p = new Pair();
        var dropped = 0;
        p.DeliverToB = f => f.Type != "data" || ++dropped > 1; // lose the first copy only
        p.A.Queue("hello");
        p.Run(2900);
        Assert.Empty(p.AtB);
        p.Run(500); // the 250 ms tick sees it due at 3.25 s
        Assert.Equal(new[] { "hello" }, p.AtB);
        Assert.Equal(2, p.SentByA.Count(f => f.Type == "data"));
        p.Run(200);
        Assert.Equal(0, p.A.Unacked);
    }

    [Fact]
    public void Silence_closes_the_link_with_timeout_after_five_resends()
    {
        var p = new Pair();
        p.DeliverToB = _ => false;
        p.DeliverToA = _ => false;
        p.A.Queue("into the void");
        p.Run(3000 * 5 + 2900);
        Assert.Null(p.EndA);
        Assert.Equal(6, p.SentByA.Count(f => f.Type == "data")); // the first send and five resends (250 ms tick: at 3.25 s, 6.25 s ...)
        p.Run(500);
        Assert.Equal("dead:timeout", p.EndA);
        Assert.True(p.A.IsClosed);
    }

    [Fact]
    public void Thirty_seconds_without_hearing_anything_closes_the_link()
    {
        var p = new Pair();
        p.DeliverToA = _ => false; // B's beats never reach A
        p.Run(29_900);
        Assert.Null(p.EndA);
        p.Run(200);
        Assert.Equal("dead:timeout", p.EndA);
    }

    [Fact]
    public void A_quiet_link_sends_a_beat_every_10_s_and_stays_open()
    {
        var p = new Pair();
        p.Run(65_000);
        Assert.Null(p.EndA);
        Assert.Null(p.EndB);
        var beats = p.SentByA.Count(f => f.Type == "beat");
        Assert.InRange(beats, 5, 7);
        Assert.Equal(0, p.SentByA.Count(f => f.Type == "data"));
    }

    [Fact]
    public void Receiving_data_is_acked_promptly_with_a_beat()
    {
        var p = new Pair();
        p.A.Queue("x");
        p.Run(200);
        Assert.Equal(0, p.A.Unacked);
        Assert.Contains(p.SentByB, f => f.Type == "beat" && f.Ack == 1);
    }

    [Fact]
    public void A_close_frame_closes_the_other_side_with_its_reason_and_is_sent_once()
    {
        var p = new Pair();
        p.A.Queue("last words");
        p.A.Close("bye");
        p.A.Close("again");
        p.Run(100);
        Assert.Equal(new[] { "last words" }, p.AtB);
        Assert.Null(p.EndA); // a local close tells nobody but the peer
        Assert.True(p.A.IsClosed);
        Assert.Equal("closed:bye", p.EndB);
        Assert.Single(p.SentByA, f => f.Type == "close");
        Assert.All(p.SentByA.Where(f => f.Type == "close"), f => Assert.Equal(0, f.Seq));
    }

    [Fact]
    public void Beats_and_acks_carry_seq_0_and_an_ack_only_beat_follows_any_data_frame_even_a_duplicate()
    {
        var p = new Pair();
        p.A.Queue("x");
        p.Run(300);
        var data = p.SentByA.Single(f => f.Type == "data");
        Assert.Equal(1, data.Seq);
        var beats = p.SentByB.Where(f => f.Type == "beat").ToList();
        Assert.Single(beats);
        Assert.Equal(0, beats[0].Seq);
        Assert.Equal(1, beats[0].Ack);
        Assert.Empty(beats[0].Msgs ?? new List<string>());
        // the same frame again: not delivered twice, but acked again (within the 30 ms batch window)
        p.SentByB.Clear();
        p.B.Receive(data);
        p.Run(60);
        Assert.Equal(new[] { "x" }, p.AtB);
        var again = Assert.Single(p.SentByB, f => f.Type == "beat");
        Assert.Equal(0, again.Seq);
        Assert.Equal(1, again.Ack);
    }

    [Fact]
    public void A_frame_packs_up_to_30000_utf8_bytes_of_messages()
    {
        var p = new Pair();
        var two = new string('a', 15_000);
        p.A.Queue(two); p.A.Queue(two); // exactly 30,000 bytes: one frame
        p.Run(100);
        Assert.Single(p.SentByA, f => f.Type == "data");
        p.SentByA.Clear();
        var multi = new string('é', 8_000); // 16,000 bytes in UTF-8
        p.A.Queue(multi); p.A.Queue(multi); // 32,000 bytes: two frames
        p.Run(100);
        Assert.Equal(2, p.SentByA.Count(f => f.Type == "data"));
        Assert.Equal(4, p.AtB.Count);
    }

    [Fact]
    public void Resends_are_checked_every_250_ms_and_only_once_3_s_have_passed()
    {
        var p = new Pair();
        p.DeliverToB = f => f.Type != "data";
        p.A.Queue("m");
        p.Run(3_200);
        Assert.Single(p.SentByA, f => f.Type == "data"); // sent at 30 ms: not due before 3,030 ms, which the 250 ms tick sees at 3,250
        p.Run(100);
        Assert.Equal(2, p.SentByA.Count(f => f.Type == "data"));
    }

    [Fact]
    public void A_burst_over_32_KiB_is_split_over_several_frames_that_each_fit()
    {
        var p = new Pair();
        var sent = new List<string>();
        for (var i = 0; i < 40; i++) { var m = new string((char)('a' + i % 26), 3000) + i; sent.Add(m); p.A.Queue(m); }
        p.Run(100);
        var frames = p.SentByA.Where(f => f.Type == "data").ToList();
        Assert.True(frames.Count >= 4);
        Assert.All(frames, f => Assert.True(Encoding.UTF8.GetByteCount(f.ToJson()) < 32 * 1024));
        Assert.Equal(sent, p.AtB);
    }

    [Fact]
    public void More_than_64_frames_ahead_are_not_held()
    {
        var p = new Pair();
        p.DeliverToB = _ => false;
        for (var i = 0; i < 70; i++) { p.A.Queue("m" + i); p.Run(40); }
        var frames = p.SentByA.Where(f => f.Type == "data").ToList();
        Assert.Equal(70, frames.Count);
        foreach (var f in frames.Skip(1)) p.B.Receive(f); // seq 2..70 while 1 is missing: only 2..65 fit (rcvNext + 64)
        Assert.Empty(p.AtB);
        p.B.Receive(frames[0]);
        Assert.Equal(65, p.AtB.Count); // 1 plus the held frames 2..65; the rest wait for a resend
    }
    [Fact]
    public void OutboundQueueDropsTextsOverTheFrameCapWithoutClosingTheLink()
    {
        var p = new Pair { DeliverToB = _ => false }; // nothing is ever acknowledged
        for (var i = 0; i < NostrLink.MaxOutFrames + 40; i++) { p.A.Queue("m" + i); p.Run(40); }
        Assert.Equal(NostrLink.MaxOutFrames, p.A.Unacked);
        Assert.Equal(40, p.A.Dropped);
        Assert.False(p.A.IsClosed);
    }

    [Fact]
    public void OutboundQueueDropsTextsOverTheByteCap()
    {
        var p = new Pair { DeliverToB = _ => false };
        var big = new string('x', 20_000);
        for (var i = 0; i < 20; i++) p.A.Queue(big); // 400 KB offered in one batch window
        Assert.True(p.A.Dropped >= 7, "dropped " + p.A.Dropped);
        p.Run(100);
        Assert.False(p.A.IsClosed);
        Assert.True(p.SentByA.Where(f => f.Type == "data").Sum(f => f.Msgs!.Count) <= 13);
    }

    [Fact]
    public void AcknowledgedTextsFreeTheOutboundBudget()
    {
        var p = new Pair();
        var big = new string('x', 20_000);
        for (var round = 0; round < 40; round++) { p.A.Queue(big); p.Run(100); }
        Assert.Equal(0, p.A.Dropped);
        Assert.Equal(40, p.AtB.Count);
    }
}

public sealed class NostrBridgeTests
{
    private sealed class Rig
    {
        public long Now = 1_000_000;
        public readonly FakeRelayNet Net = new();
        public readonly NostrOptions Options;
        public readonly string Code = JoinCode.Normalize(JoinCode.EncodeRoom(0xa1b2c3d4e5f6))!;
        public readonly Hub Hub;
        public readonly NostrHostBridge Bridge;

        public Rig(int maxPlayers = 4, int bridgeMaxPlayers = 0)
        {
            Hub = new Hub(HubOptions.ForDirect(maxPlayers, null));
            Options = new NostrOptions { RelayFactory = Net.Create, AutoTick = false, NowMs = () => Now, UnixSeconds = () => 1_700_000_000 + Now / 1000 };
            Bridge = new NostrHostBridge(Hub, Code, Options, bridgeMaxPlayers);
        }

        public NostrSignalingSocket Join() => new(Code, Options);

        public void Run(int ms, params NostrSignalingSocket[] sockets)
        {
            for (var t = 0; t < ms; t += 10)
            {
                Now += 10;
                foreach (var s in sockets) s.Tick();
                Bridge.Tick();
            }
        }

        public static IEnumerable<string> Drain(ISignalingSocket s)
        {
            while (s.TryReceive(out var t)) yield return t;
        }
    }

    private static string Hello(string name) =>
        "{\"t\":\"hello\",\"proto\":\"lk1\",\"gameId\":\"com.test\",\"netVersion\":\"1\",\"client\":{\"lib\":\"t\",\"ver\":\"1\",\"platform\":\"dotnet\"},\"name\":\"" + name + "\"}";

    [Fact]
    public void A_joiner_opens_the_socket_and_talks_to_the_hub_over_the_fake_relays() => RunHello();

    private static void RunHello()
    {
        var rig = new Rig();
        using var sock = rig.Join();
        Assert.Equal(SocketState.Connecting, sock.State);
        rig.Run(100, sock);
        Assert.Equal(SocketState.Open, sock.State);
        sock.Send(Hello("Ann"));
        rig.Run(300, sock);
        var got = Rig.Drain(sock).ToList();
        Assert.Contains(got, t => t.Contains("\"welcome\""));
        Assert.Equal(1, rig.Hub.SocketCount);
        // our own ping is answered locally and never crosses (the hub would have answered with a pong over Nostr)
        sock.Send("{\"t\":\"ping\",\"n\":7}");
        Assert.Equal("{\"t\":\"pong\",\"n\":7}", Rig.Drain(sock).Single());
        rig.Run(100, sock);
        sock.Dispose();
        rig.Run(300, sock);
        Assert.Equal(0, rig.Hub.SocketCount);
        Assert.Equal(0, rig.Bridge.PeerCount);
    }

    [Fact]
    public void Survives_a_lossy_duplicating_relay_net() => RunLossy();

    private static void RunLossy()
    {
        var rig = new Rig();
        var rng = new Random(5);
        rig.Net.Keep = _ => rng.Next(100) >= 35; // a third of the deliveries vanish
        rig.Net.Duplicate = true;
        using var sock = rig.Join();
        rig.Run(20_000, sock);
        Assert.Equal(SocketState.Open, sock.State);
        sock.Send(Hello("Ann"));
        rig.Run(15_000, sock);
        Assert.Contains(Rig.Drain(sock), t => t.Contains("\"welcome\""));
    }

    [Fact]
    public void No_relay_reachable_fails_the_socket_after_10_s_with_the_js_message() => RunNoRelay();

    private static void RunNoRelay()
    {
        var rig = new Rig();
        using var sock = rig.Join();
        ((FakeRelays)GetRelays(sock)).Up = false;
        rig.Run(9_900, sock);
        Assert.Equal(SocketState.Connecting, sock.State);
        rig.Run(200, sock);
        Assert.Equal(SocketState.Closed, sock.State);
        Assert.Equal("no Nostr relay reachable", sock.CloseReason);
    }

    [Fact]
    public void Nobody_home_gives_up_after_15_s() => RunNobody();

    private static void RunNobody()
    {
        var rig = new Rig();
        rig.Bridge.Dispose();
        using var sock = rig.Join();
        rig.Run(14_900, sock);
        Assert.Equal(SocketState.Connecting, sock.State);
        rig.Run(200, sock);
        Assert.Equal("the host did not answer through the Nostr relays", sock.CloseReason);
    }

    [Fact]
    public void A_host_that_closed_a_pubkey_ignores_its_later_opens()
    {
        var rig = new Rig();
        var keys = NostrRoomKeys.Derive(rig.Code);
        var ch = new NostrChannel(rig.Net.Create(keys.Topic), keys, () => 1_700_000_000 + rig.Now / 1000, Schnorr.NewSecretKey());
        ch.Publish(new NostrFrame { Type = "open", To = "" });
        rig.Run(100);
        Assert.Equal(1, rig.Bridge.PeerCount);
        ch.Publish(new NostrFrame { Type = "close", To = rig.Bridge.Pubkey });
        rig.Run(100);
        Assert.Equal(0, rig.Bridge.PeerCount);
        // the same key opens again (a replayed open): not admitted for the rest of the session
        ch.Publish(new NostrFrame { Type = "open", To = "" });
        rig.Run(100);
        Assert.Equal(0, rig.Bridge.PeerCount);
        // another key is
        using var sock = rig.Join();
        rig.Run(100, sock);
        Assert.Equal(1, rig.Bridge.PeerCount);
    }

    [Fact]
    public void Open_frames_with_to_set_to_the_hosts_pubkey_are_accepted_and_frames_for_someone_else_are_not()
    {
        var rig = new Rig();
        var keys = NostrRoomKeys.Derive(rig.Code);
        var ch = new NostrChannel(rig.Net.Create(keys.Topic), keys, () => 1_700_000_000 + rig.Now / 1000, Schnorr.NewSecretKey());
        ch.Publish(new NostrFrame { Type = "open", To = new string('a', 64) });
        rig.Run(100);
        Assert.Equal(0, rig.Bridge.PeerCount);
        ch.Publish(new NostrFrame { Type = "open", To = rig.Bridge.Pubkey });
        rig.Run(100);
        Assert.Equal(1, rig.Bridge.PeerCount);
    }

    [Fact]
    public void The_host_feeds_the_hub_a_ping_on_a_joiner_beat_and_drops_the_hubs_pongs()
    {
        var rig = new Rig();
        using var sock = rig.Join();
        rig.Run(100, sock);
        sock.Send(Hello("Ann"));
        rig.Run(300, sock);
        Rig.Drain(sock).ToList();
        // 25 s of quiet: only beats cross; the hub is kept alive by pings the bridge feeds it and its pongs never come back
        var seen = new List<string>();
        for (var i = 0; i < 25; i++) { rig.Run(1000, sock); seen.AddRange(Rig.Drain(sock)); }
        Assert.DoesNotContain(seen, t => t.StartsWith("{\"t\":\"pong\"", StringComparison.Ordinal));
        Assert.Equal(SocketState.Open, sock.State);
        Assert.Equal(1, rig.Hub.SocketCount);
    }

    [Fact]
    public void The_host_closing_a_full_hub_answers_then_closes() => RunFull();

    private static void RunFull()
    {
        var rig = new Rig();
        var socks = new List<NostrSignalingSocket>();
        for (var i = 0; i < 20; i++)
        {
            var s = rig.Join();
            socks.Add(s);
            rig.Run(1300, socks.ToArray()); // one joiner at a time, within the new-session refill rate
        }
        // MaxPeers is 12 for four players: later joiners get server_full and a close
        var closed = socks.Where(s => s.State == SocketState.Closed).ToList();
        Assert.NotEmpty(closed);
        Assert.All(closed, s => Assert.NotNull(s.CloseReason));
        foreach (var s in socks) s.Dispose();
    }

    [Fact]
    public void A_foreign_room_key_is_ignored() => RunForeign();

    private static void RunForeign()
    {
        var rig = new Rig();
        // same topic would need the same code: an attacker with a different code lands on another topic and is never heard
        var other = new NostrSignalingSocket(JoinCode.Normalize(JoinCode.EncodeRoom(1))!, rig.Options);
        rig.Run(1000, other);
        Assert.Equal(SocketState.Connecting, other.State);
        Assert.Equal(0, rig.Bridge.PeerCount);
        other.Dispose();
    }

    private static INostrRelays GetRelays(NostrSignalingSocket s) => s.Relays;

    [Fact]
    public void Event_filter_drops_own_old_foreign_topic_and_garbled_events()
    {
        var net = new FakeRelayNet();
        var keys = NostrRoomKeys.Derive("D1PB1X9SFPV");
        long unix = 1_700_000_000;
        var relays = (FakeRelays)net.Create(keys.Topic);
        var ch = new NostrChannel(relays, keys, () => unix);
        var other = new NostrChannel((FakeRelays)net.Create(keys.Topic), keys, () => unix);
        // a frame from "other" arrives
        other.Publish(new NostrFrame { Type = "open", To = "" });
        Assert.True(ch.TryTake(out var f));
        Assert.Equal(other.Pubkey, f.From);
        Assert.False(other.TryTake(out _)); // its own echo is dropped
        // an event stamped 200 s ago is too old
        var old = NostrEvents.Build(Schnorr.NewSecretKey(), "00", unix - 200, keys.Topic, "AAAA");
        ch.OnEvent(old);
        Assert.False(ch.TryTake(out _));
        ch.OnEvent("not json");
        ch.OnEvent("{}");
        Assert.False(ch.TryTake(out _));
        // a frame sealed under another room's key does not open
        var wrong = NostrRoomKeys.Derive("8000000000N");
        // build by hand: the same topic tag but the wrong key
        var ev = NostrEvents.Build(Schnorr.NewSecretKey(), NostrCrypto.Hex(Schnorr.PublicKey(Schnorr.NewSecretKey())), unix, keys.Topic, NostrEvents.Seal(wrong, new NostrFrame { Type = "open", From = "x" }.ToJson()));
        ch.OnEvent(ev);
        Assert.False(ch.TryTake(out _));
    }

    [Fact]
    public void Event_serialisation_id_is_sha256_of_the_nip01_array_and_the_signature_verifies()
    {
        var keys = NostrRoomKeys.Derive("D1PB1X9SFPV");
        Schnorr.NewKeyPair(out var sk, out var pk);
        var content = NostrEvents.Seal(keys, "{\"v\":1}");
        var json = NostrEvents.Build(sk, NostrCrypto.Hex(pk), 1_700_000_000, keys.Topic, content, evenYPublicKey: pk);
        using var doc = JsonDocument.Parse(json);
        var e = doc.RootElement;
        var id = NostrCrypto.Sha256(Encoding.UTF8.GetBytes("[0,\"" + NostrCrypto.Hex(pk) + "\",1700000000,25050,[[\"t\",\"" + keys.Topic + "\"]],\"" + content + "\"]"));
        Assert.Equal(NostrCrypto.Hex(id), e.GetProperty("id").GetString());
        Assert.True(Schnorr.Verify(id, pk, NostrCrypto.FromHex(e.GetProperty("sig").GetString()!)));
        Assert.Equal(25050, e.GetProperty("kind").GetInt32());
        Assert.Equal("{\"v\":1}", NostrEvents.Open(keys, content));
    }

    [Fact]
    public void Host_log_line_matches_the_js_format_host_log()
    {
        // Nostr off: the pre-Nostr line (the same three cases as the JS formatHostLog test)
        Assert.Equal("OneLobby: direct host listening on TCP+UDP :47810; code 6B01-RGFE-P2B (Internet); port mapping UPnP",
            DirectLobby.FormatHostLog(47810, 47810, "6B01-RGFE-P2B", JoinCodeKind.Internet, "UPnP"));
        Assert.Equal("OneLobby: direct host listening on TCP+UDP :47811 (47810 busy); code 0A00-0BSE-P3S (SameNetwork); port mapping off",
            DirectLobby.FormatHostLog(47810, 47811, "0A00-0BSE-P3S", JoinCodeKind.SameNetwork, "off"));
        Assert.Equal("OneLobby: direct host listening on TCP+UDP :47813 (47810-47812 busy); no join code (no IPv4 address); port mapping off",
            DirectLobby.FormatHostLog(47810, 47813, "", JoinCodeKind.None, ""));
        // Nostr on
        Assert.Equal("OneLobby: direct host listening on TCP+UDP :47810; code D1PB-1X9S-FPV (Nostr); ip code 6B01-RGFE-P2B (Internet); port mapping UPnP; nostr 4/7 relays",
            DirectLobby.FormatHostLog(47810, 47810, "D1PB-1X9S-FPV", JoinCodeKind.Nostr, "UPnP", new DirectLobby.NostrLogInfo("6B01-RGFE-P2B", JoinCodeKind.Internet, "4/7")));
        Assert.Equal("OneLobby: direct host listening on TCP+UDP :47811 (47810 busy); code D1PB-1X9S-FPV (Nostr); ip code 0A00-0BSE-P3S (SameNetwork); port mapping off; nostr 7/7 relays",
            DirectLobby.FormatHostLog(47810, 47811, "D1PB-1X9S-FPV", JoinCodeKind.Nostr, "off", new DirectLobby.NostrLogInfo("0A00-0BSE-P3S", JoinCodeKind.SameNetwork, "7/7")));
        // no IPv4 address: no ip code
        Assert.Equal("OneLobby: direct host listening on TCP+UDP :47810; code D1PB-1X9S-FPV (Nostr); no ip code (no IPv4 address); port mapping off; nostr 3/7 relays",
            DirectLobby.FormatHostLog(47810, 47810, "D1PB-1X9S-FPV", JoinCodeKind.Nostr, "", new DirectLobby.NostrLogInfo("", JoinCodeKind.None, "3/7")));
        // no relay reachable: the IP code is the code
        Assert.Equal("OneLobby: direct host listening on TCP+UDP :47810; code 0A00-0BSE-P3S (SameNetwork); ip code 0A00-0BSE-P3S (SameNetwork); port mapping off; nostr: no relay reachable",
            DirectLobby.FormatHostLog(47810, 47810, "0A00-0BSE-P3S", JoinCodeKind.SameNetwork, "off", new DirectLobby.NostrLogInfo("0A00-0BSE-P3S", JoinCodeKind.SameNetwork, "")));
        Assert.Equal("OneLobby: direct host listening on TCP+UDP :47813 (47810-47812 busy); no join code (no IPv4 address); no ip code (no IPv4 address); port mapping off; nostr: no relay reachable",
            DirectLobby.FormatHostLog(47810, 47813, "", JoinCodeKind.None, "", new DirectLobby.NostrLogInfo("", JoinCodeKind.None, "")));
    }

    [Fact]
    public void Default_relays_and_stun_are_the_js_lists_and_blueprints_carry_them()
    {
        Assert.Equal(new[]
        {
            "wss://nos.lol", "wss://relay.primal.net", "wss://nostr-pub.wellorder.net", "wss://nostr.oxtr.dev",
            "wss://nostr.bitcoiner.social", "wss://relay.nostr.net", "wss://nostr.sathoarder.com",
        }, NostrOptions.DefaultRelays);
        Assert.Equal(new[] { "stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478" }, NostrOptions.DefaultStun);
        Assert.Equal(NostrOptions.DefaultRelays, Blueprint.Parse("{\"game\":{\"id\":\"com.test.x\"}}").Hosting.Relays);
        // an unset list is the default, an empty list means "the library default" at use time, a set list wins
        var o = new NostrOptions();
        Assert.Equal(NostrOptions.DefaultRelays, o.EffectiveRelays);
        o.Relays = new string[0];
        Assert.Equal(NostrOptions.DefaultRelays, o.EffectiveRelays);
        o.Relays = new[] { "ws://127.0.0.1:1" };
        Assert.Equal(new[] { "ws://127.0.0.1:1" }, o.EffectiveRelays);
        // STUN: null = defaults, empty = no ICE servers at all
        Assert.Equal(NostrOptions.DefaultStun, o.EffectiveStun);
        o.Stun = new string[0];
        Assert.Empty(o.EffectiveStun);
    }

    [Fact]
    public void A_burst_past_the_bucket_waits_about_a_second_each_and_gets_in_on_its_repeated_open()
    {
        var rig = new Rig(maxPlayers: 40);
        var n = NostrHostBridge.NewSessionBurst + 2;
        var socks = Enumerable.Range(0, n).Select(_ => rig.Join()).ToArray();
        rig.Run(800, socks); // before the first token refills
        Assert.Equal(NostrHostBridge.NewSessionBurst, socks.Count(s => s.State == SocketState.Open));
        Assert.Equal(2, socks.Count(s => s.State == SocketState.Connecting));
        rig.Run(3000, socks); // two tokens have refilled; the waiting joiners are answered, long before any ready timeout
        Assert.All(socks, s => Assert.Equal(SocketState.Open, s.State));
        Assert.Equal(n, rig.Bridge.PeerCount);
        foreach (var s in socks) s.Dispose();
    }

    [Fact]
    public void Refused_joiners_wait_in_line_and_are_answered_as_tokens_refill_not_at_their_next_open()
    {
        var rig = new Rig(maxPlayers: 40);
        var n = NostrHostBridge.NewSessionBurst + 2;
        var socks = Enumerable.Range(0, n).Select(_ => rig.Join()).ToArray();
        rig.Run(1400, socks); // one token refilled at ~1 s; the joiners' own resend is not due until 2 s
        Assert.Equal(NostrHostBridge.NewSessionBurst + 1, socks.Count(s => s.State == SocketState.Open));
        rig.Run(1000, socks); // the second token
        Assert.All(socks, s => Assert.Equal(SocketState.Open, s.State));
        foreach (var s in socks) s.Dispose();
    }

    [Fact]
    public void The_burst_grows_to_the_lobby_s_max_players()
    {
        Assert.Equal(NostrHostBridge.NewSessionBurst, NostrHostBridge.SessionBurstFor(0));
        Assert.Equal(NostrHostBridge.NewSessionBurst, NostrHostBridge.SessionBurstFor(4));
        Assert.Equal(24, NostrHostBridge.SessionBurstFor(24));
        Assert.Equal(NostrHostBridge.MaxSessionBurst, NostrHostBridge.SessionBurstFor(1000));
        var rig = new Rig(maxPlayers: 40, bridgeMaxPlayers: 24);
        var socks = Enumerable.Range(0, 24).Select(_ => rig.Join()).ToArray();
        rig.Run(500, socks); // no refill needed: a 24-player party at once
        Assert.All(socks, s => Assert.Equal(SocketState.Open, s.State));
        foreach (var s in socks) s.Dispose();
    }

    [Fact]
    public void A_joiner_resends_open_when_another_relay_comes_up()
    {
        var rig = new Rig();
        rig.Net.Keep = _ => false; // the joiner's first relay cannot reach the host
        var s = rig.Join();
        var mine = rig.Net.Last!;
        mine.Total = 1;
        rig.Run(200, s);
        Assert.Equal(SocketState.Connecting, s.State);
        rig.Net.Keep = null;
        mine.Total = 2; // a second relay connects (one the host is on)
        rig.Run(300, s); // well before the 2 s resend
        Assert.Equal(SocketState.Open, s.State);
        s.Dispose();
    }

    private static JsonElement Last(List<string> inbox, string t) =>
        inbox.Select(x => JsonDocument.Parse(x).RootElement).Last(e => e.GetProperty("t").GetString() == t);

    [Fact]
    public void KickingANostrJoinerBansTheLinksIpAndALaterJoinerFromThatIpIsRemovedAsKicked()
    {
        var rig = new Rig();
        var host = new List<string>();
        var hs = rig.Hub.Connect("127.0.0.1", host.Add, () => { })!;
        rig.Hub.Receive(hs, Hello("Host"));
        rig.Hub.Receive(hs, "{\"t\":\"create\",\"name\":\"L\",\"maxPlayers\":4,\"visibility\":\"unlisted\",\"mode\":\"raw\"}");
        var ips = new Dictionary<int, string> { [2] = "203.0.113.7", [3] = "203.0.113.7" };
        rig.Bridge.RemoteAddressOf = id => ips.TryGetValue(id, out var ip) ? ip : null;

        using var bad = rig.Join();
        rig.Run(100, bad);
        bad.Send(Hello("Bad"));
        rig.Run(200, bad);
        bad.Send("{\"t\":\"join\"}");
        rig.Run(300, bad);
        Assert.Equal(2, Last(host, "peer_joined").GetProperty("peer").GetProperty("peerId").GetInt32());
        rig.Hub.Receive(hs, "{\"t\":\"kick\",\"peerId\":2}");
        rig.Run(300, bad);
        Assert.True(rig.Bridge.IsIpBanned("203.0.113.7"));

        using var again = rig.Join(); // a fresh pubkey, same address
        rig.Run(100, again);
        again.Send(Hello("Again"));
        rig.Run(200, again);
        again.Send("{\"t\":\"join\"}");
        rig.Run(1000, again);
        var got = Rig.Drain(again).ToList();
        Assert.Contains(got, t => t.Contains("\"kicked\""));
        Assert.Equal("kicked", Last(host, "peer_left").GetProperty("reason").GetString());
        Assert.Equal(3, Last(host, "peer_left").GetProperty("peerId").GetInt32());
    }
}
