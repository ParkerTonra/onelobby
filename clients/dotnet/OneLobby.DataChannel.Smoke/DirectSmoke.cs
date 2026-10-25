using System;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Threading;
using OneLobby;
using OneLobby.DataChannel;
using OneLobby.Direct;
using OneLobby.Server;

// Direct-IP smoke test (docs/direct-ip.md s.5 step 7): no lobby server anywhere.
//   host-direct [port] [password|-]     hosts on TCP+UDP port (default 47810), asks the router to open it (UPnP/NAT-PMP),
//                                       prints "addresses ..." and "join code ...", echoes every
//                                       message back as "echo:<text>", prints each joiner's selected ICE pair, exits
//                                       0 after a joiner says "bye" (or 1 after 120 s with nobody).
//   join-direct <code|address> [pw]     joins by join code (6B01-RGFE-P2B) or address, prints the selected ICE pair, sends "hello direct" (reliable) and
//                                       "fast direct" (fast, repeated), waits for both echoes, prints PASS/FAIL, says bye.
//     --no-upnp                         (host) do not ask the router; the code is then a same-network code.
//     --wait=<s>                        (host) how long to wait for a joiner (default 120).
//     --only-typed                      (join) drop every candidate the host offers, so only the typed address can
//                                       connect: the outside-joiner case on one machine (OnlyTypedTransport).
// The joiner's "pair" line is the evidence for the s.2 candidate rule: through a forwarded port, its remote candidate
// should be the typed public address.
internal static class DirectSmoke
{
    public static int Run(string[] args)
    {
        var onlyTyped = args.Contains("--only-typed");
        var waitS = int.Parse(args.FirstOrDefault(a => a.StartsWith("--wait=", StringComparison.Ordinal))?.Substring(7) ?? "120");
        args = args.Where(a => a != "--only-typed" && !a.StartsWith("--wait=", StringComparison.Ordinal)).ToArray();
        var sw = Stopwatch.StartNew();
        void Say(string s) { Console.WriteLine(s); Console.Out.Flush(); }
        bool Wait(Func<bool> done, Action pump, int timeoutMs)
        {
            var until = sw.ElapsedMilliseconds + timeoutMs;
            while (!done()) { pump(); Thread.Sleep(2); if (sw.ElapsedMilliseconds > until) return false; }
            return true;
        }
        var transport = new DataChannelTransport();
        var cfg = new OneLobbyConfig("com.onelobby.directsmoke", "1", new Uri("ws://unused.invalid/"), SyncMode.Raw,
            DisplayName: Environment.MachineName + " " + args[0]);
        var filter = onlyTyped ? new OnlyTypedTransport(transport) : null;
        var client = new LobbyClient(cfg, (ITransport?)filter ?? transport);
        void Pairs(string who)
        {
            foreach (var l in transport.Links.Where(l => l.LocalCandidate != null))
                Say($"pair {who} local[{l.LocalCandidate}] remote[{l.RemoteCandidate}]");
        }
        try
        {
            if (args[0] == "host-direct")
            {
                var port = args.Length > 1 ? int.Parse(args[1]) : DirectLobby.DefaultPort;
                var t = client.HostDirectAsync(new DirectHostOptions
                {
                    Port = port, Password = args.Length > 2 && args[2] != "-" ? args[2] : null, MaxPlayers = 8, OpenPort = !args.Contains("--no-upnp"),
                    PortMapping = new PortMapperOptions { Description = "OneLobby " + cfg.GameId, Log = Say },
                });
                if (!Wait(() => t.IsCompleted, client.Pump, 15000) || t.IsFaulted) { Say("FAIL host: " + (t.Exception?.GetBaseException().ToString() ?? "timed out")); return 1; }
                var lobby = t.Result;
                Say("addresses " + string.Join(" ", lobby.DirectAddresses));
                Say($"join code {lobby.JoinCode} ({lobby.JoinCodeKind}); router: {lobby.PortMapping}");
                Say("hosting on TCP+UDP " + port + $"; waiting for joiners ({waitS} s)");
                var bye = false;
                var reported = 0;
                lobby.PeerReady += p => Say($"peer_ready {p.PeerId} {p.Name}");
                lobby.PeerLeft += (p, r) => Say($"peer_left {p.PeerId} {r}");
                lobby.MessageReceived += (from, payload, ch) =>
                {
                    var text = Encoding.UTF8.GetString(payload.Span);
                    Say($"got {ch} {from} {text}");
                    if (text == "bye") { bye = true; return; }
                    lobby.Send(from, Encoding.UTF8.GetBytes("echo:" + text), ch);
                };
                var ok = Wait(() =>
                {
                    var known = transport.Links.Count(l => l.LocalCandidate != null);
                    if (known > reported) { reported = known; Pairs("host"); }
                    return bye;
                }, lobby.Pump, waitS * 1000);
                var end = sw.ElapsedMilliseconds + 300;
                Wait(() => sw.ElapsedMilliseconds > end, lobby.Pump, 1000);
                // like a game: wait for the leave (and the router mapping's removal) before exiting
                var leave = lobby.LeaveAsync();
                Wait(() => leave.IsCompleted, lobby.Pump, 5000);
                Say(ok ? "PASS host" : "FAIL host: nobody said bye");
                return ok ? 0 : 1;
            }
            else
            {
                if (args.Length < 2) { Say("usage: join-direct <address> [password]"); return 2; }
                var t = client.JoinDirectAsync(args[1], args.Length > 2 ? args[2] : null);
                if (!Wait(() => t.IsCompleted, client.Pump, 15000) || t.IsFaulted)
                {
                    var e = t.Exception?.GetBaseException();
                    Say("FAIL join: " + (e is OneLobbyException oe ? oe.Code + " " : "") + e?.Message);
                    return 1;
                }
                var lobby = t.Result;
                if (!Wait(() => lobby.ReadyAsync.IsCompleted, lobby.Pump, 20000) || !lobby.ReadyAsync.IsCompletedSuccessfully)
                { Say("FAIL link to host not open: " + lobby.ReadyAsync.Exception?.GetBaseException().Message); return 1; }
                Say($"ready after {sw.ElapsedMilliseconds} ms, host {lobby.HostPeerId}");
                Wait(() => transport.Links.Any(l => l.LocalCandidate != null), lobby.Pump, 5000);
                Pairs("joiner");
                if (filter != null) Say($"only-typed: dropped {filter.Dropped} host candidates");
                bool gotReliable = false, gotFast = false;
                lobby.MessageReceived += (from, payload, ch) =>
                {
                    var text = Encoding.UTF8.GetString(payload.Span);
                    Say($"got {ch} {from} {text}");
                    if (text == "echo:hello direct" && ch == Channel.Reliable) gotReliable = true;
                    if (text == "echo:fast direct" && ch == Channel.Fast) gotFast = true;
                };
                lobby.Send(lobby.HostPeerId, Encoding.UTF8.GetBytes("hello direct"));
                var n = 0;
                var ok = Wait(() =>
                {
                    if (n++ % 25 == 0 && !gotFast) lobby.Send(lobby.HostPeerId, Encoding.UTF8.GetBytes("fast direct"), Channel.Fast);
                    return gotReliable && gotFast;
                }, lobby.Pump, 10000);
                lobby.Send(lobby.HostPeerId, Encoding.UTF8.GetBytes("bye"));
                string? ended = null;
                lobby.SessionEnded += r => ended = r;
                Wait(() => ended != null, lobby.Pump, 5000);
                Say("session ended: " + (ended ?? "(still open)"));
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
