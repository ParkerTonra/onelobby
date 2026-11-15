using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using OneLobby.Gridpaint;

namespace OneLobby.Tests
{
    /// <summary>One in-memory world for room tests: kits with their own player id and ban stores, and simulated time.</summary>
    internal sealed class RoomRig
    {
        public readonly Rig R = new();
        public InMemoryNetwork Net => R.Net;

        public RoomRig(bool roomHub = true) { if (!roomHub) Net.Features = new[] { "set_name" }; }

        public sealed class Kit
        {
            public LobbyClient Client = null!;
            public IKeyValueStore IdStore = null!;
            public IKeyValueStore BanStore = null!;
            public string Name = "";
            public string PlayerId => Client.PlayerId;
        }

        /// <summary>A client with its own (memory) stores; pass <paramref name="from"/> to be the same install again.</summary>
        public Kit NewKit(string name, SyncMode mode = SyncMode.Raw, Kit? from = null, Func<OneLobbyConfig, OneLobbyConfig>? tweak = null)
        {
            var k = new Kit { Name = name, IdStore = from?.IdStore ?? KeyValueStores.Memory(), BanStore = from?.BanStore ?? KeyValueStores.Memory() };
            var cfg = Rig.Config(name, mode: mode) with { PlayerIdStore = k.IdStore, BanStore = k.BanStore };
            if (tweak != null) cfg = tweak(cfg);
            k.Client = new LobbyClient(cfg, Net.CreateTransport());
            R.Clients.Add(k.Client);
            return k;
        }

        public void Flush() => R.Step(12);

        /// <summary>Runs simulated time (25 ms steps).</summary>
        public void Wait(int ms) => R.Step(Math.Max(1, ms / 25));

        public (Kit K, Lobby L) Host(RoomOptions? room = null, int max = 4, string? password = null, string name = "Host", SyncMode mode = SyncMode.Raw, Kit? from = null)
        {
            var k = NewKit(name, mode, from);
            var l = R.Await(k.Client.HostAsync(new LobbyOptions("t", max) { Room = room, Password = password }));
            return (k, l);
        }

        public (Kit K, Lobby L) Join(Lobby host, string name, RoomJoinOptions? jo = null, Kit? from = null, SyncMode mode = SyncMode.Raw)
        {
            var k = from ?? NewKit(name, mode);
            var l = R.Await(k.Client.JoinAsync(host.Code, jo));
            Flush();
            return (k, l);
        }

        public static IReadOnlyDictionary<string, string> D(params (string, string)[] kv) => kv.ToDictionary(x => x.Item1, x => x.Item2);
        public static List<string> Names(Lobby l) => l.Room.Players.Select(p => p.Name).ToList();

        /// <summary>The first exception text of an action, or "".</summary>
        public static string Throws(Action a)
        {
            try { a(); return ""; } catch (Exception e) { return e is OneLobbyException o ? o.Code + ": " + o.Message : e.GetType().Name + ": " + e.Message; }
        }
    }
}
