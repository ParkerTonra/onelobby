using System;
using System.Collections.Generic;
using System.Threading.Tasks;
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

        public DirectHostTransport(ITransport inner, DirectHubHost host)
        {
            _inner = inner;
            _host = host;
        }

        public long NowMs => _inner.NowMs;

        public ISignalingSocket ConnectSignaling(Uri url) => new HubSignalingSocket(_host.Hub);

        public IPeerLink CreatePeerLink(PeerLinkOptions options) =>
            _inner.CreatePeerLink(options with
            {
                PortRangeBegin = _host.Port,
                PortRangeEnd = _host.Port,
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
