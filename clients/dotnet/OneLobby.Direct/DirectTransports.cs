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
        private readonly IReadOnlyList<IceServer> _ice;

        /// <param name="inner">The game's real transport.</param>
        /// <param name="host">The embedded hub and listener.</param>
        /// <param name="stun">STUN URLs for the peer links when Nostr joiners are welcome (they cannot reach a bare host
        /// address); empty = no ICE servers at all, as direct IP always did.</param>
        public DirectHostTransport(ITransport inner, DirectHubHost host, IReadOnlyList<string>? stun = null)
        {
            _inner = inner;
            _host = host;
            _ice = stun is { Count: > 0 } ? new[] { new IceServer(stun) } : Array.Empty<IceServer>();
        }

        public long NowMs => _inner.NowMs;

        public ISignalingSocket ConnectSignaling(Uri url) => new HubSignalingSocket(_host.Hub);

        public IPeerLink CreatePeerLink(PeerLinkOptions options) =>
            _inner.CreatePeerLink(options with
            {
                PortRangeBegin = _host.Port,
                PortRangeEnd = _host.Port,
                IceServers = _ice,
                NoIceServers = true,
            });

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
    /// servers and adds the typed address as a remote host candidate (docs/direct-ip.md s.2: without it a joiner on the
    /// internet only learns the host's private LAN addresses).
    /// </summary>
    internal sealed class DirectJoinTransport : ITransport
    {
        private readonly ITransport _inner;
        private readonly IReadOnlyList<string> _extra;

        public DirectJoinTransport(ITransport inner, IReadOnlyList<string> extraCandidates)
        {
            _inner = inner;
            _extra = extraCandidates;
        }

        public long NowMs => _inner.NowMs;

        public ISignalingSocket ConnectSignaling(Uri url) => _inner.ConnectSignaling(url);

        public IPeerLink CreatePeerLink(PeerLinkOptions options) =>
            _inner.CreatePeerLink(options with { ExtraRemoteCandidates = _extra, NoIceServers = true });

        public void Poll() => _inner.Poll();
    }
}

namespace OneLobby.Direct
{
    /// <summary>
    /// Joiner side over Nostr (spec/nostr-signaling.md): signaling through <see cref="NostrSignalingSocket"/>, every peer link
    /// uses the public STUN servers and no extra remote candidate.
    /// </summary>
    internal sealed class NostrJoinTransport : ITransport
    {
        private readonly ITransport _inner;
        private readonly string _code;
        private readonly NostrOptions _options;
        private readonly IReadOnlyList<IceServer> _ice;

        public NostrJoinTransport(ITransport inner, string normalizedCode, NostrOptions options)
        {
            _inner = inner;
            _code = normalizedCode;
            _options = options;
            _ice = new[] { new IceServer(options.EffectiveStun) };
        }

        public long NowMs => _inner.NowMs;

        public ISignalingSocket ConnectSignaling(Uri url) => new NostrSignalingSocket(_code, _options);

        public IPeerLink CreatePeerLink(PeerLinkOptions options) =>
            _inner.CreatePeerLink(options with { IceServers = _ice, ExtraRemoteCandidates = null, NoIceServers = true });

        public void Poll() => _inner.Poll();
    }
}
