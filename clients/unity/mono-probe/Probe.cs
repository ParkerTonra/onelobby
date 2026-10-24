#nullable enable
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading;
using OneLobby;
using OneLobby.DataChannel;

// Runs the managed + native half of com.onelobby.unity on Unity's own Mono (unityjit profile), with no Unity licence:
// OneLobby.Core, OneLobby.DataChannel, the shipped System.Text.Json DLLs and the libdatachannel native plugin. Two peers
// host/join through a real onelobby-server and exchange reliable + fast messages over real WebRTC data channels.
static class Probe
{
    static void PumpUntil(Func<bool> done, Action pump, string what)
    {
        var sw = Stopwatch.StartNew();
        while (!done()) { pump(); Thread.Sleep(2); if (sw.ElapsedMilliseconds > 20000) throw new TimeoutException(what); }
    }

    static int Main(string[] args)
    {
        Console.WriteLine("runtime: " + typeof(object).Assembly.Location + " | " + Type.GetType("Mono.Runtime")?.GetMethod("GetDisplayName", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)?.Invoke(null, null));
        Console.WriteLine("System.Text.Json: " + typeof(System.Text.Json.JsonDocument).Assembly.Location);
        if (Environment.GetEnvironmentVariable("ONELOBBY_PROBE_LOG") is { Length: > 0 } lv)
        {
            DataChannelTransport.NativeLogLevel = int.Parse(lv);
            DataChannelTransport.NativeLog += line => Console.WriteLine(line);
        }
        {
            var link = new DataChannelTransport().CreatePeerLink(new PeerLinkOptions(9, true, Array.Empty<IceServer>(), false));
            var reason = link.GetType().GetProperty("FailReason")?.GetValue(link);
            Console.WriteLine($"peer link self-check: failed={link.IsFailed} {reason}");
            link.Dispose();
        }
        var url = new Uri(args.Length > 0 ? args[0] : "ws://127.0.0.1:8080/ws");
        var cfg = new OneLobbyConfig("com.onelobby.monoprobe", "1", url, SyncMode.Raw);
        var a = new LobbyClient(cfg with { DisplayName = "MonoHost" }, new DataChannelTransport());
        var b = new LobbyClient(cfg with { DisplayName = "MonoJoiner" }, new DataChannelTransport());
        Lobby? host = null, joiner = null;
        void Pump() { if (host != null) host.Pump(); else a.Pump(); if (joiner != null) joiner.Pump(); else b.Pump(); }
        var sw = Stopwatch.StartNew();

        var ht = a.HostAsync(new LobbyOptions("mono probe", 2, Visibility.Public));
        PumpUntil(() => ht.IsCompleted, Pump, "host");
        host = ht.GetAwaiter().GetResult();
        var got = new List<(Channel, string)>();
        host.MessageReceived += (f, p, c) => got.Add((c, Encoding.UTF8.GetString(p.ToArray())));
        Console.WriteLine($"hosted {host.Code}");

        var lt = b.ListAsync();
        PumpUntil(() => lt.IsCompleted, Pump, "list");
        var listed = false;
        foreach (var s in lt.GetAwaiter().GetResult()) if (s.Code == host.Code && s.HostName == "MonoHost") listed = true;
        Console.WriteLine("listed: " + listed);

        var jt = b.JoinAsync(host.Code);
        PumpUntil(() => jt.IsCompleted, Pump, "join");
        joiner = jt.GetAwaiter().GetResult();
        PumpUntil(() => joiner.ReadyAsync.IsCompleted, Pump, "WebRTC link");
        Console.WriteLine($"WebRTC data channels open after {sw.ElapsedMilliseconds} ms");

        joiner.Send(host.LocalPeerId, Encoding.UTF8.GetBytes("hello from Unity's Mono"));
        var n = 0;
        PumpUntil(() =>
        {
            if (n++ % 20 == 0) joiner.Send(host.LocalPeerId, Encoding.UTF8.GetBytes("fast"), Channel.Fast);
            return got.Exists(m => m.Item1 == Channel.Reliable) && got.Exists(m => m.Item1 == Channel.Fast);
        }, Pump, "messages at host");
        var ok = listed && got.Exists(m => m.Item1 == Channel.Reliable && m.Item2 == "hello from Unity's Mono");
        Console.WriteLine($"host got reliable + fast after {sw.ElapsedMilliseconds} ms");

        joiner.LeaveAsync();
        host.LeaveAsync();
        a.DisposeAsync().AsTask().Wait();
        b.DisposeAsync().AsTask().Wait();
        Thread.Sleep(200);
        Console.WriteLine(ok ? "PASS" : "FAIL");
        return ok ? 0 : 1;
    }
}
