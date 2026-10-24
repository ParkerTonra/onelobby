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
        /// <summary>TCP and UDP port to listen on; 0 = <c>OneLobbyConfig.DirectPort</c> (default 47810).</summary>
        public int Port { get; set; }
        /// <summary>Optional; joiners must send the same one or get <c>bad_password</c>. Null or empty = none.</summary>
        public string? Password { get; set; }
        public int MaxPlayers { get; set; } = 4;
        /// <summary>Lobby name; default "&lt;DisplayName&gt;'s game".</summary>
        public string? Name { get; set; }
        public bool LateJoin { get; set; } = true;
        public IReadOnlyDictionary<string, string>? Meta { get; set; }
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
            DirectHubHost hub;
            try { hub = new DirectHubHost(port, HubOptions.ForDirect(o.MaxPlayers, o.Password)); }
            catch (SocketException e)
            {
                return Task.FromException<Lobby>(new OneLobbyException("port_in_use",
                    "cannot listen on port " + port + " (" + e.SocketErrorCode + "): is another copy of the game hosting?"));
            }
            try { client.UseDirect(inner => new DirectHostTransport(inner, hub), new Uri("onelobby-direct://host/"), hub); }
            catch (Exception e)
            {
                hub.Dispose();
                return Task.FromException<Lobby>(e);
            }
            var name = string.IsNullOrEmpty(o.Name) ? client.Config.DisplayName + "'s game" : o.Name!;
            var create = client.HostAsync(new LobbyOptions(name, o.MaxPlayers, Visibility.Unlisted, o.LateJoin, o.Meta), ct);
            return FinishHost(create, hub);
        }

        private static async Task<Lobby> FinishHost(Task<Lobby> create, DirectHubHost hub)
        {
            try
            {
                var lobby = await create.ConfigureAwait(false);
                lobby.DirectAddresses = DirectAddress.Local(hub.Port);
                return lobby;
            }
            catch
            {
                hub.Dispose();
                throw;
            }
        }

        /// <summary>
        /// Joins the lobby hosted at <paramref name="address"/> (<c>ip</c>, <c>ip:port</c>, <c>[v6]:port</c>; the port
        /// defaults to <c>OneLobbyConfig.DirectPort</c>). The typed address is also offered to ICE as the host's UDP
        /// candidate, so a host behind a forwarded port is reachable.
        /// </summary>
        public static Task<Lobby> JoinDirectAsync(this LobbyClient client, string address, string? password = null, CancellationToken ct = default)
        {
            if (client == null) throw new ArgumentNullException(nameof(client));
            if (!DirectAddress.TryParse(address, client.Config.DirectPort, out var a))
                return Task.FromException<Lobby>(new OneLobbyException("bad_address",
                    "'" + address + "' is not an address: use 192.168.1.20, 192.168.1.20:47810 or [2001:db8::1]:47810"));
            try { client.UseDirect(inner => new DirectJoinTransport(inner, new[] { a.Candidate }), a.WebSocketUri, null); }
            catch (Exception e) { return Task.FromException<Lobby>(e); }
            return client.JoinSingleLobbyAsync(password, ct);
        }
    }
}
