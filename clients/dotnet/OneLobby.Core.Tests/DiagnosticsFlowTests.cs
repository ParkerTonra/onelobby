using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace OneLobby.Tests
{
    /// <summary>A UDP server on 127.0.0.1 only (never all interfaces: no firewall prompt). <paramref name="answer"/> returns the reply, or null to stay silent.</summary>
    internal sealed class FakeUdpServer : IDisposable
    {
        private readonly UdpClient _udp = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        public int Port => ((IPEndPoint)_udp.Client.LocalEndPoint!).Port;
        public readonly List<byte[]> Received = new();

        public FakeUdpServer(Func<byte[], IPEndPoint, byte[]?> answer)
        {
            _ = Task.Run(async () =>
            {
                while (true)
                {
                    UdpReceiveResult r;
                    try { r = await _udp.ReceiveAsync(); } catch (Exception) { return; }
                    lock (Received) Received.Add(r.Buffer);
                    var reply = answer(r.Buffer, r.RemoteEndPoint);
                    if (reply == null) continue;
                    try { await _udp.SendAsync(reply, reply.Length, r.RemoteEndPoint); } catch (Exception) { return; }
                }
            });
        }

        public void Dispose() { try { _udp.Close(); } catch (Exception) { } }

        /// <summary>A STUN server that says the caller is at <paramref name="ip"/>:<paramref name="port"/>; with both null, at its real source (an open network).</summary>
        public static FakeUdpServer Stun(string? ip, int? port) => new FakeUdpServer((b, from) =>
        {
            var tid = StunMessages.TransactionId(b);
            if (tid == null || StunMessages.TypeOf(b) != 0x0001) return null;
            return StunMessages.BindingResponse(tid, ip ?? from.Address.ToString(), port ?? from.Port);
        });

        public static FakeUdpServer Silent() => new FakeUdpServer((_, _) => null);

        private static byte[] ErrorResponse(byte[] tid, int code, bool withRealm)
        {
            var body = new List<byte>();
            void Attr(int type, byte[] v)
            {
                body.Add((byte)(type >> 8)); body.Add((byte)type); body.Add((byte)(v.Length >> 8)); body.Add((byte)v.Length);
                body.AddRange(v);
                while (body.Count % 4 != 0) body.Add(0);
            }
            Attr(0x0009, new byte[] { 0, 0, (byte)(code / 100), (byte)(code % 100), (byte)'x', (byte)'x', (byte)'x', (byte)'x' });
            if (withRealm) { Attr(0x0014, Encoding.UTF8.GetBytes("test.realm")); Attr(0x0015, Encoding.UTF8.GetBytes("nonce-1234567890")); }
            var msg = new byte[20 + body.Count];
            msg[0] = 0x01; msg[1] = 0x13; msg[2] = (byte)(body.Count >> 8); msg[3] = (byte)body.Count;
            msg[4] = 0x21; msg[5] = 0x12; msg[6] = 0xa4; msg[7] = 0x42;
            Array.Copy(tid, 0, msg, 8, 12);
            body.CopyTo(msg, 20);
            return msg;
        }

        /// <summary>A TURN server: the first Allocate gets 401 with a realm and nonce; the authenticated one gets success (<paramref name="login"/> true) or 401 again (false: a rejected login).</summary>
        public static FakeUdpServer Turn(bool login) => new FakeUdpServer((b, _) =>
        {
            var tid = StunMessages.TransactionId(b);
            if (tid == null || StunMessages.TypeOf(b) != 0x0003) return null;
            var authed = Encoding.ASCII.GetString(b).Contains("test.realm");
            if (!authed) return ErrorResponse(tid, 401, true);
            if (!login) return ErrorResponse(tid, 401, true);
            var ok = new byte[20];
            ok[0] = 0x01; ok[1] = 0x03; ok[4] = 0x21; ok[5] = 0x12; ok[6] = 0xa4; ok[7] = 0x42;
            Array.Copy(tid, 0, ok, 8, 12);
            return ok;
        });
    }

    internal static class Wait
    {
        public static T For<T>(Task<T> t) => t.GetAwaiter().GetResult();
    }

    public class ConnectionCheckTests
    {
        private static CheckOptions Opts(FakeUdpServer[] stun, IceServer? turn = null) => new CheckOptions
        {
            Stun = stun.Select(s => "stun:127.0.0.1:" + s.Port).ToArray(),
            IceServers = turn == null ? null : new[] { turn },
            ServerTimeoutMs = 450,
            TimeoutMs = 4000,
        };

        private static CheckResult Run(CheckOptions o) => ConnectionCheck.CheckAsync(o).GetAwaiter().GetResult();

        [Fact]
        public void SameMappingFromTwoServersIsCone()
        {
            using var a = FakeUdpServer.Stun("203.0.113.9", 40000);
            using var b = FakeUdpServer.Stun("203.0.113.9", 40000);
            var r = Run(Opts(new[] { a, b }));
            Assert.Equal(("ok", "cone", "none", "good"), (r.Udp, r.NatType, r.Relay, r.Verdict));
        }

        [Fact]
        public void DifferentPortsFromTwoServersIsSymmetric()
        {
            using var a = FakeUdpServer.Stun("203.0.113.9", 40000);
            using var b = FakeUdpServer.Stun("203.0.113.9", 40001);
            var r = Run(Opts(new[] { a, b }));
            Assert.Equal(("ok", "symmetric", "likely_fail"), (r.Udp, r.NatType, r.Verdict));
        }

        [Fact]
        public void AnAddressEqualToTheSocketsOwnIsOpen()
        {
            using var a = FakeUdpServer.Stun(null, null);
            using var b = FakeUdpServer.Stun(null, null);
            var r = Run(Opts(new[] { a, b }));
            Assert.Equal(("ok", "open"), (r.Udp, r.NatType));
        }

        [Fact]
        public void OneAnswerSaysUdpWorksButNotTheNatType()
        {
            using var a = FakeUdpServer.Stun("203.0.113.9", 40000);
            using var b = FakeUdpServer.Silent();
            var r = Run(Opts(new[] { a, b }));
            Assert.Equal(("ok", "unknown", "unknown"), (r.Udp, r.NatType, r.Verdict));
        }

        [Fact]
        public void NoAnswerFromAnyServerIsUdpBlocked()
        {
            using var a = FakeUdpServer.Silent();
            using var b = FakeUdpServer.Silent();
            var r = Run(Opts(new[] { a, b }));
            Assert.Equal(("blocked", "unknown", "blocked"), (r.Udp, r.NatType, r.Verdict));
            Assert.Contains("blocks UDP", r.Message);
        }

        [Fact]
        public void TheRelayLogin()
        {
            using var a = FakeUdpServer.Stun("203.0.113.9", 40000);
            using var b = FakeUdpServer.Stun("203.0.113.9", 40000);
            using var good = FakeUdpServer.Turn(true);
            using var bad = FakeUdpServer.Turn(false);
            using var mute = FakeUdpServer.Silent();
            IceServer T(FakeUdpServer s) => new IceServer(new[] { "turn:127.0.0.1:" + s.Port }, "sam", "secret");
            Assert.Equal("ok", Run(Opts(new[] { a, b }, T(good))).Relay);
            Assert.Equal(("refused", "relay_refused"), (Run(Opts(new[] { a, b }, T(bad))).Relay, Run(Opts(new[] { a, b }, T(bad))).Verdict));
            Assert.Equal("unreachable", Run(Opts(new[] { a, b }, T(mute))).Relay);
        }

        [Fact]
        public void ProbeRelayTellsRefusedFromSilent()
        {
            using var bad = FakeUdpServer.Turn(false);
            using var mute = FakeUdpServer.Silent();
            using var good = FakeUdpServer.Turn(true);
            IceServer T(FakeUdpServer s) => new IceServer(new[] { "turn:127.0.0.1:" + s.Port }, "sam", "secret");
            Assert.Equal("refused", Wait.For(ConnectionCheck.ProbeRelayAsync(T(bad), 400)));
            Assert.Equal("unreachable", Wait.For(ConnectionCheck.ProbeRelayAsync(T(mute), 400)));
            Assert.Equal("ok", Wait.For(ConnectionCheck.ProbeRelayAsync(T(good), 400)));
            Assert.Equal("unknown", Wait.For(ConnectionCheck.ProbeRelayAsync(new IceServer(new[] { "turns:127.0.0.1:5349" }, "a", "b"), 400)));
        }
    }

    /// <summary>The plan's "done when" on the in-memory network: a joiner behind a strict NAT with no relay, the host's line, the log.</summary>
    public class DiagnosticsFlowTests
    {
        private sealed class Scene
        {
            public readonly Rig Rig = new();
            public LobbyClient HostClient = null!;
            public Lobby Host = null!;
            public readonly List<PeerDiagnosisInfo> Reports = new();
            public LobbyClient JoinClient = null!;
            public Lobby Joiner = null!;

            public Scene(OneLobbyConfig? joiner = null, Func<PeerLinkOptions, PeerLinkOptions, bool>? canConnect = null)
            {
                Rig.Net.CanConnect = canConnect ?? ((_, _) => false); // no pair ever forms: a strict NAT
                HostClient = new LobbyClient(Rig.Config("Host"), Rig.Net.CreateTransport());
                Rig.Clients.Add(HostClient);
                Host = Rig.Await(HostClient.HostAsync(new LobbyOptions("room", 4)));
                Host.PeerDiagnosis += r => Reports.Add(r);
                JoinClient = new LobbyClient(joiner ?? Rig.Config("Sam"), Rig.Net.CreateTransport());
                Rig.Clients.Add(JoinClient);
                Joiner = Rig.Await(JoinClient.JoinAsync(Host.Code));
            }

            /// <summary>Steps the clocks and lets real time pass (the relay probe is a real UDP exchange).</summary>
            public bool UntilFailed(int seconds = 20)
            {
                var sw = System.Diagnostics.Stopwatch.StartNew();
                while (sw.Elapsed < TimeSpan.FromSeconds(seconds))
                {
                    Rig.Step(1, 100);
                    if (Joiner.ReadyAsync.IsFaulted) { Rig.Step(8); return true; }
                    Thread.Sleep(1);
                }
                return false;
            }

            public OneLobbyException Failure() => (OneLobbyException)Joiner.ReadyAsync.Exception!.InnerException!;
        }

        private static readonly Regex Ipv4 = new(@"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b");

        [Fact]
        public void AStrictNatWithNoRelayIsNatBlockedOnBothSides() => RunStrictNat();

        private static void RunStrictNat()
        {
            var s = new Scene();
            Assert.True(s.UntilFailed());
            var e = s.Failure();
            Assert.Equal("ice_failed", e.Code);
            Assert.Equal("nat_blocked", e.Diagnosis!.Cause);
            Assert.Equal("ice", e.Diagnosis.Stage);
            var f = Friendly.DescribeError(e);
            Assert.Equal("ice_failed", f.Code);
            Assert.Equal("nat_blocked", f.Cause);
            Assert.Equal("ice", f.Stage);
            Assert.Equal("Your network blocks direct connections (strict NAT) and no relay is set.", f.Message);
            Assert.Equal(e.Diagnosis.Hint, f.Hint);

            var r = Assert.Single(s.Reports);
            Assert.Equal("Sam", r.Name);
            Assert.Equal("nat_blocked", r.Report.Cause);
            Assert.Equal(f.Message, r.Message);
            Assert.Matches(@"^Sam: strict NAT, no relay set, stopped at the connection check after 1[56] s\.$", r.Line);
            Assert.False(r.Report.RelaySet);
            Assert.Equal(new[] { "host", "srflx" }, r.Report.RemoteTypes.ToArray());

            var log = s.JoinClient.NetLog.Export();
            Assert.Contains("nat_blocked", log);
            Assert.DoesNotMatch(Ipv4, log);
            Assert.Matches(Ipv4, s.JoinClient.NetLog.Export(includeAddresses: true));
            Assert.Contains("report sent nat_blocked", log);
            Assert.Contains("report from peer 2: nat_blocked", s.HostClient.NetLog.Export());
        }

        [Fact]
        public void ReportToHostOffSendsNothing()
        {
            var s = new Scene(Rig.Config("Sam") with { Diagnostics = new DiagnosticsOptions { ReportToHost = false } });
            Assert.True(s.UntilFailed());
            Assert.Equal("nat_blocked", s.Failure().Diagnosis!.Cause); // the joiner still sees why
            Assert.Empty(s.Reports);
            Assert.DoesNotContain("report sent", s.JoinClient.NetLog.Export());
        }

        [Fact]
        public void AHubWithoutDiagGetsNoReport()
        {
            var rig = new Rig();
            rig.Net.Features = new[] { "set_name", "room" };
            rig.Net.CanConnect = (_, _) => false;
            var host = new LobbyClient(Rig.Config("Host"), rig.Net.CreateTransport());
            rig.Clients.Add(host);
            var hl = rig.Await(host.HostAsync(new LobbyOptions("room", 4)));
            var reports = new List<PeerDiagnosisInfo>();
            hl.PeerDiagnosis += r => reports.Add(r);
            var jc = new LobbyClient(Rig.Config("Sam"), rig.Net.CreateTransport());
            rig.Clients.Add(jc);
            var jl = rig.Await(jc.JoinAsync(hl.Code));
            Assert.True(rig.Until(() => jl.ReadyAsync.IsFaulted, 1500));
            rig.Step(8);
            Assert.Empty(reports);
            Assert.DoesNotContain("report sent", jc.NetLog.Export());
            Assert.Equal("nat_blocked", ((OneLobbyException)jl.ReadyAsync.Exception!.InnerException!).Diagnosis!.Cause);
        }

        [Fact]
        public void ARelayThatRejectsTheLoginIsRelayRefused()
        {
            using var turn = FakeUdpServer.Turn(false);
            RunRelay(turn, "relay_refused", "Sam: the relay rejected the login, stopped at the connection check after ");
        }

        [Fact]
        public void ARelayThatNeverAnswersIsRelayUnreachable()
        {
            using var turn = FakeUdpServer.Silent();
            RunRelay(turn, "relay_unreachable", "Sam: the relay did not answer, stopped at the connection check after ");
        }

        // A relay that answers late: the probe says "refused" 3.5 s after it starts. The joiner used to wait 2.5 s for it and
        // reported relay_unreachable; the wait is now RelayProbeWaitMs (4.5 s). The probe is a stand-in (LobbyClient.RelayProbeForTests),
        // so the real probe's own time limits play no part, and the joiner is relay-only, so there is no relay retry and the
        // probe starts in the same call as the wait: 1 s to spare against the old wait. The stand-in is answered by the pump loop
        // (not by a timer on the thread pool, which a busy CI runner can hold up for a second) and the loop waits until the
        // client has taken the answer before it pumps again, so a late thread cannot make the wait run out first.
        private const int SlowProbeMs = 3500;

        [Fact]
        public void ASlowRelayThatRejectsTheLoginIsStillRelayRefused()
        {
            Assert.True(SlowProbeMs - 2500 >= 1000 && Lobby.RelayProbeWaitMs - SlowProbeMs >= 1000);
            using var turn = FakeUdpServer.Silent(); // only its address is used: nothing is sent to it
            System.Diagnostics.Stopwatch? probe = null;
            var answer = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            var answered = false;
            var calls = 0;
            var waited = RunRelay(turn, "relay_refused", "Sam: the relay rejected the login, stopped at the connection check after ", relayOnly: true, probe: _ =>
            {
                calls++;
                probe = System.Diagnostics.Stopwatch.StartNew();
                return answer.Task;
            }, sinceProbe: () => probe?.ElapsedMilliseconds ?? -1, each: jc =>
            {
                if (answered || probe == null || probe.ElapsedMilliseconds < SlowProbeMs) return;
                answered = true;
                answer.SetResult("refused");
                var until = System.Diagnostics.Stopwatch.StartNew();
                while (!jc.NetLog.Export().Contains("relay probe refused") && until.Elapsed < TimeSpan.FromSeconds(20)) Thread.Sleep(2);
            });
            Assert.Equal(1, calls);
            Assert.True(answered);
            Assert.Empty(turn.Received);
            Assert.True(waited >= SlowProbeMs - 100, waited + " ms"); // it waited for the answer; the cause shows the answer ended the wait
        }

        /// <summary>Returns <paramref name="sinceProbe"/> read when the joiner gave up (0 without one).</summary>
        private static long RunRelay(FakeUdpServer turn, string cause, string linePrefix, bool relayOnly = false, Func<IceServer, Task<string>>? probe = null, Func<long>? sinceProbe = null, Action<LobbyClient>? each = null)
        {
            var rig = new Rig();
            rig.Net.IceServers.Add(new IceServer(new[] { "turn:127.0.0.1:" + turn.Port }, "sam", "secret"));
            rig.Net.CanConnect = (_, _) => false;
            var host = new LobbyClient(Rig.Config("Host"), rig.Net.CreateTransport());
            rig.Clients.Add(host);
            var hl = rig.Await(host.HostAsync(new LobbyOptions("room", 4)));
            var reports = new List<PeerDiagnosisInfo>();
            hl.PeerDiagnosis += r => reports.Add(r);
            var jc = new LobbyClient(Rig.Config("Sam") with { RelayOnly = relayOnly }, rig.Net.CreateTransport()) { RelayProbeForTests = probe };
            rig.Clients.Add(jc);
            var jl = rig.Await(jc.JoinAsync(hl.Code));
            var sw = System.Diagnostics.Stopwatch.StartNew();
            while (!jl.ReadyAsync.IsFaulted && sw.Elapsed < TimeSpan.FromSeconds(20)) { each?.Invoke(jc); rig.Step(1, 100); Thread.Sleep(2); }
            var waited = sinceProbe?.Invoke() ?? 0;
            Assert.True(jl.ReadyAsync.IsFaulted);
            rig.Step(8);
            sw.Restart();
            while (reports.Count == 0 && sw.Elapsed < TimeSpan.FromSeconds(5)) { rig.Step(1); Thread.Sleep(2); } // the report reaches the host a moment later
            var e = (OneLobbyException)jl.ReadyAsync.Exception!.InnerException!;
            Assert.Equal("ice_failed", e.Code);
            Assert.Equal(cause, e.Diagnosis!.Cause);
            var r = Assert.Single(reports);
            Assert.True(r.Line.StartsWith(linePrefix), r.Line);
            Assert.True(r.Report.RelaySet);
            Assert.Contains(cause, jc.NetLog.Export());
            Assert.DoesNotContain("secret", jc.NetLog.Export(includeAddresses: true));
            return waited;
        }

        [Fact]
        public void ConnectFailuresCarryTheDiagnosisWithTheSameCodes()
        {
            var rig = new Rig();
            rig.Net.AllowedGames.Add("someone-else");
            var c = new LobbyClient(Rig.Config("Sam"), rig.Net.CreateTransport());
            rig.Clients.Add(c);
            var ex = Assert.Throws<OneLobbyException>(() => rig.Await(c.HostAsync(new LobbyOptions("x", 2))));
            Assert.Equal("game_not_allowed", ex.Code);
            Assert.Null(ex.Diagnosis); // not a connection problem

            // the lobby server goes away before it answers: server_closed, now with the reason
            var c2 = new LobbyClient(Rig.Config("Sam"), rig.Net.CreateTransport());
            rig.Clients.Add(c2);
            var t = c2.JoinAsync("7HQ4K2");
            rig.Net.ShutdownServer();
            c2.Pump();
            var gone = Assert.Throws<OneLobbyException>(() => rig.Await(t));
            Assert.Equal("server_closed", gone.Code);
            Assert.Equal("signaling_unreachable", gone.Diagnosis!.Cause);
            Assert.Equal("signaling", gone.Diagnosis.Stage);
            var f = Friendly.DescribeError(gone);
            Assert.Equal(("server_closed", "signaling_unreachable"), (f.Code, f.Cause));
            Assert.Contains("diag cause signaling_unreachable stage signaling", c2.NetLog.Export());
        }

        [Fact]
        public void TheClientAnswersTheCheckAndRemembersIt()
        {
            using var a = FakeUdpServer.Stun("203.0.113.9", 40000);
            using var b = FakeUdpServer.Stun("203.0.113.9", 40001);
            var rig = new Rig();
            var c = rig.NewClient("p");
            var r = Wait.For(c.CheckConnectionAsync(new CheckOptions { Stun = new[] { "stun:127.0.0.1:" + a.Port, "stun:127.0.0.1:" + b.Port }, ServerTimeoutMs = 400 }));
            Assert.Equal("symmetric", r.NatType);
            Assert.Same(r, c.LastCheck);
            Assert.Contains("connection check udp=ok nat=symmetric", c.NetLog.Export());
        }
    }
}
