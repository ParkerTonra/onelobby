using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using OneLobby.Replication;

namespace OneLobby.Replication.Tests
{
    /// <summary>An Eons-Later-shaped alien: position on a 512 m map, height, yaw, animation, health. 64 bits on the wire.</summary>
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
        public readonly Random Rng = new(1234);
        public Player Host = null!;
        public ReplicationConfig? Config;
        /// <summary>Host sim step, run once per host tick before the snapshot.</summary>
        public Action<uint>? HostTick;
        public int FrameMs = 16;

        public Rig(ReplicationConfig? config = null, double latencyMs = 30, double lossRate = 0, double jitterMs = 0)
        {
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
            Net.Advance(FrameMs);
            foreach (var p in Players.ToList())
            {
                if (p.Session == null) { p.Client.Pump(); continue; }
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
