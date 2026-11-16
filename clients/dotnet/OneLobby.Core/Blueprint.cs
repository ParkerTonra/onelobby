using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OneLobby
{
    /// <summary>
    /// Thrown by <see cref="Blueprint.Parse(string)"/> / <see cref="Blueprint.Load(string)"/> for a bad onelobby.json
    /// (and by the blueprint display-name check). <see cref="OneLobbyException.Code"/> is <c>bad_config</c>.
    /// </summary>
    public sealed class BlueprintException : OneLobbyException
    {
        /// <summary>Dotted path of the offending key ("" = the file itself, array indexes are numbers).</summary>
        public string Path { get; }
        /// <summary>Rule id: type, required, unknown_key, enum, const, range, length, pattern, json, or a spec/blueprint.schema.json x-rule (hosting_none, ...).</summary>
        public string Rule { get; }
        public BlueprintException(string path, string rule, string message)
            : base(LobbyErrorCodes.BadConfig, (path.Length == 0 ? "onelobby.json" : path) + ": " + message) { Path = path; Rule = rule; }
    }

    public sealed record GameSection(string Id, string NetVersion, string? Title);
    public sealed record HostingSection(bool Direct, bool Server, string LobbyServer, int DirectPort, bool OpenPort, bool RelayOnly,
        IReadOnlyList<string> AllowedOrigins, bool Nostr = true, IReadOnlyList<string>? NostrRelays = null)
    {
        /// <summary>The <c>hosting.nostrRelays</c> list; the default list when the blueprint does not set it (an explicit empty list means the library default at use time).</summary>
        public IReadOnlyList<string> Relays => NostrRelays ?? Blueprint.DefaultNostrRelays;
    }
    public sealed record LobbySection(int MaxPlayers, bool Listed, bool ApproveJoins, bool Password, bool LateJoin, bool Rejoin,
        bool JoinLink, IReadOnlyDictionary<string, string> Meta);
    /// <summary>The room layer's defaults (<c>room</c> in onelobby.json, spec/room.md s.10).</summary>
    public sealed record RoomSection(bool PasswordRequired, AutoStartMode AutoStart, int AutoStartPlayers, int MinPlayers, int CountdownSeconds,
        int Spectators, LateJoinPolicy LateJoin, SeatDroppedPolicy SeatDropped, int RejoinWindowSeconds, IReadOnlyDictionary<string, DataDecl> Data)
    {
        /// <summary>Every default of the section.</summary>
        public static readonly RoomSection Defaults = new RoomSection(false, AutoStartMode.Off, 2, 1, 3, 0, LateJoinPolicy.Allow, SeatDroppedPolicy.Window, 60,
            new Dictionary<string, DataDecl>());

        /// <summary>The same as <see cref="RoomOptions"/> for the client (<paramref name="maxNameLength"/> is <c>players.maxNameLength</c>).</summary>
        public RoomOptions ToOptions(int maxNameLength = 24) => new RoomOptions
        {
            AutoStart = AutoStart, AutoStartPlayers = AutoStartPlayers, MinPlayers = MinPlayers, CountdownSeconds = CountdownSeconds, Spectators = Spectators,
            LateJoin = LateJoin, SeatDropped = SeatDropped, RejoinWindowSeconds = RejoinWindowSeconds, PasswordRequired = PasswordRequired,
            MaxNameLength = maxNameLength, Data = Data,
        };
    }

    /// <summary>
    /// <see cref="Mode"/> is "raw", "lockstep" or "replication". <see cref="Player"/> is the networked player layer
    /// (spec/net-player.md; the defaults when the file has no <c>sync.player</c>); it needs mode "replication".
    /// </summary>
    public sealed record SyncSection(string Mode, int TickRate, int HashEveryTicks)
    {
        public PlayerSection Player { get; init; } = PlayerSection.Defaults;
    }
    /// <summary>The host's limits of the networked player; null = not set = not checked.</summary>
    public sealed record PlayerLimits(int? MaxSpeed, int? MaxStep, int? MinShotIntervalMs, int? MinMeleeIntervalMs);
    /// <summary>
    /// <c>sync.player</c> (spec/net-player.md). <see cref="Authority"/>: "owner" or "host". <see cref="Space"/>: "2d" or "3d".
    /// <see cref="Range"/> and <see cref="VelocityRange"/> shape the quantisation; <see cref="Omit"/> names the preset fields and events left out.
    /// </summary>
    public sealed record PlayerSection(string Authority, string Space, int Range, int VelocityRange, PlayerLimits Limits, IReadOnlyList<string> Omit)
    {
        public static readonly PlayerSection Defaults = new PlayerSection("owner", "3d", 300, 32, new PlayerLimits(null, null, null, null), Array.Empty<string>());
        /// <summary>Preset fields and events a game may leave out; position and the teleport counter cannot go.</summary>
        public static readonly string[] Omittable =
        {
            "velocity", "yaw", "pitch", "onGround", "mode", "item", "aiming", "blocking", "health", "alive", "team",
            "jump", "land", "shoot", "melee", "reload", "use", "itemSwitch", "throw", "hit", "death", "respawn", "emote",
        };
    }
    /// <summary><see cref="Identity"/> is "name", "anonymous" or "platform".</summary>
    public sealed record PlayersSection(string Identity, int MaxNameLength);
    /// <summary><see cref="VoiceMode"/> is "pushToTalk" or "voiceActivity".</summary>
    public sealed record ChatSection(bool Text, bool Voice, string VoiceMode);
    /// <summary><see cref="HostLeaves"/>: "end" or "migrate". <see cref="Pause"/>: "off", "host" or "anyone".</summary>
    public sealed record SessionSection(string HostLeaves, string Pause, int ReadyTimeoutMs, int PeerTimeoutMs,
        RateLimit? RateLimit, bool RunInBackground);
    public sealed record SteamSetting(bool Enabled, int? AppId);
    public sealed record EpicSetting(bool Enabled, IReadOnlyDictionary<string, string> Ids);
    public sealed record PlatformsSection(SteamSetting Steam, EpicSetting Epic, bool Discord);
    /// <summary><see cref="Kind"/>: "drop-in", "generated" or "none". <see cref="Theme"/>: "light", "dark" or "auto".</summary>
    public sealed record UiSection(string Kind, string? Entry, string Theme);
    /// <summary>The diagnostics switches (spec/diagnostics.md); <see cref="LogSize"/> is 50..5000. <see cref="ShowConnectionCheck"/> and <see cref="CheckOnOpen"/> are for a drop-in menu (<see cref="CheckOnOpen"/> false: the check runs only on the button).</summary>
    public sealed record DiagnosticsSection(bool ReportToHost, int LogSize, bool RelayProbe, bool ShowConnectionCheck, bool CheckOnOpen = true)
    {
        public static readonly DiagnosticsSection Defaults = new DiagnosticsSection(true, NetLog.DefaultCapacity, true, true, true);
    }

    /// <summary>
    /// The settings file <c>onelobby.json</c> (spec/blueprint.schema.json, docs/design/blueprint.md), validated and with
    /// every default filled in. Immutable. Use <see cref="LobbyClient.FromBlueprint"/> to run a client from it, or the
    /// <c>To...</c> adapters to adopt it one call at a time.
    /// </summary>
    public sealed record Blueprint(int Version, GameSection Game, string? Engine, HostingSection Hosting, LobbySection Lobby,
        SyncSection Sync, PlayersSection Players, ChatSection Chat, SessionSection Session, PlatformsSection Platforms, UiSection Ui)
    {
        /// <summary>Stand-in server URL used by <see cref="ToConfig"/> when the file names no lobby server (direct-only games).</summary>
        public static readonly Uri NoServer = new Uri("onelobby-none://no-lobby-server/");

        /// <summary>The room layer's defaults (<c>room</c>; spec/room.md s.10).</summary>
        public RoomSection Room { get; init; } = RoomSection.Defaults;

        /// <summary>The diagnostics switches (<c>diagnostics</c>); <see cref="ToConfig"/> applies them to <see cref="OneLobbyConfig.Diagnostics"/>.</summary>
        public DiagnosticsSection Diagnostics { get; init; } = DiagnosticsSection.Defaults;

        /// <summary>
        /// Default public Nostr relays (the JS <c>DEFAULT_NOSTR_RELAYS</c>, same URLs in the same order; probed 2026-10-26,
        /// docs/design/no-server-fallback.md): all accept and echo ephemeral kind 25050.
        /// </summary>
        public static readonly IReadOnlyList<string> DefaultNostrRelays = new[]
        {
            "wss://nos.lol", "wss://relay.primal.net", "wss://nostr-pub.wellorder.net", "wss://nostr.oxtr.dev",
            "wss://nostr.bitcoiner.social", "wss://relay.nostr.net", "wss://nostr.sathoarder.com",
        };

        /// <summary>The JSON Schema (spec/blueprint.schema.json), embedded in this assembly.</summary>
        public static string SchemaJson
        {
            get
            {
                using var s = typeof(Blueprint).Assembly.GetManifestResourceStream("OneLobby.blueprint.schema.json")
                    ?? throw new InvalidOperationException("blueprint.schema.json is not embedded");
                using var r = new StreamReader(s, Encoding.UTF8);
                return r.ReadToEnd();
            }
        }

        /// <summary>Reads and validates a file. Throws <see cref="BlueprintException"/> (code <c>bad_config</c>).</summary>
        public static Blueprint Load(string path) => Parse(File.ReadAllText(path));

        /// <summary>Validates <paramref name="json"/> against the schema, fills defaults, applies the cross-key rules.</summary>
        public static Blueprint Parse(string json)
        {
            if (json == null) throw new ArgumentNullException(nameof(json));
            JsonDocument doc;
            try { doc = JsonDocument.Parse(json, new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true }); }
            catch (JsonException e) { throw new BlueprintException("", "json", "not valid JSON: " + e.Message); }
            using (doc) return BlueprintValidator.Build(doc.RootElement);
        }

        // ---- adapters ------------------------------------------------------------------------------------------------

        /// <summary>
        /// Today's <see cref="OneLobbyConfig"/>. <c>LobbyServer</c> is <c>hosting.lobbyServer</c>; when the file has none
        /// (a direct-only game) it is <see cref="NoServer"/>, which never connects, so <c>HostAsync()</c> on a blueprint
        /// client fails with <c>bad_config</c> instead of dialing nothing. Replication maps to Raw. <c>session.peerTimeoutMs</c>
        /// becomes <see cref="OneLobbyConfig.PeerTimeout"/>.
        /// </summary>
        public OneLobbyConfig ToConfig(string? displayName = null)
        {
            var server = string.IsNullOrEmpty(Hosting.LobbyServer) ? NoServer : new Uri(Hosting.LobbyServer);
            return new OneLobbyConfig(Game.Id, Game.NetVersion, server,
                Sync.Mode == "lockstep" ? SyncMode.Lockstep : SyncMode.Raw, Sync.TickRate, Sync.HashEveryTicks,
                displayName ?? "", Hosting.RelayOnly, Hosting.DirectPort)
            {
                ReadyTimeout = TimeSpan.FromMilliseconds(Session.ReadyTimeoutMs), PeerTimeout = TimeSpan.FromMilliseconds(Session.PeerTimeoutMs),
                Diagnostics = new DiagnosticsOptions { ReportToHost = Diagnostics.ReportToHost, LogSize = Diagnostics.LogSize, RelayProbe = Diagnostics.RelayProbe },
            };
        }

        /// <summary>
        /// <see cref="LobbyOptions"/> for a server lobby: listed gives Public, approveJoins Private, else Unlisted.
        /// <paramref name="name"/> defaults to "&lt;displayName&gt;'s game" ("Player's game" for no name). <c>session.rateLimit</c>
        /// becomes <see cref="LobbyOptions.RateLimit"/>. <c>lobby.password</c> only says the game asks for one: the
        /// host passes the password itself (a direct host's <c>DirectHostOptions.Password</c>).
        /// </summary>
        public LobbyOptions ToLobbyOptions(string? name = null, string? displayName = null) =>
            new LobbyOptions(string.IsNullOrEmpty(name) ? DefaultLobbyName(displayName) : name!, Lobby.MaxPlayers,
                Lobby.Listed ? Visibility.Public : Lobby.ApproveJoins ? Visibility.Private : Visibility.Unlisted,
                Lobby.LateJoin, Lobby.Meta.Count == 0 ? null : Lobby.Meta) { RateLimit = Session.RateLimit };

        internal static string DefaultLobbyName(string? displayName) => (string.IsNullOrEmpty(displayName) ? "Player" : displayName) + "'s game";

        /// <summary>Throws <c>identity_anonymous</c> / <c>bad_config</c> (path <c>displayName</c>) when the name breaks players.*.</summary>
        public void CheckDisplayName(string? displayName)
        {
            if (string.IsNullOrEmpty(displayName)) return;
            if (Players.Identity == "anonymous")
                throw new OneLobbyException(LobbyErrorCodes.IdentityAnonymous, "players.identity is anonymous: this game takes no display names");
            if (displayName!.Length > Players.MaxNameLength)
                throw new BlueprintException("displayName", "length", "longer than players.maxNameLength (" + Players.MaxNameLength + ")");
        }

        /// <summary>The validated file with defaults filled in (null values omitted). Round-trips through <see cref="Parse"/>.</summary>
        public string ToJson()
        {
            using var ms = new MemoryStream();
            using (var w = new Utf8JsonWriter(ms, new JsonWriterOptions { Indented = true }))
            {
                w.WriteStartObject();
                w.WriteNumber("version", Version);
                w.WriteStartObject("game");
                w.WriteString("id", Game.Id); w.WriteString("netVersion", Game.NetVersion);
                if (Game.Title != null) w.WriteString("title", Game.Title);
                w.WriteEndObject();
                if (Engine != null) w.WriteString("engine", Engine);
                w.WriteStartObject("hosting");
                w.WriteBoolean("direct", Hosting.Direct); w.WriteBoolean("server", Hosting.Server);
                w.WriteString("lobbyServer", Hosting.LobbyServer); w.WriteNumber("directPort", Hosting.DirectPort);
                w.WriteBoolean("openPort", Hosting.OpenPort); w.WriteBoolean("relayOnly", Hosting.RelayOnly);
                w.WriteStartArray("allowedOrigins");
                foreach (var o in Hosting.AllowedOrigins) w.WriteStringValue(o);
                w.WriteEndArray();
                w.WriteBoolean("nostr", Hosting.Nostr);
                w.WriteStartArray("nostrRelays");
                foreach (var o in Hosting.Relays) w.WriteStringValue(o);
                w.WriteEndArray();
                w.WriteEndObject();
                w.WriteStartObject("lobby");
                w.WriteNumber("maxPlayers", Lobby.MaxPlayers); w.WriteBoolean("listed", Lobby.Listed);
                w.WriteBoolean("approveJoins", Lobby.ApproveJoins); w.WriteBoolean("password", Lobby.Password);
                w.WriteBoolean("lateJoin", Lobby.LateJoin); w.WriteBoolean("rejoin", Lobby.Rejoin);
                w.WriteBoolean("joinLink", Lobby.JoinLink);
                w.WriteStartObject("meta");
                foreach (var kv in Lobby.Meta) w.WriteString(kv.Key, kv.Value);
                w.WriteEndObject();
                w.WriteEndObject();
                w.WriteStartObject("room");
                w.WriteBoolean("passwordRequired", Room.PasswordRequired);
                w.WriteString("autoStart", RoomRules.Name(Room.AutoStart)); w.WriteNumber("autoStartPlayers", Room.AutoStartPlayers);
                w.WriteNumber("minPlayers", Room.MinPlayers); w.WriteNumber("countdownSeconds", Room.CountdownSeconds);
                w.WriteNumber("spectators", Room.Spectators); w.WriteString("lateJoin", RoomRules.Name(Room.LateJoin));
                w.WriteString("seatDropped", RoomRules.Name(Room.SeatDropped)); w.WriteNumber("rejoinWindowSeconds", Room.RejoinWindowSeconds);
                w.WriteStartObject("data");
                foreach (var kv in Room.Data) { w.WritePropertyName(kv.Key); RoomWire.WriteDecl(w, kv.Value); }
                w.WriteEndObject();
                w.WriteEndObject();
                w.WriteStartObject("sync");
                w.WriteString("mode", Sync.Mode); w.WriteNumber("tickRate", Sync.TickRate); w.WriteNumber("hashEveryTicks", Sync.HashEveryTicks);
                if (Sync.Mode == "replication")
                {
                    w.WriteStartObject("player");
                    w.WriteString("authority", Sync.Player.Authority); w.WriteString("space", Sync.Player.Space);
                    w.WriteNumber("range", Sync.Player.Range); w.WriteNumber("velocityRange", Sync.Player.VelocityRange);
                    w.WriteStartObject("limits");
                    if (Sync.Player.Limits.MaxSpeed is { } l1) w.WriteNumber("maxSpeed", l1);
                    if (Sync.Player.Limits.MaxStep is { } l2) w.WriteNumber("maxStep", l2);
                    if (Sync.Player.Limits.MinShotIntervalMs is { } l3) w.WriteNumber("minShotIntervalMs", l3);
                    if (Sync.Player.Limits.MinMeleeIntervalMs is { } l4) w.WriteNumber("minMeleeIntervalMs", l4);
                    w.WriteEndObject();
                    w.WriteStartArray("omit");
                    foreach (var o in Sync.Player.Omit) w.WriteStringValue(o);
                    w.WriteEndArray();
                    w.WriteEndObject();
                }
                w.WriteEndObject();
                w.WriteStartObject("players");
                w.WriteString("identity", Players.Identity); w.WriteNumber("maxNameLength", Players.MaxNameLength);
                w.WriteEndObject();
                w.WriteStartObject("chat");
                w.WriteBoolean("text", Chat.Text); w.WriteBoolean("voice", Chat.Voice); w.WriteString("voiceMode", Chat.VoiceMode);
                w.WriteEndObject();
                w.WriteStartObject("session");
                w.WriteString("hostLeaves", Session.HostLeaves); w.WriteString("pause", Session.Pause);
                w.WriteNumber("readyTimeoutMs", Session.ReadyTimeoutMs); w.WriteNumber("peerTimeoutMs", Session.PeerTimeoutMs);
                if (Session.RateLimit != null)
                {
                    w.WriteStartObject("rateLimit");
                    w.WriteNumber("messages", Session.RateLimit.Messages); w.WriteNumber("perMs", Session.RateLimit.PerMs);
                    w.WriteEndObject();
                }
                w.WriteBoolean("runInBackground", Session.RunInBackground);
                w.WriteEndObject();
                w.WriteStartObject("platforms");
                if (Platforms.Steam.AppId is { } app) { w.WriteStartObject("steam"); w.WriteNumber("appId", app); w.WriteEndObject(); }
                else w.WriteBoolean("steam", Platforms.Steam.Enabled);
                if (Platforms.Epic.Ids.Count > 0)
                {
                    w.WriteStartObject("epic");
                    foreach (var kv in Platforms.Epic.Ids) w.WriteString(kv.Key, kv.Value);
                    w.WriteEndObject();
                }
                else w.WriteBoolean("epic", Platforms.Epic.Enabled);
                w.WriteBoolean("discord", Platforms.Discord);
                w.WriteEndObject();
                w.WriteStartObject("ui");
                w.WriteString("kind", Ui.Kind);
                if (Ui.Entry != null) w.WriteString("entry", Ui.Entry);
                w.WriteString("theme", Ui.Theme);
                w.WriteEndObject();
                w.WriteStartObject("diagnostics");
                w.WriteBoolean("reportToHost", Diagnostics.ReportToHost); w.WriteNumber("logSize", Diagnostics.LogSize);
                w.WriteBoolean("relayProbe", Diagnostics.RelayProbe); w.WriteBoolean("showConnectionCheck", Diagnostics.ShowConnectionCheck); w.WriteBoolean("checkOnOpen", Diagnostics.CheckOnOpen);
                w.WriteEndObject();
                w.WriteEndObject();
            }
            return Encoding.UTF8.GetString(ms.ToArray());
        }
    }

    /// <summary>Hand-written validator over <see cref="JsonElement"/>; mirrors spec/blueprint.schema.json and its x-rules.</summary>
    internal static class BlueprintValidator
    {
        private static readonly Regex IdPattern = new Regex("^[A-Za-z0-9._-]{1,64}$", RegexOptions.CultureInvariant);

        private static BlueprintException Err(string path, string rule, string msg) => new BlueprintException(path, rule, msg);
        private static string P(string parent, string key) => parent.Length == 0 ? key : parent + "." + key;

        // ---- primitives (each throws on the first problem) -------------------------------------------------------------

        private static void Object(JsonElement v, string path, string[] required, string[] known, Action<string, JsonElement> each)
        {
            if (v.ValueKind != JsonValueKind.Object) throw Err(path, "type", "must be an object");
            foreach (var r in required)
                if (!v.TryGetProperty(r, out _)) throw Err(P(path, r), "required", "is required");
            foreach (var prop in v.EnumerateObject())
            {
                if (prop.Name == "$comment" || (prop.Name == "$schema" && path.Length == 0)) continue;
                if (Array.IndexOf(known, prop.Name) < 0) throw Err(P(path, prop.Name), "unknown_key", "unknown key");
            }
            foreach (var k in known)
                if (v.TryGetProperty(k, out var child)) each(k, child);
            if (v.TryGetProperty("$comment", out var c) && c.ValueKind != JsonValueKind.String) throw Err(P(path, "$comment"), "type", "must be a string");
            if (path.Length == 0 && v.TryGetProperty("$schema", out var s) && s.ValueKind != JsonValueKind.String) throw Err("$schema", "type", "must be a string");
        }

        private static string Str(JsonElement v, string path, int min = 0, int max = int.MaxValue)
        {
            if (v.ValueKind != JsonValueKind.String) throw Err(path, "type", "must be a string");
            var s = v.GetString()!;
            if (s.Length < min || s.Length > max) throw Err(path, "length", "length must be " + min + "-" + max);
            return s;
        }

        private static bool Bool(JsonElement v, string path)
        {
            if (v.ValueKind != JsonValueKind.True && v.ValueKind != JsonValueKind.False) throw Err(path, "type", "must be true or false");
            return v.GetBoolean();
        }

        private static long Int(JsonElement v, string path, long min = long.MinValue, long max = long.MaxValue)
        {
            if (v.ValueKind != JsonValueKind.Number) throw Err(path, "type", "must be an integer");
            long n;
            if (!v.TryGetInt64(out n))
            {
                var d = v.GetDouble();
                if (double.IsNaN(d) || double.IsInfinity(d) || d != Math.Floor(d) || Math.Abs(d) > 9e15) throw Err(path, "type", "must be an integer");
                n = (long)d;
            }
            if (n < min || n > max) throw Err(path, "range", "must be between " + min + " and " + max);
            return n;
        }

        private static string Enum(JsonElement v, string path, params string[] values)
        {
            if (v.ValueKind != JsonValueKind.String || Array.IndexOf(values, v.GetString()) < 0)
                throw Err(path, "enum", "must be one of " + string.Join(", ", values));
            return v.GetString()!;
        }

        // ---- structure -------------------------------------------------------------------------------------------------

        private static void PlayerStructure(JsonElement v)
        {
            Object(v, "sync.player", Array.Empty<string>(), new[] { "authority", "space", "range", "velocityRange", "limits", "omit" }, (pk, pv) =>
            {
                var pp = "sync.player." + pk;
                switch (pk)
                {
                    case "authority": Enum(pv, pp, "owner", "host"); break;
                    case "space": Enum(pv, pp, "2d", "3d"); break;
                    case "range": Int(pv, pp, 1, 100000); break;
                    case "velocityRange": Int(pv, pp, 1, 1000); break;
                    case "limits":
                        Object(pv, pp, Array.Empty<string>(), new[] { "maxSpeed", "maxStep", "minShotIntervalMs", "minMeleeIntervalMs" }, (lk, lv) =>
                            Int(lv, pp + "." + lk, 1, lk.StartsWith("min", StringComparison.Ordinal) ? 60000 : 100000));
                        break;
                    default:
                        if (pv.ValueKind != JsonValueKind.Array) throw Err(pp, "type", "must be an array of names");
                        var i = 0;
                        foreach (var item in pv.EnumerateArray())
                        {
                            if (item.ValueKind != JsonValueKind.String) throw Err(pp + "." + i, "type", "must be a string");
                            if (Array.IndexOf(PlayerSection.Omittable, item.GetString()) < 0) throw Err(pp + "." + i, "enum", "must be one of " + string.Join(", ", PlayerSection.Omittable));
                            i++;
                        }
                        break;
                }
            });
        }

        private static void Structure(JsonElement root)
        {
            Object(root, "", new[] { "game" }, new[] { "version", "game", "engine", "hosting", "lobby", "room", "sync", "players", "chat", "session", "platforms", "ui", "diagnostics" }, (k, v) =>
            {
                switch (k)
                {
                    case "version":
                        if (v.ValueKind != JsonValueKind.Number) throw Err("version", "type", "must be 1");
                        if (Int(v, "version") != 1) throw Err("version", "const", "must be 1");
                        break;
                    case "game":
                        Object(v, "game", new[] { "id" }, new[] { "id", "netVersion", "title" }, (gk, gv) =>
                        {
                            var gp = "game." + gk;
                            if (gk == "id") { Str(gv, gp); if (!IdPattern.IsMatch(gv.GetString()!)) throw Err(gp, "pattern", "must match ^[A-Za-z0-9._-]{1,64}$"); }
                            else if (gk == "netVersion") Str(gv, gp, 1, 32);
                            else Str(gv, gp, 0, 64);
                        });
                        break;
                    case "engine": Enum(v, "engine", "web", "node-browser", "godot-csharp", "godot-gdscript", "unity", "dotnet"); break;
                    case "hosting":
                        Object(v, "hosting", Array.Empty<string>(), new[] { "direct", "server", "lobbyServer", "directPort", "openPort", "relayOnly", "allowedOrigins", "nostr", "nostrRelays" }, (hk, hv) =>
                        {
                            var hp = "hosting." + hk;
                            switch (hk)
                            {
                                case "lobbyServer": Str(hv, hp); break;
                                case "directPort": Int(hv, hp, 1024, 65535); break;
                                case "allowedOrigins":
                                case "nostrRelays":
                                    if (hv.ValueKind != JsonValueKind.Array) throw Err(hp, "type", "must be an array");
                                    var i = 0;
                                    foreach (var item in hv.EnumerateArray()) Str(item, hp + "." + i++);
                                    break;
                                default: Bool(hv, hp); break;
                            }
                        });
                        break;
                    case "lobby":
                        Object(v, "lobby", Array.Empty<string>(), new[] { "maxPlayers", "listed", "approveJoins", "password", "lateJoin", "rejoin", "joinLink", "meta" }, (lk, lv) =>
                        {
                            var lp = "lobby." + lk;
                            if (lk == "maxPlayers") Int(lv, lp, 2, 64);
                            else if (lk == "meta")
                            {
                                if (lv.ValueKind != JsonValueKind.Object) throw Err(lp, "type", "must be an object");
                                if (lv.EnumerateObject().Count() > 16) throw Err(lp, "length", "at most 16 keys");
                                foreach (var kv in lv.EnumerateObject())
                                {
                                    if (kv.Name.Length > 64) throw Err(lp + "." + kv.Name, "length", "key longer than 64 characters");
                                    Str(kv.Value, lp + "." + kv.Name, 0, 64);
                                }
                            }
                            else Bool(lv, lp);
                        });
                        break;
                    case "room":
                        Object(v, "room", Array.Empty<string>(), new[] { "passwordRequired", "autoStart", "autoStartPlayers", "minPlayers", "countdownSeconds", "spectators", "lateJoin", "seatDropped", "rejoinWindowSeconds", "data" }, (rk, rv) =>
                        {
                            var rp = "room." + rk;
                            switch (rk)
                            {
                                case "passwordRequired": Bool(rv, rp); break;
                                case "autoStart": Enum(rv, rp, "off", "all_ready", "players"); break;
                                case "autoStartPlayers": Int(rv, rp, 2, 64); break;
                                case "minPlayers": Int(rv, rp, 1, 64); break;
                                case "countdownSeconds": Int(rv, rp, 0, 60); break;
                                case "spectators": Int(rv, rp, 0, 64); break;
                                case "lateJoin": Enum(rv, rp, "allow", "spectate", "refuse"); break;
                                case "seatDropped": Enum(rv, rp, "window", "immediate"); break;
                                case "rejoinWindowSeconds": Int(rv, rp, 0, 600); break;
                                default: RoomData(rv, rp); break;
                            }
                        });
                        break;
                    case "sync":
                        Object(v, "sync", Array.Empty<string>(), new[] { "mode", "tickRate", "hashEveryTicks", "player" }, (sk, sv) =>
                        {
                            var sp = "sync." + sk;
                            if (sk == "mode") Enum(sv, sp, "raw", "lockstep", "replication");
                            else if (sk == "tickRate") Int(sv, sp, 1, 120);
                            else if (sk == "player") PlayerStructure(sv);
                            else Int(sv, sp, 1, 100000);
                        });
                        break;
                    case "players":
                        Object(v, "players", Array.Empty<string>(), new[] { "identity", "maxNameLength" }, (pk, pv) =>
                        {
                            if (pk == "identity") Enum(pv, "players.identity", "name", "anonymous", "platform");
                            else Int(pv, "players.maxNameLength", 1, 24);
                        });
                        break;
                    case "chat":
                        Object(v, "chat", Array.Empty<string>(), new[] { "text", "voice", "voiceMode" }, (ck, cv) =>
                        {
                            if (ck == "voiceMode") Enum(cv, "chat.voiceMode", "pushToTalk", "voiceActivity");
                            else Bool(cv, "chat." + ck);
                        });
                        break;
                    case "session":
                        Object(v, "session", Array.Empty<string>(), new[] { "hostLeaves", "pause", "readyTimeoutMs", "peerTimeoutMs", "rateLimit", "runInBackground" }, (sk, sv) =>
                        {
                            var sp = "session." + sk;
                            switch (sk)
                            {
                                case "hostLeaves": Enum(sv, sp, "end", "migrate"); break;
                                case "pause": Enum(sv, sp, "off", "host", "anyone"); break;
                                case "readyTimeoutMs": Int(sv, sp, 0, 600000); break;
                                case "peerTimeoutMs":
                                    if (Int(sv, sp) != 0) Int(sv, sp, 6000, 600000);
                                    break;
                                case "rateLimit":
                                    Object(sv, sp, new[] { "messages", "perMs" }, new[] { "messages", "perMs" }, (rk, rv) => Int(rv, sp + "." + rk, 1));
                                    break;
                                default: Bool(sv, sp); break;
                            }
                        });
                        break;
                    case "platforms":
                        Object(v, "platforms", Array.Empty<string>(), new[] { "steam", "epic", "discord" }, (pk, pv) =>
                        {
                            var pp = "platforms." + pk;
                            if (pk == "discord") { Bool(pv, pp); return; }
                            if (pv.ValueKind == JsonValueKind.True || pv.ValueKind == JsonValueKind.False) return;
                            if (pk == "steam")
                                Object(pv, pp, Array.Empty<string>(), new[] { "appId" }, (_, av) => Int(av, pp + ".appId", 1));
                            else
                            {
                                if (pv.ValueKind != JsonValueKind.Object) throw Err(pp, "type", "must be true, false or an object");
                                foreach (var kv in pv.EnumerateObject()) if (kv.Name != "$comment") Str(kv.Value, pp + "." + kv.Name);
                            }
                        });
                        break;
                    case "ui":
                        Object(v, "ui", Array.Empty<string>(), new[] { "kind", "entry", "theme" }, (uk, uv) =>
                        {
                            if (uk == "kind") Enum(uv, "ui.kind", "drop-in", "generated", "none");
                            else if (uk == "entry") Str(uv, "ui.entry");
                            else Enum(uv, "ui.theme", "light", "dark", "auto");
                        });
                        break;
                    case "diagnostics":
                        Object(v, "diagnostics", Array.Empty<string>(), new[] { "reportToHost", "logSize", "relayProbe", "showConnectionCheck", "checkOnOpen" }, (dk, dv) =>
                        {
                            if (dk == "logSize") Int(dv, "diagnostics.logSize", 50, 5000);
                            else Bool(dv, "diagnostics." + dk);
                        });
                        break;
                }
            });
        }

        private static void RoomData(JsonElement v, string path)
        {
            if (v.ValueKind != JsonValueKind.Object) throw Err(path, "type", "must be an object of data declarations");
            var props = v.EnumerateObject().Where(p => p.Name != "$comment").ToList();
            if (props.Count > 16) throw Err(path, "length", "at most 16 keys");
            foreach (var p in props)
            {
                var kp = P(path, p.Name);
                if (!RoomRules.IsDataKey(p.Name)) throw Err(kp, "pattern", "key must match ^[a-z][a-z0-9_]{0,23}$");
                string type = "";
                long? min = null, max = null;
                string? dflt = null;
                var values = new List<string>();
                Object(p.Value, kp, new[] { "type" }, new[] { "type", "min", "max", "maxLength", "values", "default", "hostOnly" }, (dk, dv) =>
                {
                    var dp = P(kp, dk);
                    switch (dk)
                    {
                        case "type": type = Enum(dv, dp, "string", "int", "enum", "bool", "color"); break;
                        case "min": min = Int(dv, dp, -2147483647, 2147483647); break;
                        case "max": max = Int(dv, dp, -2147483647, 2147483647); break;
                        case "maxLength": Int(dv, dp, 1, 64); break;
                        case "values":
                            if (dv.ValueKind != JsonValueKind.Array) throw Err(dp, "type", "must be an array");
                            var i = 0;
                            foreach (var item in dv.EnumerateArray()) values.Add(Str(item, P(dp, (i++).ToString())));
                            break;
                        case "default": dflt = Str(dv, dp); break;
                        default: Bool(dv, dp); break;
                    }
                });
                if (type == "enum")
                {
                    if (values.Count == 0) throw Err(P(kp, "values"), "required", "an enum needs values");
                    if (values.Count > 16) throw Err(P(kp, "values"), "length", "at most 16 values");
                    for (var i = 0; i < values.Count; i++)
                        if (values[i].Length < 1 || values[i].Length > 32) throw Err(P(P(kp, "values"), i.ToString()), "length", "1 to 32 characters");
                }
                if (min is long a && max is long b && a > b) throw Err(kp, "min_gt_max", "min is more than max");
                if (!string.IsNullOrEmpty(dflt) && RoomRules.CheckDataValue(ReadDecl(p.Value), dflt!) == null)
                    throw Err(P(kp, "default"), "bad_default", "default fails its own type");
            }
        }

        private static DataDecl ReadDecl(JsonElement d)
        {
            var decl = RoomWire.ParseDecl(d);
            return decl with { Min = decl.Min ?? 0, Max = decl.Max ?? 255 };
        }

        // ---- defaults + model ------------------------------------------------------------------------------------------

        private static JsonElement? Sec(JsonElement o, string k) => o.TryGetProperty(k, out var v) ? v : (JsonElement?)null;
        private static bool B(JsonElement? o, string k, bool d) => o is { } e && e.TryGetProperty(k, out var v) ? v.GetBoolean() : d;
        private static int I(JsonElement? o, string k, int d) => o is { } e && e.TryGetProperty(k, out var v) ? (int)Int(v, k) : d;
        private static string S(JsonElement? o, string k, string d) => o is { } e && e.TryGetProperty(k, out var v) ? v.GetString()! : d;
        private static string? SN(JsonElement? o, string k) => o is { } e && e.TryGetProperty(k, out var v) ? v.GetString() : null;

        private static RoomSection BuildRoom(JsonElement? room, JsonElement? lobby)
        {
            var d = RoomSection.Defaults;
            var lobbyLate = B(lobby, "lateJoin", true);
            var data = new Dictionary<string, DataDecl>();
            if (room is { } r && r.TryGetProperty("data", out var dj))
                foreach (var p in dj.EnumerateObject()) if (p.Name != "$comment") data[p.Name] = RoomWire.ParseDecl(p.Value);
            return new RoomSection(B(room, "passwordRequired", false), RoomRules.ParseAutoStart(SN(room, "autoStart")), I(room, "autoStartPlayers", d.AutoStartPlayers),
                I(room, "minPlayers", d.MinPlayers), I(room, "countdownSeconds", d.CountdownSeconds), I(room, "spectators", d.Spectators),
                room is { } rl && rl.TryGetProperty("lateJoin", out var lj) ? RoomRules.ParseLateJoin(lj.GetString()) : lobbyLate ? LateJoinPolicy.Allow : LateJoinPolicy.Refuse,
                RoomRules.ParseSeatDropped(SN(room, "seatDropped")), I(room, "rejoinWindowSeconds", d.RejoinWindowSeconds), data);
        }

        private static PlayerSection BuildPlayer(JsonElement? sync)
        {
            var d = PlayerSection.Defaults;
            var p = sync is { } sy0 ? Sec(sy0, "player") : null;
            var lim = p is { } p0 ? Sec(p0, "limits") : null;
            int? L(string k) => lim is { } e && e.TryGetProperty(k, out var v) ? (int)Int(v, k) : (int?)null;
            var omit = new List<string>();
            if (p is { } pe && pe.TryGetProperty("omit", out var oa)) foreach (var o in oa.EnumerateArray()) omit.Add(o.GetString()!);
            return new PlayerSection(S(p, "authority", d.Authority), S(p, "space", d.Space), I(p, "range", d.Range), I(p, "velocityRange", d.VelocityRange),
                new PlayerLimits(L("maxSpeed"), L("maxStep"), L("minShotIntervalMs"), L("minMeleeIntervalMs")), omit);
        }

        internal static Blueprint Build(JsonElement root)
        {
            Structure(root);
            var engine = SN(root, "engine");
            var game = Sec(root, "game");
            var hosting = Sec(root, "hosting");
            var lobby = Sec(root, "lobby");
            var sync = Sec(root, "sync");
            var players = Sec(root, "players");
            var chat = Sec(root, "chat");
            var session = Sec(root, "session");
            var platforms = Sec(root, "platforms");
            var ui = Sec(root, "ui");
            var diag = Sec(root, "diagnostics");
            var roomJson = Sec(root, "room");

            var web = engine == "web";
            var tick = I(sync, "tickRate", 20);
            var origins = new List<string>();
            if (hosting is { } h && h.TryGetProperty("allowedOrigins", out var ao)) foreach (var o in ao.EnumerateArray()) origins.Add(o.GetString()!);
            List<string>? relays = null;
            if (hosting is { } h2 && h2.TryGetProperty("nostrRelays", out var nr))
            {
                relays = new List<string>();
                foreach (var o in nr.EnumerateArray()) relays.Add(o.GetString()!);
            }
            var meta = new Dictionary<string, string>();
            if (lobby is { } l && l.TryGetProperty("meta", out var m)) foreach (var kv in m.EnumerateObject()) meta[kv.Name] = kv.Value.GetString()!;
            RateLimit? rate = null;
            if (session is { } sj && sj.TryGetProperty("rateLimit", out var rl))
                rate = new RateLimit((int)rl.GetProperty("messages").GetInt64(), (int)rl.GetProperty("perMs").GetInt64());

            var steam = new SteamSetting(false, null);
            if (platforms is { } pj && pj.TryGetProperty("steam", out var st))
                steam = st.ValueKind == JsonValueKind.Object
                    ? new SteamSetting(true, st.TryGetProperty("appId", out var aid) ? (int)aid.GetInt64() : (int?)null)
                    : new SteamSetting(st.GetBoolean(), null);
            var epic = new EpicSetting(false, new Dictionary<string, string>());
            if (platforms is { } pe && pe.TryGetProperty("epic", out var ep))
            {
                if (ep.ValueKind == JsonValueKind.Object)
                {
                    var ids = new Dictionary<string, string>();
                    foreach (var kv in ep.EnumerateObject()) if (kv.Name != "$comment") ids[kv.Name] = kv.Value.GetString()!;
                    epic = new EpicSetting(true, ids);
                }
                else epic = new EpicSetting(ep.GetBoolean(), new Dictionary<string, string>());
            }

            var bp = new Blueprint(
                1,
                new GameSection(S(game, "id", ""), S(game, "netVersion", "1"), SN(game, "title")),
                engine,
                new HostingSection(B(hosting, "direct", !web), B(hosting, "server", web), S(hosting, "lobbyServer", ""),
                    I(hosting, "directPort", 47810), B(hosting, "openPort", true), B(hosting, "relayOnly", false), origins,
                    B(hosting, "nostr", true), relays),
                new LobbySection(I(lobby, "maxPlayers", 4), B(lobby, "listed", false), B(lobby, "approveJoins", false),
                    B(lobby, "password", false), B(lobby, "lateJoin", roomJson is { } rj0 && rj0.TryGetProperty("lateJoin", out var rl0) ? rl0.GetString() != "refuse" : true), B(lobby, "rejoin", true),
                    B(lobby, "joinLink", web || engine == "node-browser"), meta),
                new SyncSection(S(sync, "mode", "raw"), tick, I(sync, "hashEveryTicks", tick)) { Player = BuildPlayer(sync) },
                new PlayersSection(S(players, "identity", "name"), I(players, "maxNameLength", 24)),
                new ChatSection(B(chat, "text", true), B(chat, "voice", false), S(chat, "voiceMode", "pushToTalk")),
                new SessionSection(S(session, "hostLeaves", "end"), S(session, "pause", "off"), I(session, "readyTimeoutMs", 15000),
                    I(session, "peerTimeoutMs", 0), rate, B(session, "runInBackground", true)),
                new PlatformsSection(steam, epic, B(platforms, "discord", false)),
                new UiSection(S(ui, "kind", web || engine == "godot-gdscript" || engine == "godot-csharp" ? "drop-in" : "generated"), SN(ui, "entry"), S(ui, "theme", "auto")))
            {
                Room = BuildRoom(roomJson, lobby),
                Diagnostics = new DiagnosticsSection(B(diag, "reportToHost", true), I(diag, "logSize", NetLog.DefaultCapacity), B(diag, "relayProbe", true), B(diag, "showConnectionCheck", true), B(diag, "checkOnOpen", true)),
            };

            // cross-key rules (spec/blueprint.schema.json x-rules), in order
            if (!bp.Hosting.Direct && !bp.Hosting.Server)
                throw Err("hosting", "hosting_none", "at least one of direct, server must be true");
            if (bp.Lobby.Listed && bp.Lobby.ApproveJoins)
                throw Err("lobby", "listed_and_approve", "listed and approveJoins cannot both be true");
            if (web && bp.Hosting.Direct)
                throw Err("hosting.direct", "direct_needs_listener", "engine web cannot host direct (a browser cannot listen on a port)");
            if (sync is { } sy && sy.TryGetProperty("player", out _) && bp.Sync.Mode != "replication")
                throw Err("sync.player", "player_needs_replication", "sync.player needs sync.mode replication");
            if (bp.Sync.Mode == "replication" && bp.Session.HostLeaves == "migrate")
                throw Err("session.hostLeaves", "migrate_with_replication", "replication has no host migration; use end");
            var lateJoinGiven = lobby is { } lg && lg.TryGetProperty("lateJoin", out _);
            var roomLateGiven = roomJson is { } rg && rg.TryGetProperty("lateJoin", out _);
            if (roomLateGiven && lateJoinGiven && (bp.Lobby.LateJoin ? bp.Room.LateJoin == LateJoinPolicy.Refuse : bp.Room.LateJoin != LateJoinPolicy.Refuse))
                throw Err("room.lateJoin", "late_join_conflict", "lobby.lateJoin and room.lateJoin disagree");
            if (bp.Room.MinPlayers > bp.Lobby.MaxPlayers)
                throw Err("room.minPlayers", "min_exceeds_max", "more than lobby.maxPlayers");
            if (bp.Room.AutoStart == AutoStartMode.Players && bp.Room.AutoStartPlayers > bp.Lobby.MaxPlayers)
                throw Err("room.autoStartPlayers", "autostart_exceeds_players", "more than lobby.maxPlayers");
            if (bp.Session.HostLeaves == "migrate" && !bp.Hosting.Server)
                throw Err("session.hostLeaves", "migrate_needs_server", "migrate needs hosting.server (direct lobbies always end)");
            return bp;
        }
    }
}
