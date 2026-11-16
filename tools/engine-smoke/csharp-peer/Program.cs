using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using OneLobby;
using OneLobby.DataChannel;
using OneLobby.Direct;
using OneLobby.Direct.Nostr;
using OneLobby.Replication;

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
        ITransport transport = new DataChannelTransport { BindAddress = A.ContainsKey("loopback") ? "127.0.0.1" : null };
        // --scenario=players: fake lag on every link of this peer: --lag (one-way ms, both ends wrapped), --jitter, --loss (percent, fast channel), --seed
        if (A.GetValueOrDefault("scenario") == "players")
            transport = new NetSimTransport(transport, new NetSimOptions(LatencyMs: double.Parse(A.GetValueOrDefault("lag", "50"), Inv), JitterMs: double.Parse(A.GetValueOrDefault("jitter", "10"), Inv), LossPercent: double.Parse(A.GetValueOrDefault("loss", "2"), Inv), Seed: int.Parse(A.GetValueOrDefault("seed", "1"))));
        var client = new LobbyClient(cfg, transport);
        var nostr = new NostrOptions { Enabled = route != "typed" && route != "ipcode", Stun = new string[0] };
        if (A.TryGetValue("relay", out var relay)) nostr.Relays = new[] { relay };
        if (A.GetValueOrDefault("scenario") == "room")
        {
            try { return role == "host" ? RoomHost(client, route, limitMs) : RoomJoin(client, route, nostr, limitMs); }
            finally { client.DisposeAsync().AsTask().Wait(1000); }
        }
        if (A.GetValueOrDefault("scenario") == "players")
        {
            try { return role == "host" ? PlayersHost(client, route, limitMs) : PlayersJoin(client, route, nostr, limitMs); }
            finally { client.DisposeAsync().AsTask().Wait(1000); }
        }
        if (A.GetValueOrDefault("scenario") == "replication")
        {
            try { return role == "host" ? ReplHost(client, route, limitMs) : ReplJoin(client, route, nostr, limitMs); }
            finally { client.DisposeAsync().AsTask().Wait(1000); }
        }
        try { return role == "host" ? Host(client, route, joiners, rounds, turn, nostr, limitMs) : Join(client, route, rounds, turn, nostr, limitMs); }
        finally { client.DisposeAsync().AsTask().Wait(1000); }
    }

    // ---- room scenario (--scenario=room): the room layer end to end on one route (same protocol as js-peer.mjs) ----------------------
    private const string RoomPw = "smoke-pw";

    private static int RoomHost(LobbyClient client, string route, int limitMs)
    {
        var room = new RoomOptions { CountdownSeconds = 1, MinPlayers = 2 };
        Lobby lobby;
        string typed = "";
        if (route == "server")
        {
            var t = client.HostAsync(new LobbyOptions("smoke", 4) { Password = RoomPw, Room = room });
            if (!Wait(() => t.IsCompleted, client.Pump, limitMs)) return Finish(false, "host timeout");
            lobby = t.GetAwaiter().GetResult();
        }
        else
        {
            var port = int.Parse(A["port"]);
            var t = client.HostDirectAsync(new DirectHostOptions
            {
                Port = port, FallbackPorts = 0, BindAddress = System.Net.IPAddress.Loopback, PublicAddress = "127.0.0.1", OpenPort = false,
                MaxPlayers = 4, Password = RoomPw, Room = room, Nostr = new NostrOptions { Enabled = false },
            });
            if (!Wait(() => t.IsCompleted, client.Pump, limitMs)) return Finish(false, "host timeout");
            lobby = t.GetAwaiter().GetResult();
            typed = "127.0.0.1:" + port;
        }
        Say($"HOST_READY code={(route == "server" ? lobby.Code : typed)} typed={typed} ipcode=");
        bool Ready() => lobby.Room.Players.Count == 2 && lobby.Room.Players.All(p => p.Id == lobby.LocalPeerId || p.Ready);
        if (!Wait(Ready, lobby.Pump, limitMs)) return Finish(false, "no ready joiner");
        var j = lobby.Room.Players.First(p => p.Id != lobby.LocalPeerId);
        if (j.Data.GetValueOrDefault("color") != "#ff8800" || j.Data.GetValueOrDefault("team") != "1") return Finish(false, "joiner data was " + string.Join(",", j.Data.Select(kv => kv.Key + "=" + kv.Value)));
        var started = false;
        lobby.Room.Started += () => started = true;
        lobby.Room.Start();
        if (!Wait(() => started, lobby.Pump, limitMs)) return Finish(false, "start timed out");
        Say("started");
        lobby.Room.Kick(j.Id, "smoke_kick", "Smoke test: bye");
        if (!Wait(() => lobby.Room.Players.Count == 1, lobby.Pump, limitMs)) return Finish(false, "the kick did not remove the joiner");
        var until = Sw.ElapsedMilliseconds + 300;
        Wait(() => Sw.ElapsedMilliseconds > until, lobby.Pump, limitMs);
        var leave = lobby.LeaveAsync();
        Wait(() => leave.IsCompleted, lobby.Pump, limitMs);
        return Finish(true, "room host");
    }

    private static int RoomJoin(LobbyClient client, string route, NostrOptions nostr, int limitMs)
    {
        var code = A["code"];
        if (A.ContainsKey("wrongpw"))
        {
            Task<Lobby> bad = route == "server"
                ? client.JoinAsync(code, new RoomJoinOptions { Password = "wrong-pw" })
                : client.JoinDirectAsync(code, new JoinDirectOptions { Password = "wrong-pw", Nostr = nostr });
            if (!Wait(() => bad.IsCompleted, client.Pump, limitMs)) return Finish(false, "join timeout");
            if (bad.IsFaulted && bad.Exception!.GetBaseException() is OneLobbyException e && e.Code == "bad_password") return Finish(true, "refused with bad_password");
            return Finish(false, bad.IsFaulted ? "wrong password gave " + bad.Exception!.GetBaseException().Message : "a wrong password was accepted");
        }
        var data = new Dictionary<string, string> { ["color"] = "#ff8800", ["team"] = "1" };
        Task<Lobby> t = route == "server"
            ? client.JoinAsync(code, new RoomJoinOptions { Password = RoomPw, Data = data })
            : client.JoinDirectAsync(code, new JoinDirectOptions { Password = RoomPw, Data = data, Nostr = nostr });
        if (!Wait(() => t.IsCompleted, client.Pump, limitMs)) return Finish(false, "join timeout");
        var lobby = t.GetAwaiter().GetResult();
        RemovalInfo? removed = null;
        bool started = false, counted = false;
        lobby.Room.Removed += r => removed = r;
        lobby.Room.Started += () => started = true;
        lobby.Room.CountdownUpdated += _ => counted = true;
        if (!Wait(() => lobby.Room.Supported == true && lobby.Room.Me != null, lobby.Pump, limitMs)) return Finish(false, "no room snapshot");
        lobby.Room.SetReady(true);
        if (!Wait(() => started, lobby.Pump, limitMs)) return Finish(false, "start timed out");
        if (!counted) return Finish(false, "no countdown reached the joiner");
        if (!Wait(() => removed != null, lobby.Pump, limitMs)) return Finish(false, "no kick");
        var ok = removed!.Code == "smoke_kick" && removed.Reason == "Smoke test: bye";
        return Finish(ok, ok ? "room joiner" : "removal was " + removed.Code + "|" + removed.Reason);
    }

    // ---- replication scenario (--scenario=replication): the same flow and numbers as js-peer.mjs (see the comment there) ------------------
    private sealed class ReplState : IReplicatedEntity
    {
        public float X, Z, Yaw; public int Hp;
        public void Write(NetWriter w) { w.WriteQuantized(X, -256, 256, 16); w.WriteQuantized(Z, -256, 256, 16); w.WriteAngle(Yaw, 9); w.WriteBits((uint)Hp, 7); }
    }

    private struct ReplView : IReplicatedState<ReplView>
    {
        public float X, Z, Yaw; public uint Hp;
        public void Read(NetReader r) { X = r.ReadQuantized(-256, 256, 16); Z = r.ReadQuantized(-256, 256, 16); Yaw = r.ReadAngle(9); Hp = r.ReadBits(7); }
        public ReplView Interpolate(in ReplView to, float t) => t < 0.5f ? this : to;
    }

    private static void E1(ReplState s, long t) { var T = (int)Math.Min(t, 60); s.X = -100f + 1.5f * T; s.Z = 20; s.Yaw = T * 7 % 360; s.Hp = 100 - T % 10; }
    private static void E2(ReplState s, long t) { var T = (int)Math.Min(t, 60); s.X = 50f - 0.5f * T; s.Z = -20; s.Yaw = T * 3 % 360; s.Hp = 90; }

    private static uint ReplHash(int owner, ReplState s)
    {
        var w = new NetWriter();
        s.Write(w);
        var h = 0x811c9dc5u;
        foreach (var b in new byte[] { 1, 1, (byte)owner }.Concat(w.ToArray())) h = unchecked((h ^ b) * 16777619u);
        return h;
    }

    // ---- players scenario (--scenario=players): the networked player layer between engines over a lagging link; the same flow in the JS, GDScript and C# peers ----
    // THE RULE (README, "The players scenario"; every peer writes it once in its own language):
    //   walk (t seconds from the walk start): heading h = 0.75 * t rad, speed 6 m/s: x = 8 (1 - cos h), z = 8 sin h, v = 6 (sin h, cos h), yaw = h in degrees [0, 360);
    //   jump at t = 2 s: y = 5 s - 7.5 s^2 for s = t - 2 in [0, 2/3), on the ground otherwise; mode 4 in the air, 1 walking, 0 standing; stand at t >= 6.
    //   authority "owner": the joiner gives that state as its own every loop. authority "host": the joiner gives the input moveY 1 (0 from t = 6), yaw = h in
    //   degrees, jump pressed for t in [2, 2.1), and both ends run the same step (below). One jump action event at t = 2 in both.
    private const double PSpeed = 6, PW = 0.75, PJumpAt = 2, PJumpV = 5, PGrav = 15, PWalkS = 6;
    private const int PSettleMs = 1500, PHoldMs = 1000, PChunk = 20;
    private const byte PMsg = 0x54;
    private static readonly System.Globalization.CultureInfo Inv = System.Globalization.CultureInfo.InvariantCulture;

    private static PlayerState PathState(double t)
    {
        var tt = Math.Min(Math.Max(t, 0), PWalkS);
        var h = PW * tt;
        var R = PSpeed / PW;
        var s = tt - PJumpAt;
        var air = s >= 0 && s < 2 * PJumpV / PGrav;
        var walking = t >= 0 && t < PWalkS;
        return new PlayerState
        {
            X = R * (1 - Math.Cos(h)), Z = R * Math.Sin(h), Y = air ? PJumpV * s - 0.5 * PGrav * s * s : 0,
            Vx = walking ? PSpeed * Math.Sin(h) : 0, Vz = walking ? PSpeed * Math.Cos(h) : 0, Vy = air ? PJumpV - PGrav * s : 0,
            Yaw = h * 180 / Math.PI % 360, OnGround = !air, Mode = air ? 4 : walking ? 1 : 0,
        };
    }

    private static NetPlayerInput PathInput(double t) => new()
    {
        MoveX = 0, MoveY = t >= 0 && t < PWalkS ? 1 : 0, Yaw = PW * Math.Min(Math.Max(t, 0), PWalkS) * 180 / Math.PI % 360,
        Buttons = t >= PJumpAt && t < PJumpAt + 0.1 ? PlayerButtons.Jump : PlayerButtons.None,
    };

    private static PlayerState PlayerStep(PlayerState s, NetPlayerInput i, double dt)
    {
        var yaw = i.Yaw * Math.PI / 180;
        var vx = PSpeed * (i.MoveY * Math.Sin(yaw) + i.MoveX * Math.Cos(yaw));
        var vz = PSpeed * (i.MoveY * Math.Cos(yaw) - i.MoveX * Math.Sin(yaw));
        double y = s.Y, vy = s.Vy;
        var onGround = s.OnGround;
        if (onGround && (i.Buttons & PlayerButtons.Jump) != 0) { vy = PJumpV; onGround = false; }
        if (!onGround) { vy -= PGrav * dt; y += vy * dt; if (y <= 0) { y = 0; vy = 0; onGround = true; } }
        s.X += vx * dt; s.Z += vz * dt; s.Y = y; s.Vx = vx; s.Vz = vz; s.Vy = vy; s.Yaw = i.Yaw; s.OnGround = onGround;
        s.Mode = onGround ? (i.MoveX != 0 || i.MoveY != 0 ? 1 : 0) : 4;
        return s;
    }

    // the owner's position at time t by linear interpolation of a trace [[unix ms, x, y, z], ...]; null outside the trace
    private static double[]? TraceAt(List<double[]> path, double t)
    {
        var n = path.Count;
        if (n == 0 || t < path[0][0] || t > path[n - 1][0]) return null;
        int lo = 0, hi = n - 1;
        while (hi - lo > 1) { var m = (lo + hi) >> 1; if (path[m][0] <= t) lo = m; else hi = m; }
        var p = path[lo]; var q = path[hi];
        var k = q[0] == p[0] ? 0 : (t - p[0]) / (q[0] - p[0]);
        return new[] { p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k, p[3] + (q[3] - p[3]) * k };
    }

    // the one constant lag (0 to 600 ms, 8 ms steps) at which the watched path is closest to the owner's on average; then the mean and worst distance there
    private static (int Lag, double Mean, double Max, int N) ComparePaths(List<double[]> owner, List<double[]> watched)
    {
        var best = (Lag: 0, Mean: double.PositiveInfinity, Max: double.PositiveInfinity, N: 0);
        for (var lag = 0; lag <= 600; lag += 8)
        {
            double sum = 0, mx = 0; var n = 0;
            foreach (var w in watched)
            {
                var o = TraceAt(owner, w[0] - lag);
                if (o == null) continue;
                var d = Math.Sqrt((w[1] - o[0]) * (w[1] - o[0]) + (w[2] - o[1]) * (w[2] - o[1]) + (w[3] - o[2]) * (w[3] - o[2]));
                sum += d; mx = Math.Max(mx, d); n++;
            }
            if (n > 20 && sum / n < best.Mean) best = (lag, sum / n, mx, n);
        }
        return best;
    }

    private static byte[] TMsg(string text) => new[] { PMsg }.Concat(Encoding.UTF8.GetBytes(text)).ToArray();
    private static long UnixMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private static NetPlayers MakePlayers(Lobby lobby, bool hostAuth) =>
        new(lobby, new NetPlayersOptions { Authority = hostAuth ? PlayerAuthority.Host : PlayerAuthority.Owner, Step = hostAuth ? PlayerStep : null });

    private static int PlayersHost(LobbyClient client, string route, int limitMs)
    {
        var hostAuth = A.GetValueOrDefault("authority") == "host";
        Lobby lobby;
        string typed = "";
        if (route == "server")
        {
            var t = client.HostAsync(new LobbyOptions("smoke", 4));
            if (!Wait(() => t.IsCompleted, client.Pump, limitMs)) return Finish(false, "host timeout");
            lobby = t.GetAwaiter().GetResult();
        }
        else
        {
            var port = int.Parse(A["port"]);
            var t = client.HostDirectAsync(new DirectHostOptions
            {
                Port = port, FallbackPorts = 0, BindAddress = System.Net.IPAddress.Loopback, PublicAddress = "127.0.0.1", OpenPort = false,
                MaxPlayers = 4, Nostr = new NostrOptions { Enabled = false },
            });
            if (!Wait(() => t.IsCompleted, client.Pump, limitMs)) return Finish(false, "host timeout");
            lobby = t.GetAwaiter().GetResult();
            typed = "127.0.0.1:" + port;
        }
        Say($"HOST_READY code={(route == "server" ? lobby.Code : typed)} typed={typed} ipcode=");
        var ready = new HashSet<int>();
        lobby.PeerReady += p => ready.Add(p.PeerId);
        if (!Wait(() => ready.Count >= 1, lobby.Pump, limitMs)) return Finish(false, "no linked joiner");
        var joiner = ready.First();
        var players = MakePlayers(lobby, hostAuth);
        if (!hostAuth) players.SetLocalState(new PlayerState());
        int jumpsCopy = 0, remoteJumps = -1;
        var ended = false;
        var own = new List<double[]>(); var copy = new List<double[]>();
        players.OnAction += e => { if (e.Name == PlayerAction.Jump && e.Player == joiner) jumpsCopy++; };
        players.Session.OtherMessage += (_, p, _) =>
        {
            var span = p.Span;
            if (span.Length < 2 || span[0] != PMsg) return;
            var f = Encoding.UTF8.GetString(span.Slice(1)).Split('|'); // "S|t,x,y,z;t,x,y,z" a part of the trace, "E|<jumps>" the end
            if (f[0] == "S") { foreach (var row in f[1].Split(';')) { var c = row.Split(',').Select(v => double.Parse(v, Inv)).ToArray(); if (c.Length == 4) own.Add(c); } }
            else if (f[0] == "E") { remoteJumps = int.Parse(f[1], Inv); ended = true; }
        };
        long lastCopy = 0;
        while (!ended)
        {
            players.Pump();
            var now = UnixMs();
            if (now - lastCopy >= 20) { lastCopy = now; if (players.TryGet(joiner, out var s)) copy.Add(new[] { (double)now, s.X, s.Y, s.Z }); }
            if (Sw.ElapsedMilliseconds > limitMs - 3000) return Finish(false, $"timed out: the joiner's trace ({own.Count} samples so far, {copy.Count} copies)");
            Thread.Sleep(2);
        }
        var r = ComparePaths(own, copy);
        Say($"PLAYERS lag={r.Lag} mean={r.Mean.ToString("F3", Inv)} worst={r.Max.ToString("F3", Inv)} samples={r.N} jumps={remoteJumps}/{jumpsCopy}");
        lobby.Send(joiner, TMsg("D"));
        var until = Sw.ElapsedMilliseconds + 600;
        Wait(() => Sw.ElapsedMilliseconds > until, players.Pump, limitMs);
        var flush = lobby.FlushAsync(TimeSpan.FromSeconds(1));
        Wait(() => flush.IsCompleted, lobby.Pump, limitMs);
        var leave = lobby.LeaveAsync();
        Wait(() => leave.IsCompleted, lobby.Pump, limitMs);
        var ok = double.IsFinite(r.Mean) && players.Session.Stats.Malformed == 0;
        return Finish(ok, ok ? $"players host ({(hostAuth ? "host" : "owner")})" : $"players: no comparison or malformed={players.Session.Stats.Malformed}");
    }

    private static int PlayersJoin(LobbyClient client, string route, NostrOptions nostr, int limitMs)
    {
        var hostAuth = A.GetValueOrDefault("authority") == "host";
        var code = A["code"];
        Task<Lobby> t = route == "server" ? client.JoinAsync(code) : client.JoinDirectAsync(code, new JoinDirectOptions { Nostr = nostr });
        if (!Wait(() => t.IsCompleted, client.Pump, limitMs)) return Finish(false, "join timeout");
        var lobby = t.GetAwaiter().GetResult();
        if (!Wait(() => lobby.ReadyAsync.IsCompleted, lobby.Pump, limitMs) || !lobby.ReadyAsync.IsCompletedSuccessfully) return Finish(false, "link to host not open");
        var players = MakePlayers(lobby, hostAuth);
        int jumpsOwn = 0;
        var done = false;
        players.OnAction += e => { if (e.Name == PlayerAction.Jump && e.Local) jumpsOwn++; };
        players.Session.OtherMessage += (_, p, _) => { var span = p.Span; if (span.Length == 2 && span[0] == PMsg && span[1] == (byte)'D') done = true; };
        void Drive(double tt) { if (!hostAuth) players.SetLocalState(PathState(tt)); else players.SetLocalInput(PathInput(tt)); }
        Drive(-1);
        var rows = new List<(long At, PlayerState S)>();
        var phase = "wait";
        long mark = 0, t00 = UnixMs();
        var jumped = false;
        long lastTick = -1;
        while (phase != "sent")
        {
            var now = UnixMs();
            if (phase == "wait" && (hostAuth ? players.Local != null : players.Players.Contains(lobby.LocalPeerId))) { phase = "settle"; mark = now; }
            if (phase == "settle" && now - mark >= PSettleMs) { phase = "walk"; mark = now; }
            var tt = phase == "walk" || phase == "hold" ? (now - mark) / 1000.0 : -1;
            Drive(tt);
            if (tt >= PJumpAt && !jumped) { jumped = true; players.Action(PlayerAction.Jump); }
            players.Pump();
            if (phase == "walk" && (long)players.Session.Clock.Tick != lastTick)
            {
                lastTick = (long)players.Session.Clock.Tick;
                if (players.Local is { } l) rows.Add((now, l));
            }
            if (phase == "walk" && tt >= PWalkS) phase = "hold";
            if (phase == "hold" && tt >= PWalkS + PHoldMs / 1000.0)
            {
                for (var i = 0; i < rows.Count; i += PChunk)
                    lobby.Send(lobby.HostPeerId, TMsg("S|" + string.Join(";", rows.Skip(i).Take(PChunk).Select(r => string.Join(",", r.At.ToString(Inv), r.S.X.ToString("F3", Inv), r.S.Y.ToString("F3", Inv), r.S.Z.ToString("F3", Inv))))));
                lobby.Send(lobby.HostPeerId, TMsg($"E|{jumpsOwn}"));
                Say($"PLAYERS_JOINER samples={rows.Count} jumps={jumpsOwn}");
                phase = "sent";
            }
            if (phase == "wait" && now - t00 > 60000) return Finish(false, "the player never came into the world");
            Thread.Sleep(2);
        }
        var until = Sw.ElapsedMilliseconds + 20000;
        Wait(() => done || Sw.ElapsedMilliseconds > until, players.Pump, limitMs);
        var flush = lobby.FlushAsync(TimeSpan.FromSeconds(1));
        Wait(() => flush.IsCompleted, lobby.Pump, limitMs);
        var leave = lobby.LeaveAsync();
        Wait(() => leave.IsCompleted, lobby.Pump, limitMs);
        var ok = done && jumpsOwn == 1 && players.Session.Stats.Malformed == 0;
        return Finish(ok, ok ? $"players joiner ({(hostAuth ? "host" : "owner")})" : $"players joiner: done={done} jumps={jumpsOwn} malformed={players.Session.Stats.Malformed}");
    }

    private static int ReplHost(LobbyClient client, string route, int limitMs)
    {
        Lobby lobby;
        string typed = "";
        if (route == "server")
        {
            var t = client.HostAsync(new LobbyOptions("smoke", 4));
            if (!Wait(() => t.IsCompleted, client.Pump, limitMs)) return Finish(false, "host timeout");
            lobby = t.GetAwaiter().GetResult();
        }
        else
        {
            var port = int.Parse(A["port"]);
            var t = client.HostDirectAsync(new DirectHostOptions
            {
                Port = port, FallbackPorts = 0, BindAddress = System.Net.IPAddress.Loopback, PublicAddress = "127.0.0.1", OpenPort = false,
                MaxPlayers = 4, Nostr = new NostrOptions { Enabled = false },
            });
            if (!Wait(() => t.IsCompleted, client.Pump, limitMs)) return Finish(false, "host timeout");
            lobby = t.GetAwaiter().GetResult();
            typed = "127.0.0.1:" + port;
        }
        Say($"HOST_READY code={(route == "server" ? lobby.Code : typed)} typed={typed} ipcode=");
        var ready = new HashSet<int>();
        lobby.PeerReady += p => ready.Add(p.PeerId);
        if (!Wait(() => ready.Count >= 1, lobby.Pump, limitMs)) return Finish(false, "no linked joiner");
        var joiner = ready.First();
        var rep = new ReplicationSession(lobby);
        ReplState e1 = new(), e2 = new();
        E1(e1, 0); E2(e2, 0);
        int spawned = 0, despawned = 0, events = 0;
        var bye = false;
        var bad = "";
        rep.Spawn(1, 0, e1); spawned++;
        var id2 = rep.Spawn(2, joiner, e2); spawned++;
        rep.EventReceived += (_, _, p) => { var s = Encoding.UTF8.GetString(p.Span); if (s == "hello-host") events++; else bad = "event " + s; };
        rep.OtherMessage += (_, p, _) => { if (Encoding.UTF8.GetString(p.Span) == "bye") bye = true; };
        var seqs = new List<uint>();
        while (!(bye && rep.Clock.Tick >= 75 && events == 1))
        {
            rep.Pump();
            while (rep.Clock.TryAdvance())
            {
                var t = rep.Clock.Tick;
                E1(e1, t); E2(e2, t);
                if (t == 10) rep.SendEvent(B("hello-client"), joiner, Channel.Reliable, 1);
                if (t == 40) { rep.Despawn(id2); despawned++; }
                if (rep.TryGetInput(joiner, out var f) && !f.Repeated)
                {
                    seqs.Add(f.Seq);
                    if (f.Bytes.Length != 1 || f.Bytes.Span[0] != (byte)(f.Seq & 255)) bad = "input bytes of seq " + f.Seq;
                }
                rep.SendSnapshot();
            }
            Thread.Sleep(2);
            if (Sw.ElapsedMilliseconds > limitMs) return Finish(false, $"stalled: bye {bye} tick {rep.Clock.Tick} events {events}");
        }
        var contiguous = seqs.Count >= 20 && Enumerable.Range(1, seqs.Count - 1).All(i => seqs[i] == seqs[i - 1] + 1);
        Say($"REPL spawned={spawned} despawned={despawned} entities={rep.HostEntities.Count()} events={events} hash={ReplHash(0, e1)}");
        var until = Sw.ElapsedMilliseconds + 300;
        Wait(() => Sw.ElapsedMilliseconds > until, rep.Pump, limitMs);
        var leave = lobby.LeaveAsync();
        Wait(() => leave.IsCompleted, lobby.Pump, limitMs);
        var ok = contiguous && bad == "" && rep.Stats.Malformed == 0;
        return Finish(ok, ok ? "replication host" : $"inputs {seqs.Count} contiguous={contiguous} {bad} malformed={rep.Stats.Malformed}");
    }

    private static int ReplJoin(LobbyClient client, string route, NostrOptions nostr, int limitMs)
    {
        var code = A["code"];
        Task<Lobby> t = route == "server" ? client.JoinAsync(code) : client.JoinDirectAsync(code, new JoinDirectOptions { Nostr = nostr });
        if (!Wait(() => t.IsCompleted, client.Pump, limitMs)) return Finish(false, "join timeout");
        var lobby = t.GetAwaiter().GetResult();
        if (!Wait(() => lobby.ReadyAsync.IsCompleted, lobby.Pump, limitMs) || !lobby.ReadyAsync.IsCompletedSuccessfully) return Finish(false, "link to host not open");
        var rep = new ReplicationSession(lobby);
        int spawned = 0, despawned = 0, events = 0;
        var said = false;
        rep.EntitySpawned += _ => { spawned++; if (!said) { said = true; rep.SendEvent(B("hello-host")); } };
        rep.EntityDespawned += _ => despawned++;
        rep.EventDelivered += e => { if (Encoding.UTF8.GetString(e.Payload.Span) == "hello-client" && e.Stream == 1 && e.Seq == 1) events++; };
        while (!(spawned == 2 && despawned == 1 && events == 1 && rep.LatestTick >= 66 && rep.LastProcessedInput > 0))
        {
            rep.Pump();
            while (rep.Clock.TryAdvance()) rep.SubmitInput(new[] { (byte)(rep.Clock.Tick & 255) });
            Thread.Sleep(2);
            if (Sw.ElapsedMilliseconds > limitMs) return Finish(false, $"stalled: spawned {spawned} despawned {despawned} events {events} latest {rep.LatestTick}");
        }
        rep.TryGetLatest<ReplView>(new NetId(1), out var latest, out _);
        var s = new ReplState { X = latest.X, Z = latest.Z, Yaw = latest.Yaw, Hp = (int)latest.Hp };
        Say($"REPL spawned={spawned} despawned={despawned} entities={rep.Entities.Count} events={events} hash={ReplHash(0, s)}");
        lobby.Send(lobby.HostPeerId, B("bye"));
        var until = Sw.ElapsedMilliseconds + 500;
        Wait(() => Sw.ElapsedMilliseconds > until, rep.Pump, limitMs);
        var flush = lobby.FlushAsync(TimeSpan.FromSeconds(1));
        Wait(() => flush.IsCompleted, lobby.Pump, limitMs);
        var leave = lobby.LeaveAsync();
        Wait(() => leave.IsCompleted, lobby.Pump, limitMs);
        var e1 = new ReplState(); E1(e1, 60);
        var ok = rep.Stats.Malformed == 0 && rep.Entities.Count == 1 && Math.Abs(latest.X - e1.X) < 0.01f;
        return Finish(ok, ok ? "replication joiner" : $"malformed={rep.Stats.Malformed} entities={rep.Entities.Count} x={latest.X}");
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
