using System;
using System.Collections.Generic;

#if !NET5_0_OR_GREATER
namespace System.Runtime.CompilerServices
{
    internal static class IsExternalInit { }
}
#endif

namespace OneLobby
{
    public enum SyncMode { Lockstep, Raw }
    public enum Channel { Reliable, Fast }
    public enum Visibility { Public, Unlisted, Private }
    public enum LobbyPhase { Lobby, InGame }
    /// <summary>Direct-IP join codes (docs/direct-ip.md s.2a): "Internet code" or "Same-network code" on the host screen; <c>Nostr</c> is a version 1 code (spec/nostr-signaling.md) that works through any router.</summary>
    public enum JoinCodeKind { None, SameNetwork, Internet, Nostr }

    public sealed record OneLobbyConfig(
        string GameId,
        string NetVersion,
        Uri LobbyServer,
        SyncMode Mode = SyncMode.Lockstep,
        int TickRate = 20,
        int HashEveryTicks = 20,
        string DisplayName = "Player",
        bool RelayOnly = false,
        int DirectPort = 47810)
    {
        /// <summary>
        /// Joiner: how long <see cref="Lobby.ReadyAsync"/> waits for the link to the host to open (default 15 s,
        /// <see cref="TimeSpan.Zero"/> = wait forever). On timeout ReadyAsync faults with <see cref="OneLobbyException"/>
        /// code <c>ice_failed</c>, <see cref="LobbyClient.Error"/> fires, the lobby is left and
        /// <see cref="Lobby.SessionEnded"/> fires with <c>"ice_failed"</c>. When the server offers a TURN relay (and
        /// <see cref="RelayOnly"/> is off, not direct IP), the second half of the budget is one relay-only retry.
        /// Set it with <c>config with { ReadyTimeout = TimeSpan.FromSeconds(30) }</c>.
        /// </summary>
        public TimeSpan ReadyTimeout { get; init; } = TimeSpan.FromSeconds(15);

        /// <summary>
        /// Treat a peer as gone after this long without hearing from it: the host drops a silent joiner
        /// (<see cref="Lobby.PeerLeft"/>, "timeout") and a joiner handles a silent host as lost. <see cref="TimeSpan.Zero"/>
        /// (default) keeps the built-in <see cref="Lobby.PeerTimeoutMs"/> / <see cref="Lobby.HostTimeoutMs"/>. Values under
        /// 6 s (<see cref="Lobby.MinPeerTimeoutMs"/>) are raised to 6 s.
        /// </summary>
        public TimeSpan PeerTimeout { get; init; } = TimeSpan.Zero;
    }

    /// <summary>At most <see cref="Messages"/> raw messages per peer in any <see cref="PerMs"/> window (a fixed window, reset every PerMs).</summary>
    public sealed record RateLimit(int Messages, int PerMs);

    public sealed record LobbyOptions(
        string Name, int MaxPlayers = 4, Visibility Visibility = Visibility.Unlisted,
        bool LateJoin = true, IReadOnlyDictionary<string, string>? Meta = null)
    {
        /// <summary>Host: per-joiner cap on incoming raw messages; the excess is dropped before <see cref="Lobby.MessageReceived"/> fires or is relayed.</summary>
        public RateLimit? RateLimit { get; init; }
    }

    public sealed record LobbySummary(string Code, string Name, string HostName, int Players, int MaxPlayers,
        LobbyPhase Phase, IReadOnlyDictionary<string, string> Meta, string Region, DateTimeOffset CreatedAt);

    public sealed record Peer(int PeerId, string Name, int PingMs, bool Relayed);

    public readonly record struct Frame(long Tick, IReadOnlyList<(int PeerId, ReadOnlyMemory<byte> Command)> Commands);

    public sealed record DesyncInfo(long Tick, ulong HostHash, ulong LocalHash, int ResyncCount);

    public sealed record LobbyError(string Code, string Message);

    public sealed record ChatLine(int PeerId, uint Id, long Ts, string Text);

    public enum VoiceMode { PushToTalk, VoiceActivity }

    /// <summary>Thrown by the async lobby calls when the server answers with an error.</summary>
    public class OneLobbyException : Exception
    {
        public string Code { get; }
        public OneLobbyException(string code, string message) : base(code + ": " + message) { Code = code; }
    }
}
