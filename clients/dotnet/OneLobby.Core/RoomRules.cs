using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace OneLobby
{
    public enum RoomRole { Player, Spectator }
    public enum RoomState { Lobby, Countdown, Started }
    /// <summary><c>Left</c> is never stored: it is the status an entry carries in <see cref="Room.PlayerLeft"/>.</summary>
    public enum RoomStatus { Connected, Reconnecting, Left }
    public enum LateJoinPolicy { Allow, Spectate, Refuse }
    public enum AutoStartMode { Off, AllReady, Players }
    public enum SeatDroppedPolicy { Window, Immediate }
    public enum RoomRequest { Start, Lobby, Rematch }
    public enum RoomFilterKind { Name, Chat }
    public enum DataType { String, Int, Enum, Bool, Color }

    /// <summary>Stable codes of the room layer (<c>nack.code</c>, <c>deny.code</c>, <see cref="OneLobbyException.Code"/>; spec/room.md s.3).</summary>
    public static class RoomErrorCodes
    {
        public const string BadValue = "bad_value";
        public const string UnknownKey = "unknown_key";
        public const string NotAllowed = "not_allowed";
        public const string TooLarge = "too_large";
        public const string RateLimited = "rate_limited";
        public const string WrongState = "wrong_state";
        public const string NotEnoughPlayers = "not_enough_players";
        public const string LobbyFull = "lobby_full";
        public const string SpectatorsFull = "spectators_full";
        public const string InGame = "in_game";
        public const string Banned = "banned";
        public const string BadPassword = "bad_password";
        public const string Kicked = "kicked";
        public const string Disconnected = "disconnected";
        public const string RoomUnsupported = "room_unsupported";
        public const string PasswordRequired = "password_required";
        /// <summary>The removal code of a declined join request.</summary>
        public const string Denied = "denied";
    }

    /// <summary>One declaration of a per-player data key (spec/room.md s.4.2, <c>room.data</c> in onelobby.json).</summary>
    public sealed record DataDecl(DataType Type)
    {
        public int? Min { get; init; }
        public int? Max { get; init; }
        public int? MaxLength { get; init; }
        public IReadOnlyList<string>? Values { get; init; }
        public string? Default { get; init; }
        public bool HostOnly { get; init; }
    }

    /// <summary>One roster row as the room replicates it (spec/room.md s.1). A snapshot: it does not change after you got it.</summary>
    public sealed record RoomEntry(int Id, string Name, RoomRole Role, int Seat, bool Ready, RoomStatus Status,
        IReadOnlyDictionary<string, string> Data, bool Legacy = false);

    /// <summary>The settings a room runs with (the host's; every peer gets them in the snapshot).</summary>
    public sealed record RoomSettings(int MaxPlayers, int Spectators, int MinPlayers, AutoStartMode AutoStart, int AutoStartPlayers,
        int CountdownMs, LateJoinPolicy LateJoin, SeatDroppedPolicy SeatDropped, int RejoinWindowMs, int MaxNameLength,
        IReadOnlyDictionary<string, DataDecl> Data);

    /// <summary>What a host sets in code or in <c>onelobby.json</c> (<c>room</c>); every property is optional.</summary>
    public sealed class RoomOptions
    {
        public AutoStartMode? AutoStart { get; set; }
        public int? AutoStartPlayers { get; set; }
        public int? MinPlayers { get; set; }
        public int? CountdownSeconds { get; set; }
        /// <summary>Spectator cap (not counted in <c>MaxPlayers</c>); 0 or null turns spectating off.</summary>
        public int? Spectators { get; set; }
        public LateJoinPolicy? LateJoin { get; set; }
        public SeatDroppedPolicy? SeatDropped { get; set; }
        public int? RejoinWindowSeconds { get; set; }
        /// <summary><c>HostAsync</c> fails with <c>password_required</c> when no password is given.</summary>
        public bool? PasswordRequired { get; set; }
        /// <summary>Longest effective name, at most 24.</summary>
        public int? MaxNameLength { get; set; }
        /// <summary>Per-player data keys beyond the built-ins <c>color</c>, <c>avatar</c> and <c>team</c>.</summary>
        public IReadOnlyDictionary<string, DataDecl>? Data { get; set; }

        /// <summary>This set of options with <paramref name="over"/> on top (its set properties win; data keys are merged).</summary>
        public RoomOptions Merge(RoomOptions? over)
        {
            var r = new RoomOptions
            {
                AutoStart = AutoStart, AutoStartPlayers = AutoStartPlayers, MinPlayers = MinPlayers, CountdownSeconds = CountdownSeconds,
                Spectators = Spectators, LateJoin = LateJoin, SeatDropped = SeatDropped, RejoinWindowSeconds = RejoinWindowSeconds,
                PasswordRequired = PasswordRequired, MaxNameLength = MaxNameLength, Data = Data,
            };
            if (over == null) return r;
            r.AutoStart = over.AutoStart ?? r.AutoStart;
            r.AutoStartPlayers = over.AutoStartPlayers ?? r.AutoStartPlayers;
            r.MinPlayers = over.MinPlayers ?? r.MinPlayers;
            r.CountdownSeconds = over.CountdownSeconds ?? r.CountdownSeconds;
            r.Spectators = over.Spectators ?? r.Spectators;
            r.LateJoin = over.LateJoin ?? r.LateJoin;
            r.SeatDropped = over.SeatDropped ?? r.SeatDropped;
            r.RejoinWindowSeconds = over.RejoinWindowSeconds ?? r.RejoinWindowSeconds;
            r.PasswordRequired = over.PasswordRequired ?? r.PasswordRequired;
            r.MaxNameLength = over.MaxNameLength ?? r.MaxNameLength;
            if (over.Data != null)
            {
                var d = new Dictionary<string, DataDecl>(r.Data ?? new Dictionary<string, DataDecl>());
                foreach (var kv in over.Data) d[kv.Key] = kv.Value;
                r.Data = d;
            }
            return r;
        }
    }

    /// <summary>What a joiner brings: its role, starting data and the password it knows.</summary>
    public sealed class RoomJoinOptions
    {
        public RoomRole Role { get; set; } = RoomRole.Player;
        public IReadOnlyDictionary<string, string>? Data { get; set; }
        public string? Password { get; set; }
    }

    /// <summary>Host: changes some settings for everyone with <see cref="Room.Configure"/>; unset properties stay.</summary>
    public sealed class RoomSettingsChange
    {
        public AutoStartMode? AutoStart { get; set; }
        public int? AutoStartPlayers { get; set; }
        public int? MinPlayers { get; set; }
        public int? CountdownMs { get; set; }
        public LateJoinPolicy? LateJoin { get; set; }
        public SeatDroppedPolicy? SeatDropped { get; set; }
        public int? RejoinWindowMs { get; set; }
    }

    /// <summary>Why this peer was removed from the lobby (spec/room.md s.5.1).</summary>
    public sealed record RemovalInfo(string Code, string Reason, bool Ban);

    public sealed record SeatDroppedInfo(int Seat, int PeerId, string Name, IReadOnlyDictionary<string, string> Data, string Reason, bool AfterWindow);
    public sealed record SeatRestoredInfo(int Seat, int PeerId, string Name, bool Returning);

    /// <summary>One ban (spec/room.md s.5.3). <c>At</c> is unix milliseconds.</summary>
    public sealed record BanEntry(string? Id, string? Ip, string? Name, string? Reason, string? Code, long At);

    /// <summary>The pure rules of the room layer (spec/room.md): names, per-player data, seats, bans, auto start, admission. No I/O.</summary>
    internal static class RoomRules
    {
        // ---- names (4.1) ---------------------------------------------------------------------------------------------

        private static bool IsStrip(char c) =>
            c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e)
            || (c >= 0x2066 && c <= 0x2069) || c == 0xfeff;

        private static bool IsSpace(char c) =>
            c == 0x20 || c == 0xa0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a) || c == 0x202f || c == 0x205f || c == 0x3000;

        /// <summary>Steps 1-2: strip control, bidi and zero-width characters, collapse whitespace runs to one space, trim.</summary>
        public static string CleanText(string? s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder(s!.Length);
            var space = false;
            foreach (var c in s)
            {
                if (IsStrip(c)) continue;
                if (IsSpace(c)) { space = true; continue; }
                if (space && sb.Length > 0) sb.Append(' ');
                space = false;
                sb.Append(c);
            }
            return sb.ToString();
        }

        public static int CodePointLength(string s)
        {
            var n = 0;
            for (var i = 0; i < s.Length; i++)
            {
                if (char.IsHighSurrogate(s[i]) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) i++;
                n++;
            }
            return n;
        }

        /// <summary><paramref name="s"/> cut to at most <paramref name="n"/> code points.</summary>
        public static string ClampCodePoints(string s, int n)
        {
            var count = 0;
            for (var i = 0; i < s.Length; i++)
            {
                if (count == n) return s.Substring(0, i);
                if (char.IsHighSurrogate(s[i]) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) i++;
                count++;
            }
            return s;
        }

        /// <summary>Runs a filter hook; a hook that throws or returns null counts as no hook.</summary>
        public static string ApplyFilter(Func<string, RoomFilterKind, string>? filter, string text, RoomFilterKind kind)
        {
            if (filter == null) return text;
            try { return filter(text, kind) ?? text; }
            catch (Exception) { return text; }
        }

        /// <summary>Steps 1-5 of the name rules (no dedupe). <paramref name="peerId"/> makes the default <c>Player N</c>.</summary>
        public static string BaseName(string? input, int peerId, int maxLength = 24, Func<string, RoomFilterKind, string>? filter = null)
        {
            var max = Math.Max(1, Math.Min(24, maxLength));
            var n = ClampCodePoints(CleanText(input), max);
            if (filter != null) n = ClampCodePoints(CleanText(ApplyFilter(filter, n, RoomFilterKind.Name)), max);
            if (n.Length == 0 || n == "Player") n = "Player " + peerId.ToString(CultureInfo.InvariantCulture);
            return n;
        }

        /// <summary>Step 6: <paramref name="name"/> made unique among <paramref name="others"/> (case-insensitive).</summary>
        public static string DedupeName(string name, IEnumerable<string> others, int maxLength = 24)
        {
            var max = Math.Max(1, Math.Min(24, maxLength));
            var taken = new HashSet<string>(others.Select(o => o.ToLowerInvariant()));
            if (!taken.Contains(name.ToLowerInvariant())) return name;
            for (var i = 2; ; i++)
            {
                var suffix = " " + i.ToString(CultureInfo.InvariantCulture);
                var cand = ClampCodePoints(name, Math.Max(1, max - suffix.Length)).TrimEnd(' ') + suffix;
                if (!taken.Contains(cand.ToLowerInvariant())) return cand;
            }
        }

        public static string EffectiveName(string? input, int peerId, IEnumerable<string> others, int maxLength = 24, Func<string, RoomFilterKind, string>? filter = null) =>
            DedupeName(BaseName(input, peerId, maxLength, filter), others, maxLength);

        // ---- reasons and codes (5.1) -----------------------------------------------------------------------------------

        public static readonly IReadOnlyDictionary<string, string> DefaultReasons = new Dictionary<string, string>
        {
            ["kicked"] = "The host removed you from the game.",
            ["denied"] = "The host did not let you in.",
            ["disconnected"] = "The host disconnected you.",
            ["banned"] = "You are banned from this game.",
            ["bad_password"] = "Wrong password.",
            ["lobby_full"] = "The game is full.",
            ["spectators_full"] = "No spectator seats are free.",
            ["in_game"] = "The game has already started.",
        };

        private const string FallbackReason = "You were removed from the game.";
        public const int ReasonMax = 120;

        public static bool IsCode(string? s)
        {
            if (string.IsNullOrEmpty(s) || s!.Length > 32 || s[0] < 'a' || s[0] > 'z') return false;
            foreach (var c in s) if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) return false;
            return true;
        }

        /// <summary>The plain sentence for a removal: the host's text when it has one, else the default of the code.</summary>
        public static string RemovalReason(string code, string? text = null)
        {
            var t = ClampCodePoints(CleanText(text), ReasonMax);
            if (t.Length > 0) return t;
            return DefaultReasons.TryGetValue(code, out var d) ? d : FallbackReason;
        }

        // ---- player id and addresses -----------------------------------------------------------------------------------

        public static bool IsPlayerId(string? s)
        {
            if (s == null || s.Length != 32) return false;
            foreach (var c in s) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
            return true;
        }

        private const string HexDigits = "0123456789abcdef";

        /// <summary>A fresh player id: 16 random bytes as 32 lower-case hex characters.</summary>
        public static string NewPlayerId()
        {
            var b = new byte[16];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(b);
            var sb = new StringBuilder(32);
            foreach (var x in b) sb.Append(HexDigits[x >> 4]).Append(HexDigits[x & 15]);
            return sb.ToString();
        }

        /// <summary>Lower-case; an IPv4-mapped IPv6 address becomes its IPv4 form.</summary>
        public static string NormalizeIp(string? ip)
        {
            var s = (ip ?? "").Trim().ToLowerInvariant();
            if (s.StartsWith("::ffff:", StringComparison.Ordinal))
            {
                var rest = s.Substring(7);
                var parts = rest.Split('.');
                if (parts.Length == 4 && parts.All(p => p.Length > 0 && p.All(ch => ch >= '0' && ch <= '9'))) return rest;
            }
            return s;
        }

        public static bool IsLoopbackIp(string? ip)
        {
            var s = NormalizeIp(ip);
            return s == "::1" || s.StartsWith("127.", StringComparison.Ordinal) || s == "localhost";
        }

        // ---- bans (5.3) ----------------------------------------------------------------------------------------------------

        /// <summary>Whether <paramref name="entry"/> bans the candidate: equal ids, or equal addresses when at least one side has no id.</summary>
        public static bool BanMatches(BanEntry entry, string? id, string? ip)
        {
            if (!string.IsNullOrEmpty(entry.Id) && !string.IsNullOrEmpty(id)) return entry.Id == id;
            if (!string.IsNullOrEmpty(entry.Ip) && !string.IsNullOrEmpty(ip) && (string.IsNullOrEmpty(entry.Id) || string.IsNullOrEmpty(id)))
                return NormalizeIp(entry.Ip) == NormalizeIp(ip);
            return false;
        }

        // ---- per-player data (4.2) --------------------------------------------------------------------------------------

        public const int DataMaxBytes = 1024;

        public static readonly IReadOnlyDictionary<string, DataDecl> BuiltinData = new Dictionary<string, DataDecl>
        {
            ["color"] = new DataDecl(DataType.Color),
            ["avatar"] = new DataDecl(DataType.Int) { Min = 0, Max = 255, Default = "0" },
            ["team"] = new DataDecl(DataType.Int) { Min = 0, Max = 15, Default = "0" },
        };

        public static bool IsDataKey(string? k)
        {
            if (string.IsNullOrEmpty(k) || k!.Length > 24 || k[0] < 'a' || k[0] > 'z') return false;
            foreach (var c in k) if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) return false;
            return true;
        }

        /// <summary>The built-ins with the game's declarations on top (a declaration of the same key replaces it).</summary>
        public static IReadOnlyDictionary<string, DataDecl> MergeDataSpec(IReadOnlyDictionary<string, DataDecl>? custom)
        {
            var d = new Dictionary<string, DataDecl>(BuiltinData);
            if (custom != null) foreach (var kv in custom) d[kv.Key] = kv.Value;
            return d;
        }

        /// <summary>One value against its declaration: the stored text, or null when invalid. "" (unset) is always valid.</summary>
        public static string? CheckDataValue(DataDecl decl, string value)
        {
            if (value == null) return null;
            if (value.Length == 0) return "";
            switch (decl.Type)
            {
                case DataType.String:
                {
                    var v = CleanText(value);
                    return CodePointLength(v) <= Math.Min(64, decl.MaxLength ?? 32) ? v : null;
                }
                case DataType.Int:
                {
                    var neg = value[0] == '-';
                    var digits = neg ? value.Substring(1) : value;
                    if (digits.Length == 0 || digits.Length > 11 || digits.Any(c => c < '0' || c > '9')) return null;
                    if (digits.Length > 1 && digits[0] == '0') return null;
                    if (neg && digits == "0") return null;
                    var n = long.Parse(digits, CultureInfo.InvariantCulture) * (neg ? -1 : 1);
                    if (Math.Abs(n) > 2147483647) return null;
                    return n >= (decl.Min ?? 0) && n <= (decl.Max ?? 255) ? value : null;
                }
                case DataType.Enum:
                    return decl.Values != null && decl.Values.Contains(value) ? value : null;
                case DataType.Bool:
                    return value == "true" || value == "false" ? value : null;
                case DataType.Color:
                    if (value.Length != 7 || value[0] != '#') return null;
                    for (var i = 1; i < 7; i++) if (!Uri.IsHexDigit(value[i])) return null;
                    return value.ToLowerInvariant();
                default:
                    return null;
            }
        }

        public readonly struct DataResult
        {
            public readonly bool Ok;
            public readonly Dictionary<string, string>? Data;
            public readonly string Code;
            public readonly string? Key;
            private DataResult(bool ok, Dictionary<string, string>? data, string code, string? key) { Ok = ok; Data = data; Code = code; Key = key; }
            public static DataResult Good(Dictionary<string, string> data) => new DataResult(true, data, "", null);
            public static DataResult Fail(string code, string? key = null) => new DataResult(false, null, code, key);
        }

        /// <summary>Applies <paramref name="set"/> to <paramref name="before"/> under <paramref name="spec"/>, atomically. A null value is a non-string (bad_value).</summary>
        public static DataResult ApplyData(IReadOnlyDictionary<string, DataDecl> spec, IReadOnlyDictionary<string, string> before,
            IEnumerable<KeyValuePair<string, string?>> set, bool byHost)
        {
            var next = new Dictionary<string, string>(before);
            foreach (var kv in set)
            {
                if (!IsDataKey(kv.Key) || !spec.TryGetValue(kv.Key, out var decl)) return DataResult.Fail(RoomErrorCodes.UnknownKey, kv.Key);
                if (decl.HostOnly && !byHost) return DataResult.Fail(RoomErrorCodes.NotAllowed, kv.Key);
                var v = kv.Value == null ? null : CheckDataValue(decl, kv.Value);
                if (v == null) return DataResult.Fail(RoomErrorCodes.BadValue, kv.Key);
                if (v.Length == 0) next.Remove(kv.Key);
                else next[kv.Key] = v;
            }
            if (JsonBytes(next) > DataMaxBytes) return DataResult.Fail(RoomErrorCodes.TooLarge);
            return DataResult.Good(next);
        }

        /// <summary>UTF-8 size of the JSON text of a string map, counted the way JS <c>JSON.stringify</c> writes it.</summary>
        private static int JsonBytes(IReadOnlyDictionary<string, string> d)
        {
            var n = 2;
            var first = true;
            foreach (var kv in d)
            {
                if (!first) n++;
                first = false;
                n += StringBytes(kv.Key) + 1 + StringBytes(kv.Value);
            }
            return n;
        }

        private static int StringBytes(string s)
        {
            var n = 2;
            for (var i = 0; i < s.Length; i++)
            {
                var c = s[i];
                if (c == '"' || c == '\\' || c == '\b' || c == '\f' || c == '\n' || c == '\r' || c == '\t') n += 2;
                else if (c < 0x20) n += 6;
                else if (c < 0x80) n += 1;
                else if (c < 0x800) n += 2;
                else if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) { n += 4; i++; }
                else if (char.IsSurrogate(c)) n += 6; // a lone surrogate is escaped
                else n += 3;
            }
            return n;
        }

        /// <summary>The declared defaults, applied at admission to the keys a player did not set.</summary>
        public static Dictionary<string, string> DataDefaults(IReadOnlyDictionary<string, DataDecl> spec, IReadOnlyDictionary<string, string> data)
        {
            var o = new Dictionary<string, string>(data);
            foreach (var kv in spec)
                if (!string.IsNullOrEmpty(kv.Value.Default) && !o.ContainsKey(kv.Key)) o[kv.Key] = kv.Value.Default!;
            return o;
        }

        // ---- seats (4.3) ----------------------------------------------------------------------------------------------------

        public readonly struct SeatChoice
        {
            public readonly int Seat;
            public readonly bool Returning;
            public readonly string? TakeOver;
            public SeatChoice(int seat, bool returning, string? takeOver = null) { Seat = seat; Returning = returning; TakeOver = takeOver; }
        }

        /// <summary>
        /// The seat for a player entering. <paramref name="held"/>: seats of connected or reconnecting players. <paramref name="memory"/>:
        /// <c>pid -&gt; seat</c> of everyone the host remembers (the caller drops <c>TakeOver</c>). Seat -1 when every seat is held.
        /// </summary>
        public static SeatChoice ChooseSeat(int maxPlayers, ISet<int> held, IReadOnlyDictionary<string, int> memory, string pid)
        {
            if (pid.Length > 0 && memory.TryGetValue(pid, out var mine) && mine >= 0 && mine < maxPlayers && !held.Contains(mine))
                return new SeatChoice(mine, true);
            var others = new Dictionary<int, string>();
            foreach (var kv in memory) if (kv.Key != pid) others[kv.Value] = kv.Key;
            for (var s = 0; s < maxPlayers; s++) if (!held.Contains(s) && !others.ContainsKey(s)) return new SeatChoice(s, false);
            for (var s = 0; s < maxPlayers; s++)
                if (!held.Contains(s)) return new SeatChoice(s, false, others.TryGetValue(s, out var o) ? o : null);
            return new SeatChoice(-1, false);
        }

        // ---- auto start (4.5) -----------------------------------------------------------------------------------------

        public readonly struct StartPlayer
        {
            public readonly RoomRole Role;
            public readonly RoomStatus Status;
            public readonly bool Ready, Legacy;
            public StartPlayer(RoomRole role, RoomStatus status, bool ready, bool legacy) { Role = role; Status = status; Ready = ready; Legacy = legacy; }
            /// <summary>Players that count for starting: role player, connected, not legacy.</summary>
            public bool Eligible => Role == RoomRole.Player && Status == RoomStatus.Connected && !Legacy;
        }

        /// <summary>True when the auto-start condition holds now (the caller checks the state is lobby).</summary>
        public static bool AutoStartHolds(AutoStartMode mode, int autoStartPlayers, int minPlayers, IReadOnlyList<StartPlayer> players)
        {
            if (mode == AutoStartMode.Off) return false;
            var eligible = players.Where(p => p.Eligible).ToList();
            if (mode == AutoStartMode.Players) return eligible.Count >= Math.Max(Math.Max(autoStartPlayers, minPlayers), 1);
            var reconnecting = players.Any(p => p.Role == RoomRole.Player && p.Status == RoomStatus.Reconnecting && !p.Legacy);
            return !reconnecting && eligible.Count >= Math.Max(minPlayers, 1) && eligible.All(p => p.Ready);
        }

        // ---- countdown time base (4.5) --------------------------------------------------------------------------------

        public const int MaxOneWayMs = 2000;

        /// <summary>Milliseconds from now until the countdown ends for a receiver that got <paramref name="left"/> and measured <paramref name="rtt"/> (null = none).</summary>
        public static int CountdownRemaining(int left, int? rtt)
        {
            var oneWay = Math.Min(MaxOneWayMs, Math.Max(0, (rtt ?? 0) / 2.0));
            return (int)Math.Max(0, Math.Round(left - oneWay, MidpointRounding.AwayFromZero));
        }

        // ---- admission (4.8) --------------------------------------------------------------------------------------------

        public readonly struct Admission
        {
            public readonly bool Ok;
            public readonly RoomRole Role;
            public readonly string Code;
            private Admission(bool ok, RoomRole role, string code) { Ok = ok; Role = role; Code = code; }
            public static Admission Yes(RoomRole role) => new Admission(true, role, "");
            public static Admission No(string code) => new Admission(false, RoomRole.Player, code);
        }

        /// <summary>The order of checks on a <c>join</c>: banned, password, late join, capacity.</summary>
        public static Admission Admit(bool banned, bool hasPassword, bool passwordOk, RoomState state, LateJoinPolicy lateJoin, RoomRole role,
            int players, int maxPlayers, int spectators, int spectatorCap)
        {
            if (banned) return Admission.No(RoomErrorCodes.Banned);
            if (hasPassword && !passwordOk) return Admission.No(RoomErrorCodes.BadPassword);
            if (state == RoomState.Started)
            {
                if (lateJoin == LateJoinPolicy.Refuse) return Admission.No(RoomErrorCodes.InGame);
                if (lateJoin == LateJoinPolicy.Spectate) role = RoomRole.Spectator;
            }
            if (role == RoomRole.Player && players >= maxPlayers) return Admission.No(RoomErrorCodes.LobbyFull);
            if (role == RoomRole.Spectator && spectators >= spectatorCap) return Admission.No(RoomErrorCodes.SpectatorsFull);
            return Admission.Yes(role);
        }

        /// <summary>Constant-time string comparison (length is not hidden; passwords are at most 64 characters).</summary>
        public static bool SafeEqual(string a, string b)
        {
            var x = Encoding.UTF8.GetBytes(a);
            var y = Encoding.UTF8.GetBytes(b);
            var d = x.Length ^ y.Length;
            var n = Math.Max(x.Length, y.Length);
            for (var i = 0; i < n; i++) d |= (i < x.Length ? x[i] : 0) ^ (i < y.Length ? y[i] : 0);
            return d == 0;
        }

        // ---- names of enum values on the wire -----------------------------------------------------------------------

        public static string Name(RoomRole r) => r == RoomRole.Spectator ? "spectator" : "player";
        public static string Name(RoomState s) => s == RoomState.Countdown ? "countdown" : s == RoomState.Started ? "started" : "lobby";
        public static string Name(RoomStatus s) => s == RoomStatus.Reconnecting ? "reconnecting" : s == RoomStatus.Left ? "left" : "connected";
        public static string Name(LateJoinPolicy p) => p == LateJoinPolicy.Refuse ? "refuse" : p == LateJoinPolicy.Spectate ? "spectate" : "allow";
        public static string Name(AutoStartMode m) => m == AutoStartMode.AllReady ? "all_ready" : m == AutoStartMode.Players ? "players" : "off";
        public static string Name(SeatDroppedPolicy p) => p == SeatDroppedPolicy.Immediate ? "immediate" : "window";
        public static string Name(RoomRequest r) => r == RoomRequest.Rematch ? "rematch" : r == RoomRequest.Lobby ? "lobby" : "start";
        public static string Name(DataType t) => t switch { DataType.Int => "int", DataType.Enum => "enum", DataType.Bool => "bool", DataType.Color => "color", _ => "string" };

        public static RoomRole ParseRole(string? s) => s == "spectator" ? RoomRole.Spectator : RoomRole.Player;
        public static bool TryRole(string? s, out RoomRole r) { r = s == "spectator" ? RoomRole.Spectator : RoomRole.Player; return s == "player" || s == "spectator"; }
        public static RoomState ParseState(string? s) => s == "countdown" ? RoomState.Countdown : s == "started" ? RoomState.Started : RoomState.Lobby;
        public static RoomStatus ParseStatus(string? s) => s == "reconnecting" ? RoomStatus.Reconnecting : RoomStatus.Connected;
        public static LateJoinPolicy ParseLateJoin(string? s) => s == "refuse" ? LateJoinPolicy.Refuse : s == "spectate" ? LateJoinPolicy.Spectate : LateJoinPolicy.Allow;
        public static AutoStartMode ParseAutoStart(string? s) => s == "all_ready" ? AutoStartMode.AllReady : s == "players" ? AutoStartMode.Players : AutoStartMode.Off;
        public static SeatDroppedPolicy ParseSeatDropped(string? s) => s == "immediate" ? SeatDroppedPolicy.Immediate : SeatDroppedPolicy.Window;
        public static DataType ParseDataType(string? s) => s switch { "int" => DataType.Int, "enum" => DataType.Enum, "bool" => DataType.Bool, "color" => DataType.Color, _ => DataType.String };
    }
}
