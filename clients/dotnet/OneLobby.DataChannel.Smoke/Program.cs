using System;
using System.Diagnostics;
using System.Text;
using System.Threading;
using OneLobby;
using OneLobby.DataChannel;

// Cross-play peer over DataChannelTransport (used by integration/crossplay-datachannel.mjs).
//   host <ws-url>          prints "code XXXXXX", echoes every message back to its sender as "echo:<text>" on the same
//                          channel, prints "got <channel> <from> <text>", exits after "bye" arrives.
//   join <ws-url> <code>   sends "hello from .NET" (reliable) and "fast from .NET" (fast, repeated) to the host, waits
//                          for both echoes, prints "PASS" (exit 0) or "FAIL ..." (exit 1), sends "bye".
// Every line is flushed; the process gives up after 30 s.
internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length >= 1 && args[0] is "host-direct" or "join-direct") return DirectSmoke.Run(args);
        if (args.Length < 2) { Console.Error.WriteLine("usage: host <ws> | join <ws> <code> | host-direct [port] [password] | join-direct <address> [password]"); return 2; }
        Console.Out.Flush();
        var cfg = new OneLobbyConfig("com.onelobby.crossplay", "1", new Uri(args[1]), SyncMode.Raw, DisplayName: ".NET " + args[0]);
        var client = new LobbyClient(cfg, new DataChannelTransport());
        var sw = Stopwatch.StartNew();
        void Say(string s) { Console.WriteLine(s); Console.Out.Flush(); }
        bool Wait(Func<bool> done, Action pump)
        {
            while (!done()) { pump(); Thread.Sleep(2); if (sw.ElapsedMilliseconds > 30000) return false; }
            return true;
        }
        try
        {
            if (args[0] == "host")
            {
                var t = client.HostAsync(new LobbyOptions("crossplay", 2));
                if (!Wait(() => t.IsCompleted, client.Pump)) { Say("FAIL host timeout"); return 1; }
                var lobby = t.GetAwaiter().GetResult();
                Say("code " + lobby.Code);
                var bye = false;
                lobby.MessageReceived += (from, payload, ch) =>
                {
                    var text = Encoding.UTF8.GetString(payload.Span);
                    Say($"got {ch} {from} {text}");
                    if (text == "bye") { bye = true; return; }
                    if (!text.StartsWith("echo:")) lobby.Send(from, Encoding.UTF8.GetBytes("echo:" + text), ch);
                };
                lobby.PeerReady += p => Say($"peer_ready {p.PeerId} {p.Name}");
                var ok = Wait(() => bye, lobby.Pump);
                lobby.LeaveAsync();
                Say(ok ? "PASS" : "FAIL host never got bye");
                return ok ? 0 : 1;
            }
            else
            {
                var t = client.JoinAsync(args[2]);
                if (!Wait(() => t.IsCompleted, client.Pump)) { Say("FAIL join timeout"); return 1; }
                var lobby = t.GetAwaiter().GetResult();
                if (!Wait(() => lobby.ReadyAsync.IsCompleted, lobby.Pump) || !lobby.ReadyAsync.IsCompletedSuccessfully)
                { Say("FAIL link to host not open: " + lobby.ReadyAsync.Exception?.GetBaseException().Message); return 1; }
                Say($"ready after {sw.ElapsedMilliseconds} ms, host {lobby.HostPeerId}");
                bool gotReliable = false, gotFast = false;
                lobby.MessageReceived += (from, payload, ch) =>
                {
                    var text = Encoding.UTF8.GetString(payload.Span);
                    Say($"got {ch} {from} {text}");
                    if (text == "echo:hello from .NET" && ch == Channel.Reliable) gotReliable = true;
                    if (text == "echo:fast from .NET" && ch == Channel.Fast) gotFast = true;
                };
                lobby.Send(lobby.HostPeerId, Encoding.UTF8.GetBytes("hello from .NET"));
                var n = 0;
                var ok = Wait(() =>
                {
                    if (n++ % 25 == 0 && !gotFast) lobby.Send(lobby.HostPeerId, Encoding.UTF8.GetBytes("fast from .NET"), Channel.Fast);
                    return gotReliable && gotFast;
                }, lobby.Pump);
                lobby.Send(lobby.HostPeerId, Encoding.UTF8.GetBytes("bye"));
                var until = sw.ElapsedMilliseconds + 500;
                Wait(() => sw.ElapsedMilliseconds > until, lobby.Pump);
                lobby.LeaveAsync();
                Say(ok ? $"PASS after {sw.ElapsedMilliseconds} ms" : $"FAIL reliable={gotReliable} fast={gotFast}");
                return ok ? 0 : 1;
            }
        }
        finally
        {
            client.DisposeAsync().AsTask().Wait(1000);
        }
    }
}
