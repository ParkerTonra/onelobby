using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

namespace OneLobby
{
    /// <summary>A player-facing error: a stable code, one short sentence and, when there is one, what the player can do.</summary>
    /// <param name="Code">The error code (<see cref="LobbyErrorCodes"/>), or <c>unknown</c>.</param>
    /// <param name="Message">One short sentence a player can read.</param>
    /// <param name="Hint">What the player can do about it; null when there is nothing.</param>
    public sealed record FriendlyError(string Code, string Message, string? Hint = null);

    /// <summary>
    /// Plain-language error text for players. The wording is the JS client's <c>describeError</c> word for word
    /// (spec/vectors/describe-error.json is the shared test); nothing here touches the network.
    /// </summary>
    public static class Friendly
    {
        private static readonly Dictionary<string, (string Message, string? Hint)> Text = new Dictionary<string, (string, string?)>
        {
            ["unknown_code"] = ("We couldn't find a lobby with that code.", "Check the code with the host. Codes stop working once everyone leaves."),
            ["bad_code"] = ("That doesn't look like a lobby code.", "Codes are 6 letters and numbers, like 7HQ 4K2."),
            ["lobby_full"] = ("That lobby is full.", "Ask the host to make room, or start your own lobby."),
            ["version_mismatch"] = ("You and the host are running different versions of the game.", "Reload the page (or update the game) on both sides, then try again."),
            ["in_game"] = ("That game has already started.", "Ask the host to let people join mid-game, or wait for the next round."),
            ["kicked"] = ("The host removed you from the lobby.", null),
            ["denied"] = ("The host didn't let you in this time.", "Ask the host to approve you, then try again."),
            ["bad_password"] = ("That password isn't right.", "Check it with the host, then try again."),
            ["not_host"] = ("Only the host can do that.", null),
            ["rate_limited"] = ("Slow down a little: too many tries in a short time.", "Wait a moment, then try again."),
            ["max_lobbies"] = ("You already have the most lobbies open that this server allows.", "Close one of your other lobbies, then try again."),
            ["server_full"] = ("The game server is full right now.", "Try again in a few minutes."),
            ["game_not_allowed"] = ("This game server doesn't host this game.", "The game's server setting may be wrong; let the game's owner know."),
            ["bad_request"] = ("The game sent something the server didn't understand.", "Reload the page and try again. If it keeps happening, the game may need an update."),
            ["connect_failed"] = ("Couldn't reach the game server.", "Check your internet connection, then try again."),
            ["server_closed"] = ("Lost the connection to the game server.", "Check your internet connection, then try again."),
            ["bad_address"] = ("That doesn't look like a join code or an address.", "Paste the code the host shows, or an address like 192.168.1.20:47810."),
            ["port_in_use"] = ("Couldn't open a port to host this game.", "Close other copies of the game, or pick another port, then try again."),
            ["unknown_version"] = ("That code is from a newer version of the game.", "Update the game, then try again."),
            ["unsupported_code"] = ("That code is from a newer version of the game.", "Update the game, then try again."),
            ["no_relay"] = ("Couldn't reach any of the servers that set up direct games.", "Check your internet connection, then try again."),
            ["busy"] = ("Still working on your last request.", "Wait a moment, then try again."),
            ["in_lobby"] = ("You are already in a lobby.", "Leave it first, then try again."),
            ["closed"] = ("Lost the connection to the game server.", "Check your internet connection, then try again."),
            ["server_lost"] = ("Lost the connection to the game server.", "Your game may keep going; new players can't join until it's back."),
            ["invalid_token"] = ("Your old seat in that lobby is no longer available.", "Join again with the lobby code."),
            ["ice_failed"] = ("Couldn't connect to the other players.", "Some networks (school, work, public Wi-Fi) block game connections. Try another network or a phone hotspot, or ask the host to port-forward."),
            ["no_server"] = ("This game has no lobby server address yet.", "Enter one in the multiplayer settings, or host from your own computer with a join code."),
            ["timeout"] = ("The connection took too long.", "Check your internet connection, then try again."),
            ["unsupported"] = ("The host's game is too old for that.", "Ask the host to update the game."),
            ["voice_disabled"] = ("Voice chat is turned off in this game.", null),
            ["chat_disabled"] = ("Text chat is turned off in this game.", null),
            ["pause_disabled"] = ("Pausing is turned off in this game.", null),
            ["not_in_game"] = ("You can only pause while a game is running.", "Start the game first."),
            ["not_allowed"] = ("You can't do that right now.", "The player who paused, or the host, can resume."),
            ["listing_disabled"] = ("This game has no public lobby list.", "Join with a code or a link from the host."),
            ["direct_unreachable"] = ("Couldn't reach the host.", "Check the code, and that the host is still online. A host in a browser needs its tab open and visible."),
            ["nostr_disabled"] = ("This game can't be hosted from a browser.", "Host from the desktop version, or let the game's owner know."),
            ["identity_anonymous"] = ("This game doesn't use player names.", "Everyone shows up as Player 1, Player 2, and so on."),
            ["bad_config"] = ("The game's multiplayer settings file is not valid.", "Let the game's owner know; the details are in the error message."),
            ["left"] = ("You left the lobby.", null),
            ["unknown"] = ("Something went wrong.", "Try again. If it keeps happening, reload the page."),
        };

        private static readonly Regex CodeRe = new Regex(@"^[a-z][a-z0-9_]*\z", RegexOptions.CultureInvariant);
        private static readonly Regex PrefixRe = new Regex(@"^([a-z][a-z0-9_]*):", RegexOptions.CultureInvariant);
        private static readonly Regex BareRe = new Regex(@"^([a-z][a-z0-9_]*)(?::|\z)", RegexOptions.CultureInvariant);
        private static readonly Regex NetworkRe = new Regex("network|failed to fetch|websocket", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Regex TimeoutRe = new Regex("timed? ?out", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        /// <summary>
        /// Text for a caught exception: a <see cref="OneLobbyException"/> by its <see cref="OneLobbyException.Code"/>;
        /// timeouts and socket / HTTP failures as <c>timeout</c> / <c>connect_failed</c>; anything else (a stack trace
        /// or a raw technical message is never shown) as <c>unknown</c>.
        /// </summary>
        public static FriendlyError DescribeError(Exception? error)
        {
            if (error == null) return DescribeError((string?)null);
            if (error is OneLobbyException o) return DescribeError(o.Code, null, o.Message);
            var name = error is TimeoutException || error is OperationCanceledException ? "TimeoutError"
                : error is System.Net.Sockets.SocketException || error is System.Net.WebSockets.WebSocketException || error is System.Net.Http.HttpRequestException ? "NetworkError"
                : error.GetType().Name;
            return DescribeError(null, null, error.Message, name);
        }

        /// <summary>Text for a <see cref="LobbyError"/> (the client's <c>Error</c> event).</summary>
        public static FriendlyError DescribeError(LobbyError error) => DescribeError(error?.Code, null, error?.Message);

        /// <summary>Text for a bare code or a <c>code: text</c> string such as <c>"lobby_full: lobby is full"</c>; null gives <c>unknown</c>.</summary>
        public static FriendlyError DescribeError(string? codeOrText)
        {
            var m = codeOrText == null ? null : BareRe.Match(codeOrText.Trim());
            return Describe(m != null && m.Success ? m.Groups[1].Value : null, null);
        }

        /// <summary>
        /// Text for an error given as its parts. <paramref name="data"/> is the server's error data (<c>reason</c> "denied" /
        /// "max_lobbies", <c>retryAfterMs</c>); numbers may be any numeric type or a <see cref="System.Text.Json.JsonElement"/>.
        /// With no usable <paramref name="code"/>, a <c>code: text</c> <paramref name="message"/> naming a known code, then
        /// a <paramref name="name"/> of <c>NetworkError</c> / <c>TimeoutError</c> or such a message, pick the code.
        /// </summary>
        public static FriendlyError DescribeError(string? code, IReadOnlyDictionary<string, object?>? data, string? message = null, string? name = null)
        {
            if (code != null && CodeRe.IsMatch(code)) return Describe(code, data);
            if (message != null)
            {
                var m = PrefixRe.Match(message);
                if (m.Success && Text.ContainsKey(m.Groups[1].Value)) return Describe(m.Groups[1].Value, data);
                if (name == "NetworkError" || NetworkRe.IsMatch(message)) return Describe("connect_failed", null);
                if (name == "TimeoutError" || TimeoutRe.IsMatch(message)) return Describe("timeout", null);
            }
            return Describe(null, null);
        }

        private static FriendlyError Describe(string? code, IReadOnlyDictionary<string, object?>? data)
        {
            if (code == null) return Unknown("unknown");
            var key = code;
            if (code == "kicked" && Str(data, "reason") == "denied") key = "denied";
            if (code == "rate_limited" && Str(data, "reason") == "max_lobbies") key = "max_lobbies";
            if (!Text.TryGetValue(key, out var e)) return Unknown(code);
            var hint = e.Hint;
            if (key == "rate_limited" && Num(data, "retryAfterMs") is double ms)
            {
                var s = (long)Math.Max(1, Math.Ceiling(ms / 1000));
                hint = "Wait " + s.ToString(CultureInfo.InvariantCulture) + " second" + (s == 1 ? "" : "s") + ", then try again.";
            }
            return new FriendlyError(code, e.Message, hint);
        }

        private static FriendlyError Unknown(string code) => new FriendlyError(code, Text["unknown"].Message, Text["unknown"].Hint);

        private static string? Str(IReadOnlyDictionary<string, object?>? d, string key)
        {
            if (d == null || !d.TryGetValue(key, out var v)) return null;
            if (v is System.Text.Json.JsonElement je) return je.ValueKind == System.Text.Json.JsonValueKind.String ? je.GetString() : null;
            return v as string;
        }

        private static double? Num(IReadOnlyDictionary<string, object?>? d, string key)
        {
            if (d == null || !d.TryGetValue(key, out var v) || v == null) return null;
            if (v is System.Text.Json.JsonElement je) return je.ValueKind == System.Text.Json.JsonValueKind.Number ? je.GetDouble() : (double?)null;
            if (v is bool || v is string || v is char) return null;
            return v is IConvertible c && !(v is DateTime) ? c.ToDouble(CultureInfo.InvariantCulture) : (double?)null;
        }
    }
}
