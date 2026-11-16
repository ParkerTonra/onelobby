using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using OneLobby.Replication;

namespace OneLobby.Replication.Tests
{
    /// <summary>A typical creature: position on a 512 m map, height, yaw, animation, health. 64 bits on the wire.</summary>
    internal sealed class Alien : IReplicatedEntity
    {
        public float X, Y, Z, Yaw;
        public byte Anim, Hp = 100;
        public void Write(NetWriter w)
        {
            w.WriteQuantized(X, -256, 256, 16);
            w.WriteQuantized(Y, -32, 32, 12);
            w.WriteQuantized(Z, -256, 256, 16);
            w.WriteAngle(Yaw, 9);
            w.WriteBits(Anim, 4);
            w.WriteBits(Hp, 7);
        }
        public AlienState Quantized()
        {
            var w = new NetWriter();
            Write(w);
            var s = new AlienState();
            s.Read(new NetReader(w.ToArray()));
            return s;
        }
    }

    internal struct AlienState : IReplicatedState<AlienState>
    {
        public float X, Y, Z, Yaw;
        public byte Anim, Hp;
        public void Read(NetReader r)
        {
            X = r.ReadQuantized(-256, 256, 16);
            Y = r.ReadQuantized(-32, 32, 12);
            Z = r.ReadQuantized(-256, 256, 16);
            Yaw = r.ReadAngle(9);
            Anim = (byte)r.ReadBits(4);
            Hp = (byte)r.ReadBits(7);
        }
        public AlienState Interpolate(in AlienState to, float t) => new()
        {
            X = NetMath.Lerp(X, to.X, t), Y = NetMath.Lerp(Y, to.Y, t), Z = NetMath.Lerp(Z, to.Z, t),
            Yaw = NetMath.LerpAngle(Yaw, to.Yaw, t), Anim = t < 0.5f ? Anim : to.Anim, Hp = t < 0.5f ? Hp : to.Hp,
        };
    }

    internal sealed class Player
    {
        public LobbyClient Client = null!;
        public ITransport Transport = null!;
        public Lobby Lobby = null!;
        public ReplicationSession Session = null!;
        public readonly List<EntityInfo> Spawned = new();
        public readonly List<EntityInfo> Despawned = new();
        public readonly List<(int From, uint Tick, byte[] Payload)> Events = new();
        /// <summary>Client: called once per local input tick; returns the input bytes (null = send nothing).</summary>
        public Func<uint, byte[]?>? MakeInput;
        public readonly List<uint> SubmittedSeqs = new();
        /// <summary>The networked player layer, when this peer has one (the rig then calls its Pump, which runs the session).</summary>
        public NetPlayers? Layer;
        public int PeerId => Lobby.LocalPeerId;

        public void Attach(ReplicationConfig? cfg)
        {
            Session = new ReplicationSession(Lobby, cfg);
            Session.EntitySpawned += e => Spawned.Add(e);
            Session.EntityDespawned += e => Despawned.Add(e);
            Session.EventReceived += (f, t, p) => Events.Add((f, t, p.ToArray()));
        }
    }

    internal sealed class Rig
    {
        public readonly InMemoryNetwork Net = new();
        public readonly List<Player> Players = new();
        public readonly Random Rng;
        public Player Host = null!;
        public ReplicationConfig? Config;
        /// <summary>Host sim step, run once per host tick before the snapshot.</summary>
        public Action<uint>? HostTick;
        public int FrameMs = 16;
        /// <summary>False (default): a message is read at the end of the frame it became due in. True: at its due millisecond, as the JS rig does.</summary>
        public bool PreciseArrival;
        /// <summary>False (default): an exception out of a layer's Pump fails the test. True: it is collected in <see cref="PumpErrors"/> and the frame goes on.</summary>
        public bool CatchPumpErrors;
        public readonly List<Exception> PumpErrors = new();
        /// <summary>Peers whose frames are skipped (a host that stopped sending, a client that went away).</summary>
        public readonly HashSet<Player> Frozen = new();
        /// <summary>Virtual time in ms.</summary>
        public long NowMs => Net.NowMs;

        public Rig(ReplicationConfig? config = null, double latencyMs = 30, double lossRate = 0, double jitterMs = 0, int seed = 1234)
        {
            Rng = new Random(seed);
            Config = config;
            Net.LatencyMs = latencyMs;
            if (lossRate > 0) Net.DropUnreliable = () => Rng.NextDouble() < lossRate;
            if (jitterMs > 0) Net.ExtraDelayMs = _ => Rng.NextDouble() * jitterMs;
        }

        private static OneLobbyConfig Cfg(string name) =>
            new("dev.onelobby.replication-tests", "1", new Uri("ws://mem/ws"), SyncMode.Raw, 30, 30, name);

        private Player NewPlayer(string name)
        {
            var t = Net.CreateTransport();
            var p = new Player { Transport = t, Client = new LobbyClient(Cfg(name), t) };
            Players.Add(p);
            return p;
        }

        private T Await<T>(Task<T> task)
        {
            for (var i = 0; i < 600 && !task.IsCompleted; i++) Step();
            if (!task.IsCompleted) throw new TimeoutException("lobby call did not complete");
            return task.GetAwaiter().GetResult();
        }

        public Player StartHost()
        {
            var p = NewPlayer("host");
            p.Lobby = Await(p.Client.HostAsync(new LobbyOptions("room", 8)));
            p.Attach(Config);
            Host = p;
            return p;
        }

        /// <summary>A host with a player layer (and room for spectators).</summary>
        public Player StartHostLayer(NetPlayersOptions options, int spectators = 0)
        {
            var p = NewPlayer("host");
            p.Lobby = Await(p.Client.HostAsync(new LobbyOptions("room", 8) { Room = spectators > 0 ? new RoomOptions { Spectators = spectators } : null }));
            p.Attach(Config);
            p.Layer = new NetPlayers(p.Session, options);
            Host = p;
            return p;
        }

        /// <summary>A joiner with a player layer, as a player or a spectator.</summary>
        public Player JoinLayer(string name, NetPlayersOptions options, bool spectator = false)
        {
            var p = NewPlayer(name);
            p.Lobby = Await(p.Client.JoinAsync(Host.Lobby.Code, new RoomJoinOptions { Role = spectator ? RoomRole.Spectator : RoomRole.Player }));
            p.Attach(Config);
            p.Layer = new NetPlayers(p.Session, options);
            Until(() => p.Lobby.IsReady, 400);
            return p;
        }

        /// <summary>The peer leaves the lobby and its frames stop.</summary>
        public void Leave(Player p)
        {
            var t = p.Lobby.LeaveAsync();
            for (var i = 0; i < 600 && !t.IsCompleted; i++) Step();
            Frozen.Add(p);
        }

        public Player Join(string name)
        {
            var p = NewPlayer(name);
            p.Lobby = Await(p.Client.JoinAsync(Host.Lobby.Code));
            p.Attach(Config);
            Until(() => p.Lobby.IsReady, 400);
            return p;
        }

        /// <summary>One render frame on every peer: pump, run due ticks (host: sim + snapshot; client: inputs).</summary>
        public void Step()
        {
            if (PreciseArrival)
            {
                // the JS rig fires each message at its due millisecond; do the same: pump every peer's lobby after each ms of the frame
                for (var ms = 1; ms < FrameMs; ms++) { Net.Advance(1); foreach (var q in Players.ToList()) if (!Frozen.Contains(q)) q.Client.Pump(); }
                Net.Advance(1);
            }
            else Net.Advance(FrameMs);
            foreach (var p in Players.ToList())
            {
                if (p.Session == null) { p.Client.Pump(); continue; }
                if (Frozen.Contains(p)) continue;
                if (p.Layer != null)
                {
                    try { p.Layer.Pump(); }
                    catch (Exception e) when (CatchPumpErrors) { PumpErrors.Add(e); }
                    continue;
                }
                p.Session.Pump();
                if (p.Session.IsHost)
                {
                    while (p.Session.Clock.TryAdvance())
                    {
                        HostTick?.Invoke(p.Session.Clock.Tick);
                        p.Session.SendSnapshot();
                    }
                }
                else
                {
                    while (p.Session.Clock.TryAdvance())
                    {
                        var input = p.MakeInput?.Invoke(p.Session.Clock.Tick);
                        if (input != null) p.SubmittedSeqs.Add(p.Session.SubmitInput(input));
                    }
                }
            }
        }

        public void Run(double seconds) { for (var i = 0; i < seconds * 1000 / FrameMs; i++) Step(); }

        public bool Until(Func<bool> cond, int maxSteps = 1200)
        {
            for (var i = 0; i < maxSteps; i++) { if (cond()) return true; Step(); }
            return cond();
        }
    }
}
