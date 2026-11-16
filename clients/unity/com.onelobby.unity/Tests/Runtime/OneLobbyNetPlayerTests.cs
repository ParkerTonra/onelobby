#nullable enable
using System;
using System.Collections;
using System.Collections.Generic;
using System.Threading.Tasks;
using NUnit.Framework;
using OneLobby.Replication;
using UnityEngine;
using UnityEngine.TestTools;

namespace OneLobby.Unity.PlayTests
{
    /// <summary>
    /// The networked player component and its spawner, in Play mode, with no socket: every peer is a <see cref="LobbyClient"/> on one
    /// <see cref="InMemoryNetwork"/> (a virtual clock, 30 ms each way), two or three of them in this one editor process. A frame is 33 ms of
    /// virtual time (<see cref="Time.captureDeltaTime"/> makes Unity's fixed steps follow it), and the spawner pumps each layer in its own Update.
    /// The measured numbers are printed as <c>NETPLAYER_UNITY ...</c> lines.
    /// <code>Unity -batchmode -nographics -projectPath P -runTests -testPlatform PlayMode -testFilter OneLobby.Unity.PlayTests</code>
    /// </summary>
    public sealed class OneLobbyNetPlayerTests
    {
        private const float FrameSeconds = 0.033f;
        private const int FrameMs = 33;
        private const int CharacterLayer = 8;

        private InMemoryNetwork _net = null!;
        private readonly List<GameObject> _objects = new();
        private readonly List<Peer> _peers = new();
        private readonly List<string> _logged = new();
        private string _kind = "transform";
        private Func<int, Vector3>? _spawnPoint;
        private int _step;

        // ---- rig ------------------------------------------------------------------------------------------------------------

        private sealed class Counts
        {
            public readonly Dictionary<string, int> N = new();
            public readonly List<string> Args = new();
            public int this[string k] => N.TryGetValue(k, out var v) ? v : 0;
            private void Add(string k, string args = "") { N[k] = this[k] + 1; if (args.Length > 0) Args.Add(k + " " + args); }
            public void Hook(OneLobbyNetPlayer np)
            {
                np.Jumped += () => Add("Jumped");
                np.Landed += i => Add("Landed", i.ToString("F1"));
                np.Shot += (y, p, v) => Add("Shot", y.ToString("F0") + " " + p.ToString("F0"));
                np.Melee += s => Add("Melee", s.ToString());
                np.Reloaded += () => Add("Reloaded");
                np.Used += t => Add("Used", t.ToString());
                np.ItemSwitched += s => Add("ItemSwitched", s.ToString());
                np.Thrown += (y, p, pw) => Add("Thrown", y.ToString("F0") + " " + p.ToString("F0") + " " + pw.ToString("F1"));
                np.Hit += (by, d) => Add("Hit", by + " " + d);
                np.Died += by => Add("Died", by.ToString());
                np.Respawned += () => Add("Respawned");
                np.Emoted += e => Add("Emoted", e.ToString());
            }
            public int Total { get { var t = 0; foreach (var v in N.Values) t += v; return t; } }
        }

        private sealed class Peer
        {
            public string Name = "";
            public LobbyClient Client = null!;
            public Lobby Lobby = null!;
            public OneLobbyNetPlayerSpawner Spawner = null!;
            public NetPlayers Layer => Spawner.Players!;
            public int Id => Lobby.LocalPeerId;
            public readonly Dictionary<int, Counts> Counts = new();
            public readonly List<(int Peer, bool Local, bool RendererOn)> Spawned = new();
            public readonly List<int> Removed = new();
            public GameObject? LocalCharacter;
            public OneLobbyNetPlayer Of(int peer) => Spawner.CharacterOf(peer)!.GetComponentInChildren<OneLobbyNetPlayer>();
            public OneLobbyNetPlayer Mine => Of(Id);
        }

        [SetUp]
        public void SetUp()
        {
            _net = new InMemoryNetwork { LatencyMs = 30 };
            _objects.Clear();
            _peers.Clear();
            _logged.Clear();
            _kind = "transform";
            _spawnPoint = null;
            Time.captureDeltaTime = FrameSeconds;
            Physics.IgnoreLayerCollision(CharacterLayer, CharacterLayer, true);
            Application.logMessageReceived += OnLog;
        }

        [TearDown]
        public void TearDown()
        {
            Application.logMessageReceived -= OnLog;
            Time.captureDeltaTime = 0;
            Physics.IgnoreLayerCollision(CharacterLayer, CharacterLayer, false);
            foreach (var go in _objects) if (go != null) UnityEngine.Object.DestroyImmediate(go);
            _objects.Clear();
            _peers.Clear();
        }

        private void OnLog(string condition, string stack, LogType type) => _logged.Add(type + ": " + condition);

        private void Check(bool ok, string what) => Assert.IsTrue(ok, what);

        private void Report(string line) => Debug.Log("NETPLAYER_UNITY " + line);

        private void Floor()
        {
            var floor = new GameObject("floor");
            _objects.Add(floor);
            var box = floor.AddComponent<BoxCollider>();
            box.size = new Vector3(400, 1, 400);
            floor.transform.position = new Vector3(0, -0.5f, 0);
        }

        /// <summary>A character: a capsule with the component, and (per <see cref="_kind"/>) a CharacterController, a Rigidbody or neither.</summary>
        private GameObject MakeCharacter(int peer)
        {
            var go = new GameObject("character " + peer);
            var visual = GameObject.CreatePrimitive(PrimitiveType.Capsule);
            UnityEngine.Object.DestroyImmediate(visual.GetComponent<Collider>());
            visual.transform.SetParent(go.transform, false);
            switch (_kind)
            {
                case "cc":
                    var cc = go.AddComponent<CharacterController>();
                    cc.height = 2; cc.radius = 0.5f; cc.center = Vector3.zero;
                    break;
                case "rb":
                    var cap = go.AddComponent<CapsuleCollider>();
                    cap.height = 2; cap.radius = 0.5f;
                    var rb = go.AddComponent<Rigidbody>();
                    rb.constraints = RigidbodyConstraints.FreezeRotation;
                    rb.interpolation = RigidbodyInterpolation.Interpolate;
                    break;
            }
            go.AddComponent<OneLobbyNetPlayer>();
            // every machine of this test lives in one scene: a character and its copies on the other machines must not push each other
            go.layer = CharacterLayer;
            foreach (var t in go.GetComponentsInChildren<Transform>()) t.gameObject.layer = CharacterLayer;
            return go;
        }

        private static OneLobbyConfig Config(string name) =>
            new("netplayer-test", "1", new Uri("ws://mem/ws"), SyncMode.Raw, 30, 30, name) { SettingsEnv = PlayerSettings.NoEnvironment };

        private void Step()
        {
            _net.Advance(FrameMs);
            _step++;
            foreach (var p in _peers)
            {
                if (p.Spawner != null && p.Spawner.Players != null && p.Spawner.PumpLayer) continue; // its spawner pumps in Update
                if (p.Lobby != null) p.Lobby.Pump(); else p.Client.Pump();
            }
        }

        private IEnumerator Frames(int n, Action<int>? each = null)
        {
            for (var i = 0; i < n; i++)
            {
                each?.Invoke(i);
                Step();
                yield return null;
            }
        }

        private IEnumerator Wait(Task t)
        {
            for (var i = 0; i < 900 && !t.IsCompleted; i++) { Step(); yield return null; }
            Check(t.IsCompleted, "a lobby call did not complete");
            if (t.IsFaulted) throw t.Exception!;
        }

        /// <summary>One host and <paramref name="clients"/> joiners, each with a spawner on a layer made from <paramref name="options"/>.</summary>
        private IEnumerator Match(int clients, NetPlayersOptions? options = null)
        {
            for (var i = 0; i <= clients; i++)
            {
                var name = i == 0 ? "host" : "client" + i;
                var p = new Peer { Name = name };
                p.Client = new LobbyClient(Config(name), _net.CreateTransport());
                _peers.Add(p);
                Task<Lobby> t = i == 0 ? p.Client.HostAsync(new LobbyOptions("room", 8)) : p.Client.JoinAsync(_peers[0].Lobby.Code);
                yield return Wait(t);
                p.Lobby = t.Result;
                if (i > 0) { for (var k = 0; k < 400 && !p.Lobby.IsReady; k++) { Step(); yield return null; } Check(p.Lobby.IsReady, name + " never became ready"); }
                BeginSpawner(p, options);
            }
            yield return Frames(20);
        }

        private void BeginSpawner(Peer p, NetPlayersOptions? options)
        {
            var go = new GameObject("spawner " + p.Name);
            _objects.Add(go);
            p.Spawner = go.AddComponent<OneLobbyNetPlayerSpawner>();
            p.Spawner.Factory = MakeCharacter;
            p.Spawner.SpawnPoint = _spawnPoint;
            p.Spawner.PlayerSpawned += (peer, character, isLocal) =>
            {
                var np = character.GetComponentInChildren<OneLobbyNetPlayer>();
                var r = character.GetComponentInChildren<Renderer>();
                p.Spawned.Add((peer, isLocal, r != null && r.enabled));
                if (!p.Counts.TryGetValue(peer, out var c)) p.Counts[peer] = c = new Counts();
                c.Hook(np);
                if (isLocal) p.LocalCharacter = character;
            };
            p.Spawner.PlayerRemoved += (peer, _) => p.Removed.Add(peer);
            p.Spawner.Begin(p.Lobby, null, options);
        }

        // ---- the walk, and the comparison of two paths ---------------------------------------------------------------------------

        private struct Sample { public double T; public Vector3 P; }

        /// <summary>The one constant lag (0 to 600 ms, 8 ms steps) at which the watched path is closest to the owner's on average (D1 of spec/net-player.md).</summary>
        private static (int Lag, double Mean, double Max, int N) Compare(List<Sample> owner, List<Sample> watched)
        {
            var best = (Lag: 0, Mean: double.MaxValue, Max: double.MaxValue, N: 0);
            for (var lag = 0; lag <= 600; lag += 8)
            {
                double sum = 0, mx = 0; var n = 0;
                foreach (var w in watched)
                {
                    if (!At(owner, w.T - lag, out var o)) continue;
                    var d = (w.P - o).magnitude;
                    sum += d; mx = Math.Max(mx, d); n++;
                }
                if (n > 20 && sum / n < best.Mean) best = (lag, sum / n, mx, n);
            }
            return best;
        }

        private static bool At(List<Sample> path, double t, out Vector3 p)
        {
            p = default;
            var n = path.Count;
            if (n == 0 || t < path[0].T || t > path[n - 1].T) return false;
            int lo = 0, hi = n - 1;
            while (hi - lo > 1) { var m = (lo + hi) >> 1; if (path[m].T <= t) lo = m; else hi = m; }
            var a = path[lo]; var b = path[hi];
            var k = b.T == a.T ? 0 : (t - a.T) / (b.T - a.T);
            p = a.P + (b.P - a.P) * (float)k;
            return true;
        }

        /// <summary>Walk A's character: stand 1 s, +x for 2.5 s with one jump at 1 s into the walk, +z for 1.5 s, stand 1 s. Moves it the way a game of this kind would.</summary>
        private void WalkStep(OneLobbyNetPlayer me, int frame, ref float vy, ref bool jumped)
        {
            var t = frame * FrameSeconds;
            var move = Vector3.zero;
            if (t >= 1.0f && t < 3.5f) move = new Vector3(5, 0, 0);
            else if (t >= 3.5f && t < 5.0f) move = new Vector3(0, 0, 5);
            var jump = t >= 2.0f && !jumped;
            if (jump) { jumped = true; me.Jump(); }
            var dt = FrameSeconds;
            var tr = me.transform;
            switch (_kind)
            {
                case "cc":
                    var cc = tr.GetComponent<CharacterController>();
                    if (cc.isGrounded) { vy = jump ? 6f : -1f; } else vy -= 18f * dt;
                    cc.Move((move + new Vector3(0, vy, 0)) * dt);
                    break;
                case "rb":
                    var rb = tr.GetComponent<Rigidbody>();
                    var v = rb.linearVelocity;
                    rb.linearVelocity = new Vector3(move.x, jump ? 6f : v.y, move.z);
                    break;
                default:
                    if (jump) vy = 6f;
                    if (tr.position.y > 1.0f || vy > 0) vy -= 18f * dt; else vy = 0;
                    var p = tr.position + (move + new Vector3(0, vy, 0)) * dt;
                    p.y = Math.Max(1.0f, p.y);
                    tr.position = p;
                    break;
            }
        }

        // ---- tests --------------------------------------------------------------------------------------------------------------

        [UnityTest]
        public IEnumerator OwnerAuthority_Transform_PathArrivesWithinTheBoundsAndEachEventPlaysOnce() => OwnerWalk("transform", true);

        [UnityTest]
        public IEnumerator OwnerAuthority_CharacterController_IsReadAndTheRemoteCopyHasItSwitchedOff() => OwnerWalk("cc", false);

        [UnityTest]
        public IEnumerator OwnerAuthority_Rigidbody_IsReadAndTheRemoteCopyIsKinematic() => OwnerWalk("rb", false);

        private IEnumerator OwnerWalk(string kind, bool events)
        {
            _kind = kind;
            _spawnPoint = peer => new Vector3(-6f + 2f * (peer % 5), 1f, 0f);
            Floor();
            yield return Match(2);
            var host = _peers[0]; var a = _peers[1]; var b = _peers[2];
            var mine = a.Mine;
            Check(mine.IsLocal && mine.HasState, "A's own character is local");
            Check(a.Spawned[0].Local && a.Spawned[0].Peer == a.Id, "A's own character was spawned first, at once");
            // every machine has a character for A, and on the other two it is the remote copy
            var onB = b.Of(a.Id); var onHost = host.Of(a.Id);
            Check(!onB.IsLocal && !onHost.IsLocal, "the copies of A are remote");
            if (kind == "cc") Check(!onB.GetComponent<CharacterController>().enabled && mine.GetComponent<CharacterController>().enabled, "the remote copy's CharacterController is off, the owner's is on");
            if (kind == "rb") Check(onB.GetComponent<Rigidbody>().isKinematic && !mine.GetComponent<Rigidbody>().isKinematic, "the remote copy's Rigidbody is kinematic, the owner's is not");
            mine.Health = 70; mine.Item = 3; mine.Team = 2; mine.Aiming = true;

            var own = new List<Sample>(); var onBPath = new List<Sample>(); var onHostPath = new List<Sample>();
            var vy = 0f; var jumped = false;
            var t0 = _net.NowMs;
            yield return null; // let a fixed step run with the character at rest
            var start = a.Mine.transform.position;
            var frames = (int)(7.5f / FrameSeconds);
            for (var i = 0; i < frames; i++)
            {
                WalkStep(mine, i, ref vy, ref jumped);
                Step();
                yield return null;
                var now = (double)_net.NowMs;
                own.Add(new Sample { T = now, P = mine.transform.position });
                if (onB.HasState) onBPath.Add(new Sample { T = now, P = onB.transform.position });
                if (onHost.HasState) onHostPath.Add(new Sample { T = now, P = onHost.transform.position });
            }
            var rb = Compare(own, onBPath); var rh = Compare(own, onHostPath);
            Report($"owner {kind} watcher client: lag {rb.Lag} ms, mean {rb.Mean:F3} m, worst {rb.Max:F3} m, {rb.N} samples; watcher host: lag {rh.Lag} ms, mean {rh.Mean:F3} m, worst {rh.Max:F3} m, {rh.N} samples");
            Check(rb.N > 100 && rh.N > 100, "enough samples");
            Check(rb.Max < 0.5 && rb.Mean < 0.15, $"client copy: worst {rb.Max:F3} (< 0.5), mean {rb.Mean:F3} (< 0.15)");
            Check(rh.Max < 0.5 && rh.Mean < 0.15, $"host copy: worst {rh.Max:F3} (< 0.5), mean {rh.Mean:F3} (< 0.15)");
            Check((onB.transform.position - mine.transform.position).magnitude < 0.5f, "the copy ends near the owner: " + onB.transform.position + " vs " + mine.transform.position);
            Check(own[own.Count - 1].P.x > start.x + 10f, "the character really walked: " + start + " -> " + own[own.Count - 1].P);

            // the values the game set travel, and the auto mode followed the movement
            Check(onB.Health == 70 && onB.Item == 3 && onB.Team == 2 && onB.Aiming, "health, item, team, aiming arrive");
            Check(onB.Mode == 0 && mine.Mode == 0, "standing at the end: mode idle (is " + onB.Mode + " / " + mine.Mode + ")");
            Check(mine.OnGround && onB.OnGround, "on the ground at the end");
            // a set on a remote machine is ignored
            onB.Health = 5;
            Check(onB.Health == 70, "a remote player's values are read-only");
            if (!events) yield break;

            // every action event, once on each of the three machines
            mine.Land(3.5f); mine.Shoot(40f, 10f); mine.MeleeAttack(2); mine.Reload(); mine.Use(9); mine.SwitchItem(4); mine.Throw(120f, 20f, 0.5f); mine.Emote(7);
            host.Of(a.Id).Hurt(host.Id, 20);
            host.Of(a.Id).Kill(host.Id);
            mine.Respawn();
            yield return Frames(60);
            foreach (var m in new[] { a, b, host })
            {
                var c = m.Counts[a.Id];
                foreach (var name in new[] { "Jumped", "Landed", "Shot", "Melee", "Reloaded", "Used", "ItemSwitched", "Thrown", "Hit", "Died", "Respawned", "Emoted" })
                    Check(c[name] == 1, m.Name + " saw " + name + " " + c[name] + " times (expected once): " + string.Join("; ", c.Args));
                Check(c.Total == 12, m.Name + " saw " + c.Total + " events of A in all (expected 12)");
            }
            Check(b.Counts[a.Id].Args.Contains("Shot 40 10") && b.Counts[a.Id].Args.Contains("Hit " + host.Id + " 20") && b.Counts[a.Id].Args.Contains("Emoted 7"), "the arguments arrive: " + string.Join("; ", b.Counts[a.Id].Args));
            Report("owner events: 12 of 12 once on the owner, the host and the other client");
            // hidden until the first state: B's copy was created with its renderer off, and showed once the state was in
            var spawnedA = b.Spawned.Find(s => s.Peer == a.Id);
            Check(!spawnedA.RendererOn, "B's copy of A was hidden when it was spawned");
            Check(b.Of(a.Id).GetComponentInChildren<Renderer>().enabled, "and visible once its first state arrived");
        }

        [UnityTest]
        public IEnumerator HostAuthority_InputIsPredictedAndNeverAtTheOriginBeforeTheFirstState()
        {
            _spawnPoint = peer => new Vector3(7f + peer, 1f, 3f);
            Floor();
            var step = new PlayerStepFunc((s, i, dt) => { s.X += i.MoveX * 6 * dt; s.Z += i.MoveY * 6 * dt; s.Vx = i.MoveX * 6; s.Vz = i.MoveY * 6; s.Yaw = i.Yaw; return s; });
            var opts = new NetPlayersOptions { Authority = PlayerAuthority.Host, Step = step };
            // joiners first create their local character (no state yet); build the match by hand so the first frames can be watched
            yield return Match(2, opts);
            var host = _peers[0]; var a = _peers[1]; var b = _peers[2];
            Check(a.Mine.IsLocal && a.Mine.HasState, "after the match, A has the host's first state of its player");
            var sp = _spawnPoint!(a.Id);
            Check((a.Mine.transform.position - sp).magnitude < 0.1f, "A starts where the host spawned it, not at the origin: " + a.Mine.transform.position);

            // a fresh joiner: its character stands at the spawn point from the first frame, never at the origin, and is not moved until the host's state is in
            var c = new Peer { Name = "client3" };
            c.Client = new LobbyClient(Config("client3"), _net.CreateTransport());
            _peers.Add(c);
            var tj = c.Client.JoinAsync(host.Lobby.Code);
            yield return Wait(tj);
            c.Lobby = tj.Result;
            for (var k = 0; k < 400 && !c.Lobby.IsReady; k++) { Step(); yield return null; }
            BeginSpawner(c, opts);
            var spawnC = _spawnPoint!(c.Id);
            var nearOriginFrames = 0; var framesBefore = 0; var firstState = -1;
            for (var i = 0; i < 60; i++)
            {
                var np = c.Mine;
                np.SetInput(new Vector2(1, 0), 90f);
                var pos = c.Mine.transform.position;
                if (pos.magnitude < 1.5f) nearOriginFrames++;
                if (!np.HasState) { framesBefore++; Check((pos - spawnC).magnitude < 0.01f, "before the first state the character stays where the game put it (" + pos + ")"); }
                else if (firstState < 0) firstState = i;
                Step();
                yield return null;
            }
            Check(nearOriginFrames == 0, "the character was near the origin in " + nearOriginFrames + " frames");
            Check(firstState >= 0, "the first state never arrived");
            Report($"host authority: the joiner's first state came after {framesBefore} frames, never near the origin");

            // everyone walks for 2 s (A and the host), then stops; the host's record, A's prediction and B's copy agree
            var hostNp = host.Mine;
            for (var i = 0; i < 61; i++)
            {
                a.Mine.SetInput(new Vector2(1, 0), 90f);
                hostNp.SetInput(new Vector2(0, 1), 0f);
                c.Mine.SetInput(Vector2.zero, 0f);
                Step();
                yield return null;
            }
            a.Mine.SetInput(Vector2.zero, 90f); hostNp.SetInput(Vector2.zero, 0f);
            yield return Frames(60);
            var recA = host.Layer.Latest(a.Id)!.Value;
            var recHost = host.Layer.Local!.Value;
            var aLocal = a.Mine.transform.position; var aOnB = b.Of(a.Id).transform.position; var aOnHost = host.Of(a.Id).transform.position;
            var hostOnB = b.Of(host.Id).transform.position;
            Report($"host authority: A moved {aLocal.x - sp.x:F2} m in x (host record {recA.X - sp.x:F2}); copy on B {aOnB.x - sp.x:F2}; the host walked {hostOnB.z - _spawnPoint(host.Id).z:F2} m in z");
            Check(aLocal.x - sp.x > 8f, "A's predicted character walked: " + (aLocal.x - sp.x));
            Check(Math.Abs(aLocal.x - recA.X) < 0.3, "A's prediction agrees with the host's record: " + aLocal.x + " vs " + recA.X);
            Check((aOnB - aOnHost).magnitude < 0.3f && Math.Abs(aOnB.x - recA.X) < 0.3, "B's copy of A agrees with the host's record: " + aOnB.x + " vs " + recA.X);
            Check(Math.Abs(hostOnB.z - recHost.Z) < 0.3 && recHost.Z - _spawnPoint(host.Id).z > 8, "the host's own character walked and B sees it: " + hostOnB.z + " vs " + recHost.Z);
            Check(Math.Abs(a.Mine.transform.rotation.eulerAngles.y - 90f) < 1f && Math.Abs(b.Of(a.Id).transform.rotation.eulerAngles.y - 90f) < 1f, "the facing arrived (yaw 90)");
        }

        [UnityTest]
        public IEnumerator HostAuthority_WithoutAStepIsOneClearError()
        {
            var go = new GameObject("lonely");
            _objects.Add(go);
            var p = new Peer { Name = "host" };
            p.Client = new LobbyClient(Config("host"), _net.CreateTransport());
            _peers.Add(p);
            var t = p.Client.HostAsync(new LobbyOptions("room", 4));
            yield return Wait(t);
            p.Lobby = t.Result;
            var layer = new NetPlayers(p.Lobby, new NetPlayersOptions { Authority = PlayerAuthority.Host });
            var np = go.AddComponent<OneLobbyNetPlayer>();
            np.PeerId = p.Id;
            LogAssert.Expect(LogType.Error, new System.Text.RegularExpressions.Regex("give the component a Step"));
            np.Bind(layer);
            np.SetInput(new Vector2(1, 0), 0f);
            for (var i = 0; i < 10; i++) { Step(); yield return null; } // the layer is not pumped here: only the component's own message is expected
            var errors = _logged.FindAll(l => l.StartsWith("Error", StringComparison.Ordinal) || l.StartsWith("Exception", StringComparison.Ordinal));
            Check(errors.Count == 1, "exactly one error, got " + errors.Count + ": " + string.Join(" | ", errors));
            // once a step is set, the same component works
            np.Step = (s, i, dt) => { s.X += i.MoveX * dt; return s; };
            Check(layer.Step != null, "the component hands its Step to the layer");
            np.Unbind();
            layer.Dispose();
            layer.Session.Dispose();
        }

        [UnityTest]
        public IEnumerator Spawner_ASpectatorsLocalCharacterIsTakenBackWhenTheRosterSaysSpectator()
        {
            var host = new Peer { Name = "host" };
            host.Client = new LobbyClient(Config("host"), _net.CreateTransport());
            _peers.Add(host);
            var t = host.Client.HostAsync(new LobbyOptions("room", 8) { Room = new RoomOptions { Spectators = 2 } });
            yield return Wait(t);
            host.Lobby = t.Result;
            BeginSpawner(host, null);
            var s = new Peer { Name = "spectator" };
            s.Client = new LobbyClient(Config("spectator"), _net.CreateTransport());
            _peers.Add(s);
            var tj = s.Client.JoinAsync(host.Lobby.Code, new RoomJoinOptions { Role = RoomRole.Spectator });
            yield return Wait(tj);
            s.Lobby = tj.Result;
            BeginSpawner(s, null);
            var atOnce = s.Spawner.CharacterOf(s.Id) != null;
            yield return Frames(60);
            Report("spectator: local character at once " + atOnce + ", after 60 frames " + (s.Spawner.CharacterOf(s.Id) != null) + ", roster role " + s.Lobby.Room.Player(s.Id)?.Role);
            Check(s.Spawner.CharacterOf(s.Id) == null, "the spectator has no local character once the roster says spectator");
            Check(host.Spawner.CharacterOf(s.Id) == null, "the host never made one for it");
            Check(host.Spawner.CharacterOf(host.Id) != null, "the host's own stays");
            if (atOnce) Check(s.Removed.Contains(s.Id), "the early character was taken back with PlayerRemoved");
        }

        [UnityTest]
        public IEnumerator Spawner_ASpectatorWhoBecomesAPlayerGetsACharacter()
        {
            var host = new Peer { Name = "host" };
            host.Client = new LobbyClient(Config("host"), _net.CreateTransport());
            _peers.Add(host);
            var t = host.Client.HostAsync(new LobbyOptions("room", 8) { Room = new RoomOptions { Spectators = 2 } });
            yield return Wait(t);
            host.Lobby = t.Result;
            BeginSpawner(host, null);
            var s = new Peer { Name = "spectator" };
            s.Client = new LobbyClient(Config("spectator"), _net.CreateTransport());
            _peers.Add(s);
            var tj = s.Client.JoinAsync(host.Lobby.Code, new RoomJoinOptions { Role = RoomRole.Spectator });
            yield return Wait(tj);
            s.Lobby = tj.Result;
            BeginSpawner(s, null);
            yield return Frames(60);
            Check(s.Spawner.CharacterOf(s.Id) == null && host.Spawner.CharacterOf(s.Id) == null, "no character while it is a spectator");
            s.Lobby.Room.SetRole(RoomRole.Player);
            yield return Frames(120);
            Report("spectator to player: roster role " + s.Lobby.Room.Player(s.Id)?.Role + ", own character " + (s.Spawner.CharacterOf(s.Id) != null) + ", host's copy " + (host.Spawner.CharacterOf(s.Id) != null));
            Check(s.Spawner.CharacterOf(s.Id) != null && s.Spawned.Exists(x => x.Peer == s.Id && x.Local), "its own character is made, marked local");
            Check(host.Spawner.CharacterOf(s.Id) != null, "and the host has a copy of it");
        }

        [UnityTest]
        public IEnumerator HostAuthority_ACharactersOwnStepSurvivesASpawnerWithoutOne()
        {
            var p = new Peer { Name = "host" };
            p.Client = new LobbyClient(Config("host"), _net.CreateTransport());
            _peers.Add(p);
            var t = p.Client.HostAsync(new LobbyOptions("room", 4));
            yield return Wait(t);
            p.Lobby = t.Result;
            PlayerStepFunc own = (st, i, dt) => st;
            var go = new GameObject("spawner own step");
            _objects.Add(go);
            p.Spawner = go.AddComponent<OneLobbyNetPlayerSpawner>();
            p.Spawner.Factory = peer =>
            {
                var c = MakeCharacter(peer);
                c.GetComponentInChildren<OneLobbyNetPlayer>(true).Step = own; // what a character's own Awake or prefab setup does
                return c;
            };
            p.Spawner.Begin(p.Lobby, null, new NetPlayersOptions { Authority = PlayerAuthority.Host });
            yield return Frames(20);
            var np = p.Spawner.CharacterOf(p.Lobby.LocalPeerId)!.GetComponentInChildren<OneLobbyNetPlayer>(true);
            Check(np.Step == own, "the character keeps its own step");
            Check(p.Spawner.Players!.Step == own, "and the layer got it");
            Check(!_logged.Exists(l => l.StartsWith("Error", StringComparison.Ordinal) || l.StartsWith("Exception", StringComparison.Ordinal)), "no error: " + string.Join(" | ", _logged));
        }

        [UnityTest]
        public IEnumerator HostAuthority_SpawnerWithoutAStepLogsOneErrorAndNeverThrows()
        {
            var p = new Peer { Name = "host" };
            p.Client = new LobbyClient(Config("host"), _net.CreateTransport());
            _peers.Add(p);
            var t = p.Client.HostAsync(new LobbyOptions("room", 4));
            yield return Wait(t);
            p.Lobby = t.Result;
            LogAssert.Expect(LogType.Error, new System.Text.RegularExpressions.Regex("give the component a Step"));
            LogAssert.Expect(LogType.Exception, new System.Text.RegularExpressions.Regex("authority Host needs a step function"));
            BeginSpawner(p, new NetPlayersOptions { Authority = PlayerAuthority.Host });
            _logged.Clear();
            yield return Frames(60);
            // the spawner pumps the layer itself (no workaround): the layer reports the missing step once and keeps working
            var bad = _logged.FindAll(l => l.StartsWith("Error", StringComparison.Ordinal) || l.StartsWith("Exception", StringComparison.Ordinal));
            var again = bad.FindAll(l => l.Contains("needs a step function"));
            Check(again.Count == 1, "the layer reports the missing step once, not every frame: " + again.Count + " of " + string.Join(" | ", bad));
            yield return Frames(20);
            Check(_logged.FindAll(l => l.Contains("needs a step function")).Count == 1, "and still once after 20 more frames");
            // a step arrives later: the layer runs
            _logged.Clear();
            p.Spawner.Players!.Step = (st, i, dt) => st;
            yield return Frames(30);
            Check(!_logged.Exists(l => l.StartsWith("Exception", StringComparison.Ordinal) || l.StartsWith("Error", StringComparison.Ordinal)), "and runs once a Step is set");
        }

        [UnityTest]
        public IEnumerator Animator_ValuesFollowTheMapAndAMissingParameterIsSkipped()
        {
            Floor();
            yield return Match(1);
            var a = _peers[0]; var b = _peers[1];
            // a controller made in code: speed (float), grounded (bool), mode (int); no parameter for health
            var ctrl = new UnityEditor.Animations.AnimatorController();
            ctrl.AddLayer("Base");
            ctrl.AddParameter("speed", AnimatorControllerParameterType.Float);
            ctrl.AddParameter("grounded", AnimatorControllerParameterType.Bool);
            ctrl.AddParameter("mode", AnimatorControllerParameterType.Int);
            ctrl.AddParameter("team", AnimatorControllerParameterType.Int);
            ctrl.AddParameter("fire", AnimatorControllerParameterType.Trigger);
            var remote = b.Of(a.Id);
            var anim = remote.gameObject.AddComponent<Animator>();
            anim.runtimeAnimatorController = ctrl;
            remote.Animator = anim;
            remote.AnimatorMap = new List<NetPlayerAnimatorEntry>
            {
                new() { Value = "speed", Parameter = "speed" }, new() { Value = "on_ground", Parameter = "grounded" }, new() { Value = "mode", Parameter = "mode" },
                new() { Value = "health", Parameter = "hp" },     // the Animator has no "hp": skipped
                new() { Value = "alive", Parameter = "fire" },    // a trigger: skipped
                new() { Value = "team", Parameter = "team" },
            };
            remote.RefreshAnimator();
            a.Mine.Team = 2; a.Mine.Health = 33;
            var mine = a.Mine;
            _logged.Clear();
            for (var i = 0; i < 90; i++)
            {
                mine.transform.position += new Vector3(5 * FrameSeconds, 0, 0);
                Step();
                yield return null;
            }
            Report($"animator: speed {anim.GetFloat("speed"):F2}, grounded {anim.GetBool("grounded")}, mode {anim.GetInteger("mode")}, team {anim.GetInteger("team")}");
            Check(Math.Abs(anim.GetFloat("speed") - 5f) < 0.6f, "speed follows the velocity: " + anim.GetFloat("speed"));
            Check(anim.GetBool("grounded"), "on_ground goes to the bool");
            Check(anim.GetInteger("mode") == 1, "the walking mode goes to the int (derived from the movement): " + anim.GetInteger("mode"));
            Check(anim.GetInteger("team") == 2, "team goes to the int");
            Check(remote.Health == 33, "health is still a property");
            Check(!_logged.Exists(l => l.Contains("Parameter") || l.StartsWith("Error") || l.StartsWith("Exception")), "no message about a missing parameter: " + string.Join(" | ", _logged));
            // no Animator set: nothing happens
            var plain = a.Of(b.Id);
            Check(plain.Animator == null, "no Animator set on the other copy: nothing to do (and nothing logged)");
        }

        [UnityTest]
        public IEnumerator Spawner_LocalAtOnce_JoinLeaveAndStop()
        {
            Floor();
            var host = new Peer { Name = "host" };
            host.Client = new LobbyClient(Config("host"), _net.CreateTransport());
            _peers.Add(host);
            var t = host.Client.HostAsync(new LobbyOptions("room", 8));
            yield return Wait(t);
            host.Lobby = t.Result;
            BeginSpawner(host, null);
            // the local character exists before any frame ran
            Check(host.Spawner.CharacterOf(host.Id) != null, "the local character exists at once");
            Check(host.Spawned.Count == 1 && host.Spawned[0].Local, "PlayerSpawned(local) was raised at once");
            Check(host.Layer.LocalPeerId == host.Id, "the layer is the host's");

            var j = new Peer { Name = "joiner" };
            j.Client = new LobbyClient(Config("joiner"), _net.CreateTransport());
            _peers.Add(j);
            var tj = j.Client.JoinAsync(host.Lobby.Code);
            yield return Wait(tj);
            j.Lobby = tj.Result;
            for (var k = 0; k < 400 && !j.Lobby.IsReady; k++) { Step(); yield return null; }
            BeginSpawner(j, null);
            Check(j.Spawner.CharacterOf(j.Id) != null, "the joiner's local character exists at once");
            yield return Frames(30);
            Check(host.Spawner.CharacterOf(j.Id) != null && host.Spawned.Exists(s => s.Peer == j.Id && !s.Local), "the host spawned the joiner on PlayerJoined");
            Check(j.Spawner.CharacterOf(host.Id) != null && j.Spawned.Exists(s => s.Peer == host.Id && !s.Local), "the joiner spawned the host's character");
            Check(host.Spawned.FindAll(s => s.Peer == j.Id).Count == 1, "one character per player (not two: the local one is not spawned again)");
            Check(host.Spawner.Characters.Count == 2, "two characters");
            var charJ = host.Spawner.CharacterOf(j.Id)!;

            // Stop on the joiner: its characters are destroyed, the layer and its session are disposed (the session no longer reads the lobby)
            var layer = j.Layer;
            var tick = layer.Session.LatestTick;
            Check(tick > 0, "the joiner's session had snapshots");
            var mineGo = j.Spawner.CharacterOf(j.Id)!;
            j.Spawner.Stop();
            yield return null;
            Check(j.Spawner.Players == null && j.Spawner.Characters.Count == 0 && mineGo == null, "Stop: no layer, no characters, the character destroyed");
            Check(j.Removed.Contains(j.Id) && j.Removed.Contains(host.Id), "Stop raised PlayerRemoved for each character");
            for (var i = 0; i < 20; i++) { Step(); yield return null; }
            Check(layer.Session.LatestTick == tick, "the disposed session no longer reads the lobby (latest tick stayed " + tick + ")");
            // the same lobby can start another layer afterwards, and destroying the spawner's object disposes it too
            BeginSpawner(j, null);
            Check(j.Spawner.CharacterOf(j.Id) != null, "a second Begin on the same lobby works");
            var wait = 0;
            while (wait < 60 && j.Spawner.CharacterOf(host.Id) == null) { Step(); wait++; yield return null; }
            Report("a second layer on a lobby that is already playing saw the host's player after " + wait + " frames (" + wait * FrameMs + " ms)");
            // a full snapshot answers the new layer's ack 0 at once (replication spec "Resync"): 198 ms measured, bound 300 ms (50% room)
            Check(j.Spawner.CharacterOf(host.Id) != null && wait * FrameMs <= 300, "and sees the host again within 300 ms (" + wait * FrameMs + " ms)");
            var second = j.Layer;
            var tick2 = second.Session.LatestTick;
            Check(tick2 > 0, "the second session had snapshots");
            UnityEngine.Object.DestroyImmediate(j.Spawner.gameObject);
            yield return null;
            for (var i = 0; i < 20; i++) { Step(); yield return null; }
            Check(second.Session.LatestTick == tick2, "OnDestroy disposed the layer's session");
            j.Spawner = null!;

            // the joiner leaves: its character is destroyed on the host
            var leave = j.Lobby.LeaveAsync();
            yield return Wait(leave);
            yield return Frames(40);
            Check(host.Removed.Contains(j.Id), "PlayerRemoved was raised on the host");
            Check(host.Spawner.CharacterOf(j.Id) == null && charJ == null, "and the character is destroyed");
        }

        [UnityTest]
        public IEnumerator TwoD_PositionIsXYAndYawIsTheZRotation()
        {
            // a 2D game: the wire's x, y are the transform's x, y; the facing is the rotation about z; z of the transform is left alone
            _spawnPoint = peer => new Vector3(peer, peer, 5f);
            yield return Match(1, new NetPlayersOptions { Space = "2d" });
            var a = _peers[0]; var b = _peers[1];
            var mine = a.Mine;
            var copy = b.Of(a.Id);
            double vx = 0, vy = 0;
            for (var i = 0; i < 90; i++)
            {
                mine.transform.position += new Vector3(3 * FrameSeconds, 2 * FrameSeconds, 0);
                mine.transform.rotation = Quaternion.Euler(0, 0, 135f);
                Step();
                yield return null;
                vx = copy.State.Vx; vy = copy.State.Vy;
            }
            yield return Frames(5);
            var p = copy.transform.position;
            Report($"2d: owner ({mine.transform.position.x:F2}, {mine.transform.position.y:F2}), copy ({p.x:F2}, {p.y:F2}, z {p.z:F2}), copy yaw about z {copy.transform.eulerAngles.z:F1}");
            Check(Math.Abs(p.x - mine.transform.position.x) < 0.2f && Math.Abs(p.y - mine.transform.position.y) < 0.2f, "x and y of the transform follow");
            Check(Math.Abs(p.z - 5f) < 0.001f, "the transform's z is never written (was 5, is " + p.z + ")");
            Check(Math.Abs(copy.transform.eulerAngles.z - 135f) < 1f && Math.Abs(copy.transform.eulerAngles.y) < 0.001f, "the yaw is the rotation about z");
            Check(Math.Abs(vx - 3.0) < 0.5 && Math.Abs(vy - 2.0) < 0.5, "the velocity is (vx, vy): " + vx + ", " + vy);
        }

        [UnityTest]
        public IEnumerator OwnerAuthority_AHostCorrectionPutsTheOwnersCharacterBack()
        {
            Floor();
            _spawnPoint = peer => new Vector3(0, 1, 0);
            yield return Match(1, new NetPlayersOptions { Limits = new PlayerLimits(MaxSpeed: 8, MaxStep: null, MinShotIntervalMs: null, MinMeleeIntervalMs: null) });
            var a = _peers[1]; var mine = a.Mine;
            // an honest walk first, then a jump of 60 m in one frame that is not a teleport: the host keeps the old place and puts the owner back
            for (var i = 0; i < 30; i++) { mine.transform.position += new Vector3(4 * FrameSeconds, 0, 0); Step(); yield return null; }
            var before = mine.transform.position;
            mine.transform.position += new Vector3(60, 0, 0);
            var corrections = a.Layer.Stats.Corrections;
            for (var i = 0; i < 40; i++) { Step(); yield return null; }
            Report($"correction: before {before.x:F2}, after the jump and the correction {mine.transform.position.x:F2}, corrections {a.Layer.Stats.Corrections}");
            Check(a.Layer.Stats.Corrections > corrections, "the host put the owner back (a correction was counted)");
            Check(Math.Abs(mine.transform.position.x - before.x) < 3f, "the owner's character is near where it was: " + mine.transform.position.x + " vs " + before.x);
        }

        [UnityTest]
        public IEnumerator UnbindPutsTheControllerAndTheBodyBack()
        {
            _kind = "cc";
            Floor();
            yield return Match(1);
            var remote = _peers[1].Of(_peers[0].Id);
            var cc = remote.GetComponent<CharacterController>();
            Check(!cc.enabled, "bound as a remote copy: the controller is off");
            remote.Unbind();
            Check(cc.enabled, "unbound: the controller is on again");
            Check(!remote.IsBound, "unbound");
        }
    }
}
