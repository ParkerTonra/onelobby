using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Threading;
using Xunit;

namespace OneLobby.Tests
{
    /// <summary>A test that binds a real UDP socket (127.0.0.1 only): it runs in CI (CI=true) and is skipped on a dev PC.</summary>
    public sealed class CiOnlyFactAttribute : FactAttribute
    {
        public CiOnlyFactAttribute()
        {
            if (Environment.GetEnvironmentVariable("CI") != "true") Skip = "binds a real UDP socket on 127.0.0.1: runs in CI only";
        }
    }

    /// <summary>An in-memory UDP network: sends to 127.0.0.1:port reach the socket bound there; broadcasts go nowhere. No OS socket exists.</summary>
    internal sealed class FakeLanNet
    {
        private readonly object _lock = new object();
        private readonly Dictionary<int, Sock> _bound = new Dictionary<int, Sock>();
        private int _next = 50000;
        public int Created;
        public readonly List<string> Sent = new List<string>();
        public Func<ILanUdp> Factory => () => { Interlocked.Increment(ref Created); return new Sock(this); };
        public int BoundCount { get { lock (_lock) return _bound.Count; } }

        private sealed class Sock : ILanUdp
        {
            private readonly FakeLanNet _net;
            private readonly ConcurrentQueue<(byte[] Data, IPAddress From, int Port)> _in = new ConcurrentQueue<(byte[], IPAddress, int)>();
            private int _port;
            private volatile bool _closed;
            public Sock(FakeLanNet net) { _net = net; }

            public int Bind(IPAddress address, int port, bool broadcast)
            {
                lock (_net._lock)
                {
                    if (port == 0) port = _net._next++;
                    if (_net._bound.ContainsKey(port)) throw new SocketException((int)SocketError.AddressAlreadyInUse);
                    _net._bound[port] = this;
                    _port = port;
                    return port;
                }
            }

            public void Send(byte[] data, IPAddress to, int port)
            {
                if (_closed) return;
                lock (_net._lock)
                {
                    _net.Sent.Add(to + ":" + port);
                    if (IPAddress.IsLoopback(to) && _net._bound.TryGetValue(port, out var peer) && !peer._closed)
                        peer._in.Enqueue((data, IPAddress.Loopback, _port));
                }
            }

            public bool TryReceive(int waitMs, out byte[] data, out IPAddress from, out int fromPort)
            {
                var until = Environment.TickCount64 + waitMs;
                do
                {
                    if (_closed) break;
                    if (_in.TryDequeue(out var d)) { data = d.Data; from = d.From; fromPort = d.Port; return true; }
                    if (waitMs > 0) Thread.Sleep(1);
                } while (Environment.TickCount64 < until);
                data = Array.Empty<byte>(); from = IPAddress.None; fromPort = 0;
                return false;
            }

            public void Dispose()
            {
                if (_closed) return;
                _closed = true;
                lock (_net._lock) if (_port != 0 && _net._bound.TryGetValue(_port, out var s) && s == this) _net._bound.Remove(_port);
            }
        }
    }

    public class LanDiscoveryTests
    {
        private static readonly JsonDocument V = Spec.Load("vectors/lan-discovery.json");
        private static JsonElement Root => V.RootElement;

        private static LanHostInfo Info(int players = 1, bool password = false, string lobby = "Sam's game", string host = "Sam", int port = 47810) =>
            new LanHostInfo(lobby, host, players, 4, password, port);

        private static string Hex(byte[] b) => string.Concat(b.Select(x => x.ToString("x2")));

        // ---- vectors -------------------------------------------------------------------------------------------------

        [Fact]
        public void EncodesAndDecodesEveryQuestion()
        {
            foreach (var q in Root.GetProperty("questions").EnumerateArray())
            {
                var name = q.GetProperty("name").GetString();
                var bytes = LanWire.EncodeQuestion(Spec.Hex(q.GetProperty("nonce").GetString()!), q.GetProperty("gameId").GetString()!);
                Assert.Equal(q.GetProperty("hex").GetString(), Hex(bytes));
                Assert.True(LanWire.TryDecodeQuestion(Spec.Hex(q.GetProperty("hex").GetString()!), out var d), name);
                Assert.Equal(q.GetProperty("nonce").GetString(), Hex(d.Nonce));
                Assert.Equal(q.GetProperty("gameId").GetString(), d.GameId);
            }
        }

        [Fact]
        public void EncodesAndDecodesEveryAnswer()
        {
            foreach (var a in Root.GetProperty("answers").EnumerateArray())
            {
                var f = a.GetProperty("fields");
                var msg = new LanAnswerMessage(Spec.Hex(f.GetProperty("nonce").GetString()!), f.GetProperty("port").GetInt32(), f.GetProperty("players").GetInt32(),
                    f.GetProperty("maxPlayers").GetInt32(), f.GetProperty("password").GetBoolean(), f.GetProperty("gameId").GetString()!, f.GetProperty("netVersion").GetString()!,
                    f.GetProperty("lobbyName").GetString()!, f.GetProperty("hostName").GetString()!);
                var name = a.GetProperty("name").GetString();
                Assert.Equal(a.GetProperty("hex").GetString(), Hex(LanWire.EncodeAnswer(msg)));
                var bytes = Spec.Hex(a.GetProperty("hex").GetString()!);
                Assert.True(bytes.Length <= LanWire.MaxDatagram, name);
                Assert.True(LanWire.TryDecodeAnswer(bytes, out var d), name);
                Assert.Equal(msg.Port, d.Port); Assert.Equal(msg.Players, d.Players); Assert.Equal(msg.MaxPlayers, d.MaxPlayers); Assert.Equal(msg.Password, d.Password);
                Assert.Equal(msg.GameId, d.GameId); Assert.Equal(msg.NetVersion, d.NetVersion); Assert.Equal(msg.LobbyName, d.LobbyName); Assert.Equal(msg.HostName, d.HostName);
                Assert.Equal(f.GetProperty("nonce").GetString(), Hex(d.Nonce));
            }
        }

        [Fact]
        public void DropsEveryBadQuestionAndEveryBadAnswer()
        {
            foreach (var d in Root.GetProperty("dropQuestions").EnumerateArray())
                Assert.False(LanWire.TryDecodeQuestion(Spec.Hex(d.GetProperty("hex").GetString()!), out _), d.GetProperty("name").GetString());
            foreach (var d in Root.GetProperty("dropAnswers").EnumerateArray())
                Assert.False(LanWire.TryDecodeAnswer(Spec.Hex(d.GetProperty("hex").GetString()!), out _), d.GetProperty("name").GetString());
        }

        [Fact]
        public void ClassesSourceAddresses()
        {
            foreach (var s in Root.GetProperty("sourceClasses").EnumerateArray())
            {
                var c = s.GetProperty("class");
                Assert.Equal(c.ValueKind == JsonValueKind.Null ? null : c.GetString(), LanWire.SourceClass(s.GetProperty("ip").GetString()!));
            }
        }

        [Fact]
        public void AppliesTheHostRules()
        {
            foreach (var r in Root.GetProperty("hostRules").EnumerateArray())
            {
                var sent = 0;
                var a = new LanAnswerer(r.GetProperty("ownGameId").GetString()!, "3", () => Info(), (_, _, _) => sent++);
                var got = a.Handle(Spec.Hex(r.GetProperty("question").GetString()!), r.GetProperty("source").GetString()!, 50000);
                var name = r.GetProperty("name").GetString();
                Assert.Equal(r.GetProperty("expect").GetString(), got);
                Assert.Equal(got == "answer" ? 1 : 0, sent);
            }
        }

        [Fact]
        public void AppliesTheFinderRules()
        {
            foreach (var r in Root.GetProperty("finderRules").EnumerateArray())
            {
                var f = new LanFinder(r.GetProperty("ownGameId").GetString()!, r.GetProperty("ownNetVersion").GetString()!);
                foreach (var n in r.GetProperty("sentNonces").EnumerateArray()) f.RememberNonce(n.GetString()!);
                var expect = r.GetProperty("expect").GetString();
                var name = r.GetProperty("name").GetString();
                Assert.Equal(expect, f.Receive(Spec.Hex(r.GetProperty("answer").GetString()!), r.GetProperty("source").GetString()!, 47840));
                var kept = expect == "ok" || expect == "other_version";
                Assert.Equal(kept ? 1 : 0, f.Games.Count);
                if (expect == "other_version") Assert.False(f.Games[0].SameVersion);
            }
        }

        // ---- the host's limits ---------------------------------------------------------------------------------------

        private static byte[] Q(int n, string gameId = "g") => LanWire.EncodeQuestion(new byte[] { (byte)n, 0, 0, 0, 0, 0, 0, 0 }, gameId);

        [Fact]
        public void AnswersAtMostThePerSourceNumberInAWindow()
        {
            long t = 1000; var sent = 0;
            var a = new LanAnswerer("g", "1", () => Info(), (_, _, _) => sent++, () => t);
            for (var i = 0; i < 200; i++) a.Handle(Q(i), "192.168.1.9", 5000);
            Assert.Equal(LanWire.RatePerSource, sent);
            Assert.Equal(200 - LanWire.RatePerSource, a.Stats["rate_limited"]);
            t += 1000;
            a.Handle(Q(250), "192.168.1.9", 5000);
            Assert.Equal(LanWire.RatePerSource + 1, sent);
        }

        [Fact]
        public void AnswersAtMostTheTotalNumberInAWindowOverManySources()
        {
            var sent = 0;
            var a = new LanAnswerer("g", "1", () => Info(), (_, _, _) => sent++, () => 5);
            for (var i = 0; i < 200; i++) a.Handle(Q(1), "10.0." + (i >> 8) + "." + (i & 255), 5000);
            Assert.Equal(LanWire.RateTotal, sent);
        }

        [Fact]
        public void AnswersTheSameQuestionOnce()
        {
            var sent = 0;
            var a = new LanAnswerer("g", "1", () => Info(), (_, _, _) => sent++);
            Assert.Equal("answer", a.Handle(Q(7), "192.168.1.9", 5000));
            Assert.Equal("duplicate", a.Handle(Q(7), "192.168.1.9", 5000));
            Assert.Equal(1, sent);
        }

        [Fact]
        public void NeverSendsMoreThan512BytesWhateverTheQuestionsSize()
        {
            var sent = new List<byte[]>();
            var a = new LanAnswerer("g", "1", () => Info(lobby: new string('x', 500), host: string.Concat(Enumerable.Repeat("\U0001F41C", 300))), (b, _, _) => sent.Add(b));
            a.Handle(Q(1), "127.0.0.1", 5000);
            a.Handle(new byte[4000], "127.0.0.1", 5000);
            a.Handle(Enumerable.Repeat((byte)0x4f, 512).ToArray(), "127.0.0.1", 5000);
            Assert.Single(sent);
            Assert.True(sent[0].Length <= LanWire.MaxDatagram);
            Assert.True(LanWire.TryDecodeAnswer(sent[0], out var d));
            Assert.True(d.LobbyName.Length <= 24);
        }

        [Fact]
        public void AnswersNothingBeforeALobbyIsOpen()
        {
            var a = new LanAnswerer("g", "1", () => null, (_, _, _) => Assert.Fail("sent"));
            Assert.Equal("no_lobby", a.Handle(Q(1), "127.0.0.1", 5000));
        }

        // ---- host and finder, in memory (no OS socket) -----------------------------------------------------------------

        private sealed class Clock { public long Now = 1000; public Func<long> Fn => () => Now; }

        private static (FakeLanNet net, LanHost host, LanFinder finder, Clock clock, List<string> hostLog) Pair(Func<LanHostInfo?> info, string hostGame = "g", string hostVersion = "1", string finderGame = "g", string finderVersion = "1")
        {
            var net = new FakeLanNet();
            var log = new List<string>();
            var host = new LanHost(hostGame, hostVersion, info, 47840, IPAddress.Loopback, net.Factory, log.Add);
            Assert.True(host.Start());
            var clock = new Clock();
            var finder = new LanFinder(finderGame, finderVersion, new LanFinderOptions { Targets = new[] { "127.0.0.1" }, Port = 47840, Udp = net.Factory, NowMs = clock.Fn });
            return (net, host, finder, clock, log);
        }

        private static void PumpUntil(LanFinder f, Clock c, Func<bool> done, string what)
        {
            for (var i = 0; i < 400 && !done(); i++) { c.Now += 100; f.Pump(); Thread.Sleep(2); }
            Assert.True(done(), "timed out: " + what);
        }

        [Fact]
        public void ShowsARowWithTheRightFieldsChangesWithTheLobbyAndDropsWhenTheHostCloses()
        {
            var info = Info(players: 1, password: true, lobby: "Ants!", host: "Sam", port: 47812);
            var (net, host, finder, clock, _) = Pair(() => info);
            var counts = new List<int>();
            finder.Changed += g => counts.Add(g.Count);
            Assert.Equal(LanFinderStatus.Running, finder.Start());
            PumpUntil(finder, clock, () => finder.Games.Count == 1, "first row");
            var row = finder.Games[0];
            Assert.Equal(("127.0.0.1", 47812, "Ants!", "Sam", 1, 4, true, true), (row.Address, row.Port, row.Name, row.HostName, row.Players, row.MaxPlayers, row.HasPassword, row.SameVersion));
            info = info with { Players = 2 };
            PumpUntil(finder, clock, () => finder.Games[0].Players == 2, "player count change");
            host.Dispose();
            PumpUntil(finder, clock, () => finder.Games.Count == 0, "row gone after the host closed");
            Assert.Equal(0, counts.Last());
            finder.Stop();
            Assert.Equal(0, net.BoundCount);
        }

        [Fact]
        public void MarksAnotherNetVersion()
        {
            var (_, _, finder, clock, _) = Pair(() => Info(), hostVersion: "2", finderVersion: "1");
            finder.Start();
            PumpUntil(finder, clock, () => finder.Games.Count == 1, "row");
            Assert.False(finder.Games[0].SameVersion);
            Assert.Equal("2", finder.Games[0].NetVersion);
        }

        [Fact]
        public void AQuestionForAnotherGameIdGetsNoAnswer()
        {
            var (_, host, finder, clock, _) = Pair(() => Info(), hostGame: "g", finderGame: "other");
            finder.Start();
            PumpUntil(finder, clock, () => host.Answerer.Stats["wrong_game"] >= 1, "question seen");
            Assert.Equal(0, host.Answerer.Stats["answered"]);
            Assert.Empty(finder.Games);
        }

        [Fact]
        public void StopClosesTheSocketEmptiesTheListAndALateAnswerReachesNothing()
        {
            var (net, host, finder, clock, _) = Pair(() => Info());
            var changed = 0;
            finder.Start();
            PumpUntil(finder, clock, () => finder.Games.Count == 1, "row");
            Assert.Equal(2, net.BoundCount); // host + finder
            finder.Changed += _ => changed++;
            finder.Stop();
            Assert.Equal(1, net.BoundCount); // only the host: the finder's socket is closed
            Assert.Empty(finder.Games);
            Assert.Equal(LanFinderStatus.Idle, finder.Status);
            changed = 0;
            finder.Pump(); // a stopped finder reads nothing
            Assert.Equal(0, changed);
            Assert.Empty(finder.Games);
            host.Dispose();
        }

        [Fact]
        public void AskNowAsksAtOnceButNeverFasterThanTheMinimumGap()
        {
            var (net, _, finder, clock, _) = Pair(() => Info());
            finder.Start();
            var before = net.Sent.Count;
            for (var i = 0; i < 10; i++) finder.AskNow();
            Assert.Equal(before, net.Sent.Count); // held: the first ask was just now
            clock.Now += LanWire.MinGapMs;
            finder.Pump();
            Assert.Equal(before + 1, net.Sent.Count);
        }

        [Fact]
        public void TheTakenPortCaseTheSecondHostGoesOnWithoutLanDiscoveryAndSaysWhy()
        {
            var net = new FakeLanNet();
            var a = new LanHost("g", "1", () => Info(), 47840, IPAddress.Loopback, net.Factory);
            Assert.True(a.Start());
            var log = new List<string>();
            var b = new LanHost("g", "1", () => Info(), 47840, IPAddress.Loopback, net.Factory, log.Add);
            Assert.False(b.Start());
            Assert.False(b.Listening);
            Assert.Equal(new[] { "LAN discovery is off for this lobby: UDP port 47840 is taken" }, log);
            a.Dispose();
        }

        [Fact]
        public void TheSwitchOffOpensNoSocket()
        {
            var net = new FakeLanNet();
            // a finder from a blueprint with hosting.lan false stays off and never asks the factory for a socket
            var off = Blueprint.Parse(@"{""game"":{""id"":""a""},""engine"":""dotnet""}");
            Assert.False(off.Hosting.Lan);
            var client = LobbyClient.FromBlueprint(off, new InMemoryNetwork().CreateTransport(), "Ann");
            var f = client.CreateLanFinder(new LanFinderOptions { Targets = new[] { "127.0.0.1" }, Udp = net.Factory });
            Assert.Equal(LanFinderStatus.Off, f.Start());
            f.AskNow(); f.Pump(); f.Stop();
            Assert.Equal(0, net.Created);
            // with the switch on the same call opens exactly one
            var on = Blueprint.Parse(@"{""game"":{""id"":""a""},""engine"":""dotnet"",""hosting"":{""lan"":true}}");
            var client2 = LobbyClient.FromBlueprint(on, new InMemoryNetwork().CreateTransport(), "Ann");
            var f2 = client2.CreateLanFinder(new LanFinderOptions { Targets = new[] { "127.0.0.1" }, Udp = net.Factory });
            Assert.Equal(LanFinderStatus.Running, f2.Start());
            Assert.Equal(1, net.Created);
            f2.Stop();
        }

        // ---- real sockets on 127.0.0.1 (CI only) --------------------------------------------------------------------

        private static int FreeUdpPort()
        {
            using var u = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
            return ((IPEndPoint)u.Client.LocalEndPoint!).Port;
        }

        [CiOnlyFact]
        public void RealSocketsHostAndFinderOnLoopback()
        {
            var port = FreeUdpPort();
            var info = Info(players: 1, port: 47812);
            using var host = new LanHost("g", "1", () => info, port, IPAddress.Loopback);
            Assert.True(host.Start());
            using var finder = new LanFinder("g", "1", new LanFinderOptions { Targets = new[] { "127.0.0.1" }, Port = port, AskIntervalMs = 100, MinGapMs = 40, RowTimeoutMs = 600 });
            Assert.Equal(LanFinderStatus.Running, finder.Start());
            var sw = System.Diagnostics.Stopwatch.StartNew();
            while (finder.Games.Count == 0 && sw.ElapsedMilliseconds < 8000) { finder.Pump(); Thread.Sleep(5); }
            Assert.Single(finder.Games);
            Assert.Equal(("127.0.0.1", 47812, "Sam's game"), (finder.Games[0].Address, finder.Games[0].Port, finder.Games[0].Name));
            info = info with { Players = 3 };
            while (finder.Games[0].Players != 3 && sw.ElapsedMilliseconds < 8000) { finder.Pump(); Thread.Sleep(5); }
            Assert.Equal(3, finder.Games[0].Players);
            host.Dispose();
            while (finder.Games.Count > 0 && sw.ElapsedMilliseconds < 8000) { finder.Pump(); Thread.Sleep(5); }
            Assert.Empty(finder.Games);
        }

        [CiOnlyFact]
        public void RealSocketsTakenPortOnLoopback()
        {
            var port = FreeUdpPort();
            using var a = new LanHost("g", "1", () => Info(), port, IPAddress.Loopback);
            Assert.True(a.Start());
            var log = new List<string>();
            using var b = new LanHost("g", "1", () => Info(), port, IPAddress.Loopback, null, log.Add);
            Assert.False(b.Start());
            Assert.Single(log);
            Assert.StartsWith("LAN discovery is off for this lobby: UDP port " + port, log[0]);
        }
    }
}
