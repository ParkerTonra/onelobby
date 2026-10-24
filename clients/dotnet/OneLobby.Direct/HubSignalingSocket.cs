using System;
using System.Collections.Concurrent;
using OneLobby.Server;

namespace OneLobby.Direct
{
    /// <summary>
    /// The direct-IP host's own signaling socket: talks to the embedded <see cref="Hub"/> in memory, no network
    /// (docs/direct-ip.md s.5 step 4). Sends go straight into the hub; the hub's replies queue until
    /// <see cref="TryReceive"/> drains them on the pumping thread.
    /// </summary>
    public sealed class HubSignalingSocket : ISignalingSocket
    {
        /// <summary>Address the hub sees for the host itself (rate limits and kicks are per address).</summary>
        public const string LocalAddress = "local";

        private readonly Hub _hub;
        private readonly Session? _session;
        private readonly ConcurrentQueue<string> _inbox = new ConcurrentQueue<string>();
        private volatile int _state;
        private volatile string? _closeReason;

        public HubSignalingSocket(Hub hub)
        {
            _hub = hub ?? throw new ArgumentNullException(nameof(hub));
            _state = (int)SocketState.Open;
            _session = hub.Connect(LocalAddress, text => _inbox.Enqueue(text), () => Close("closed by the hub"));
            if (_session == null) Close("hub is full");
        }

        public SocketState State => (SocketState)_state;
        public string? CloseReason => _closeReason;

        public void Send(string text)
        {
            if (State == SocketState.Open && _session != null) _hub.Receive(_session, text);
        }

        public bool TryReceive(out string text)
        {
            if (_inbox.TryDequeue(out var t)) { text = t; return true; }
            text = "";
            return false;
        }

        private void Close(string reason)
        {
            if (_state == (int)SocketState.Closed) return;
            _closeReason = reason;
            _state = (int)SocketState.Closed;
        }

        public void Dispose()
        {
            var wasOpen = State == SocketState.Open;
            Close("closed locally");
            if (wasOpen && _session != null) _hub.Disconnect(_session);
        }
    }
}
