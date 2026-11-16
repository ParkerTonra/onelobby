using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Godot;
using OneLobby;
using OneLobby.Replication;

namespace OneLobbyDemo;

/// <summary>
/// The headless two-process check of the sample (<c>--netplayer-test</c> after <c>--</c> on both sides, run by
/// clients/dotnet/demo-godot/net-player-test.sh): the joiner walks a scripted path and jumps once; the host records where its copy of the
/// joiner's character is; the joiner sends its own trace to the host at the end; the host compares the two paths and prints
/// NETPLAYER_OK or NETPLAYER_FAIL &lt;why&gt;. Both sides read the same wall clock, so the traces line up (the comparison also looks for the
/// one constant lag where they match best, like D1: the lag is the render delay plus the link). The twin of the GDScript autotest.gd, with
/// the same log lines. The self-check runs the same class on an in-memory network with a virtual clock (<see cref="Clock"/>).
/// <para>Bounds (spec/net-player.md section 11, D1): worst error under 0.5 m and mean under 0.15 m at the best lag. The check passes only when
/// the joiner jumped once, the host's copy jumped once, and the copy ended near where the joiner stopped.</para>
/// </summary>
public partial class NetPlayerAutotest : Node
{
    public const double MaxError = 0.5;
    public const double MeanError = 0.15;
    private const double SettleMs = 1500.0;
    private const double WalkEndMs = 6500.0;
    private const double TimeoutMs = 45000.0;
    private const int Chunk = 20;
    private const byte MsgByte = 0x54; // 'T': raw messages that are not replication ones (those start with 0x52)

    public NetPlayerGame Game { get; private set; } = null!;
    public NetPlayers Players { get; private set; } = null!;
    public bool IsHost { get; private set; }

    /// <summary>Milliseconds of the clock (default: the wall clock); the self-check gives its virtual one.</summary>
    public Func<double>? Clock { get; set; }

    /// <summary>The verdict, once there is one: null while running, "" for OK, else the reason.</summary>
    public string? Verdict { get; private set; }

    /// <summary>The last NETPLAYER_NUMBERS line (the host's).</summary>
    public string Numbers { get; private set; } = "";

    public CompareResult Result { get; private set; }
    public int JumpsSeen => _jumpsSeen;
    public int JoinerJumps => _remoteJumps;
    public double EndGap { get; private set; }

    /// <summary>Quit the engine when done (the real run); the self-check turns it off.</summary>
    public bool QuitWhenDone { get; set; } = true;

    private double _tStart = -1.0;
    private double _tBoot;
    private int _peer; // the other player (the joiner, on the host)
    private readonly List<double[]> _own = new(); // [t_ms, x, y, z]
    private readonly List<double[]> _copy = new();
    private int _jumpsSeen, _jumpsOwn, _remoteJumps = -1;
    private bool _sent, _done, _jumpDone;
    private readonly List<double[]> _remoteTrace = new();
    private double[] _remoteFinal = new double[3];
    private double _sampleAt;

    private double Now() => Clock != null ? Clock() : Time.GetUnixTimeFromSystem() * 1000.0;

    public void Attach(NetPlayerGame game)
    {
        Game = game;
        Players = game.Players;
        IsHost = Players.IsHost;
        _tBoot = Now();
        if (Clock == null) Engine.MaxFps = 60;
        Players.Session.OtherMessage += OnOther;
        GD.Print("NETPLAYER_" + (IsHost ? "HOST" : "JOINER") + "_READY");
    }

    public override void _Process(double delta)
    {
        if (_done || Players == null) return;
        var now = Now();
        if (now - _tBoot > TimeoutMs)
        {
            Finish(false, "timeout: the other player or its trace never came");
            return;
        }
        if (_peer == 0)
        {
            foreach (var p in Players.Players)
            {
                var c = Game.Spawner.CharacterOf(p) as Node3D;
                if (p != Players.LocalPeerId && c != null && c.Visible && Game.Spawner.CharacterOf(Players.LocalPeerId) != null)
                {
                    _peer = p;
                    _tStart = now + SettleMs;
                    Watch();
                    break;
                }
            }
            return;
        }
        if (now - _sampleAt < 50.0) return;
        _sampleAt = now;
        var elapsed = now - _tStart;
        if (IsHost)
        {
            if (Game.Spawner.CharacterOf(_peer) is Node3D c && c.Visible && elapsed > -SettleMs)
            {
                var g = c.GlobalPosition;
                _copy.Add(new double[] { now, g.X, g.Y, g.Z });
            }
        }
        else
        {
            var me = Game.Spawner.CharacterOf(Players.LocalPeerId) as Node3D;
            if (me != null && elapsed >= 0.0)
            {
                var g = me.GlobalPosition;
                _own.Add(new double[] { now, g.X, g.Y, g.Z });
            }
            if (elapsed >= WalkEndMs && !_sent && me != null) SendTrace(me);
        }
    }

    private void Watch()
    {
        var np = ((NetPlayerCharacter)Game.Spawner.CharacterOf(_peer)!).Net;
        np.Jumped += () => _jumpsSeen++;
        if (IsHost) return;
        // the joiner's own character walks the script; the host's copy of the host's character just stands
        var me = (NetPlayerCharacter)Game.Spawner.CharacterOf(Players.LocalPeerId)!;
        me.Scripted = Script;
        me.Net.Jumped += () => _jumpsOwn++;
    }

    /// <summary>The joiner's path: stand 1 s, walk +x for 2.5 s (jump once at 1 s into the walk), walk +z for 1.5 s, stand.</summary>
    private (Vector2 Move, bool Jump) Script()
    {
        var t = Now() - _tStart;
        var move = Vector2.Zero;
        if (t >= 1000.0 && t < 3500.0) move = new Vector2(1f, 0f);
        else if (t >= 3500.0 && t < 5000.0) move = new Vector2(0f, 1f);
        var jump = false;
        if (t >= 2000.0 && !_jumpDone)
        {
            _jumpDone = true;
            jump = true;
        }
        return (move, jump);
    }

    private void SendTrace(Node3D me)
    {
        _sent = true;
        var lobby = Players.Session.Lobby;
        var host = Players.Session.HostPeerId;
        for (var i = 0; i < _own.Count; i += Chunk)
        {
            var part = new List<string>();
            for (var k = i; k < Math.Min(i + Chunk, _own.Count); k++)
            {
                var s = _own[k];
                part.Add(string.Format(CultureInfo.InvariantCulture, "{0},{1:0.000},{2:0.000},{3:0.000}", (long)s[0], s[1], s[2], s[3]));
            }
            Send(lobby, host, new Dictionary<string, object> { ["trace"] = part });
        }
        var g = me.GlobalPosition;
        Send(lobby, host, new Dictionary<string, object> { ["end"] = true, ["jumps"] = _jumpsOwn, ["final"] = new[] { (double)g.X, g.Y, g.Z } });
        GD.Print("NETPLAYER_JOINER_DONE samples=" + _own.Count + " jumps=" + _jumpsOwn);
        GetTree().CreateTimer(2.0).Timeout += () => Finish(true, "");
    }

    private static void Send(Lobby lobby, int to, Dictionary<string, object> msg)
    {
        var json = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(msg));
        var b = new byte[json.Length + 1];
        b[0] = MsgByte;
        Buffer.BlockCopy(json, 0, b, 1, json.Length);
        lobby.Send(to, b, Channel.Reliable);
    }

    private void OnOther(int from, ReadOnlyMemory<byte> bytes, Channel channel)
    {
        if (!IsHost || bytes.Length < 2 || bytes.Span[0] != MsgByte) return;
        JsonDocument doc;
        try { doc = JsonDocument.Parse(bytes.Slice(1)); } catch (JsonException) { return; }
        using (doc)
        {
            var d = doc.RootElement;
            if (d.ValueKind != JsonValueKind.Object) return;
            if (d.TryGetProperty("trace", out var trace))
            {
                foreach (var line in trace.EnumerateArray())
                {
                    var f = (line.GetString() ?? "").Split(',');
                    if (f.Length == 4) _remoteTrace.Add(new[] { P(f[0]), P(f[1]), P(f[2]), P(f[3]) });
                }
            }
            if (d.TryGetProperty("end", out _))
            {
                _remoteJumps = d.GetProperty("jumps").GetInt32();
                var f = d.GetProperty("final");
                _remoteFinal = new[] { f[0].GetDouble(), f[1].GetDouble(), f[2].GetDouble() };
                Evaluate();
            }
        }
    }

    private static double P(string s) => double.Parse(s, CultureInfo.InvariantCulture);

    private void Evaluate()
    {
        var r = ComparePaths(_remoteTrace, _copy);
        Result = r;
        var cf = _copy.Count > 0 ? _copy[_copy.Count - 1] : new double[] { 0, 1e9, 0, 0 };
        EndGap = Math.Sqrt((cf[1] - _remoteFinal[0]) * (cf[1] - _remoteFinal[0]) + (cf[3] - _remoteFinal[2]) * (cf[3] - _remoteFinal[2]));
        Numbers = string.Format(CultureInfo.InvariantCulture, "NETPLAYER_NUMBERS lag {0} ms, mean {1:0.000} m, worst {2:0.000} m, compared {3} samples, joiner jumps {4}, copy jumps {5}, end gap {6:0.00} m",
            r.LagMs, r.Mean, r.Max, r.N, _remoteJumps, _jumpsSeen, EndGap);
        GD.Print(Numbers);
        var why = "";
        if (r.N < 20) why = "too few samples to compare (" + r.N + ")";
        else if (r.Max >= MaxError) why = string.Format(CultureInfo.InvariantCulture, "worst error {0:0.000} m is over {1:0.0} m", r.Max, MaxError);
        else if (r.Mean >= MeanError) why = string.Format(CultureInfo.InvariantCulture, "mean error {0:0.000} m is over {1:0.00} m", r.Mean, MeanError);
        else if (_remoteJumps != 1) why = "the joiner jumped " + _remoteJumps + " times, expected 1";
        else if (_jumpsSeen != 1) why = "the host's copy jumped " + _jumpsSeen + " times, expected 1";
        else if (EndGap > 1.0) why = string.Format(CultureInfo.InvariantCulture, "the copy ended {0:0.00} m from where the joiner stopped", EndGap);
        Finish(why == "", why);
    }

    private void Finish(bool ok, string why)
    {
        if (_done) return;
        _done = true;
        Verdict = ok ? "" : why;
        if (IsHost) GD.Print(ok ? "NETPLAYER_OK" : "NETPLAYER_FAIL " + why);
        else if (!ok) GD.Print("NETPLAYER_FAIL " + why);
        if (QuitWhenDone) GetTree().Quit(ok ? 0 : 1);
    }

    public readonly record struct CompareResult(int LagMs, double Mean, double Max, int N);

    /// <summary>The owner's position at time <paramref name="t"/> (ms), interpolated between its samples <c>[t, x, y, z]</c>; false outside the path.</summary>
    public static bool At(List<double[]> path, double t, out double x, out double y, out double z)
    {
        x = y = z = 0;
        var n = path.Count;
        if (n == 0 || t < path[0][0] || t > path[n - 1][0]) return false;
        int lo = 0, hi = n - 1;
        while (hi - lo > 1)
        {
            var m = (lo + hi) >> 1;
            if (path[m][0] <= t) lo = m; else hi = m;
        }
        var a = path[lo];
        var b = path[hi];
        var k = b[0] == a[0] ? 0.0 : (t - a[0]) / (b[0] - a[0]);
        x = a[1] + (b[1] - a[1]) * k;
        y = a[2] + (b[2] - a[2]) * k;
        z = a[3] + (b[3] - a[3]) * k;
        return true;
    }

    /// <summary>Two paths that are a render delay apart: the one constant lag (0 to 600 ms, 8 ms steps) at which the watched path is closest to the owner's on average, then the mean and worst distance at that lag.</summary>
    public static CompareResult ComparePaths(List<double[]> owner, List<double[]> watched)
    {
        var best = new CompareResult(0, double.PositiveInfinity, double.PositiveInfinity, 0);
        for (var lag = 0; lag <= 600; lag += 8)
        {
            double sum = 0, mx = 0;
            var n = 0;
            foreach (var w in watched)
            {
                if (!At(owner, w[0] - lag, out var ox, out var oy, out var oz)) continue;
                var d = Math.Sqrt((w[1] - ox) * (w[1] - ox) + (w[2] - oy) * (w[2] - oy) + (w[3] - oz) * (w[3] - oz));
                sum += d;
                mx = Math.Max(mx, d);
                n++;
            }
            if (n > 20 && sum / n < best.Mean) best = new CompareResult(lag, sum / n, mx, n);
        }
        return best;
    }
}
