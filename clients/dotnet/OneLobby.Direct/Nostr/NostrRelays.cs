#nullable enable
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace OneLobby.Direct.Nostr
{
    /// <summary>
    /// A set of relays carrying one topic (spec s.6). Events arrive on background threads through
    /// <see cref="EventReceived"/>; <see cref="Publish"/> may be called from any thread and never blocks.
    /// </summary>
    internal interface INostrRelays : IDisposable
    {
        /// <summary>Starts connecting and subscribing; safe to call once.</summary>
        void Start();
        /// <summary>Sends <c>["EVENT", ...]</c> to every connected relay (dropped for relays that are down).</summary>
        void Publish(string eventJson);
        /// <summary>One raw event object (JSON text) from any relay.</summary>
        event Action<string>? EventReceived;
        /// <summary>Relays connected right now.</summary>
        int Connected { get; }
        int Total { get; }
        /// <summary>True once every relay has either connected or failed an attempt (or been skipped).</summary>
        bool Settled { get; }
    }

    /// <summary>The real thing: one <see cref="ClientWebSocket"/> per relay, reconnecting with 1 s doubling to 30 s backoff.</summary>
    internal sealed class WebSocketRelays : INostrRelays
    {
        private const int ConnectTimeoutMs = 10_000;
        private readonly string[] _urls;
        private readonly string _topic;
        private readonly Func<long> _unixSeconds;
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private readonly Relay[] _relays;
        private int _started;

        public event Action<string>? EventReceived;

        private sealed class Relay
        {
            public string Url = "";
            public volatile ClientWebSocket? Ws;
            public volatile bool Connected;
            public volatile bool Attempted;
            public volatile bool Skipped;
            public readonly SemaphoreSlim SendLock = new SemaphoreSlim(1, 1);
        }

        public WebSocketRelays(IReadOnlyList<string> urls, string topic, Func<long>? unixSeconds = null)
        {
            _urls = new string[urls.Count];
            for (var i = 0; i < _urls.Length; i++) _urls[i] = urls[i];
            _topic = topic;
            _unixSeconds = unixSeconds ?? (() => DateTimeOffset.UtcNow.ToUnixTimeSeconds());
            _relays = new Relay[_urls.Length];
            for (var i = 0; i < _relays.Length; i++) _relays[i] = new Relay { Url = _urls[i] };
        }

        public int Total => _relays.Length;

        public int Connected
        {
            get
            {
                var n = 0;
                foreach (var r in _relays) if (r.Connected) n++;
                return n;
            }
        }

        public bool Settled
        {
            get
            {
                foreach (var r in _relays) if (!r.Attempted && !r.Skipped) return false;
                return true;
            }
        }

        public void Start()
        {
            if (Interlocked.Exchange(ref _started, 1) != 0) return;
            foreach (var r in _relays)
            {
                var relay = r;
                Task.Run(() => RunAsync(relay));
            }
        }

        private async Task RunAsync(Relay r)
        {
            var backoff = 1000;
            var token = _cts.Token;
            while (!token.IsCancellationRequested && !r.Skipped)
            {
                var ws = new ClientWebSocket();
                var up = false;
                try
                {
                    using (var ct = CancellationTokenSource.CreateLinkedTokenSource(token))
                    {
                        ct.CancelAfter(ConnectTimeoutMs);
                        await ws.ConnectAsync(new Uri(r.Url), ct.Token).ConfigureAwait(false);
                    }
                    r.Ws = ws;
                    await SendTextAsync(r, ws, NostrEvents.ReqMessage("ol" + Guid.NewGuid().ToString("N").Substring(0, 8), _topic, _unixSeconds() - 30)).ConfigureAwait(false);
                    r.Connected = true;
                    r.Attempted = true;
                    up = true;
                    backoff = 1000;
                    await ReadLoopAsync(r, ws, token).ConfigureAwait(false);
                }
                catch (Exception) { /* connect failed or the relay hung up: retry below */ }
                finally
                {
                    r.Connected = false;
                    r.Attempted = true;
                    r.Ws = null;
                    try { ws.Dispose(); } catch (Exception) { }
                }
                if (r.Skipped || token.IsCancellationRequested) return;
                try { await Task.Delay(up ? 1000 : backoff, token).ConfigureAwait(false); }
                catch (OperationCanceledException) { return; }
                if (!up) backoff = Math.Min(backoff * 2, 30_000);
            }
        }

        private async Task ReadLoopAsync(Relay r, ClientWebSocket ws, CancellationToken token)
        {
            var buf = new byte[16 * 1024];
            using var msg = new MemoryStream();
            while (ws.State == WebSocketState.Open && !token.IsCancellationRequested)
            {
                var res = await ws.ReceiveAsync(new ArraySegment<byte>(buf), token).ConfigureAwait(false);
                if (res.MessageType == WebSocketMessageType.Close) return;
                msg.Write(buf, 0, res.Count);
                if (!res.EndOfMessage) { if (msg.Length > 1 << 20) return; continue; }
                var text = Encoding.UTF8.GetString(msg.GetBuffer(), 0, (int)msg.Length);
                msg.SetLength(0);
                if (res.MessageType == WebSocketMessageType.Text) Handle(r, text);
            }
        }

        private void Handle(Relay r, string text)
        {
            try
            {
                using var doc = JsonDocument.Parse(text);
                var a = doc.RootElement;
                if (a.ValueKind != JsonValueKind.Array || a.GetArrayLength() < 2 || a[0].ValueKind != JsonValueKind.String) return;
                switch (a[0].GetString())
                {
                    case "EVENT":
                        if (a.GetArrayLength() >= 3 && a[2].ValueKind == JsonValueKind.Object) EventReceived?.Invoke(a[2].GetRawText());
                        break;
                    case "OK":
                        if (a.GetArrayLength() >= 3 && a[2].ValueKind == JsonValueKind.False) Skip(r);
                        break;
                    case "CLOSED":
                        Skip(r);
                        break;
                }
            }
            catch (Exception e) when (e is JsonException || e is InvalidOperationException) { /* not ours */ }
        }

        /// <summary>A relay refusing our events or subscription is left alone for the session (spec s.6).</summary>
        private static void Skip(Relay r)
        {
            r.Skipped = true;
            r.Connected = false;
            try { r.Ws?.Abort(); } catch (Exception) { }
        }

        private static async Task SendTextAsync(Relay r, ClientWebSocket ws, string text)
        {
            await r.SendLock.WaitAsync().ConfigureAwait(false);
            try
            {
                using var ct = new CancellationTokenSource(5000);
                await ws.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(text)), WebSocketMessageType.Text, true, ct.Token).ConfigureAwait(false);
            }
            finally { r.SendLock.Release(); }
        }

        public void Publish(string eventJson)
        {
            var msg = NostrEvents.EventMessage(eventJson);
            foreach (var r in _relays)
            {
                var ws = r.Ws;
                if (ws == null || !r.Connected || r.Skipped) continue;
                var relay = r;
                Task.Run(async () =>
                {
                    try { await SendTextAsync(relay, ws, msg).ConfigureAwait(false); }
                    catch (Exception) { try { ws.Abort(); } catch (Exception) { } }
                });
            }
        }

        public void Dispose()
        {
            _cts.Cancel();
            foreach (var r in _relays)
            {
                try { r.Ws?.Abort(); } catch (Exception) { }
            }
        }
    }
}
