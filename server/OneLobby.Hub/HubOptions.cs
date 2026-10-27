namespace OneLobby.Server;

/// <summary>
/// The settings <see cref="Hub"/> reads. <c>onelobby-server</c> fills them from flags (<c>ServerOptions</c>); a game
/// hosting by IP fills them in code (<see cref="ForDirect"/>, docs/design/direct-ip.md s.2).
/// </summary>
public class HubOptions
{
    public List<string> TurnUrls { get; set; } = new();
    public string TurnSecret { get; set; } = "";
    public List<string> StunUrls { get; set; } = new() { "stun:stun.l.google.com:19302" };
    public string Region { get; set; } = "";
    /// <summary>Empty = every gameId allowed.</summary>
    public HashSet<string> AllowedGames { get; set; } = new(StringComparer.Ordinal);
    public Dictionary<string, int> GameQuotas { get; set; } = new(StringComparer.Ordinal);
    public int MaxLobbies { get; set; } = 1000;
    public int MaxPeers { get; set; } = 10000;
    /// <summary>Default and advertised maxPlayers limit (welcome.limits.maxPlayers); create accepts 2..this. Hard cap 250.</summary>
    public int HardMaxPlayers { get; set; } = 64;
    public int RateScale { get; set; } = 1;
    public int TurnTtlSeconds { get; set; } = 3600;
    public int MaxMessageBytes { get; set; } = 16 * 1024;
    /// <summary>Testing only (load script): turns off the per-IP limits of DESIGN s.12.</summary>
    public bool DisableIpLimits { get; set; }
    public int CreatePerMin { get; set; } = 10;
    public int JoinPerMin { get; set; } = 60;
    public int SignalPerSec { get; set; } = 20;
    /// <summary><c>signal</c> per second to one Nostr-bridged joiner (address <c>nostr:...</c>); the relays refuse more.</summary>
    public int NostrSignalPerSec { get; set; } = 10;
    /// <summary>Open sockets per IP address, loopback included (<see cref="DisableIpLimits"/> switches it off).</summary>
    public int MaxSocketsPerIp { get; set; } = 32;
    /// <summary>A socket with more unsent bytes than this is closed with 1008 <c>backpressure</c> (hosts that own the socket).</summary>
    public int MaxPendingWriteBytes { get; set; } = 1 << 20;
    public int OpenLobbiesPerIp { get; set; } = 8;
    public long IdleTimeoutMs { get; set; } = 30_000;
    public long ResumeWindowMs { get; set; } = 60_000;
    public long CodeReuseMs { get; set; } = 24L * 3600 * 1000;
    public int ListLimitMax { get; set; } = 100;

    /// <summary>
    /// One lobby per hub (direct IP): the first <c>create</c> makes it and every later <c>create</c> is refused, even
    /// after it closes; a <c>join</c> without a code joins it.
    /// </summary>
    public bool SingleLobby { get; set; }
    /// <summary>When set, <c>join</c> must carry the same <c>password</c> or gets <c>bad_password</c>.</summary>
    public string? Password { get; set; }
    /// <summary>False: lobbies still get an internal code, but <c>lobby</c> messages carry <c>code: ""</c> and <c>list</c> is empty.</summary>
    public bool IssueCodes { get; set; } = true;

    /// <summary>Settings for a hub that runs inside the host's game (docs/design/direct-ip.md s.2): no codes, no list, no ICE servers.</summary>
    public static HubOptions ForDirect(int maxPlayers, string? password) => new()
    {
        SingleLobby = true,
        IssueCodes = false,
        Password = string.IsNullOrEmpty(password) ? null : password,
        StunUrls = new(),
        TurnUrls = new(),
        MaxLobbies = 1,
        HardMaxPlayers = Math.Clamp(maxPlayers, 2, 250),
        MaxPeers = Math.Clamp(maxPlayers, 2, 250) + 8,
    };
}
