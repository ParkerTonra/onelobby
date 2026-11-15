using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using OneLobby;
using OneLobby.DataChannel;
using OneLobby.Direct;
using OneLobby.Direct.Nostr;

// C# engine peer for tools/engine-smoke (its README has the shared peer protocol and flags). OneLobby.Core + OneLobby.Direct over
// DataChannelTransport (libdatachannel), the transport the Unity package uses. Prints "RESULT PASS ..." / "RESULT FAIL ...".
internal static class Program
{
    private static readonly Dictionary<string, string> A = new();
    private static readonly Stopwatch Sw = Stopwatch.StartNew();
    private static string Name = "cs";

    private static void Say(string s) { Console.WriteLine(s); Console.Out.Flush(); }
    private static int Finish(bool ok, string why) { Say((ok ? "RESULT PASS " : "RESULT FAIL ") + Name + " " + why); return ok ? 0 : 1; }
    private static byte[] B(string s) => Encoding.UTF8.GetBytes(s);

    // Evidence for the exit crash (README, "Findings"): the library never calls rtcCleanup, and without it the process dies with an access
    // violation at exit on Windows. `--native-cleanup` calls it here, after everything else, and the exit code is 0 again.
    [System.Runtime.InteropServices.DllImport("datachannel", EntryPoint = "rtcCleanup")] private static extern void rtcCleanup();

    private static int Main(string[] args)
    {
        var rc = Main2(args);
        if (A.ContainsKey("native-cleanup")) { try { rtcCleanup(); } catch (Exception e) { Say("rtcCleanup failed: " + e.Message); } }
        return rc;
    }

    private static int Main2(string[] args)
    {
        foreach (var x in args)
            if (x.StartsWith("--", StringComparison.Ordinal))
            {
                var eq = x.IndexOf('=');
                if (eq < 0) A[x.Substring(2)] = "1"; else A[x.Substring(2, eq - 2)] = x.Substring(eq + 1);
            }
        Name = A.GetValueOrDefault("name", "cs");
        if (A.ContainsKey("native-log")) { DataChannelTransport.NativeLogLevel = 5; DataChannelTransport.NativeLog += l => Say("native: " + l); }
        var timeoutMs = int.Parse(A.GetValueOrDefault("timeout", "60")) * 1000;
        try { return Run(timeoutMs); }
        catch (Exception e) { return Finish(false, (e is OneLobbyException oe ? oe.Code + " " : "") + e.Message); }
    }

    private static bool Wait(Func<bool> done, Action pump, int limitMs)
    {
        while (!done()) { pump(); Thread.Sleep(2); if (Sw.ElapsedMilliseconds > limitMs) return false; }
        return true;
    }

    private static int Run(int limitMs)
    {
        var role = A["role"];
        var route = A["route"];
        var joiners = int.Parse(A.GetValueOrDefault("joiners", "2"));
        var rounds = int.Parse(A.GetValueOrDefault("rounds", "3"));
        // the pasted TURN line goes through the library's own parser, as a settings field would
        IceServer? turn = A.TryGetValue("turn", out var line) ? TurnLogin.Parse(line) : null;
        var cfg = new OneLobbyConfig("com.onelobby.enginesmoke", "1", new Uri(A.GetValueOrDefault("server", "ws://unused.invalid/")), A.GetValueOrDefault("sync", "raw") == "lockstep" ? SyncMode.Lockstep : SyncMode.Raw,
            TickRate: 20, HashEveryTicks: 10, DisplayName: Name, RelayOnly: turn != null) { ReadyTimeout = TimeSpan.FromSeconds(40) };
        // --loopback: bind every ICE socket to 127.0.0.1 (no Windows firewall prompt; the host then offers a 127.0.0.1 host candidate)
        var client = new LobbyClient(cfg, new DataChannelTransport { BindAddress = A.ContainsKey("loopback") ? "127.0.0.1" : null });
        var nostr = new NostrOptions { Enabled = route != "typed" && route != "ipcode", Stun = new string[0] };
        if (A.TryGetValue("relay", out var relay)) nostr.Relays = new[] { relay };
        try { return role == "host" ? Host(client, route, joiners, rounds, turn, nostr, limitMs) : Join(client, route, rounds, turn, nostr, limitMs); }
        finally { client.DisposeAsync().AsTask().Wait(1000); }
    }

    private static int Host(LobbyClient client, string route, int joiners, int rounds, IceServer? turn, NostrOptions nostr, int limitMs)
    {
        Lobby lobby;
        string typed = "", code, ipcode = "";
        if (route == "server")
        {
            var t = client.HostAsync(new LobbyOptions("smoke", 4));
            if (!Wait(() => t.IsCompleted, client.Pump, limitMs)) return Finish(false, "host timeout");
            lobby = t.GetAwaiter().GetResult();
            code = lobby.Code;
        }
        else
        {
            var port = int.Parse(A["port"]);
            var t = client.HostDirectAsync(new DirectHostOptions
            {
                Port = port, FallbackPorts = 0, BindAddress = System.Net.IPAddress.Loopback, PublicAddress = "127.0.0.1", OpenPort = false,
                MaxPlayers = 4, Nostr = nostr, IceServers = turn != null ? new[] { turn } : null,
            });
            if (!Wait(() => t.IsCompleted, client.Pump, limitMs)) return Finish(false, "host timeout");
            lobby = t.GetAwaiter().GetResult();
            typed = "127.0.0.1:" + port;
            ipcode = lobby.DirectCode;
            code = route == "typed" ? typed : route == "ipcode" ? lobby.DirectCode : lobby.JoinCode;
        }
        Say($"HOST_READY code={code} typed={typed} ipcode={ipcode}");
        var ready = new HashSet<int>();
        var pong = new Dictionary<string, HashSet<int>>();
        var fpong = new Dictionary<string, HashSet<int>>();
        var byes = new HashSet<int>();
        lobby.PeerReady += p => { ready.Add(p.PeerId); Say($"peer_ready {p.PeerId} relayed={p.Relayed}"); };
        lobby.MessageReceived += (from, payload, ch) =>
        {
            var f = Encoding.UTF8.GetString(payload.Span).Split('|');
            HashSet<int> Set(Dictionary<string, HashSet<int>> d) { if (!d.TryGetValue(f[1], out var s)) d[f[1]] = s = new HashSet<int>(); return s; }
            if (f[0] == "pong") Set(pong).Add(from);
            else if (f[0] == "fpong" && ch == Channel.Fast) Set(fpong).Add(from);
            else if (f[0] == "bye") byes.Add(from);
        };
        if (!Wait(() => ready.Count >= joiners, lobby.Pump, limitMs)) return Finish(false, $"only {ready.Count}/{joiners} joiners linked");
        if (A.GetValueOrDefault("sync", "raw") == "lockstep")
        {
            if (!SyncRun(lobby, true, joiners + 1, limitMs, out var why)) return Finish(false, why);
            if (!Wait(() => byes.Count >= joiners, lobby.Pump, limitMs)) return Finish(false, $"only {byes.Count}/{joiners} joiners said bye");
            lobby.Broadcast(B("done"));
            var wait = Sw.ElapsedMilliseconds + 500;
            Wait(() => Sw.ElapsedMilliseconds > wait, lobby.Pump, limitMs);
            var fl = lobby.FlushAsync(TimeSpan.FromSeconds(1));
            Wait(() => fl.IsCompleted, lobby.Pump, limitMs);
            var lv = lobby.LeaveAsync();
            Wait(() => lv.IsCompleted, lobby.Pump, limitMs);
            return Finish(true, $"host lockstep joiners={joiners}");
        }
        for (var r = 1; r <= rounds; r++)
        {
            var k = r.ToString();
            lobby.Broadcast(B("ping|" + k));
            var nextFast = 0L;
            if (!Wait(() =>
                {
                    if (Sw.ElapsedMilliseconds >= nextFast) { lobby.Broadcast(B("fping|" + k), Channel.Fast); nextFast = Sw.ElapsedMilliseconds + 200; }
                    return pong.TryGetValue(k, out var a) && a.Count >= joiners && fpong.TryGetValue(k, out var b) && b.Count >= joiners;
                }, lobby.Pump, limitMs))
                return Finish(false, $"round {r} incomplete (reliable {(pong.TryGetValue(k, out var pa) ? pa.Count : 0)}, fast {(fpong.TryGetValue(k, out var fa) ? fa.Count : 0)} of {joiners})");
            Say($"round {r} ok");
        }
        lobby.Broadcast(B("done"));
        if (!Wait(() => byes.Count >= joiners, lobby.Pump, limitMs)) return Finish(false, $"only {byes.Count}/{joiners} joiners said bye");
        var until = Sw.ElapsedMilliseconds + 300;
        Wait(() => Sw.ElapsedMilliseconds > until, lobby.Pump, limitMs);
        var flush = lobby.FlushAsync(TimeSpan.FromSeconds(1));
        Wait(() => flush.IsCompleted, lobby.Pump, limitMs);
        var leave = lobby.LeaveAsync();
        Wait(() => leave.IsCompleted, lobby.Pump, limitMs);
        return Finish(true, $"host rounds={rounds} joiners={joiners}");
    }

    private static int Join(LobbyClient client, string route, int rounds, IceServer? turn, NostrOptions nostr, int limitMs)
    {
        var code = A["code"];
        Task<Lobby> t = route == "server"
            ? client.JoinAsync(code)
            : client.JoinDirectAsync(code, new JoinDirectOptions { Nostr = nostr, IceServers = turn != null ? new[] { turn } : null });
        if (!Wait(() => t.IsCompleted, client.Pump, limitMs)) return Finish(false, "join timeout");
        var lobby = t.GetAwaiter().GetResult();
        var seen = new HashSet<string>();
        var fseen = new HashSet<string>();
        var done = false;
        lobby.MessageReceived += (from, payload, ch) =>
        {
            var f = Encoding.UTF8.GetString(payload.Span).Split('|');
            if (f[0] == "ping") { seen.Add(f[1]); lobby.Send(from, B($"pong|{f[1]}|{Name}")); }
            else if (f[0] == "fping" && ch == Channel.Fast) { fseen.Add(f[1]); lobby.Send(from, B($"fpong|{f[1]}|{Name}"), Channel.Fast); }
            else if (f[0] == "done") { done = true; lobby.Send(from, B("bye|" + Name)); }
        };
        if (!Wait(() => lobby.ReadyAsync.IsCompleted, lobby.Pump, limitMs) || !lobby.ReadyAsync.IsCompletedSuccessfully)
            return Finish(false, "link to host not open: " + lobby.ReadyAsync.Exception?.GetBaseException().Message);
        Say("ready, host " + lobby.HostPeerId);
        if (A.GetValueOrDefault("sync", "raw") == "lockstep")
        {
            if (!SyncRun(lobby, false, int.Parse(A.GetValueOrDefault("peers", "3")), limitMs, out var why)) return Finish(false, why);
            lobby.Send(lobby.HostPeerId, B("bye|" + Name));
            if (!Wait(() => done, lobby.Pump, limitMs)) return Finish(false, "no done from host");
            var w = Sw.ElapsedMilliseconds + 300;
            Wait(() => Sw.ElapsedMilliseconds > w, lobby.Pump, limitMs);
            var fl = lobby.FlushAsync(TimeSpan.FromSeconds(1));
            Wait(() => fl.IsCompleted, lobby.Pump, limitMs);
            var lv = lobby.LeaveAsync();
            Wait(() => lv.IsCompleted, lobby.Pump, limitMs);
            return Finish(true, "joiner lockstep");
        }
        if (!Wait(() => done, lobby.Pump, limitMs)) return Finish(false, $"no done from host (reliable {seen.Count}/{rounds} fast {fseen.Count}/{rounds})");
        var until = Sw.ElapsedMilliseconds + 500;
        Wait(() => Sw.ElapsedMilliseconds > until, lobby.Pump, limitMs);
        var flush = lobby.FlushAsync(TimeSpan.FromSeconds(1));
        Wait(() => flush.IsCompleted, lobby.Pump, limitMs);
        var leave = lobby.LeaveAsync();
        Wait(() => leave.IsCompleted, lobby.Pump, limitMs);
        var ok = seen.Count == rounds && fseen.Count == rounds;
        return Finish(ok, $"joiner rounds={rounds} (reliable {seen.Count} fast {fseen.Count})");
    }

    // ---- the lockstep exchange (--sync=lockstep): chat, a shared pause and 60 ticks of a tiny sim; the same flow in all three
    // engine peers. The sim is FNV-1a 32 over every frame (tick, then peer id, length and bytes of each command), so equal
    // hashes mean equal frames.
    private const int SyncTicks = 60, CmdsEach = 5;

    private static bool SyncRun(Lobby lobby, bool isHost, int total, int limitMs, out string why)
    {
        why = "";
        var ls = lobby.Lockstep!;
        uint h = 0x811c9dc5; uint cmds = 0; long tick = 0;
        void Fnv(int b) { h = unchecked((h ^ (uint)(b & 255)) * 16777619u); }
        ls.Snapshot = () => { var o = new byte[8]; BitConverter.GetBytes(h).CopyTo(o, 0); BitConverter.GetBytes(cmds).CopyTo(o, 4); return o; };
        ls.Restore = (t, b) => { var s = b.Span; h = BitConverter.ToUInt32(s.Slice(0, 4)); cmds = BitConverter.ToUInt32(s.Slice(4, 4)); tick = t; };
        // chat: the host speaks first; everyone answers; everyone must see one line from each of the `total` peers
        var lines = new HashSet<int>();
        lobby.Chat.Received += l =>
        {
            lines.Add(l.PeerId);
            if (!isHost && l.PeerId == lobby.HostPeerId && !lines.Contains(lobby.LocalPeerId)) lobby.Chat.Send("hi from " + Name);
        };
        if (isHost) { var until0 = Sw.ElapsedMilliseconds + 500; Wait(() => Sw.ElapsedMilliseconds > until0, lobby.Pump, limitMs); lobby.Chat.Send("hi from " + Name); } // a joiner may still be between ready and its handler
        if (!Wait(() => lines.Count >= total, lobby.Pump, limitMs)) { why = $"chat: lines from {lines.Count}/{total} peers"; return false; }
        Say("chat ok lines=" + lines.Count);
        // pause: join1 pauses once at tick 20 and resumes 700 ms later; every peer sees both changes and no ticks in between
        long pausedAt = -1, gap = -1;
        lobby.Pause.Changed += s =>
        {
            if (s.Paused && pausedAt < 0) pausedAt = ls.Tick;
            else if (!s.Paused && pausedAt >= 0 && gap < 0) gap = ls.Tick - pausedAt;
        };
        if (isHost) { var st = lobby.StartAsync(); Wait(() => st.IsCompleted, lobby.Pump, limitMs); }
        int sent = 0; bool asked = false; long resumeAt = long.MaxValue; bool finished = false; uint finalHash = 0, finalCmds = 0;
        while (!finished)
        {
            lobby.Pump();
            while (ls.TryNextFrame(out var f))
            {
                for (var i = 0; i < 4; i++) Fnv((int)(f.Tick >> (8 * i)));
                foreach (var (peer, cmd) in f.Commands) { Fnv(peer); Fnv(peer >> 8); Fnv(cmd.Length); foreach (var b in cmd.Span) Fnv(b); cmds++; }
                tick = f.Tick;
                ls.ReportHash(tick, h);
                if (tick % 3 == 0 && tick <= CmdsEach * 3 && sent < CmdsEach) ls.Submit(new byte[] { (byte)lobby.LocalPeerId, (byte)++sent });
                if (tick == SyncTicks) { finalHash = h; finalCmds = cmds; finished = true; }
            }
            if (!asked && Name.StartsWith("join1", StringComparison.Ordinal) && tick >= 20) { asked = true; lobby.Pause.Request(true); resumeAt = Sw.ElapsedMilliseconds + 700; }
            if (Sw.ElapsedMilliseconds >= resumeAt) { resumeAt = long.MaxValue; lobby.Pause.Request(false); }
            if (Sw.ElapsedMilliseconds > limitMs) { why = $"lockstep stalled at tick {tick}"; return false; }
            Thread.Sleep(2);
        }
        // keep applying frames until the pause has come and gone
        var until = Sw.ElapsedMilliseconds + 6000;
        while (gap < 0 && Sw.ElapsedMilliseconds < until)
        {
            lobby.Pump();
            while (ls.TryNextFrame(out var f)) tick = f.Tick;
            if (Sw.ElapsedMilliseconds >= resumeAt) { resumeAt = long.MaxValue; lobby.Pause.Request(false); }
            Thread.Sleep(5);
        }
        if (gap < 0 || gap > 4) { why = "pause: " + (gap < 0 ? "never resumed" : gap + " frames arrived while paused"); return false; }
        Say($"LOCKSTEP tick={SyncTicks} hash={finalHash} cmds={finalCmds} pausegap={gap}");
        return true;
    }
}
