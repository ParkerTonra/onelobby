using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using OneLobby.Direct.Nostr;
using OneLobby.Server;

namespace OneLobby.Direct
{
    /// <summary>
    /// Host side: signaling goes to the embedded hub in memory (<see cref="HubSignalingSocket"/>), every peer link binds
    /// ICE to the one UDP port <c>P</c> (the same number as the TCP listener) and offers no ICE servers, and each
    /// <see cref="Poll"/> also pumps the hub. Wraps the game's real transport (e.g. DataChannelTransport).
    /// </summary>
    internal sealed class DirectHostTransport : ITransport
    {
        private readonly ITransport _inner;
        private readonly DirectHubHost _host;
        private readonly bool _nostr;

        /// <param name="inner">The game's real transport.</param>
        /// <param name="host">The embedded hub and listener.</param>
        /// <param name="nostr">Nostr joiners are welcome: the peer links use the ICE servers the hub's <c>welcome</c> carries
        /// (its STUN list, they cannot reach a bare host address); false = no ICE servers at all, as direct IP always did.</param>
        public DirectHostTransport(ITransport inner, DirectHubHost host, bool nostr = false)
        {
            _inner = inner;
            _host = host;
            _nostr = nostr;
        }

        public long NowMs => _inner.NowMs;

        public ISignalingSocket ConnectSignaling(Uri url) => new HubSignalingSocket(_host.Hub);

        public IPeerLink CreatePeerLink(PeerLinkOptions options)
        {
            var link = _inner.CreatePeerLink(options with
            {
                PortRangeBegin = _host.Port,
                PortRangeEnd = _host.Port,
                IceServers = _nostr ? options.IceServers : TurnOnly(options.IceServers),
                NoIceServers = true,
            });
            lock (_links) _links[options.RemotePeerId] = link; // the newest link to a peer id (ids are never reused in a lobby)
            return link;
        }

        /// <summary>The TURN entries of <paramref name="ice"/>: a bare host address needs no STUN, but a relay still helps.</summary>
        internal static IReadOnlyList<IceServer> TurnOnly(IReadOnlyList<IceServer> ice)
        {
            var keep = new List<IceServer>();
            foreach (var s in ice)
                foreach (var u in s.Urls)
                    if (u.StartsWith("turn:", StringComparison.OrdinalIgnoreCase) || u.StartsWith("turns:", StringComparison.OrdinalIgnoreCase)) { keep.Add(s); break; }
            return keep;
        }

        private readonly Dictionary<int, IPeerLink> _links = new Dictionary<int, IPeerLink>();

        /// <summary>The remote IP of the link to <paramref name="peerId"/> once its path is known and direct; else null. Any thread.</summary>
        public string? RemoteAddressOf(int peerId)
        {
            IPeerLink? link;
            lock (_links) _links.TryGetValue(peerId, out link);
            return (link as IRemoteAddressPeerLink)?.RemoteAddress;
        }

        public void Poll()
        {
            _host.Pump();
            _inner.Poll();
            while (_posted.TryDequeue(out var act)) act();
            for (var i = _waits.Count - 1; i >= 0; i--)
                if (_waits[i].Work.IsCompleted)
                {
                    var tcs = _waits[i].Done;
                    _waits.RemoveAt(i);
                    tcs.TrySetResult(true);
                }
        }

        private readonly System.Collections.Concurrent.ConcurrentQueue<Action> _posted = new System.Collections.Concurrent.ConcurrentQueue<Action>();

        /// <summary>Runs <paramref name="action"/> from inside the next <see cref="Poll"/>, on the game's pumping thread.</summary>
        public void Post(Action action) => _posted.Enqueue(action);

        private readonly List<(Task Work, TaskCompletionSource<bool> Done)> _waits = new List<(Task, TaskCompletionSource<bool>)>();

        /// <summary>
        /// Completes from inside the next <see cref="Poll"/> after <paramref name="work"/> finishes, so continuations run
        /// on the game's pumping thread like every other lobby callback (the router request finishes on the thread pool).
        /// </summary>
        public Task AfterPump(Task work)
        {
            var done = new TaskCompletionSource<bool>();
            _waits.Add((work, done));
            return done.Task;
        }
    }

    /// <summary>
    /// Joiner side: signaling over the real transport's WebSocket to <c>ws://ip:P/</c>; every peer link offers no ICE
    /// servers and adds the typed address as a remote host candidate (docs/design/direct-ip.md s.2: without it a joiner on the
    /// internet only learns the host's private LAN addresses).
    /// </summary>
    internal sealed class DirectJoinTransport : ITransport
    {
        private readonly ITransport _inner;
        private readonly IReadOnlyList<string> _extra;
        private readonly IReadOnlyList<IceServer> _ice;

        // extraIce: The joiner's own ICE servers, added to the host's welcome list (only TURN entries are used here).
        public DirectJoinTransport(ITransport inner, IReadOnlyList<string> extraCandidates, IReadOnlyList<IceServer>? extraIce = null)
        {
            _inner = inner;
            _extra = extraCandidates;
            _ice = extraIce ?? Array.Empty<IceServer>();
        }

        public long NowMs => _inner.NowMs;

        public ISignalingSocket ConnectSignaling(Uri url) => _inner.ConnectSignaling(url);

        public IPeerLink CreatePeerLink(PeerLinkOptions options) =>
            _inner.CreatePeerLink(options with
            {
                IceServers = DirectHostTransport.TurnOnly(Concat(options.IceServers, _ice)),
                ExtraRemoteCandidates = _extra,
                NoIceServers = true,
            });

        internal static IReadOnlyList<IceServer> Concat(IReadOnlyList<IceServer> a, IReadOnlyList<IceServer> b)
        {
            if (b.Count == 0) return a;
            var all = new List<IceServer>(a);
            all.AddRange(b);
            return all;
        }

        public void Poll() => _inner.Poll();
    }
}

namespace OneLobby.Direct
{
    /// <summary>
    /// Joiner side over Nostr (spec/nostr-signaling.md): signaling through <see cref="NostrSignalingSocket"/>, every peer link
    /// uses the STUN servers the host's <c>welcome</c> offers, else the options' (default: the public ones; an empty list
    /// means none), and no extra remote candidate.
    /// </summary>
    internal sealed class NostrJoinTransport : ITransport
    {
        private readonly ITransport _inner;
        private readonly string _code;
        private readonly NostrOptions _options;
        private readonly IReadOnlyList<IceServer> _ice;
        private readonly IReadOnlyList<IceServer> _extraIce;

        // extraIce: The joiner's own ICE servers, added after the host's welcome list (or the STUN default).
        public NostrJoinTransport(ITransport inner, string normalizedCode, NostrOptions options, IReadOnlyList<IceServer>? extraIce = null)
        {
            _extraIce = extraIce ?? Array.Empty<IceServer>();
            _inner = inner;
            _code = normalizedCode;
            _options = options;
            var stun = options.EffectiveStun;
            _ice = stun.Count > 0 ? new[] { new IceServer(stun) } : Array.Empty<IceServer>();
        }

        public long NowMs => _inner.NowMs;

        public ISignalingSocket ConnectSignaling(Uri url) => new NostrSignalingSocket(_code, _options);

        public IPeerLink CreatePeerLink(PeerLinkOptions options) =>
            _inner.CreatePeerLink(options with { IceServers = DirectJoinTransport.Concat(options.IceServers.Count > 0 ? options.IceServers : _ice, _extraIce), ExtraRemoteCandidates = null, NoIceServers = true });

        public void Poll() => _inner.Poll();
    }
}
