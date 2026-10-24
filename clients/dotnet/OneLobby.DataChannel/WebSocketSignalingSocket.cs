#nullable enable
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace OneLobby.DataChannel
{
    /// <summary>
    /// Pull-based <see cref="ISignalingSocket"/> over <see cref="ClientWebSocket"/>. A thread-pool receive loop fills a queue
    /// that <see cref="TryReceive"/> drains; sends go through one send loop (ClientWebSocket allows one send at a time).
    /// Touches no engine objects, so it is safe off the main thread. Used by <see cref="DataChannelTransport"/>.
    /// </summary>
    public sealed class WebSocketSignalingSocket : ISignalingSocket
    {
        private readonly ClientWebSocket _ws = new ClientWebSocket();
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private readonly ConcurrentQueue<string> _inbox = new ConcurrentQueue<string>();
        private readonly ConcurrentQueue<string> _outbox = new ConcurrentQueue<string>();
        private readonly SemaphoreSlim _outSignal = new SemaphoreSlim(0);
        private volatile int _state = (int)SocketState.Connecting;
        private volatile string? _closeReason;
        private volatile bool _draining;
        private volatile bool _sendLoopStarted;

        public bool Disposed { get; private set; }
        public SocketState State => (SocketState)_state;
        public string? CloseReason => _closeReason;

        public WebSocketSignalingSocket(Uri url)
        {
            // Task.Run so no continuation is captured by a main-thread SynchronizationContext (Unity, WinForms...).
            Task.Run(() => RunAsync(url));
        }

        private async Task RunAsync(Uri url)
        {
            var everOpen = false;
            try
            {
                await _ws.ConnectAsync(url, _cts.Token).ConfigureAwait(false);
                everOpen = true;
                _sendLoopStarted = true;
                _ = Task.Run(SendLoopAsync);
                _state = (int)SocketState.Open;
                var buf = new byte[16 * 1024];
                using var msg = new MemoryStream();
                while (!_cts.IsCancellationRequested)
                {
                    var r = await _ws.ReceiveAsync(new ArraySegment<byte>(buf), _cts.Token).ConfigureAwait(false);
                    if (r.MessageType == WebSocketMessageType.Close)
                    {
                        Close("closed " + (int?)r.CloseStatus + " " + r.CloseStatusDescription);
                        try { await _ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None).ConfigureAwait(false); }
                        catch (Exception) { /* already gone */ }
                        return;
                    }
                    msg.Write(buf, 0, r.Count);
                    if (!r.EndOfMessage) continue;
                    if (r.MessageType == WebSocketMessageType.Text)
                        _inbox.Enqueue(Encoding.UTF8.GetString(msg.GetBuffer(), 0, (int)msg.Length));
                    msg.SetLength(0);
                }
            }
            catch (Exception e)
            {
                Close(everOpen ? "closed: " + e.Message : "could not connect: " + e.Message);
            }
        }

        private async Task SendLoopAsync()
        {
            try
            {
                while (true)
                {
                    await _outSignal.WaitAsync(_cts.Token).ConfigureAwait(false);
                    while (_outbox.TryDequeue(out var text))
                    {
                        var bytes = Encoding.UTF8.GetBytes(text);
                        await _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, _cts.Token).ConfigureAwait(false);
                    }
                    if (_draining) break;
                }
                // Dispose was called: everything queued before it (e.g. "leave") is sent; now close politely.
                using var t = new CancellationTokenSource(1000);
                await _ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", t.Token).ConfigureAwait(false);
            }
            catch (Exception e)
            {
                Close("closed: " + e.Message);
            }
            finally
            {
                if (_draining) TearDown();
            }
        }

        private void Close(string reason)
        {
            if (_state == (int)SocketState.Closed) return;
            _closeReason = reason;
            _state = (int)SocketState.Closed;
        }

        public void Send(string text)
        {
            if (State != SocketState.Open || _draining) return;
            _outbox.Enqueue(text);
            _outSignal.Release();
        }

        public bool TryReceive(out string text)
        {
            if (_inbox.TryDequeue(out var t)) { text = t; return true; }
            text = "";
            return false;
        }

        public void Dispose()
        {
            if (Disposed) return;
            Disposed = true;
            var wasOpen = State == SocketState.Open;
            Close("closed locally");
            _draining = true;
            if (wasOpen && _sendLoopStarted) _outSignal.Release(); // the send loop flushes, closes and tears down
            else TearDown();
        }

        private void TearDown()
        {
            try { _cts.Cancel(); } catch (ObjectDisposedException) { }
            _ws.Dispose();
        }
    }
}
