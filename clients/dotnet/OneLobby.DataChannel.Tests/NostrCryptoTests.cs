using System;
using System.Collections.Generic;
using System.Text;
using OneLobby.Direct.Nostr;
using Xunit;

namespace OneLobby.DataChannel.Tests;

/// <summary>
/// The platform AesGcm and the managed GCM (what Unity's Mono falls back to) must read each other's frames, and the
/// switch to the managed one must be visible once. ForceManaged is process-wide, so these share one collection and restore it.
/// </summary>
[Collection("NostrCrypto")]
public class NostrGcmSeamTests
{
    private static readonly byte[] Key = Enumerable32();
    private static readonly byte[] Iv = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 };

    private static byte[] Enumerable32()
    {
        var k = new byte[32];
        for (var i = 0; i < k.Length; i++) k[i] = (byte)(i * 7 + 3);
        return k;
    }

    private static T With<T>(bool forceManaged, Func<T> f)
    {
        var was = NostrCrypto.ForceManaged;
        NostrCrypto.ForceManaged = forceManaged;
        try { return f(); }
        finally { NostrCrypto.ForceManaged = was; }
    }

    public static IEnumerable<object[]> Plains()
    {
        yield return new object[] { "" };
        yield return new object[] { "a" };
        yield return new object[] { "a frame of json {\"k\":1} with unicode é中 and more than sixteen bytes" };
    }

    [Theory, MemberData(nameof(Plains))]
    public void Platform_seal_opens_with_managed(string text)
    {
        var plain = Encoding.UTF8.GetBytes(text);
        var blob = With(false, () => NostrCrypto.GcmSeal(Key, Iv, plain));
        var opened = With(true, () => NostrCrypto.GcmOpen(Key, blob));
        Assert.NotNull(opened);
        Assert.Equal(plain, opened);
    }

    [Theory, MemberData(nameof(Plains))]
    public void Managed_seal_opens_with_platform(string text)
    {
        var plain = Encoding.UTF8.GetBytes(text);
        var blob = With(true, () => NostrCrypto.GcmSeal(Key, Iv, plain));
        var opened = With(false, () => NostrCrypto.GcmOpen(Key, blob));
        Assert.NotNull(opened);
        Assert.Equal(plain, opened);
    }

    [Fact]
    public void ForceManaged_round_trips_and_rejects_a_flipped_tag()
    {
        var plain = Encoding.UTF8.GetBytes("forced managed path");
        With(true, () =>
        {
            var blob = NostrCrypto.GcmSeal(Key, Iv, plain);
            Assert.Equal(plain, NostrCrypto.GcmOpen(Key, blob));
            blob[^1] ^= 1;
            Assert.Null(NostrCrypto.GcmOpen(Key, blob));
            return 0;
        });
    }

    [Fact]
    public void ForceManaged_matches_the_managed_reference()
    {
        var plain = Encoding.UTF8.GetBytes("same bytes either way");
        var forced = With(true, () => NostrCrypto.GcmSeal(Key, Iv, plain));
        Assert.Equal(NostrCrypto.ManagedSeal(Key, Iv, plain), forced);
    }

    [Fact]
    public void Platform_failure_falls_back_to_managed_and_logs_once()
    {
        // A 5-byte key makes the platform ctor throw (ArgumentException, not one of the four types the old filter named);
        // the managed path takes over, the hook hears it once, and good keys keep working afterwards.
        var was = NostrCrypto.ForceManaged;
        var oldLog = NostrCrypto.FallbackLog;
        var lines = new List<string>();
        try
        {
            NostrCrypto.ResetFallbackLogForTests();
            NostrCrypto.ForceManaged = false;
            NostrCrypto.FallbackLog = lines.Add;
            try { NostrCrypto.GcmSeal(new byte[5], Iv, new byte[3]); } catch (Exception) { /* the managed GCM may reject a bad key too */ }
            Assert.True(NostrCrypto.ForceManaged);
            Assert.Single(lines);
            Assert.Contains("managed AES-GCM", lines[0]);
            NostrCrypto.ForceManaged = false;
            try { NostrCrypto.GcmSeal(new byte[5], Iv, new byte[3]); } catch (Exception) { }
            Assert.Single(lines);
            var plain = Encoding.UTF8.GetBytes("still fine");
            Assert.Equal(plain, NostrCrypto.GcmOpen(Key, NostrCrypto.GcmSeal(Key, Iv, plain)));
        }
        finally
        {
            NostrCrypto.FallbackLog = oldLog;
            NostrCrypto.ForceManaged = was;
        }
    }
}
