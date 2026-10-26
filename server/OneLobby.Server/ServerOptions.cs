namespace OneLobby.Server;

/// <summary>onelobby-server's settings: the hub's (<see cref="HubOptions"/>) plus listening and proxy options.</summary>
public sealed class ServerOptions : HubOptions
{
    public string Listen { get; set; } = ":8080";
    public string PublicUrl { get; set; } = "";
    public bool TrustProxy { get; set; }
    /// <summary>Trusted proxies in front of the server: the client IP is the X-Forwarded-For entry this many from the right.</summary>
    public int TrustProxyHops { get; set; } = 1;

    public const string Help = @"onelobby-server: lobby and signaling server for OneLobby (protocol lk1)

  --listen <addr>          :8080, host:port or a full http(s) URL       (ONELOBBY_LISTEN, else :$PORT)
  --turn-urls <a,b>        turn:host:3478,turns:host:443                (ONELOBBY_TURN_URLS)
  --turn-secret <s>        coturn static-auth-secret                    (ONELOBBY_TURN_SECRET)
  --stun-urls <a,b>        default stun:stun.l.google.com:19302         (ONELOBBY_STUN_URLS)
  --public-url <url>       advertised wss:// URL (informational)        (ONELOBBY_PUBLIC_URL)
  --allowed-games <a,b>    gameId allow-list, empty = all               (ONELOBBY_ALLOWED_GAMES)
  --max-lobbies <n>        default 1000                                 (ONELOBBY_MAX_LOBBIES)
  --max-peers <n>          default 10000                                (ONELOBBY_MAX_PEERS)
  --game-quota <id=n>      max live lobbies for one gameId, repeatable  (ONELOBBY_GAME_QUOTAS=id=n,id=n)
  --region <tag>           coarse region tag shown in the lobby list    (ONELOBBY_REGION)
  --turn-ttl <seconds>     TURN credential lifetime, default 3600       (ONELOBBY_TURN_TTL)
  --max-msg <bytes>        signaling message cap, default 16384         (ONELOBBY_MAX_MSG)
  --trust-proxy            take client IP from X-Forwarded-For          (ONELOBBY_TRUST_PROXY)
  --trust-proxy-hops <n>   proxies you run in front, default 1          (ONELOBBY_TRUST_PROXY_HOPS)
  --max-players <n>        largest maxPlayers a lobby may ask for, <=250 (ONELOBBY_MAX_PLAYERS, default 64)
  --rate-scale <n>         testing only: multiply the per-IP limits     (ONELOBBY_RATE_SCALE, default 1)
  --disable-ip-limits      testing only: no per-IP rate limits          (ONELOBBY_DISABLE_IP_LIMITS)
Every ONELOBBY_* variable is also read under its old name KEEPALIVE_* (deprecated) when the new one is unset.
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
        "game-quotas", "region", "turn-ttl", "max-msg", "trust-proxy", "trust-proxy-hops", "disable-ip-limits", "max-players", "rate-scale",
    };

    /// <summary>Env var prefix from before the Keepalive -> OneLobby rename; read as a fallback for one version.</summary>
    public const string LegacyEnvPrefix = "KEEPALIVE_";

    /// <summary>Environment first, then flags override. Throws ArgumentException on bad input.</summary>
    public static ServerOptions Parse(string[] args, Func<string, string?> env)
    {
        var o = new ServerOptions();
        // Hosts such as Render, Railway and Heroku tell the app which port to use in PORT.
        // Lowest precedence: ONELOBBY_LISTEN and --listen still win.
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
                case "trust-proxy-hops": o.TrustProxyHops = Math.Max(1, Int(key, val)); break;
                case "disable-ip-limits": o.DisableIpLimits = Bool(val); break;
                default: throw new ArgumentException($"unknown option --{key}");
            }
        }
        foreach (var key in Keys)
        {
            string name = key.ToUpperInvariant().Replace('-', '_');
            // KEEPALIVE_* is the pre-rename name, still read for one version (ONELOBBY_* wins when both are set).
            string? v = env("ONELOBBY_" + name);
            if (string.IsNullOrEmpty(v)) v = env(LegacyEnvPrefix + name);
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

    /// <summary>
    /// The startup line, in the shape every hub prints (<c>OneLobby: &lt;server|direct host&gt; listening on &lt;TCP|TCP+UDP&gt; :&lt;port&gt;; ...</c>,
    /// as the direct hosts do), e.g. <c>OneLobby: server listening on TCP :8080 (http://0.0.0.0:8080); turn off; games any</c>.
    /// </summary>
    public string StartupLine()
    {
        string url = ListenUrl();
        var m = System.Text.RegularExpressions.Regex.Match(url, @":(\d+)(?:/|$)");
        string port = m.Success ? m.Groups[1].Value : url.StartsWith("https:", StringComparison.OrdinalIgnoreCase) ? "443" : "80";
        string turn = TurnUrls.Count > 0 && TurnSecret.Length > 0 ? "on" : "off";
        string games = AllowedGames.Count == 0 ? "any" : string.Join(",", AllowedGames);
        return $"OneLobby: server listening on TCP :{port} ({url}); turn {turn}; games {games}";
    }
}
