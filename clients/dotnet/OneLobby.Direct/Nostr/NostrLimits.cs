#nullable enable
namespace OneLobby.Direct.Nostr
{
    /// <summary>
    /// Every Nostr limit and timer shared with the JS client (clients/js/packages/client/src/nostr/limits.ts). Pinned by
    /// <c>spec/vectors/nostr-limits.json</c> in a test per language: change a number in all three.
    /// </summary>
    internal static class NostrLimits
    {
        // Reliable link (spec s.4)
        public const int BatchMs = 30;
        public const int ResendMs = 3000;
        public const int MaxResends = 5;
        public const int BeatMs = 10_000;
        public const int SilenceMs = 30_000;
        public const int MaxHeld = 64;
        public const int MaxOutFrames = 128;
        public const int MaxOutBytes = 256 * 1024;
        public const int MaxFrameBytes = 30_000;
        public const int TickMs = 250;

        // Host bridge: new joiner token bucket (spec s.4)
        public const int NewSessionBurst = 16;
        public const int MaxSessionBurst = 64;
        public const int NewSessionRefillMs = 1_000;
        public const int WaitingMax = 64;
        public const int WaitingStaleMs = 5_000;

        // Joiner socket (spec s.4)
        public const int OpenEveryMs = 2000;
        public const int GiveUpMs = 15_000;

        // Relay waits (spec s.6)
        /// <summary><c>HostDirectAsync</c>: how long to wait for a first relay before hosting by IP alone (the IP code shows first, the Nostr code takes over later).</summary>
        public const int HostFirstRelayMs = 3_000;
        /// <summary>Pinned by the vector for JS <c>hostNostr</c> (a browser host has no IP fallback); C# has no browser host.</summary>
        public const int HostNostrFirstRelayMs = 10_000;
        /// <summary>A joiner: how long to wait for a first relay before <c>connect_failed</c>.</summary>
        public const int JoinerFirstRelayMs = 10_000;
        /// <summary>After the first relay: at most this long for the rest of the list; ends at once when every relay has answered.</summary>
        public const int RestWaitMs = 1500;
        public const int RestPollMs = 50;
    }
}
