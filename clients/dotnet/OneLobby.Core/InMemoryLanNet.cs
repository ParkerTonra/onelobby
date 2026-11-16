using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Threading;

namespace OneLobby
{
    /// <summary>An in-memory UDP network: sends to 127.0.0.1:port reach the socket bound there; broadcasts go nowhere. No OS socket exists.</summary>
    public sealed class InMemoryLanNet
    {
        private readonly object _lock = new object();
        private readonly Dictionary<int, Sock> _bound = new Dictionary<int, Sock>();
        private int _next = 50000;
        /// <summary>Sockets made so far (each Factory call).</summary>
        public int Created;
        public readonly List<string> Sent = new List<string>();
        public Func<ILanUdp> Factory => () => { Interlocked.Increment(ref Created); return new Sock(this); };
        /// <summary>Sockets bound right now: 0 when nothing is open.</summary>
        public int BoundCount { get { lock (_lock) return _bound.Count; } }

        private sealed class Sock : ILanUdp
        {
            private readonly InMemoryLanNet _net;
            private readonly ConcurrentQueue<(byte[] Data, IPAddress From, int Port)> _in = new ConcurrentQueue<(byte[], IPAddress, int)>();
            private int _port;
            private volatile bool _closed;
            public Sock(InMemoryLanNet net) { _net = net; }

            public int Bind(IPAddress address, int port, bool broadcast)
            {
                lock (_net._lock)
                {
                    if (port == 0) port = _net._next++;
                    if (_net._bound.ContainsKey(port)) throw new SocketException((int)SocketError.AddressAlreadyInUse);
                    _net._bound[port] = this;
                    _port = port;
                    return port;
                }
            }

            public void Send(byte[] data, IPAddress to, int port)
            {
                if (_closed) return;
                lock (_net._lock)
                {
                    _net.Sent.Add(to + ":" + port);
                    if (IPAddress.IsLoopback(to) && _net._bound.TryGetValue(port, out var peer) && !peer._closed)
                        peer._in.Enqueue((data, IPAddress.Loopback, _port));
                }
            }

            public bool TryReceive(int waitMs, out byte[] data, out IPAddress from, out int fromPort)
            {
                var clock = System.Diagnostics.Stopwatch.StartNew();
                do
                {
                    if (_closed) break;
                    if (_in.TryDequeue(out var d)) { data = d.Data; from = d.From; fromPort = d.Port; return true; }
                    if (waitMs > 0) Thread.Sleep(1);
                } while (clock.ElapsedMilliseconds < waitMs);
                data = Array.Empty<byte>(); from = IPAddress.None; fromPort = 0;
                return false;
            }

            public void Dispose()
            {
                if (_closed) return;
                _closed = true;
                lock (_net._lock) if (_port != 0 && _net._bound.TryGetValue(_port, out var s) && s == this) _net._bound.Remove(_port);
            }
        }
    }
}
