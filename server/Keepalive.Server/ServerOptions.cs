namespace Keepalive.Server;

public sealed class ServerOptions
{
    public string Listen { get; set; } = ":8080";
    public List<string> TurnUrls { get; set; } = new();
    public string TurnSecret { get; set; } = "";
    public List<string> StunUrls { get; set; } = new() { "stun:stun.l.google.com:19302" };
    public string PublicUrl { get; set; } = "";
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
    public bool TrustProxy { get; set; }
    /// <summary>Testing only (load script): turns off the per-IP limits of DESIGN s.12.</summary>
    public bool DisableIpLimits { get; set; }
    public int CreatePerMin { get; set; } = 10;
    public int JoinPerMin { get; set; } = 60;
    public int SignalPerSec { get; set; } = 20;
    public int OpenLobbiesPerIp { get; set; } = 8;
    public long IdleTimeoutMs { get; set; } = 30_000;
    public long ResumeWindowMs { get; set; } = 60_000;
    public long CodeReuseMs { get; set; } = 24L * 3600 * 1000;
    public int ListLimitMax { get; set; } = 100;

    public const string Help = @"keepalive-server: lobby and signaling server for Keepalive (protocol lk1)

  --listen <addr>          :8080, host:port or a full http(s) URL       (KEEPALIVE_LISTEN, else :$PORT)
  --turn-urls <a,b>        turn:host:3478,turns:host:443                (KEEPALIVE_TURN_URLS)
  --turn-secret <s>        coturn static-auth-secret                    (KEEPALIVE_TURN_SECRET)
  --stun-urls <a,b>        default stun:stun.l.google.com:19302         (KEEPALIVE_STUN_URLS)
  --public-url <url>       advertised wss:// URL (informational)        (KEEPALIVE_PUBLIC_URL)
  --allowed-games <a,b>    gameId allow-list, empty = all               (KEEPALIVE_ALLOWED_GAMES)
  --max-lobbies <n>        default 1000                                 (KEEPALIVE_MAX_LOBBIES)
  --max-peers <n>          default 10000                                (KEEPALIVE_MAX_PEERS)
  --game-quota <id=n>      max live lobbies for one gameId, repeatable  (KEEPALIVE_GAME_QUOTAS=id=n,id=n)
  --region <tag>           coarse region tag shown in the lobby list    (KEEPALIVE_REGION)
  --turn-ttl <seconds>     TURN credential lifetime, default 3600       (KEEPALIVE_TURN_TTL)
  --max-msg <bytes>        signaling message cap, default 16384         (KEEPALIVE_MAX_MSG)
  --trust-proxy            take client IP from X-Forwarded-For          (KEEPALIVE_TRUST_PROXY)
  --max-players <n>        largest maxPlayers a lobby may ask for, <=250 (KEEPALIVE_MAX_PLAYERS, default 64)
  --rate-scale <n>         testing only: multiply the per-IP limits     (KEEPALIVE_RATE_SCALE, default 1)
  --disable-ip-limits      testing only: no per-IP rate limits          (KEEPALIVE_DISABLE_IP_LIMITS)
";

    private static List<string> Split(string v) =>
        v.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

    private static void AddQuotas(ServerOptions o, string v)
    {
        foreach (var part in Split(v))
        {
            int eq = part.LastIndexOf('=');
            if (eq <= 0 || !int.TryParse(part[(eq + 1)..], out int n) || n < 0)
                throw new ArgumentException($"bad game quota '{part}', expected id=n");
            o.GameQuotas[part[..eq]] = n;
        }
    }

    private static readonly string[] Keys =
    {
        "listen", "turn-urls", "turn-secret", "stun-urls", "public-url", "allowed-games", "max-lobbies", "max-peers",
        "game-quotas", "region", "turn-ttl", "max-msg", "trust-proxy", "disable-ip-limits", "max-players", "rate-scale",
    };

    /// <summary>Environment first, then flags override. Throws ArgumentException on bad input.</summary>
    public static ServerOptions Parse(string[] args, Func<string, string?> env)
    {
        var o = new ServerOptions();
        // Hosts such as Render, Railway and Heroku tell the app which port to use in PORT.
        // Lowest precedence: KEEPALIVE_LISTEN and --listen still win.
        string? port = env("PORT");
        if (!string.IsNullOrEmpty(port))
            o.Listen = ":" + (int.TryParse(port, out int p) && p is > 0 and < 65536 ? p : throw new ArgumentException($"PORT '{port}' is not a port number"));
        void Apply(string key, string val)
        {
            switch (key)
            {
                case "listen": o.Listen = val; break;
                case "turn-urls": o.TurnUrls = Split(val); break;
                case "turn-secret": o.TurnSecret = val; break;
                case "stun-urls": o.StunUrls = Split(val); break;
                case "public-url": o.PublicUrl = val; break;
                case "allowed-games": { var g = Split(val); o.AllowedGames = g.Contains("*") ? new(StringComparer.Ordinal) : new(g, StringComparer.Ordinal); } break;
                case "max-lobbies": o.MaxLobbies = Int(key, val); break;
                case "max-peers": o.MaxPeers = Int(key, val); break;
                case "game-quota": case "game-quotas": AddQuotas(o, val); break;
                case "region": o.Region = val; break;
                case "max-players": o.HardMaxPlayers = Math.Clamp(Int(key, val), 2, 250); break;
                case "rate-scale": o.RateScale = Math.Max(1, Int(key, val)); break;
                case "turn-ttl": o.TurnTtlSeconds = Int(key, val); break;
                case "max-msg": o.MaxMessageBytes = Int(key, val); break;
                case "trust-proxy": o.TrustProxy = Bool(val); break;
                case "disable-ip-limits": o.DisableIpLimits = Bool(val); break;
                default: throw new ArgumentException($"unknown option --{key}");
            }
        }
        foreach (var key in Keys)
        {
            string? v = env("KEEPALIVE_" + key.ToUpperInvariant().Replace('-', '_'));
            if (!string.IsNullOrEmpty(v)) Apply(key, v);
        }
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (!a.StartsWith("--")) throw new ArgumentException($"unexpected argument '{a}'");
            string key = a[2..];
            string? val = null;
            int eq = key.IndexOf('=');
            if (eq >= 0) { val = key[(eq + 1)..]; key = key[..eq]; }
            bool isBool = key is "trust-proxy" or "disable-ip-limits";
            if (val is null)
            {
                if (isBool) val = "true";
                else if (i + 1 < args.Length) val = args[++i];
                else throw new ArgumentException($"--{key} needs a value");
            }
            Apply(key, val);
        }
        return o;
    }

    private static int Int(string key, string v) =>
        int.TryParse(v, out int n) && n >= 0 ? n : throw new ArgumentException($"--{key} expects a non-negative integer");

    private static bool Bool(string v) => v is "1" or "true" or "TRUE" or "True" or "yes";

    /// <summary>":8080" and "host:port" become http URLs for Kestrel; full URLs pass through.</summary>
    public string ListenUrl()
    {
        if (Listen.Contains("://")) return Listen;
        if (Listen.StartsWith(':')) return "http://0.0.0.0" + Listen;
        return "http://" + Listen;
    }
}
