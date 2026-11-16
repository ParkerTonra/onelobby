using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using OneLobby.DataChannel;
using OneLobby.Server;
using Xunit;

namespace OneLobby.DataChannel.Tests;

/// <summary>
/// The plan's "done when" with real WebRTC: a joiner behind a simulated strict NAT (every candidate it receives is dropped
/// before it reaches ICE) with no relay gets <c>nat_blocked</c>, the host gets the same sentence and the one-line view.
/// Everything is on 127.0.0.1. Needs the native library, like <see cref="LiveWebRtcTests"/>.
/// </summary>
public sealed class DiagnosticsLiveTests : IAsyncLifetime
{
    private WebApplication _app = null!;
    private string _ws = "";

    public async Task InitializeAsync()
    {
        _app = ServerApp.Build(new ServerOptions { RateScale = 20 }, listenUrl: "http://127.0.0.1:0");
        await _app.StartAsync();
        var http = _app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        _ws = http.Replace("http://", "ws://") + "/ws";
    }

    public async Task DisposeAsync() { await _app.StopAsync(); await _app.DisposeAsync(); }

    /// <summary>A transport whose links never hear a remote candidate: an ICE that can never find a pair.</summary>
    private sealed class StrictNat : ITransport
    {
        private readonly ITransport _inner;
        public StrictNat(ITransport inner) { _inner = inner; }
        public long NowMs => _inner.NowMs;
        public ISignalingSocket ConnectSignaling(Uri url) => _inner.ConnectSignaling(url);
        public void Poll() => _inner.Poll();
        public IPeerLink CreatePeerLink(PeerLinkOptions options) => new Link(_inner.CreatePeerLink(options));

        private sealed class Link : IPeerLink, IBufferedPeerLink, IDiagnosticPeerLink
        {
            private readonly IPeerLink _l;
            public Link(IPeerLink l) { _l = l; }
            public bool IsOpen => _l.IsOpen;
            public bool IsFailed => _l.IsFailed;
            public int PingMs => _l.PingMs;
            public bool Relayed => _l.Relayed;
            public void StartOffer() => _l.StartOffer();
            public void ApplySignal(PeerSignal s)
            {
                if (s.Sdp == null) return; // a trickled candidate: dropped
                var lines = s.Sdp.Split('\n').Where(x => !x.StartsWith("a=candidate:", StringComparison.Ordinal) && !x.StartsWith("a=end-of-candidates", StringComparison.Ordinal));
                _l.ApplySignal(PeerSignal.Description(s.SdpType!, string.Join("\n", lines)));
            }
            public bool TryTakeSignal(out PeerSignal signal) => _l.TryTakeSignal(out signal);
            public void Send(PeerChannel channel, ReadOnlySpan<byte> frame) => _l.Send(channel, frame);
            public bool TryReceive(out PeerChannel channel, out byte[] frame) => _l.TryReceive(out channel, out frame);
            public void Dispose() => _l.Dispose();
            public long ReliableBufferedBytes => (_l as IBufferedPeerLink)?.ReliableBufferedBytes ?? 0;
            public Action<string, string>? OnTrace { get => (_l as IDiagnosticPeerLink)?.OnTrace; set { if (_l is IDiagnosticPeerLink d) d.OnTrace = value; } }
            public LinkFacts Facts() => (_l as IDiagnosticPeerLink)?.Facts() ?? new LinkFacts(false, RelayState.None);
        }
    }

    [Fact]
    public void AStrictNatWithNoRelayIsNatBlockedOnBothSidesOverRealWebRtc() => Run();

    private void Run()
    {
        NativeLib.Require();
        var cfg = new OneLobbyConfig("com.onelobby.dctest", "1", new Uri(_ws), SyncMode.Raw);
        var hostClient = new LobbyClient(cfg with { DisplayName = "Host" }, new DataChannelTransport { BindAddress = "127.0.0.1" });
        var joinClient = new LobbyClient(cfg with { DisplayName = "Sam", ReadyTimeout = TimeSpan.FromSeconds(6) },
            new StrictNat(new DataChannelTransport { BindAddress = "127.0.0.1" }));
        Lobby? host = null, joiner = null;
        void Pump()
        {
            if (host != null) host.Pump(); else hostClient.Pump();
            if (joiner != null) joiner.Pump(); else joinClient.Pump();
        }
        void Until(Func<bool> done, string what, int ms = 30000)
        {
            var sw = Stopwatch.StartNew();
            while (!done()) { Pump(); if (sw.ElapsedMilliseconds > ms) throw new TimeoutException("timed out: " + what); Thread.Sleep(2); }
        }
        var ht = hostClient.HostAsync(new LobbyOptions("dc diag", MaxPlayers: 2));
        Until(() => ht.IsCompleted, "host");
        host = ht.GetAwaiter().GetResult();
        var reports = new List<PeerDiagnosisInfo>();
        host.PeerDiagnosis += r => reports.Add(r);
        var jt = joinClient.JoinAsync(host.Code);
        Until(() => jt.IsCompleted, "join");
        joiner = jt.GetAwaiter().GetResult();
        Until(() => joiner.ReadyAsync.IsCompleted, "the joiner gives up");
        Until(() => reports.Count > 0, "the host hears why");

        var e = Assert.IsType<OneLobbyException>(joiner.ReadyAsync.Exception!.GetBaseException());
        Assert.Equal("ice_failed", e.Code);
        Assert.Equal("nat_blocked", e.Diagnosis!.Cause);
        var r = Assert.Single(reports);
        Assert.Equal("Sam", r.Name);
        Assert.Equal(e.Diagnosis.Message, r.Message);
        Assert.Matches(@"^Sam: strict NAT, no relay set, stopped at the connection check after [0-9]+ s\.$", r.Line);
        var log = joinClient.NetLog.Export();
        Assert.Contains("nat_blocked", log);
        Assert.DoesNotMatch(new Regex(@"\b[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b"), log);
    }
}
