using System;
using System.Collections.Generic;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;
using OneLobby.Server;

namespace OneLobby.Direct
{
    /// <summary>Settings for <see cref="DirectLobby.HostDirectAsync"/>.</summary>
    public sealed class DirectHostOptions
    {
        /// <summary>
        /// TCP and UDP port to listen on; 0 = <c>OneLobbyConfig.DirectPort</c> (default 47810). When it is busy (another
        /// program holds it) the next free one of the following <see cref="FallbackPorts"/> is used; the join code carries
        /// the port, so friends never type it.
        /// </summary>
        public int Port { get; set; }
        /// <summary>How many ports after <see cref="Port"/> to try when it is busy; null = 9 with <see cref="Port"/> 0, else 0.</summary>
        public int? FallbackPorts { get; set; }
        /// <summary>Optional; joiners must send the same one or get <c>bad_password</c>. Null or empty = none.</summary>
        public string? Password { get; set; }
        public int MaxPlayers { get; set; } = 4;
        /// <summary>Lobby name; default "&lt;DisplayName&gt;'s game".</summary>
        public string? Name { get; set; }
        public bool LateJoin { get; set; } = true;
        public IReadOnlyDictionary<string, string>? Meta { get; set; }
        /// <summary>
        /// Ask the home router to forward TCP + UDP P (UPnP, then NAT-PMP) so the join code works from the internet
        /// (docs/direct-ip.md s.2a). Show it as the host-menu toggle "Open port automatically". Default on.
        /// </summary>
        public bool OpenPort { get; set; } = true;
        /// <summary>Test seam and knobs for the router request; null = defaults (description "OneLobby &lt;GameId&gt;").</summary>
        public PortMapperOptions? PortMapping { get; set; }
    }

    /// <summary>
    /// Host or join by IP address, with no server of anyone's (docs/direct-ip.md). The host's game runs the signaling
    /// hub and listens on TCP <c>P</c>; peer links use UDP <c>P</c>; the host forwards that one port for friends outside
    /// its network. Everything after host/join is the normal <see cref="Lobby"/> API. Like <c>HostAsync</c>, these
    /// complete from inside <see cref="LobbyClient.Pump"/>.
    /// <para>Errors (<see cref="OneLobbyException.Code"/>): <c>port_in_use</c> (host), <c>bad_address</c>,
    /// <c>direct_unreachable</c> (no answer on TCP <c>P</c> within 5 s), <c>bad_password</c>, plus the usual
    /// <c>lobby_full</c>, <c>version_mismatch</c>, <c>in_game</c>. When the host leaves, joiners get
    /// <c>SessionEnded("host_left")</c>: there is no host migration in direct mode.</para>
    /// </summary>
    public static class DirectLobby
    {
        /// <summary>The library default for <c>P</c> (same as <c>OneLobbyConfig.DirectPort</c>).</summary>
        public const int DefaultPort = 47810;

        /// <summary>With <see cref="DirectHostOptions.Port"/> left at 0, how many ports after the default are tried when it is busy.</summary>
        public const int DefaultFallbackPorts = 9;

        /// <summary>
        /// Starts the embedded hub and listener on <c>P</c>, connects this client to it in memory and creates the lobby.
        /// The lobby's <see cref="Lobby.DirectAddresses"/> lists this machine's addresses for the host screen. Leaving the
        /// lobby stops the listener and ends the session for everyone.
        /// </summary>
        public static Task<Lobby> HostDirectAsync(this LobbyClient client, DirectHostOptions? options = null, CancellationToken ct = default)
        {
            if (client == null) throw new ArgumentNullException(nameof(client));
            var o = options ?? new DirectHostOptions();
            var port = o.Port > 0 ? o.Port : client.Config.DirectPort;
            var last = port + Math.Max(0, o.FallbackPorts ?? (o.Port > 0 ? 0 : DefaultFallbackPorts));
            DirectHubHost? hub = null;
            bool anyBusy = false, anyReserved = false;
            for (var p = port; hub == null; p++)
            {
                try { hub = new DirectHubHost(p, HubOptions.ForDirect(o.MaxPlayers, o.Password)); }
                catch (SocketException e)
                {
                    // AccessDenied: Windows reserved the port (Hyper-V, WSL, Docker exclusion ranges); try the next one too
                    var reserved = e.SocketErrorCode == SocketError.AccessDenied;
                    if (reserved) anyReserved = true; else anyBusy = true;
                    if (p < last && (reserved || e.SocketErrorCode == SocketError.AddressAlreadyInUse)) continue;
                    var range = last > port ? "ports " + port + "-" + last : "port " + port;
                    return Task.FromException<Lobby>(new OneLobbyException("port_in_use",
                        "cannot listen on " + range + " (" + e.SocketErrorCode + "): " + PortFailureHint(anyBusy, anyReserved)));
                }
            }
            DirectHostTransport transport = null!;
            try { client.UseDirect(inner => transport = new DirectHostTransport(inner, hub), new Uri("onelobby-direct://host/"), hub); }
            catch (Exception e)
            {
                hub.Dispose();
                return Task.FromException<Lobby>(e);
            }
            var name = string.IsNullOrEmpty(o.Name) ? client.Config.DisplayName + "'s game" : o.Name!;
            // The router request runs off the game thread alongside lobby creation; its answer is handed back from Pump.
            Task<PortMapResult?> mapping = o.OpenPort
                ? MapAsync(hub, o.PortMapping ?? new PortMapperOptions { Description = "OneLobby " + client.Config.GameId })
                : Task.FromResult<PortMapResult?>(null);
            var create = client.HostAsync(new LobbyOptions(name, o.MaxPlayers, Visibility.Unlisted, o.LateJoin, o.Meta), ct);
            return FinishHost(create, mapping, transport, hub, port);
        }

        /// <summary>
        /// One line for the game's log once a direct host is up, e.g.
        /// <c>OneLobby: direct host listening on TCP+UDP :47811 (47810 busy); code 0A00-0BSE-P3S (SameNetwork); port mapping off</c>.
        /// Empty for any other lobby. The Unity runner logs it; other hosts can log it themselves.
        /// </summary>
        internal static string HostLogLine(Lobby lobby) => lobby.DirectHostLog;

        /// <summary>The end of a <c>port_in_use</c> message: busy (another program) and reserved (Windows) need different fixes.</summary>
        internal static string PortFailureHint(bool anyBusy, bool anyReserved) =>
            !anyReserved ? "is another copy of the game hosting?"
            : !anyBusy ? "Windows has reserved it (an excluded port range, often from Hyper-V, WSL or Docker); pick another port"
            : "each one is busy or reserved by Windows (an excluded port range); is another copy of the game hosting?";

        internal static string FormatHostLog(int requested, int bound, string code, JoinCodeKind kind, string mapping)
        {
            var line = "OneLobby: direct host listening on TCP+UDP :" + bound;
            if (bound != requested) line += " (" + (bound - requested == 1 ? requested.ToString() : requested + "-" + (bound - 1)) + " busy)";
            line += string.IsNullOrEmpty(code) ? "; no join code (no IPv4 address)" : "; code " + code + " (" + kind + ")";
            return line + "; port mapping " + (string.IsNullOrEmpty(mapping) ? "off" : mapping);
        }

        private static async Task<PortMapResult?> MapAsync(DirectHubHost hub, PortMapperOptions options)
        {
            try { return await hub.OpenPortAsync(options).ConfigureAwait(false); }
            catch (Exception e) { return new PortMapResult { Detail = e.Message }; }
        }

        private static async Task<Lobby> FinishHost(Task<Lobby> create, Task<PortMapResult?> mapping, DirectHostTransport transport, DirectHubHost hub, int requestedPort)
        {
            try
            {
                var lobby = await create.ConfigureAwait(false);
                await transport.AfterPump(mapping).ConfigureAwait(false);
                var map = mapping.Result;
                lobby.DirectAddresses = DirectAddress.Local(hub.Port);
                lobby.PortMapping = map == null ? "off" : map.Detail;
                if (map is { Mapped: true } && PortMapper.IsPublicIPv4(map.ExternalIPv4))
                {
                    lobby.JoinCode = OneLobby.JoinCode.Encode(map.ExternalIPv4!, hub.Port);
                    lobby.JoinCodeKind = JoinCodeKind.Internet;
                }
                else if ((map?.LocalIPv4 ?? DirectAddress.LanIPv4()) is { } lan)
                {
                    lobby.JoinCode = OneLobby.JoinCode.Encode(lan, hub.Port);
                    lobby.JoinCodeKind = JoinCodeKind.SameNetwork;
                }
                lobby.DirectHostLog = FormatHostLog(requestedPort, hub.Port, lobby.JoinCode, lobby.JoinCodeKind, lobby.PortMapping);
                return lobby;
            }
            catch
            {
                hub.Dispose();
                throw;
            }
        }

        /// <summary>
        /// Joins the lobby behind a join code (<c>6B01-RGFE-P2B</c>, from the host's <see cref="Lobby.JoinCode"/>) or an
        /// address (<c>ip</c>, <c>ip:port</c>, <c>[v6]:port</c>; the port defaults to <c>OneLobbyConfig.DirectPort</c>). The
        /// host's address is also offered to ICE as its UDP candidate, so a host behind a forwarded port is reachable.
        /// A mistyped code fails at once with <c>bad_code</c>.
        /// </summary>
        public static Task<Lobby> JoinDirectAsync(this LobbyClient client, string address, string? password = null, CancellationToken ct = default)
        {
            if (client == null) throw new ArgumentNullException(nameof(client));
            if (!TryUseDirect(client, address, out var a, out var fail)) return Task.FromException<Lobby>(fail!);
            return WithJoinCode(client.JoinSingleLobbyAsync(password, ct), a!);
        }

        /// <summary>
        /// Takes a seat back after a drop or a restart: <paramref name="address"/> is the code or address joined before,
        /// <paramref name="resumeToken"/> that lobby's <see cref="Lobby.ResumeToken"/> (save it after joining: it changes
        /// on every resume). The host keeps a dropped seat for 60 s; the same peer id comes back and the host sees
        /// <c>PeerJoined</c> for it again. When the seat is gone (too late, or the host left) this fails: offer a plain join.
        /// </summary>
        public static Task<Lobby> RejoinDirectAsync(this LobbyClient client, string address, string resumeToken, CancellationToken ct = default)
        {
            if (client == null) throw new ArgumentNullException(nameof(client));
            if (string.IsNullOrEmpty(resumeToken)) throw new ArgumentException("resume token required", nameof(resumeToken));
            if (!TryUseDirect(client, address, out var a, out var fail)) return Task.FromException<Lobby>(fail!);
            return WithJoinCode(client.RejoinAsync(resumeToken, ct), a!);
        }

        private static bool TryUseDirect(LobbyClient client, string address, out DirectAddress? result, out Exception? fail)
        {
            result = null;
            fail = null;
            if (OneLobby.JoinCode.LooksLikeCode(address))
            {
                if (!OneLobby.JoinCode.TryDecode(address, out var ip, out var port, out var err))
                {
                    fail = new OneLobbyException(err!, err == "unknown_version"
                        ? "'" + address + "' is a join code from a newer version of the game"
                        : "'" + address + "' is not a valid join code: check for a typo");
                    return false;
                }
                address = ip + ":" + port.ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
            if (!DirectAddress.TryParse(address, client.Config.DirectPort, out var a))
            {
                fail = new OneLobbyException("bad_address",
                    "'" + address + "' is not an address: use 192.168.1.20, 192.168.1.20:47810 or [2001:db8::1]:47810");
                return false;
            }
            try { client.UseDirect(inner => new DirectJoinTransport(inner, new[] { a.Candidate }), a.WebSocketUri, null); }
            catch (Exception e) { fail = e; return false; }
            result = a;
            return true;
        }

        /// <summary>A joiner's <see cref="Lobby.JoinCode"/> is what it joined with (the code, normalized), so a HUD can show it on both sides.</summary>
        private static async Task<Lobby> WithJoinCode(Task<Lobby> join, DirectAddress a)
        {
            var lobby = await join.ConfigureAwait(false);
            try { lobby.JoinCode = a.IsIPv6 ? a.ToString() : OneLobby.JoinCode.Encode(a.Host, a.Port); }
            catch (ArgumentException) { lobby.JoinCode = a.ToString(); } // a host name has no code
            return lobby;
        }
    }
}
