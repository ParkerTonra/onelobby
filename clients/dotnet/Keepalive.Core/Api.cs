using System;
using System.Collections.Generic;

#if !NET5_0_OR_GREATER
namespace System.Runtime.CompilerServices
{
    internal static class IsExternalInit { }
}
#endif

namespace Keepalive
{
    public enum SyncMode { Lockstep, Raw }
    public enum Channel { Reliable, Fast }
    public enum Visibility { Public, Unlisted, Private }
    public enum LobbyPhase { Lobby, InGame }

    public sealed record KeepaliveConfig(
        string GameId,
        string NetVersion,
        Uri LobbyServer,
        SyncMode Mode = SyncMode.Lockstep,
        int TickRate = 20,
        int HashEveryTicks = 20,
        string DisplayName = "Player",
        bool RelayOnly = false);

    public sealed record LobbyOptions(
        string Name, int MaxPlayers = 4, Visibility Visibility = Visibility.Unlisted,
        bool LateJoin = true, IReadOnlyDictionary<string, string>? Meta = null);

    public sealed record LobbySummary(string Code, string Name, string HostName, int Players, int MaxPlayers,
        LobbyPhase Phase, IReadOnlyDictionary<string, string> Meta, string Region, DateTimeOffset CreatedAt);

    public sealed record Peer(int PeerId, string Name, int PingMs, bool Relayed);

    public readonly record struct Frame(long Tick, IReadOnlyList<(int PeerId, ReadOnlyMemory<byte> Command)> Commands);

    public sealed record DesyncInfo(long Tick, ulong HostHash, ulong LocalHash, int ResyncCount);

    public sealed record LobbyError(string Code, string Message);

    public sealed record ChatLine(int PeerId, uint Id, long Ts, string Text);

    public enum VoiceMode { PushToTalk, VoiceActivity }

    /// <summary>Thrown by the async lobby calls when the server answers with an error.</summary>
    public sealed class KeepaliveException : Exception
    {
        public string Code { get; }
        public KeepaliveException(string code, string message) : base(code + ": " + message) { Code = code; }
    }
}
