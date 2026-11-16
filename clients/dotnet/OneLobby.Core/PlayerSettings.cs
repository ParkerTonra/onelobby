using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace OneLobby
{
    /// <summary>The four player settings (spec/settings.md); an empty string is "none".</summary>
    public sealed record SettingsValues(string Name, string Relay, string LastCode, string Server)
    {
        public static readonly SettingsValues Empty = new("", "", "", "");
    }

    /// <summary>Which saved settings the client applies as defaults (spec/settings.md s.5). All on; each can be switched off.</summary>
    public sealed record SettingsOptions
    {
        /// <summary>Use the saved name when the game gives none (empty or the default "Player").</summary>
        public bool Name { get; init; } = true;
        /// <summary>Add the saved relay line to this player's ICE list.</summary>
        public bool Relay { get; init; } = true;
        /// <summary>Use the saved lobby server when neither the call nor onelobby.json gives one.</summary>
        public bool Server { get; init; } = true;
        /// <summary>Save the code after a successful host or join.</summary>
        public bool LastCode { get; init; } = true;
        /// <summary>Every default off.</summary>
        public static SettingsOptions None => new() { Name = false, Relay = false, Server = false, LastCode = false };
    }

    /// <summary>The result of <see cref="PlayerSettings.Save"/>: the fields that did not clean were not written (never their text).</summary>
    public sealed record SaveResult(bool Ok, IReadOnlyList<string> Rejected);

    /// <summary>The cleaning, validation and masking rules of the player settings (spec/settings.md s.1 and s.4). Pure functions.</summary>
    public static class SettingsRules
    {
        /// <summary>The environment variable that overrides each setting for one run (spec/settings.md s.3).</summary>
        public static readonly IReadOnlyDictionary<string, string> EnvNames = new Dictionary<string, string>
        {
            ["name"] = "ONELOBBY_NAME", ["relay"] = "ONELOBBY_RELAY", ["lastCode"] = "ONELOBBY_LAST_CODE", ["server"] = "ONELOBBY_LOBBY_SERVER",
        };

        /// <summary>What a masked relay shows in place of the user name and the credential (spec/diagnostics.md s.6).</summary>
        public const string Hidden = "<hidden>";

        /// <summary>The fixed warning for a saved relay line that does not parse. It never holds the line.</summary>
        public const string RelaySkippedWarning = "The saved relay line is not valid, so it is not used.";

        public static readonly string[] Fields = { "name", "relay", "lastCode", "server" };

        /// <summary>Name rules steps 1-3 (spec/room.md s.4.1); exactly <c>Player</c> counts as no name.</summary>
        public static string CleanName(string? input, int maxLength = 24)
        {
            if (input == null) return "";
            var n = RoomRules.ClampCodePoints(RoomRules.CleanText(input), Math.Max(1, Math.Min(24, maxLength)));
            return n == "Player" ? "" : n;
        }

        /// <summary>The relay line trimmed, or null when it is not empty and <see cref="TurnLogin.TryParse"/> rejects it.</summary>
        public static string? CleanRelay(string? input)
        {
            if (input == null) return null;
            var t = input.Trim();
            if (t.Length == 0) return "";
            return TurnLogin.TryParse(t, out _, out _) ? t : null;
        }

        /// <summary>A lobby code (6 characters) or direct join code (11) the way a pasted code is cleaned, or null.</summary>
        public static string? CleanLastCode(string? input)
        {
            if (input == null) return null;
            var t = input.Trim();
            if (t.Length == 0) return "";
            return Crockford.Normalize(t) ?? JoinCode.Normalize(t);
        }

        private static readonly Regex Placeholder = new(@"your[-_ ]?(lobby[-_ ]?)?server|replace[-_ ]?me|<|>", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Regex HttpScheme = new(@"^https?://", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Regex WsScheme = new(@"^wss?://", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Regex Authority = new(@"^wss?://(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]*)(?::(\d*))?(?:[/?#]|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Regex HostChars = new(@"^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)$", RegexOptions.CultureInvariant);
        private static readonly Regex DocHost = new(@"(^|\.)example\.(com|net|org)$|\.example$", RegexOptions.CultureInvariant);

        /// <summary>The lobby server address as a ws(s) URL (the <c>&lt;one-lobby server&gt;</c> rule plus a port check), "" for none, or null.</summary>
        public static string? CleanServer(string? input)
        {
            if (input == null) return null;
            var t = input.Trim();
            if (t.Length == 0) return "";
            if (t.Any(char.IsWhiteSpace) || Placeholder.IsMatch(t)) return null;
            var url = t;
            if (HttpScheme.IsMatch(url)) url = "ws" + url.Substring(4);
            else if (!WsScheme.IsMatch(url)) url = "wss://" + url;
            var m = Authority.Match(url);
            if (!m.Success) return null;
            var host = m.Groups[1].Value;
            if (!HostChars.IsMatch(host)) return null;
            if (m.Groups[2].Success)
            {
                var p = m.Groups[2].Value;
                if (p.Length == 0 || p.Length > 5 || !int.TryParse(p, out var port) || port < 1 || port > 65535) return null;
            }
            var h = host.ToLowerInvariant();
            if (DocHost.IsMatch(h) || h == "example") return null;
            if (!h.Contains('.') && !h.Contains(':') && h != "localhost") return null;
            return url;
        }

        /// <summary>The cleaner of a field by name; null = invalid.</summary>
        public static string? Clean(string field, string? input) => field switch
        {
            "name" => CleanName(input),
            "relay" => CleanRelay(input),
            "lastCode" => CleanLastCode(input),
            "server" => CleanServer(input),
            _ => null,
        };

        /// <summary>
        /// The relay line for showing in a settings field: the URLs stay readable, the user name and the credential are
        /// <c>&lt;hidden&gt;</c>. Empty stays empty; a line that does not parse is <c>&lt;hidden&gt;</c> whole.
        /// </summary>
        public static string MaskRelay(string? line)
        {
            var t = (line ?? "").Trim();
            if (t.Length == 0) return "";
            if (!TurnLogin.TryParse(t, out var e, out _)) return Hidden;
            var parts = new List<string> { string.Join(",", e!.Urls) };
            if (!string.IsNullOrEmpty(e.Username)) parts.Add(Hidden);
            if (!string.IsNullOrEmpty(e.Credential)) parts.Add(Hidden);
            return string.Join(" ", parts);
        }

        /// <summary>The ICE entry for a relay line, or null when it is empty or invalid.</summary>
        public static IceServer? RelayEntry(string? line)
        {
            var t = (line ?? "").Trim();
            return t.Length > 0 && TurnLogin.TryParse(t, out var e, out _) ? e : null;
        }

        /// <summary><c>user:pass@</c> dropped from an address before it goes in a log.</summary>
        public static string RedactUrl(string url) => Regex.Replace(url, @"^([a-z][a-z0-9+.-]*://)[^/?#]*@", "$1", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }

    /// <summary>
    /// The player's own multiplayer settings (spec/settings.md): name, relay line, last join code and lobby server, kept in an
    /// <see cref="IKeyValueStore"/> under <c>onelobby.settings.&lt;gameId&gt;</c> with the environment on top
    /// (<c>ONELOBBY_NAME</c>, <c>ONELOBBY_RELAY</c>, <c>ONELOBBY_LAST_CODE</c>, <c>ONELOBBY_LOBBY_SERVER</c>). A
    /// <see cref="LobbyClient"/> applies them as defaults; <c>client.Settings</c> is the object a settings menu edits.
    /// <code>
    /// client.Settings.Save(name: "Sam", relay: field.Text);          // Rejected lists a field that did not clean
    /// field.Text = client.Settings.MaskedRelay();                     // turn:relay.example.com:3478 &lt;hidden&gt; &lt;hidden&gt;
    /// </code>
    /// </summary>
    public sealed class PlayerSettings
    {
        /// <summary>An environment reader that finds nothing (settings from the store only).</summary>
        public static readonly Func<string, string?> NoEnvironment = _ => null;

        private readonly IKeyValueStore _store;
        private readonly string _key;
        private readonly Func<string, string?> _env;
        private string? _lastWritten;
        private bool _writeFailed;

        /// <summary>The store key of a game's settings (same as JS).</summary>
        public static string Key(string gameId) => "onelobby.settings." + gameId;

        /// <param name="gameId">The game id the settings belong to.</param>
        /// <param name="store">null: memory (the settings last one process).</param>
        /// <param name="env">Reads the overriding variables; default <see cref="Environment.GetEnvironmentVariable(string)"/>; <see cref="NoEnvironment"/> reads none.</param>
        public PlayerSettings(IKeyValueStore? store, string gameId, Func<string, string?>? env = null)
        {
            _store = store ?? KeyValueStores.Memory();
            _key = Key(gameId);
            _env = env ?? (n => Environment.GetEnvironmentVariable(n));
        }

        private string? RawText()
        {
            if (_writeFailed) return _lastWritten;
            try { return _store.GetItem(_key); } catch (Exception) { return _lastWritten; }
        }

        private JsonObject RawObject()
        {
            var text = RawText();
            if (string.IsNullOrEmpty(text)) return new JsonObject();
            try { return JsonNode.Parse(text!) as JsonObject ?? new JsonObject(); }
            catch (Exception) { return new JsonObject(); }
        }

        private static string? StringOf(JsonObject o, string field) =>
            o.TryGetPropertyValue(field, out var n) && n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

        /// <summary>The stored values, cleaned; a missing, corrupt or odd value reads as empty. Never throws.</summary>
        public SettingsValues Load()
        {
            var o = RawObject();
            string F(string f) => SettingsRules.Clean(f, StringOf(o, f)) ?? "";
            return new SettingsValues(F("name"), F("relay"), F("lastCode"), F("server"));
        }

        private string EnvValue(string field)
        {
            string? raw;
            try { raw = _env(SettingsRules.EnvNames[field]); } catch (Exception) { raw = null; }
            return string.IsNullOrWhiteSpace(raw) ? "" : raw!;
        }

        /// <summary>The values this run uses: a clean, non-empty environment variable over the stored value (never written back).</summary>
        public SettingsValues Effective()
        {
            var v = Load();
            string Pick(string f, string stored)
            {
                var e = EnvValue(f);
                var c = e.Length == 0 ? null : SettingsRules.Clean(f, e);
                return string.IsNullOrEmpty(c) ? stored : c!;
            }
            return new SettingsValues(Pick("name", v.Name), Pick("relay", v.Relay), Pick("lastCode", v.LastCode), Pick("server", v.Server));
        }

        /// <summary>
        /// Writes the fields given (null = leave alone, "" = remove); every unknown field already stored is kept. A field that does
        /// not clean is not written and is listed in <see cref="SaveResult.Rejected"/>. Never throws; a store that cannot
        /// write keeps the values for the session.
        /// </summary>
        public SaveResult Save(string? name = null, string? relay = null, string? lastCode = null, string? server = null)
        {
            var o = RawObject();
            var rejected = new List<string>();
            void Apply(string field, string? value)
            {
                if (value == null) return;
                var c = SettingsRules.Clean(field, value);
                if (c == null) rejected.Add(field);
                else if (c.Length == 0) o.Remove(field);
                else o[field] = c;
            }
            Apply("name", name);
            Apply("relay", relay);
            Apply("lastCode", lastCode);
            Apply("server", server);
            var hasVersion = o.TryGetPropertyValue("v", out var vn) && vn is JsonValue vv && vv.TryGetValue<long>(out _);
            if (!hasVersion) o["v"] = 1;
            var text = o.ToJsonString();
            _lastWritten = text;
            try { _store.SetItem(_key, text); _writeFailed = false; }
            catch (Exception) { _writeFailed = true; }
            return new SaveResult(rejected.Count == 0, rejected);
        }

        /// <summary>Forgets every saved setting (unknown fields too).</summary>
        public void Clear()
        {
            _lastWritten = null;
            try { _store.RemoveItem(_key); _writeFailed = false; }
            catch (Exception) { _writeFailed = true; }
        }

        /// <summary>The relay line this run uses, masked for a settings field (see <see cref="SettingsRules.MaskRelay"/>).</summary>
        public string MaskedRelay() => SettingsRules.MaskRelay(Effective().Relay);

        /// <summary>
        /// The ICE entry of the effective relay line (null when none), and whether a relay line is set that does not parse
        /// (stored or environment: skipped, so the caller warns once).
        /// </summary>
        public (IceServer? Entry, bool Invalid) RelayStatus()
        {
            var stored = StringOf(RawObject(), "relay");
            var env = EnvValue("relay");
            var invalid = (!string.IsNullOrWhiteSpace(stored) && SettingsRules.CleanRelay(stored) == null)
                || (env.Length > 0 && SettingsRules.CleanRelay(env) == null);
            return (SettingsRules.RelayEntry(Effective().Relay), invalid);
        }
    }
}
