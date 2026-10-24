using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace OneLobby.Direct
{
    /// <summary>
    /// A host address as a player types it: <c>ip</c>, <c>ip:port</c>, <c>[v6]:port</c>, a bare IPv6 address, or a host
    /// name (a virtual-LAN name, say). The port defaults to <c>OneLobbyConfig.DirectPort</c>.
    /// </summary>
    public sealed class DirectAddress
    {
        public string Host { get; }
        public int Port { get; }
        public bool IsIPv6 { get; }

        private DirectAddress(string host, int port, bool v6) { Host = host; Port = port; IsIPv6 = v6; }

        /// <summary>The joiner's signaling URL: <c>ws://host:port/</c>.</summary>
        public Uri WebSocketUri => new Uri("ws://" + ToString() + "/");

        /// <summary>
        /// The typed address as a remote ICE host candidate (UDP, same port number as the TCP listener), for
        /// <c>PeerLinkOptions.ExtraRemoteCandidates</c> (docs/direct-ip.md s.2). Host names are resolved by the transport.
        /// </summary>
        public string Candidate => "candidate:1 1 UDP 2122317823 " + Host + " " + Port.ToString(CultureInfo.InvariantCulture) + " typ host";

        public override string ToString() => (IsIPv6 ? "[" + Host + "]" : Host) + ":" + Port.ToString(CultureInfo.InvariantCulture);

        public static bool TryParse(string? input, int defaultPort, out DirectAddress address)
        {
            address = null!;
            if (input == null) return false;
            var s = input.Trim();
            if (s.StartsWith("ws://", StringComparison.OrdinalIgnoreCase)) s = s.Substring(5);
            s = s.TrimEnd('/');
            if (s.Length == 0) return false;
            string host;
            string? portText = null;
            if (s[0] == '[')
            {
                var close = s.IndexOf(']');
                if (close < 0) return false;
                host = s.Substring(1, close - 1);
                var rest = s.Substring(close + 1);
                if (rest.Length > 0)
                {
                    if (rest[0] != ':') return false;
                    portText = rest.Substring(1);
                }
            }
            else
            {
                var first = s.IndexOf(':');
                if (first >= 0 && first == s.LastIndexOf(':')) { host = s.Substring(0, first); portText = s.Substring(first + 1); }
                else host = s; // no colon, or several (a bare IPv6 address)
            }
            var port = defaultPort;
            if (portText != null && (!int.TryParse(portText, NumberStyles.None, CultureInfo.InvariantCulture, out port) || port < 1 || port > 65535))
                return false;
            if (IPAddress.TryParse(host, out var ip))
            {
                if (ip.AddressFamily == AddressFamily.InterNetworkV6 && ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
                var v6 = ip.AddressFamily == AddressFamily.InterNetworkV6;
                address = new DirectAddress(v6 ? ip.ToString() : ip.ToString(), port, v6);
                return true;
            }
            if (Uri.CheckHostName(host) != UriHostNameType.Dns) return false;
            address = new DirectAddress(host, port, false);
            return true;
        }

        /// <summary>
        /// The IPv4 address a same-network join code carries when the router was not found: the address the OS would
        /// use to reach the internet (a UDP connect sends nothing), else the first private IPv4 of <see cref="Local"/>.
        /// Null when the machine has no IPv4.
        /// </summary>
        public static string? LanIPv4()
        {
            try
            {
                using var s = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
                s.Connect(new IPEndPoint(IPAddress.Parse("192.0.2.1"), 9)); // TEST-NET-1: routed like the internet, never contacted
                var ip = ((IPEndPoint)s.LocalEndPoint!).Address;
                if (!IPAddress.Any.Equals(ip) && !IPAddress.IsLoopback(ip)) return ip.ToString();
            }
            catch (SocketException) { /* no default route: offline LAN party, look at the interfaces instead */ }
            foreach (var a in Local(1))
                if (!a.StartsWith("[", StringComparison.Ordinal)) return a.Substring(0, a.LastIndexOf(':'));
            return null;
        }

        /// <summary>
        /// This machine's addresses with the port, for the host screen ("Your address"): every up, non-loopback interface,
        /// IPv4 first, link-local addresses left out. Empty when the platform will not say.
        /// </summary>
        public static IReadOnlyList<string> Local(int port)
        {
            var v4 = new List<string>();
            var v6 = new List<string>();
            try
            {
                foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (nic.OperationalStatus != OperationalStatus.Up || nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                    foreach (var ua in nic.GetIPProperties().UnicastAddresses)
                    {
                        var a = ua.Address;
                        if (IPAddress.IsLoopback(a)) continue;
                        if (a.AddressFamily == AddressFamily.InterNetwork)
                        {
                            var b = a.GetAddressBytes();
                            if (b[0] == 169 && b[1] == 254) continue;
                            v4.Add(a + ":" + port.ToString(CultureInfo.InvariantCulture));
                        }
                        else if (a.AddressFamily == AddressFamily.InterNetworkV6 && !a.IsIPv6LinkLocal && !a.IsIPv6Multicast)
                        {
                            var text = new IPAddress(a.GetAddressBytes()).ToString(); // no %scope
                            v6.Add("[" + text + "]:" + port.ToString(CultureInfo.InvariantCulture));
                        }
                    }
                }
            }
            catch (Exception) { /* some platforms (sandboxed mobile) refuse; the UI then shows nothing */ }
            var all = new List<string>(v4);
            all.AddRange(v6);
            return all;
        }
    }
}
