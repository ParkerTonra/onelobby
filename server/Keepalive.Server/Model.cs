namespace Keepalive.Server;

/// <summary>One WebSocket connection. Transport-agnostic: the hub only calls <see cref="Send"/> and <see cref="Close"/>.</summary>
public sealed class Session
{
    public long Id { get; init; }
    public string Ip { get; init; } = "";
    public string ConnId { get; init; } = "";
    public Action<string> Send { get; init; } = _ => { };
    public Action Close { get; init; } = () => { };

    public bool Closed;
    public long LastSeen;
    public bool HelloDone;
    public string GameId = "";
    public string NetVersion = "";
    public string Name = "";
    public Lobby? Lobby;
    public Member? Member;
    /// <summary>Private lobby this session has asked to join and awaits approval for.</summary>
    public Lobby? PendingIn;
    public Member? PendingMember;
    public RateWindow? SignalRate;
}

public sealed class Member
{
    public int PeerId;
    public string Name = "";
    public long JoinedAt;
    public Session? Session;
    /// <summary>0 while attached; otherwise the time the socket dropped (resume window running).</summary>
    public long DetachedAt;
    public string Token = "";
    public string Ip = "";
}

public sealed class Lobby
{
    public string Code = "";
    public string GameId = "";
    public string NetVersion = "";
    public string Name = "";
    public string Visibility = "public";
    public string Mode = "lockstep";
    public int TickRate = 20;
    public bool LateJoin;
    public bool RelayOnly;
    public string Phase = "lobby";
    public int MaxPlayers;
    public long CreatedAt;
    public string OwnerIp = "";
    public SortedDictionary<string, string> Meta = new(StringComparer.Ordinal);
    public List<Member> Members = new();
    public List<Member> Pending = new();
    public HashSet<string> Kicked = new(StringComparer.Ordinal);
    public int HostId;
    public int Epoch;
    public int NextPeerId = 1;

    public Member? Find(int peerId)
    {
        foreach (var m in Members) if (m.PeerId == peerId) return m;
        return null;
    }
}
