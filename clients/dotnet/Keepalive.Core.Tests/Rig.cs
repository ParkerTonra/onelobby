using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Keepalive.Gridpaint;

namespace Keepalive.Tests
{
    internal sealed class FakeCodec : IVoiceCodec
    {
        public int SampleRate => 48000;
        public int FrameSamples => 960;
        public int Bitrate { get; set; } = 24000;
        public int Encode(ReadOnlySpan<short> pcm, Span<byte> output)
        {
            output[0] = 0xF8; output[1] = (byte)pcm[0]; output[2] = (byte)(pcm[0] >> 8);
            return 3;
        }
        public int Decode(int streamId, ReadOnlySpan<byte> packet, Span<short> pcm)
        {
            short v = packet.Length >= 3 ? (short)(packet[1] | packet[2] << 8) : (short)-1;
            pcm.Fill(v);
            return pcm.Length;
        }
        public void ReleaseStream(int streamId) { }
        public void Dispose() { }
    }

    internal sealed class FakeAudio : IVoiceAudio
    {
        public readonly Queue<short> Captured = new();
        public readonly List<(int Peer, short First, float Gain)> Played = new();
        public bool Capturing;
        public bool StartCapture() { Capturing = true; return true; }
        public void StopCapture() { Capturing = false; }
        public void Feed(short value, int frames = 1) { for (var i = 0; i < frames; i++) Captured.Enqueue(value); }
        public bool ReadCapture(Span<short> frame)
        {
            if (Captured.Count == 0) return false;
            frame.Fill(Captured.Dequeue());
            return true;
        }
        public void Play(int peerId, ReadOnlySpan<short> pcm, float gain) => Played.Add((peerId, pcm[0], gain));
        public void Dispose() { }
    }

    /// <summary>One client plus its gridpaint game, following the s.11.1 loop.</summary>
    internal sealed class GridPlayer
    {
        public LobbyClient Client = null!;
        public Lobby Lobby = null!;
        public GridpaintGame Game = null!;
        public ITransport Transport = null!;
        public readonly Dictionary<long, ulong> Hashes = new();
        public readonly List<DesyncInfo> Desyncs = new();
        public readonly List<(Peer, string)> Left = new();
        public readonly List<int> HostChanges = new();
        public readonly List<string> Ended = new();
        public bool Paused;

        public void Attach(Lobby lobby)
        {
            Lobby = lobby;
            Game = new GridpaintGame(lobby.Code);
            var ls = lobby.Lockstep!;
            ls.Snapshot = () => Game.Snapshot();
            ls.Restore = (t, b) => { Game.Restore(t, b.Span); Hashes.Clear(); };
            ls.Desync += d => Desyncs.Add(d);
            lobby.PeerLeft += (p, r) => Left.Add((p, r));
            lobby.HostChanged += h => HostChanges.Add(h);
            lobby.SessionEnded += r => Ended.Add(r);
        }

        public void Consume()
        {
            if (Lobby == null || Paused) return;
            var ls = Lobby.Lockstep!;
            while (ls.TryNextFrame(out var f))
            {
                Game.Apply(f.Tick, f.Commands);
                Hashes[f.Tick] = Game.Hash();
                if (f.Tick % GridpaintGame.HashEveryTicks == 0) ls.ReportHash(f.Tick, Game.Hash());
            }
        }

        public void Paint(int x, int y) => Lobby.Lockstep!.Submit(GridpaintGame.PaintCommand(x, y));
    }

    internal sealed class Rig
    {
        public readonly InMemoryNetwork Net = new();
        public readonly List<GridPlayer> Players = new();
        public readonly List<LobbyClient> Clients = new();

        public static KeepaliveConfig Config(string name = "p", string netVersion = GridpaintGame.NetVersion, SyncMode mode = SyncMode.Lockstep) =>
            new(GridpaintGame.GameId, netVersion, new Uri("ws://mem/ws"), mode, GridpaintGame.TickRate, GridpaintGame.HashEveryTicks, name);

        public GridPlayer NewPlayer(string name, string netVersion = GridpaintGame.NetVersion)
        {
            var t = Net.CreateTransport();
            var c = new LobbyClient(Config(name, netVersion), t);
            Clients.Add(c);
            var p = new GridPlayer { Client = c, Transport = t };
            Players.Add(p);
            return p;
        }

        public LobbyClient NewClient(string name, SyncMode mode = SyncMode.Lockstep, string netVersion = GridpaintGame.NetVersion)
        {
            var c = new LobbyClient(Config(name, netVersion, mode), Net.CreateTransport());
            Clients.Add(c);
            return c;
        }

        public void Step(int n = 1, long ms = 25)
        {
            for (var i = 0; i < n; i++)
            {
                Net.Advance(ms);
                foreach (var c in Clients.ToList()) c.Pump();
                foreach (var p in Players.ToList()) p.Consume();
            }
        }

        public bool Until(Func<bool> cond, int maxSteps = 1200)
        {
            for (var i = 0; i < maxSteps; i++)
            {
                if (cond()) return true;
                Step();
            }
            return cond();
        }

        public T Await<T>(Task<T> task)
        {
            Until(() => task.IsCompleted, 600);
            if (!task.IsCompleted) throw new TimeoutException("task did not complete");
            return task.GetAwaiter().GetResult();
        }

        public GridPlayer Host(string name = "host", LobbyOptions? options = null)
        {
            var p = NewPlayer(name);
            p.Attach(Await(p.Client.HostAsync(options ?? new LobbyOptions("room", 8, Visibility.Public))));
            return p;
        }

        public GridPlayer Join(string code, string name)
        {
            var p = NewPlayer(name);
            p.Attach(Await(p.Client.JoinAsync(code)));
            return p;
        }

        public bool AllReady() => Players.All(p => p.Lobby != null && p.Lobby.IsReady);

        /// <summary>Hashes recorded at the same tick must agree between all given players.</summary>
        public static int CompareHashes(params GridPlayer[] players)
        {
            var common = players[0].Hashes.Keys.Where(k => players.All(p => p.Hashes.ContainsKey(k))).ToList();
            foreach (var t in common)
                foreach (var p in players.Skip(1))
                    if (players[0].Hashes[t] != p.Hashes[t]) throw new Xunit.Sdk.XunitException("hash differs at tick " + t);
            return common.Count;
        }
    }
}
