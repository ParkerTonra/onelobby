using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using Godot;
using OneLobby;
using OneLobby.Replication;

namespace OneLobbyDemo;

/// <summary>
/// A headless check of the Godot C# networked player (OneLobbyNetPlayer, OneLobbyNetPlayerSpawner and the sample), run by
/// <c>NetPlayerDemo.tscn -- --netplayer-selfcheck</c>. Everything runs in this one process on an in-memory network with a virtual clock:
/// no socket is opened. Each case makes a host and two clients (each with a world node and a spawner of its own), then calls the nodes'
/// physics and render frames by hand after each network step, like the engine would, so the cases are deterministic. The last case runs the
/// sample (NetPlayerGame and NetPlayerAutotest, the scripted walk of --netplayer-test) between a host and a joiner with real physics frames.
/// It prints <c>NETPLAYER_SELF_OK (n checks)</c> or <c>NETPLAYER_SELF_FAIL ...</c> as its last line and quits (exit code 0 or 1). The
/// "ERROR:" lines of the 2D / 3D mismatch are expected. CI has only the non-.NET Godot, so this runs with the .NET build:
///   Godot_mono_console --headless --path clients/dotnet/demo-godot res://NetPlayerDemo.tscn -- --netplayer-selfcheck
/// </summary>
public partial class NetPlayerSelfCheck : Node
{
    private readonly List<string> _failures = new();
    private int _checks;
    private bool _done;
    private ulong _startedAt;
    private Cluster? _drive; // while set, every physics tick moves this cluster's virtual clock (the sample case)

    private sealed class Machine
    {
        public string Name = "";
        public LobbyClient Client = null!;
        public Lobby Lobby = null!;
        public Node World = null!;
        public OneLobbyNetPlayerSpawner? Spawner;
        public NetPlayers? Layer;
        public bool Frozen;
        public bool Pumped = true; // false: something else pumps this machine's layer (the sample's own spawner)
        public readonly List<(int Peer, bool Local)> Spawned = new();
        public int Peer => Lobby.LocalPeerId;
    }

    private sealed class Cluster
    {
        public readonly InMemoryNetwork Net = new() { LatencyMs = 30 };
        public readonly List<Machine> Machines = new();
        public Machine Host => Machines[0];

        public void Pump()
        {
            foreach (var m in Machines)
            {
                if (m.Frozen || !m.Pumped) continue;
                if (m.Layer != null) m.Layer.Pump(); else m.Client.Pump();
            }
        }

        /// <summary>One network frame of 16 ms on every machine.</summary>
        public void Step()
        {
            Net.Advance(16);
            Pump();
        }
    }

    public override void _Ready() => Run();

    public override void _PhysicsProcess(double delta)
    {
        if (_drive == null) return;
        _drive.Net.Advance(16);
        foreach (var m in _drive.Machines) if (m.Pumped && !m.Frozen) m.Client.Pump();
    }

    public override void _Process(double delta)
    {
        if (!_done && Time.GetTicksMsec() - _startedAt > 240_000)
        {
            Check(false, "timed out");
            Finish();
        }
    }

    private async void Run()
    {
        _startedAt = Time.GetTicksMsec();
        await Frames(2); // the root is still setting up its children in _Ready
        try
        {
            await Case("owner_3d", Owner3D);
            await Case("host_authority", HostAuthority);
            await Case("host_authority_spawn_point", HostAuthoritySpawnPoint);
            await Case("events_signals_animation", EventsAndAnimation);
            await Case("hide_until_first_state", HideUntilFirstState);
            await Case("2d_and_mismatch", TwoDAndMismatch);
            await Case("leave_and_spectator", LeaveAndSpectator);
            await Case("teleport_and_corrections", TeleportAndCorrections);
            await Case("body_and_missing_step", BodyAndMissingStep);
            await Case("spawner", SpawnerLifetime);
            await Case("allocation", Allocation);
            await Case("sample_trace", SampleTrace);
        }
        catch (Exception e)
        {
            Check(false, "exception: " + e);
        }
        Finish();
    }

    private async Task Case(string name, Func<Task> body)
    {
        var before = _checks;
        var failed = _failures.Count;
        try { await body(); }
        catch (Exception e) { Check(false, name + ": exception: " + e); }
        GD.Print("NETPLAYER_SELF case " + name + ": " + (_checks - before) + " checks, " + (_failures.Count - failed) + " failed");
    }

    private void Finish()
    {
        if (_done) return;
        _done = true;
        foreach (var f in _failures) GD.Print("FAIL: ", f);
        GD.Print(_failures.Count == 0 ? $"NETPLAYER_SELF_OK ({_checks} checks)" : $"NETPLAYER_SELF_FAIL {_failures.Count} of {_checks} checks failed, first: {_failures[0]}");
        GetTree().Quit(_failures.Count == 0 ? 0 : 1);
    }

    private void Check(bool ok, string what)
    {
        _checks++;
        if (!ok) _failures.Add(what);
    }

    private async Task Frames(int n)
    {
        for (var i = 0; i < n; i++) await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);
    }

    // ---- the rig ----------------------------------------------------------------------------------------------------

    private static OneLobbyConfig Cfg(string name) =>
        new("netplayer-selfcheck", "1", new Uri("ws://mem/ws"), SyncMode.Raw, 30, 30, name) { SettingsEnv = PlayerSettings.NoEnvironment };

    /// <summary>Wait for a lobby call while the cluster's virtual clock runs (continuations come back on engine frames).</summary>
    private async Task<T> Await<T>(Cluster c, Task<T> task, bool drive = true)
    {
        for (var i = 0; i < 2000 && !task.IsCompleted; i++)
        {
            if (drive) c.Step();
            await Frames(1);
        }
        if (!task.IsCompleted) throw new TimeoutException("lobby call did not complete");
        return await task;
    }

    private async Task UntilReady(Cluster c, Machine m)
    {
        for (var i = 0; i < 2000 && !m.Lobby.IsReady; i++)
        {
            c.Step();
            await Frames(1);
        }
        if (!m.Lobby.IsReady) throw new TimeoutException("lobby never became ready");
    }

    /// <summary>A machine: a client in the lobby (host or joiner), a world node in the tree and a spawner on the layer made from <paramref name="options"/>.</summary>
    private async Task<Machine> NewMachine(Cluster c, string name, NetPlayersOptions options, PackedScene scene, bool host = false, bool spectator = false, int spectators = 0)
    {
        var m = new Machine { Name = name, Client = new LobbyClient(Cfg(name), c.Net.CreateTransport()) };
        c.Machines.Add(m); // the cluster pumps its client while the call runs
        if (host) m.Lobby = await Await(c, m.Client.HostAsync(new LobbyOptions("room", 8) { Room = spectators > 0 ? new RoomOptions { Spectators = spectators } : null }));
        else m.Lobby = await Await(c, m.Client.JoinAsync(c.Host.Lobby.Code, new RoomJoinOptions { Role = spectator ? RoomRole.Spectator : RoomRole.Player }));
        var world = new Node3D { Name = "World_" + name };
        GetTree().Root.AddChild(world);
        m.World = world;
        var sp = new OneLobbyNetPlayerSpawner { Scene = scene, PumpLayer = false }; // the cluster pumps the layers on its virtual clock
        sp.PlayerSpawned += (peer, _, local) => m.Spawned.Add((peer, local));
        world.AddChild(sp);
        m.Spawner = sp;
        m.Layer = sp.Start(m.Lobby, null, options);
        await UntilReady(c, m);
        return m;
    }

    private static OneLobbyNetPlayer Np(Node character) => character.GetNode<OneLobbyNetPlayer>("NetPlayer");

    private static Node? Char(Machine m, int peer) => m.Spawner!.CharacterOf(peer);

    /// <summary>One cluster frame, then the frames of every node (physics, then render), like the engine would.</summary>
    private static void Frame(Cluster c)
    {
        c.Step();
        foreach (var m in c.Machines)
        {
            if (m.Spawner == null) continue;
            foreach (var ch in m.Spawner.Characters.Values.ToArray())
            {
                if (!GodotObject.IsInstanceValid(ch) || ch.IsQueuedForDeletion()) continue;
                var np = Np(ch);
                np._PhysicsProcess(0.016);
                np._Process(0.016);
            }
        }
    }

    private static void Cleanup(Cluster c)
    {
        foreach (var m in c.Machines)
        {
            m.Spawner?.Stop();
            if (GodotObject.IsInstanceValid(m.World)) m.World.Free();
        }
    }

    /// <summary>A character scene made in code: a root (<c>Node3D</c>, <c>CharacterBody3D</c> or a 2D kind) with a OneLobbyNetPlayer and an AnimationPlayer that has "walk" and "idle".</summary>
    private static PackedScene CharacterScene(string kind)
    {
        Node root = kind switch { "body3d" => new CharacterBody3D(), "node2d" => new Node2D(), _ => new Node3D() };
        root.Name = "Player";
        var np = new OneLobbyNetPlayer { Name = "NetPlayer", AnimationPlayerPath = new NodePath("../Anim") };
        root.AddChild(np);
        np.Owner = root;
        var ap = new AnimationPlayer { Name = "Anim" };
        var lib = new AnimationLibrary();
        lib.AddAnimation("idle", new Animation());
        lib.AddAnimation("walk", new Animation());
        ap.AddAnimationLibrary("", lib);
        root.AddChild(ap);
        ap.Owner = root;
        var ps = new PackedScene();
        var err = ps.Pack(root);
        if (err != Error.Ok) throw new InvalidOperationException("Pack failed: " + err);
        root.Free();
        return ps;
    }

    private static PlayerState WalkStep(PlayerState s, NetPlayerInput i, double dt)
    {
        s.X += i.MoveX * 6 * dt;
        s.Z += i.MoveY * 6 * dt;
        s.Vx = i.MoveX * 6;
        s.Vz = i.MoveY * 6;
        s.Yaw = i.Yaw;
        return s;
    }

    /// <summary>A 12 m circle at 0.8 rad/s (9.6 m/s), with its velocity.</summary>
    private static (Vector3 Pos, Vector3 Vel) PathAt(double ms)
    {
        var t = ms / 1000.0;
        return (new Vector3((float)(12 * Math.Sin(0.8 * t)), 0f, (float)(12 * Math.Cos(0.8 * t))),
            new Vector3((float)(12 * 0.8 * Math.Cos(0.8 * t)), 0f, (float)(-12 * 0.8 * Math.Sin(0.8 * t))));
    }

    private static string F(double v) => v.ToString("0.000", CultureInfo.InvariantCulture);

    /// <summary>Counts every signal of a node (the C# events the [Signal] delegates generate) and keeps the last arguments.</summary>
    private sealed class Probe
    {
        public readonly Dictionary<string, int> Count = new();
        public (float Yaw, float Pitch, long View) Shot;
        public int Melee, Used, Slot, Emote, HitBy, HitDamage, DiedBy;
        public (float Yaw, float Pitch, float Power) Thrown;
        public float Impact;

        public Probe(OneLobbyNetPlayer n)
        {
            void Inc(string k) => Count[k] = Count.GetValueOrDefault(k) + 1;
            n.Jumped += () => Inc("Jumped");
            n.Landed += i => { Inc("Landed"); Impact = i; };
            n.Shot += (y, p, v) => { Inc("Shot"); Shot = (y, p, v); };
            n.Melee += s => { Inc("Melee"); Melee = s; };
            n.Reloaded += () => Inc("Reloaded");
            n.Used += t => { Inc("Used"); Used = t; };
            n.ItemSwitched += s => { Inc("ItemSwitched"); Slot = s; };
            n.Thrown += (y, p, w) => { Inc("Thrown"); Thrown = (y, p, w); };
            n.Hit += (b, d) => { Inc("Hit"); HitBy = b; HitDamage = d; };
            n.Died += b => { Inc("Died"); DiedBy = b; };
            n.Respawned += () => Inc("Respawned");
            n.Emoted += e => { Inc("Emoted"); Emote = e; };
        }

        public static readonly string[] All = { "Jumped", "Landed", "Shot", "Melee", "Reloaded", "Used", "ItemSwitched", "Thrown", "Hit", "Died", "Respawned", "Emoted" };
        public bool EachOnce => All.All(k => Count.GetValueOrDefault(k) == 1);
        public override string ToString() => string.Join(" ", All.Select(k => k + "=" + Count.GetValueOrDefault(k)));
    }

    // ---- the cases --------------------------------------------------------------------------------------------------

    /// <summary>Authority "owner": a real CharacterBody3D moved by the game; the node does the rest. D1 bounds on B's copy of A.</summary>
    private async Task Owner3D()
    {
        var c = new Cluster();
        var opts = new NetPlayersOptions { Authority = PlayerAuthority.Owner };
        var scene = CharacterScene("body3d");
        var h = await NewMachine(c, "host", opts, scene, host: true);
        var a = await NewMachine(c, "a", opts, scene);
        var b = await NewMachine(c, "b", opts, scene);
        var apeer = a.Peer;
        Check(a.Spawned.Count == 1 && a.Spawned[0].Local && a.Spawned[0].Peer == apeer, "owner 3D: a machine's own character is there at once, marked local");
        var ownerPath = new List<double[]>();
        var copyPath = new List<double[]>();
        var probes = new Dictionary<string, Probe>();
        for (var i = 0; i < 700; i++)
        {
            var ac = (CharacterBody3D?)Char(a, apeer);
            if (ac != null)
            {
                var (pos, vel) = PathAt(c.Net.NowMs);
                ac.Position = pos;
                ac.Velocity = vel;
                ac.RotationDegrees = new Vector3(0f, 90f, 0f);
                ownerPath.Add(new double[] { c.Net.NowMs, pos.X, pos.Y, pos.Z });
            }
            Frame(c);
            if (i == 150)
            {
                foreach (var m in new[] { h, a, b }) probes[m.Name] = new Probe(Np(Char(m, apeer)!));
                Np(Char(a, apeer)!).Jump();
            }
            if (i > 250 && Char(b, apeer) is Node3D bc) copyPath.Add(new double[] { c.Net.NowMs, bc.GlobalPosition.X, bc.GlobalPosition.Y, bc.GlobalPosition.Z });
        }
        Check(h.Spawned.Count == 3 && a.Spawned.Count == 3 && b.Spawned.Count == 3, $"owner 3D: every machine has three characters ({h.Spawned.Count} {a.Spawned.Count} {b.Spawned.Count})");
        Check(b.Spawned.Count(s => s.Local) == 1 && b.Spawned.First(s => s.Local).Peer == b.Peer, "owner 3D: exactly one local character per machine");
        var r = NetPlayerAutotest.ComparePaths(ownerPath, copyPath);
        GD.Print($"NETPLAYER_SELF owner 3D: B's copy of A's character within {F(r.Max)} m worst, {F(r.Mean)} m mean of A's path at a {r.LagMs} ms lag, over {r.N} frames");
        Check(r.N > 100 && r.Max < NetPlayerAutotest.MaxError && r.Mean < NetPlayerAutotest.MeanError, $"owner 3D: the remote character follows the owner's path within the D1 bounds (worst {F(r.Max)} < 0.5, mean {F(r.Mean)} < 0.15, lag {r.LagMs} ms)");
        var bnode = (Node3D)Char(b, apeer)!;
        Check(bnode.Visible, "owner 3D: the remote character is shown once its first state arrived");
        Check(Math.Abs(((bnode.RotationDegrees.Y % 360) + 360) % 360 - 90.0) < 0.2, "owner 3D: and faces where the owner faces");
        Check(probes["a"].Count.GetValueOrDefault("Jumped") == 1 && probes["host"].Count.GetValueOrDefault("Jumped") == 1 && probes["b"].Count.GetValueOrDefault("Jumped") == 1,
            $"owner 3D: one jump arrives once on every machine ({probes["host"].Count.GetValueOrDefault("Jumped")} {probes["a"].Count.GetValueOrDefault("Jumped")} {probes["b"].Count.GetValueOrDefault("Jumped")})");
        var bn = Np(bnode);
        Check(!bn.IsLocal && bn.PeerId == apeer && (bn.Mode is 0 or 1 or 4 or 5), $"owner 3D: the remote node exposes the player's values (mode {bn.Mode})");
        Check(Math.Abs(bn.Velocity.Length() - 9.6) < 0.8, $"owner 3D: and its velocity ({F(bn.Velocity.Length())} m/s of 9.6)");
        Cleanup(c);
    }

    /// <summary>Authority "host": the owner gives input and a step function; the character is predicted and the watchers follow the host.</summary>
    private async Task HostAuthority()
    {
        var c = new Cluster();
        var opts = new NetPlayersOptions { Authority = PlayerAuthority.Host, Step = WalkStep };
        var scene = CharacterScene("node3d");
        var h = await NewMachine(c, "host", opts, scene, host: true);
        var a = await NewMachine(c, "a", opts, scene);
        var b = await NewMachine(c, "b", opts, scene);
        var apeer = a.Peer;
        double worstOwner = 0, worst = 0;
        for (var i = 0; i < 400; i++)
        {
            if (Char(a, apeer) is { } ac)
            {
                var t = c.Net.NowMs / 1000.0;
                Np(ac).SetInput(new NetPlayerInput { MoveX = Math.Sin(0.8 * t), MoveY = Math.Cos(0.8 * t), Yaw = 90 });
            }
            Frame(c);
            if (i > 150 && Char(h, apeer) is Node3D hc && Char(b, apeer) is Node3D bc && Char(a, apeer) is Node3D ac2)
            {
                worstOwner = Math.Max(worstOwner, Math.Sqrt(Math.Pow(ac2.Position.X - hc.Position.X, 2) + Math.Pow(ac2.Position.Z - hc.Position.Z, 2)));
                worst = Math.Max(worst, Math.Sqrt(Math.Pow(bc.Position.X - hc.Position.X, 2) + Math.Pow(bc.Position.Z - hc.Position.Z, 2)));
            }
        }
        var moved = ((Node3D)Char(a, apeer)!).Position.Length();
        GD.Print($"NETPLAYER_SELF host authority: A's predicted character at most {worstOwner:0.00} m from the host's copy (the host is behind by the round trip); B's copy at most {worst:0.00} m");
        Check(moved > 1.0, $"host authority: the input moved the character ({moved:0.00} m from the origin)");
        Check(worstOwner < 3.5, $"host authority: the owner's prediction stays close to the host ({worstOwner:0.00})");
        Check(worst < 3.5, $"host authority: a watcher's copy is close to the host's ({worst:0.00})");
        Check(Np(Char(a, apeer)!).IsLocal && Np(Char(h, apeer)!).IsBound, "host authority: A's node is local on A and bound on the host");
        Cleanup(c);
    }

    /// <summary>Authority "host": until the host's first state of the owner's own player has arrived the node writes nothing (no origin, no flash); then the host's spawn point.</summary>
    private async Task HostAuthoritySpawnPoint()
    {
        var c = new Cluster();
        var opts = new NetPlayersOptions { Authority = PlayerAuthority.Host, Step = WalkStep, Spawn = _ => new PlayerState { X = 50, Y = 1 } };
        var scene = CharacterScene("node3d");
        var h = await NewMachine(c, "host", opts, scene, host: true);
        var a = await NewMachine(c, "a", opts, scene);
        var apeer = a.Peer;
        var home = new Vector3(7f, 0f, 7f); // where the game put the character before the host says where the player starts
        int seenHome = 0, nearOrigin = 0;
        double firstX = -1;
        var placed = false;
        for (var i = 0; i < 300; i++)
        {
            if (Char(a, apeer) is Node3D ac)
            {
                if (!placed) { placed = true; ac.Position = home; }
                Np(ac).SetInput(new NetPlayerInput { MoveX = 1.0, MoveY = 0.0, Yaw = 90 }); // from the very first frame
            }
            Frame(c);
            if (Char(a, apeer) is Node3D ac2)
            {
                if (ac2.Position.DistanceTo(home) < 1e-6) seenHome++;
                else if (ac2.Position.X < 40.0) nearOrigin++;
                else if (firstX < 0) firstX = ac2.Position.X;
            }
        }
        GD.Print($"NETPLAYER_SELF host authority spawn: {seenHome} frames the character stayed where the game put it, {nearOrigin} frames anywhere else below x=40, first written x {F(firstX)}");
        Check(seenHome > 0, "host authority spawn: before the host's first state the node writes nothing into the character");
        Check(nearOrigin == 0, "host authority spawn: the character is never moved to the origin or anywhere near it");
        Check(Math.Abs(firstX - 50.0) < 6.0 / 30.0 + 0.01, $"host authority spawn: the first written position is the spawn point ({F(firstX)})");
        Cleanup(c);
    }

    /// <summary>Each signal once on both sides, the arguments, the layer's own events and the animation.</summary>
    private async Task EventsAndAnimation()
    {
        var c = new Cluster();
        var opts = new NetPlayersOptions { Authority = PlayerAuthority.Owner };
        var scene = CharacterScene("node3d");
        var h = await NewMachine(c, "host", opts, scene, host: true);
        var a = await NewMachine(c, "a", opts, scene);
        var b = await NewMachine(c, "b", opts, scene);
        var apeer = a.Peer;
        for (var i = 0; i < 160; i++)
        {
            var ac = (Node3D)Char(a, apeer)!;
            ac.Position = new Vector3(i * 0.05f, 0f, 0f); // A walks along x; auto mode derives a mode only from a velocity, so set it by hand
            Np(ac).AutoMode = false;
            Np(ac).Mode = 1;
            Frame(c);
        }
        var probes = new Dictionary<string, Probe> { ["a"] = new Probe(Np(Char(a, apeer)!)), ["b"] = new Probe(Np(Char(b, apeer)!)), ["host"] = new Probe(Np(Char(h, apeer)!)) };
        // the signal names are the Godot ones (a GDScript game connects by name)
        var byName = 0;
        Np(Char(b, apeer)!).Connect("Jumped", Callable.From(() => byName++));
        Check(Np(Char(b, apeer)!).HasSignal("Jumped") && Np(Char(b, apeer)!).HasSignal("ItemSwitched") && Np(Char(b, apeer)!).HasSignal("Emoted"), "signals: the node has Jumped, ItemSwitched, Emoted ... by name");
        var na = Np(Char(a, apeer)!);
        na.Jump();
        na.Shoot(123.4f, -12.5f);
        na.MeleeAttack(200);
        na.Use(4242);
        na.SwitchItem(5);
        na.ThrowItem(10f, 30f, 0.5f);
        na.Emote(17);
        na.Reload();
        na.Land(12.5f);
        na.Respawn(new Vector3(1f, 0f, 0f));
        // the host raises hit and death for A through A's node on the host
        var hostPeer = h.Peer;
        Np(Char(h, apeer)!).Hurt(hostPeer, 25);
        Np(Char(h, apeer)!).Kill(hostPeer);
        for (var i = 0; i < 160; i++) Frame(c);
        foreach (var k in new[] { "a", "b", "host" })
            Check(probes[k].EachOnce, $"signals: all twelve arrive exactly once on {k} ({probes[k]})");
        Check(byName == 1, "signals: a connection made by name (as GDScript does) gets the signal once");
        var pb = probes["b"];
        Check(Math.Abs(pb.Shot.Yaw - 123.4) < 0.2 && Math.Abs(pb.Shot.Pitch + 12.5) < 0.2 && pb.Shot.View > 0, $"events: Shot(yaw, pitch, view) arrives with its arguments ({pb.Shot})");
        Check(pb.Melee == 200 && pb.Used == 4242 && pb.Slot == 5 && pb.Emote == 17, "events: Melee, Used, ItemSwitched and Emoted");
        Check(Math.Abs(pb.Thrown.Power - 0.5) < 0.02 && Math.Abs(pb.Thrown.Yaw - 10) < 0.2, $"events: Thrown(yaw, pitch, power) ({pb.Thrown})");
        Check(Math.Abs(pb.Impact - 12.5) < 0.5, $"events: Landed(impact) ({pb.Impact})");
        Check(pb.HitBy == hostPeer && pb.HitDamage == 25 && pb.DiedBy == hostPeer, "events: the host's Hit and Died reach the watcher");
        Check(Np(Char(b, apeer)!).Item == 5, "events: the Item property follows the owner (SwitchItem(5))");
        // animation: B's copy of A plays the animation of A's mode; a mode without an animation is skipped silently
        var ap = Char(b, apeer)!.GetNode<AnimationPlayer>("Anim");
        Check(ap.Get("current_animation").AsString() == "walk", $"animation: mode 1 plays \"walk\" on the remote ({ap.Get("current_animation").AsString()})");
        na.Mode = 6; // swim: the scene has no such animation
        for (var i = 0; i < 80; i++) Frame(c);
        Check(Np(Char(b, apeer)!).Mode == 6 && ap.Get("current_animation").AsString() == "walk", "animation: a mode with no animation is skipped silently, the mode still arrives");
        na.Mode = 0;
        for (var i = 0; i < 80; i++) Frame(c);
        Check(ap.Get("current_animation").AsString() == "idle", "animation: mode 0 plays \"idle\"");
        Cleanup(c);
    }

    /// <summary>A remote character is hidden when it is made and shown once its first state is written.</summary>
    private async Task HideUntilFirstState()
    {
        var c = new Cluster();
        var opts = new NetPlayersOptions { Authority = PlayerAuthority.Owner };
        var scene = CharacterScene("node3d");
        var h = await NewMachine(c, "host", opts, scene, host: true);
        var a = await NewMachine(c, "a", opts, scene);
        var apeer = a.Peer;
        var hiddenAtFirst = false;
        var seen = false;
        var visibleAfter = false;
        var localVisible = true;
        for (var i = 0; i < 200; i++)
        {
            if (Char(a, apeer) is Node3D ac) ac.Position = new Vector3(20f, 0f, 20f);
            c.Step();
            var hc = Char(h, apeer) as Node3D;
            if (hc != null && !seen)
            {
                seen = true;
                hiddenAtFirst = !hc.Visible; // made by the spawner, no frame of its node has run yet
            }
            foreach (var m in c.Machines)
                foreach (var ch in m.Spawner!.Characters.Values.ToArray())
                {
                    Np(ch)._PhysicsProcess(0.016);
                    Np(ch)._Process(0.016);
                }
            if (seen && hc != null && !visibleAfter)
            {
                visibleAfter = hc.Visible && hc.Position.DistanceTo(new Vector3(20f, 0f, 20f)) < 3.0;
                if (visibleAfter) break;
            }
            localVisible &= ((Node3D)Char(a, apeer)!).Visible;
        }
        Check(seen && hiddenAtFirst, "hide: a remote character is hidden when the spawner makes it");
        Check(visibleAfter, "hide: and shown (at the owner's place, not the origin) once its first state is written");
        Check(localVisible, "hide: the local character is never hidden");
        Cleanup(c);
    }

    /// <summary>A Node2D character under a 2D layer follows; a parent of the other kind is one error and the node stays unbound.</summary>
    private async Task TwoDAndMismatch()
    {
        var c = new Cluster();
        var opts = new NetPlayersOptions { Authority = PlayerAuthority.Owner, Space = "2d", Range = 100, VelocityRange = 16 };
        var scene = CharacterScene("node2d");
        var h = await NewMachine(c, "host", opts, scene, host: true);
        var a = await NewMachine(c, "a", opts, scene);
        var apeer = a.Peer;
        for (var i = 0; i < 200; i++)
        {
            var ac = (Node2D)Char(a, apeer)!;
            ac.Position = new Vector2(i * 0.1f, 3f);
            ac.RotationDegrees = 45f;
            Frame(c);
        }
        var hc = (Node2D)Char(h, apeer)!;
        Check(Math.Abs(hc.Position.Y - 3.0) < 0.1 && hc.Position.X > 5.0, $"2D: the host's copy of A's character follows ({hc.Position})");
        Check(Math.Abs(((hc.RotationDegrees % 360) + 360) % 360 - 45.0) < 0.2, $"2D: and faces where A faces ({F(hc.RotationDegrees)})");
        Check(Np(hc).Velocity2D.Length() >= 0f && Np(hc).IsBound, "2D: the node is bound and exposes Velocity2D");
        Cleanup(c);
        // a 3D character under a layer that says 2D: one clear error, and the node stays unbound
        var c2 = new Cluster();
        var m3 = await NewMachine(c2, "host", opts, CharacterScene("node3d"), host: true);
        Check(m3.Spawner!.Characters.Count == 1 && !Np(Char(m3, m3.Peer)!).IsBound, "mismatch: a 3D parent under space \"2d\" is not bound (one error logged)");
        Cleanup(c2);
        // and a 2D character under a layer that says 3D
        var c3 = new Cluster();
        var m2 = await NewMachine(c3, "host", new NetPlayersOptions { Authority = PlayerAuthority.Owner }, CharacterScene("node2d"), host: true);
        Check(m2.Spawner!.Characters.Count == 1 && !Np(Char(m2, m2.Peer)!).IsBound, "mismatch: a 2D parent under space \"3d\" is not bound (one error logged)");
        Cleanup(c3);
    }

    /// <summary>A spectator has no character and nobody has one for it; a player who leaves has its character freed.</summary>
    private async Task LeaveAndSpectator()
    {
        var c = new Cluster();
        var opts = new NetPlayersOptions { Authority = PlayerAuthority.Owner };
        var scene = CharacterScene("node3d");
        var h = await NewMachine(c, "host", opts, scene, host: true, spectators: 1);
        var a = await NewMachine(c, "a", opts, scene);
        var b = await NewMachine(c, "b", opts, scene);
        var s = await NewMachine(c, "c", opts, scene, spectator: true);
        for (var i = 0; i < 250; i++)
        {
            foreach (var (m, x) in new[] { (a, 0f), (b, 5f) })
                if (Char(m, m.Peer) is Node3D ch) ch.Position = new Vector3(x, 0f, i * 0.02f);
            Frame(c);
        }
        Check(Char(s, s.Peer) == null && s.Spawner!.Characters.Count == 3, "spectator: the spectator has no character of its own (made at once, taken back when the roster says spectator)");
        Check(Char(h, s.Peer) == null && Char(a, s.Peer) == null, "spectator: and nobody has one for it");
        Check(Char(s, a.Peer) != null && Char(s, b.Peer) != null, "spectator: it sees the players");
        var bOnHost = Char(h, b.Peer);
        Check(bOnHost != null && !bOnHost.IsQueuedForDeletion(), "leave: B's character exists on the host");
        var leaving = b.Lobby.LeaveAsync();
        for (var i = 0; i < 600 && !leaving.IsCompleted; i++)
        {
            c.Step();
            await Frames(1);
        }
        b.Frozen = true;
        for (var i = 0; i < 300; i++) Frame(c);
        Check(Char(h, b.Peer) == null && bOnHost!.IsQueuedForDeletion(), "leave: B's character is freed on the host");
        Check(Char(a, b.Peer) == null, "leave: and on A");
        Cleanup(c);
    }

    /// <summary>The node's Teleport does not slide on the watcher; a cheat is put back and the node takes the host's state.</summary>
    private async Task TeleportAndCorrections()
    {
        var c = new Cluster();
        var opts = new NetPlayersOptions { Authority = PlayerAuthority.Owner, Limits = new PlayerLimits(12, 3, null, null) };
        var scene = CharacterScene("node3d");
        var h = await NewMachine(c, "host", opts, scene, host: true);
        var a = await NewMachine(c, "a", opts, scene);
        var b = await NewMachine(c, "b", opts, scene);
        var apeer = a.Peer;
        for (var i = 0; i < 120; i++)
        {
            ((Node3D)Char(a, apeer)!).Position = new Vector3(1f, 0f, 1f);
            Frame(c);
        }
        var watched = new List<double>();
        for (var i = 0; i < 120; i++)
        {
            if (i == 30) Np(Char(a, apeer)!).Teleport(new Vector3(60f, 0f, 60f));
            Frame(c);
            watched.Add(((Node3D)Char(b, apeer)!).Position.X);
        }
        int big = 0, slide = 0;
        for (var i = 1; i < watched.Count; i++)
        {
            var d = Math.Abs(watched[i] - watched[i - 1]);
            if (d > 40.0) big++;
            else if (d > 1.0) slide++;
        }
        GD.Print($"NETPLAYER_SELF teleport: {big} frame(s) jumped over 40 m, {slide} slid");
        Check(big == 1 && slide == 0, "teleport: one jump on the watcher and no slide");
        var told = 0;
        a.Layer!.Corrected += _ => told++;
        for (var i = 0; i < 120; i++)
        {
            ((Node3D)Char(a, apeer)!).Position = new Vector3(500f, 0f, 500f); // the game claims to be far away: the host refuses
            Frame(c);
            if (told > 0) break;
        }
        for (var i = 0; i < 5; i++) Frame(c); // the node takes the state in its next frame
        var pos = ((Node3D)Char(a, apeer)!).Position;
        Check(told >= 1, $"corrections: the owner is told ({told})");
        Check(pos.X < 100.0, $"corrections: and its node took the host's state back ({pos})");
        Cleanup(c);
    }

    /// <summary>A CharacterBody3D parent: its velocity and floor state travel; host authority without a step function is one clear error, not a crash.</summary>
    private async Task BodyAndMissingStep()
    {
        var c = new Cluster();
        var opts = new NetPlayersOptions { Authority = PlayerAuthority.Owner };
        var h = await NewMachine(c, "host", opts, CharacterScene("body3d"), host: true);
        var a = await NewMachine(c, "a", opts, CharacterScene("body3d"));
        var apeer = a.Peer;
        for (var i = 0; i < 150; i++)
        {
            var cb = (CharacterBody3D)Char(a, apeer)!;
            cb.Velocity = new Vector3(3f, 0f, -2f);
            cb.Position += cb.Velocity * 0.016f;
            Frame(c);
        }
        var hv = Np(Char(h, apeer)!).Velocity;
        Check(Math.Abs(hv.X - 3.0) < 0.1 && Math.Abs(hv.Z + 2.0) < 0.1, $"CharacterBody3D: the velocity arrives ({hv})");
        Check(!Np(Char(a, apeer)!).OnGround, "CharacterBody3D: OnGround comes from IsOnFloor() (false in the air)");
        Check(Np(Char(h, apeer)!).Mode == 5, $"CharacterBody3D: AutoMode says fall in the air ({Np(Char(h, apeer)!).Mode})");
        Cleanup(c);
        // host authority without a step function: the node reports it once and goes on
        var c2 = new Cluster();
        var m = await NewMachine(c2, "host", new NetPlayersOptions { Authority = PlayerAuthority.Host }, CharacterScene("node3d"), host: true);
        var np = Np(Char(m, m.Peer)!);
        var threw = false;
        try
        {
            np._PhysicsProcess(0.016);
            np._PhysicsProcess(0.016);
            np.SetInput(new NetPlayerInput { MoveX = 1 });
            np._PhysicsProcess(0.016);
        }
        catch (Exception) { threw = true; }
        Check(np.IsBound && np.StepWarned && !threw, "host authority without a step function: the node reports it once and goes on");
        Cleanup(c2);
    }

    /// <summary>The spawner: local at once, joins, leaves, Stop and leaving the tree dispose the layer.</summary>
    private async Task SpawnerLifetime()
    {
        var c = new Cluster();
        var opts = new NetPlayersOptions { Authority = PlayerAuthority.Owner };
        var scene = CharacterScene("node3d");
        var h = await NewMachine(c, "host", opts, scene, host: true);
        Check(h.Spawned.Count == 1 && h.Spawned[0].Local && h.Spawned[0].Peer == h.Peer, "spawner: the local character is made at once, before anybody else is there");
        Check(h.Spawner!.CharacterOf(h.Peer) != null && h.Spawner.CharacterOf(h.Peer)!.GetMeta("onelobby_local").AsBool(), "spawner: CharacterOf finds it and it is marked local");
        Check(h.Spawner.CharacterOf(h.Peer)!.Name == "Player" + h.Peer, "spawner: the character is named PlayerN");
        var removed = new List<int>();
        h.Spawner.PlayerRemoved += (peer, _) => removed.Add(peer);
        var a = await NewMachine(c, "a", opts, scene);
        var b = await NewMachine(c, "b", opts, scene);
        for (var i = 0; i < 100; i++)
        {
            if (Char(a, a.Peer) is Node3D ac) ac.Position = new Vector3(2f, 0f, 0f);
            if (Char(b, b.Peer) is Node3D bc) bc.Position = new Vector3(4f, 0f, 0f);
            Frame(c);
        }
        Check(h.Spawned.Count == 3 && h.Spawner.Characters.Count == 3, "spawner: the host made a character for each of the two who joined");
        // Stop: characters freed, the layer disposed (its session no longer runs), a new join makes nothing
        var layer = a.Layer!;
        var spawnerA = a.Spawner!;
        spawnerA.Stop();
        Check(spawnerA.Characters.Count == 0 && spawnerA.Players == null, "spawner: Stop frees the characters and lets go of the layer");
        var tick = layer.Session.Clock.Tick;
        for (var i = 0; i < 40; i++) Frame(c);
        Check(layer.Session.Clock.Tick == tick && h.Layer!.Session.Clock.Tick > tick, "spawner: Stop disposed the layer (its session pump does nothing, the others go on)");
        // leaving the tree does the same
        var layerB = b.Layer!;
        var tickB = layerB.Session.Clock.Tick;
        b.World.RemoveChild(b.Spawner!);
        Check(b.Spawner!.Players == null && b.Spawner.Characters.Count == 0, "spawner: leaving the tree stops it");
        for (var i = 0; i < 40; i++) Frame(c);
        Check(layerB.Session.Clock.Tick == tickB, "spawner: and disposes the layer");
        b.Spawner.Free();
        b.Spawner = null;
        // the host's spawner saw both leave... no: they went quiet, the lobby has not dropped them; remove events are the leave case's job
        Check(removed.Count == 0, "spawner: PlayerRemoved is raised only when a player leaves");
        Cleanup(c);
    }

    /// <summary>What the node allocates in a frame (the layer's own Pump is measured separately and not counted here).</summary>
    private async Task Allocation()
    {
        var c = new Cluster();
        var opts = new NetPlayersOptions { Authority = PlayerAuthority.Owner };
        var scene = CharacterScene("body3d");
        var h = await NewMachine(c, "host", opts, scene, host: true);
        var a = await NewMachine(c, "a", opts, scene);
        var apeer = a.Peer;
        for (var i = 0; i < 200; i++)
        {
            var (pos, vel) = PathAt(c.Net.NowMs);
            var ac = (CharacterBody3D)Char(a, apeer)!;
            ac.Position = pos;
            ac.Velocity = vel;
            Frame(c);
        }
        var local = Np(Char(a, apeer)!);
        var remote = Np(Char(h, apeer)!);
        const int N = 2000;
        for (var i = 0; i < 100; i++) { local._PhysicsProcess(0.016); local._Process(0.016); remote._Process(0.016); }
        var g0 = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < N; i++) { local._PhysicsProcess(0.016); local._Process(0.016); }
        var g1 = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < N; i++) remote._Process(0.016);
        var g2 = GC.GetAllocatedBytesForCurrentThread();
        var layer = h.Layer!;
        for (var i = 0; i < N; i++) layer.TryGet(apeer, out _);
        var g3 = GC.GetAllocatedBytesForCurrentThread();
        GD.Print($"NETPLAYER_SELF allocation: owner node {(g1 - g0) / (double)N:0.0} bytes per physics+render frame, remote node {(g2 - g1) / (double)N:0.0} bytes per render frame of which the layer's own TryGet is {(g3 - g2) / (double)N:0.0} (over {N} frames each)");
        Check(g1 - g0 == 0, $"allocation: the owner's physics and render frame allocates nothing ({(g1 - g0) / (double)N:0.0} bytes per frame)");
        Check(g2 - g1 <= g3 - g2, $"allocation: the remote node's render frame allocates nothing beyond the layer's own TryGet ({(g2 - g1) / (double)N:0.0} vs {(g3 - g2) / (double)N:0.0} bytes per frame)");
        Cleanup(c);
    }

    /// <summary>
    /// The sample (NetPlayerGame: the menu's game, started the way the menu starts it, with the layer made from the blueprint) between a host and a
    /// joiner, with real physics frames and a real CharacterBody3D on a floor; the scripted walk of --netplayer-test (NetPlayerAutotest) on a virtual clock.
    /// </summary>
    private async Task SampleTrace()
    {
        var c = new Cluster();
        var bp = Blueprint.Parse(FileAccess.GetFileAsString("res://NetPlayerDemo.onelobby.json"));
        Check(bp.Sync.Mode == "replication" && bp.Sync.Player.Authority == "owner", "sample: the blueprint asks for replication and the player layer (owner authority)");
        Func<double> clock = () => c.Net.NowMs;
        _drive = c;
        var hm = new Machine { Name = "host", Client = new LobbyClient(Cfg("host"), c.Net.CreateTransport()) };
        c.Machines.Add(hm); // the physics tick pumps its client until its game takes over
        hm.Lobby = await Await(c, hm.Client.HostAsync(new LobbyOptions("room", 4)), drive: false);
        var hostGame = new NetPlayerGame();
        GetTree().Root.AddChild(hostGame);
        hostGame.Start(hm.Lobby, bp, clock, test: true);
        hm.Pumped = false; // its spawner pumps the layer, as in the real game
        var jm = new Machine { Name = "joiner", Client = new LobbyClient(Cfg("joiner"), c.Net.CreateTransport()) };
        c.Machines.Add(jm);
        jm.Lobby = await Await(c, jm.Client.JoinAsync(hm.Lobby.Code), drive: false);
        var joinGame = new NetPlayerGame();
        GetTree().Root.AddChild(joinGame);
        joinGame.Start(jm.Lobby, bp, clock, test: true);
        jm.Pumped = false;
        // one physics world holds both machines' characters: keep them from colliding with each other (a layer each, the floor is layer 1)
        uint bit = 2;
        foreach (var game in new[] { hostGame, joinGame })
        {
            var mine = bit;
            bit <<= 1;
            game.Spawner.PlayerSpawned += (_, ch, _) => { var cb = (CharacterBody3D)ch; cb.CollisionLayer = mine; cb.CollisionMask = 1; };
            foreach (var ch in game.Spawner.Characters.Values) { var cb = (CharacterBody3D)ch; cb.CollisionLayer = mine; cb.CollisionMask = 1; }
        }
        hostGame.Autotest!.QuitWhenDone = false;
        joinGame.Autotest!.QuitWhenDone = false;
        for (var i = 0; i < 6000 && hostGame.Autotest.Verdict == null; i++) await Frames(1);
        _drive = null;
        var host = hostGame.Autotest;
        GD.Print("NETPLAYER_SELF sample: " + host.Numbers);
        Check(host.Verdict == "", "sample: the host's verdict is NETPLAYER_OK (" + (host.Verdict ?? "no verdict") + ")");
        Check(host.Result.N >= 20 && host.Result.Max < NetPlayerAutotest.MaxError && host.Result.Mean < NetPlayerAutotest.MeanError,
            $"sample: the host's copy follows the joiner's trace within the D1 bounds (worst {F(host.Result.Max)} < 0.5, mean {F(host.Result.Mean)} < 0.15, lag {host.Result.LagMs} ms, {host.Result.N} samples)");
        Check(host.JoinerJumps == 1 && host.JumpsSeen == 1, $"sample: the joiner jumped once and the host's copy jumped once ({host.JoinerJumps} {host.JumpsSeen})");
        Check(host.EndGap <= 1.0, $"sample: the copy ended {host.EndGap:0.00} m from where the joiner stopped");
        Check(hostGame.Spawner.Characters.Count == 2 && joinGame.Spawner.Characters.Count == 2, "sample: two characters on each machine");
        hostGame.Spawner.Stop();
        joinGame.Spawner.Stop();
        hostGame.Free();
        joinGame.Free();
        _drive = null;
    }
}
