namespace OneLobby
{
    /// <summary>
    /// Every <c>Code</c> a <see cref="OneLobbyException"/> or <see cref="LobbyError"/> can carry (spec/signaling.md and the
    /// client's own). Compare against these instead of string literals; JS has the same values in <c>ErrorCodes</c>.
    /// </summary>
    public static class LobbyErrorCodes
    {
        // ---- from the lobby server or a direct host's hub ----
        /// <summary>No lobby with that code (or it ended).</summary>
        public const string UnknownCode = "unknown_code";
        /// <summary>The code is not a well-formed lobby code.</summary>
        public const string BadCode = "bad_code";
        /// <summary>The lobby has MaxPlayers members (or too many join requests are pending).</summary>
        public const string LobbyFull = "lobby_full";
        /// <summary>The joiner's NetVersion differs from the lobby's.</summary>
        public const string VersionMismatch = "version_mismatch";
        /// <summary>The game started and the lobby was created with LateJoin false.</summary>
        public const string InGame = "in_game";
        /// <summary>The host removed this player, banned this address, or turned a private-lobby join request down.</summary>
        public const string Kicked = "kicked";
        /// <summary>Wrong lobby password.</summary>
        public const string BadPassword = "bad_password";
        /// <summary>A host-only request from a non-host.</summary>
        public const string NotHost = "not_host";
        /// <summary>Too many requests in a short time, or too many lobbies open from this address.</summary>
        public const string RateLimited = "rate_limited";
        /// <summary>The server is at its connection or lobby limit.</summary>
        public const string ServerFull = "server_full";
        /// <summary>The server does not host this GameId.</summary>
        public const string GameNotAllowed = "game_not_allowed";
        /// <summary>The server could not parse a request.</summary>
        public const string BadRequest = "bad_request";

        // ---- from this client ----
        /// <summary>The signaling socket closed before or during a request.</summary>
        public const string ServerClosed = "server_closed";
        /// <summary>No peer link to the host within ReadyTimeout (including the relay-only retry).</summary>
        public const string IceFailed = "ice_failed";
        /// <summary>A request got no answer in time.</summary>
        public const string Timeout = "timeout";
        /// <summary>RejoinAsync: the seat behind the resume token is gone (resume window over, or the lobby ended).</summary>
        public const string InvalidToken = "invalid_token";
        /// <summary>Direct IP: nothing answered on the host's TCP port.</summary>
        public const string DirectUnreachable = "direct_unreachable";
        /// <summary>Direct IP: the join code or address could not be read.</summary>
        public const string BadAddress = "bad_address";
        /// <summary>Direct IP host: no port in 47810-47819 could be bound.</summary>
        public const string PortInUse = "port_in_use";
    }
}
