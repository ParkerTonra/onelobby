using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Threading.Channels;

namespace Keepalive.Server;

public static class ServerApp
{
    /// <summary>Builds the app. <paramref name="listenUrl"/> overrides the options' listen address (tests pass http://127.0.0.1:0).</summary>
    public static WebApplication Build(ServerOptions options, string[]? args = null, IClock? clock = null, string? listenUrl = null)
    {
        var builder = WebApplication.CreateBuilder(args ?? Array.Empty<string>());
        builder.WebHost.UseUrls(listenUrl ?? options.ListenUrl());
        builder.Logging.ClearProviders();
        builder.Logging.AddSimpleConsole(o => { o.SingleLine = true; o.TimestampFormat = "HH:mm:ss "; });
        builder.Services.AddSingleton(options);
        builder.Services.AddSingleton(sp => new Hub(options, clock, sp.GetRequiredService<ILoggerFactory>().CreateLogger("keepalive")));
        builder.Services.AddHostedService<TickService>();
        var app = builder.Build();
        var hub = app.Services.GetRequiredService<Hub>();

        app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(20) });
        app.MapGet("/healthz", () => Results.Text("ok\n"));
        app.MapGet("/metrics", () => Results.Text(hub.Metrics.Render(), "text/plain; version=0.0.4"));
        app.Map("/ws", ctx => HandleSocket(ctx, hub, options));
        return app;
    }

    private static string ClientIp(HttpContext ctx, ServerOptions o)
    {
        if (o.TrustProxy && ctx.Request.Headers.TryGetValue("X-Forwarded-For", out var xff))
        {
            string first = xff.ToString().Split(',')[0].Trim();
            if (first.Length > 0) return first;
        }
        return ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
    }

    private static async Task HandleSocket(HttpContext ctx, Hub hub, ServerOptions o)
    {
        if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = 400; return; }
        using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
        var outbound = Channel.CreateBounded<string>(new BoundedChannelOptions(512) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);

        var session = hub.Connect(ClientIp(ctx, o),
            send: text => { if (!outbound.Writer.TryWrite(text)) outbound.Writer.TryComplete(); },
            close: () => outbound.Writer.TryComplete());

        var writer = Task.Run(async () =>
        {
            try
            {
                await foreach (var text in outbound.Reader.ReadAllAsync(cts.Token))
                    await ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, cts.Token);
                if (ws.State == WebSocketState.Open)
                    await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None);
            }
            catch (Exception) { }
            finally { cts.CancelAfter(TimeSpan.FromSeconds(2)); }
        });

        if (session is not null)
        {
            var buf = new byte[o.MaxMessageBytes + 1];
            try
            {
                while (ws.State == WebSocketState.Open && !cts.IsCancellationRequested)
                {
                    int len = 0;
                    ValueWebSocketReceiveResult r;
                    do
                    {
                        r = await ws.ReceiveAsync(buf.AsMemory(len), cts.Token);
                        len += r.Count;
                        if (r.MessageType == WebSocketMessageType.Close) break;
                    } while (!r.EndOfMessage && len <= o.MaxMessageBytes);
                    if (r.MessageType == WebSocketMessageType.Close) break;
                    if (len > o.MaxMessageBytes || (!r.EndOfMessage))
                    {
                        hub.Receive(session, new string('x', o.MaxMessageBytes + 1)); // oversize: hub replies bad_request and closes
                        break;
                    }
                    if (r.MessageType != WebSocketMessageType.Text) continue;
                    hub.Receive(session, Encoding.UTF8.GetString(buf, 0, len));
                }
            }
            catch (Exception) { }
            finally { hub.Disconnect(session); outbound.Writer.TryComplete(); }
        }
        await writer;
    }
}

/// <summary>Drives <see cref="Hub.Tick"/> once a second.</summary>
public sealed class TickService : BackgroundService
{
    private readonly Hub _hub;
    public TickService(Hub hub) => _hub = hub;

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        try { while (await timer.WaitForNextTickAsync(stop)) _hub.Tick(); }
        catch (OperationCanceledException) { }
    }
}
