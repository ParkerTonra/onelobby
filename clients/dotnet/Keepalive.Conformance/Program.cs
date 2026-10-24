using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using Keepalive;
using Keepalive.Gridpaint;

namespace Keepalive.Conformance;

/// <summary>
/// Stdio JSON-lines adapter for conformance/peer (see conformance/peer/README.md). The real LobbyClient/Lobby runs against
/// a scripted signaling socket and peer links whose frames go through the harness instead of WebRTC.
///   node conformance/peer/run.mjs --stdio="dotnet run --project clients/dotnet/Keepalive.Conformance"
/// </summary>
internal static class Program
{
    private static readonly object Gate = new();
    private static readonly object OutGate = new();
    private static Session? _session;
    private static TextWriter _out = null!;

    public static int Main()
    {
        _out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        var pump = new Thread(PumpLoop) { IsBackground = true };
        pump.Start();
        string? line;
        while ((line = stdin.ReadLine()) != null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonDocument doc;
            try { doc = JsonDocument.Parse(line); } catch (JsonException) { continue; }
            using (doc)
            {
                var req = doc.RootElement;
                var id = req.GetProperty("id").GetInt32();
                try
                {
                    object result;
                    lock (Gate) { result = Call(req.GetProperty("op").GetString()!, req); _session?.Pump(); }
                    Emit(new Dictionary<string, object?> { ["id"] = id, ["ok"] = true, ["result"] = result });
                }
                catch (Exception e)
                {
                    Emit(new Dictionary<string, object?> { ["id"] = id, ["ok"] = false, ["error"] = e.GetType().Name + ": " + e.Message });
                }
            }
        }
        lock (Gate) { _session?.Dispose(); _session = null; }
        return 0;
    }

    internal static void Emit(object o)
    {
        var s = JsonSerializer.Serialize(o);
        lock (OutGate) _out.WriteLine(s);
    }

    private static void PumpLoop()
    {
        while (true)
        {
            Thread.Sleep(2);
            lock (Gate)
            {
                try { _session?.Pump(); }
                catch (Exception e) { Emit(new Dictionary<string, object?> { ["ev"] = "adapter_error", ["error"] = e.ToString() }); }
            }
        }
    }

    private static object Call(string op, JsonElement a)
    {
        int I(string n) => a.GetProperty(n).GetInt32();
        switch (op)
        {
            case "init":
                return new { name = "keepalive-dotnet", capabilities = new[] { "host", "joiner", "lockstep", "raw", "chat", "voice", "migration", "deflate" } };
            case "start":
                _session?.Dispose();
                _session = new Session(a);
                return new { };
            case "stop":
                _session?.Dispose();
                _session = null;
                return new { };
        }
        var s = _session ?? throw new InvalidOperationException("no session");
        switch (op)
        {
            case "begin": _ = s.Lobby.StartAsync(); return new { };
            case "link_open": s.EnsureLink(I("peerId")).Open = true; return new { };
            case "link_close": { var l = s.Link(I("peerId")); l.ClosedByHarness = true; l.Failed = true; return new { }; }
            case "recv":
                s.Link(I("from")).Inbox.Enqueue((ChannelOf(a.GetProperty("channel").GetString()!), Convert.FromHexString(a.GetProperty("hex").GetString()!)));
                return new { };
            case "command": s.Lobby.Lockstep!.Submit(GridpaintGame.PaintCommand(I("x"), I("y"))); return new { };
            case "chat_send": s.Lobby.Chat.Send(a.GetProperty("text").GetString()!); return new { };
            case "chat_host_mute": s.Lobby.Chat.HostMute(I("peerId"), a.GetProperty("muted").GetBoolean()); return new { };
            case "voice_send":
                s.Lobby.Voice.SendEncoded(a.GetProperty("frames").EnumerateArray().Select(f => Convert.FromHexString(f.GetString()!)).ToList(),
                    a.TryGetProperty("endOfBurst", out var e) && e.ValueKind == JsonValueKind.True);
                return new { };
            case "raw_send":
            {
                var ch = a.TryGetProperty("channel", out var c) && c.GetString() == "fast" ? Channel.Fast : Channel.Reliable;
                var bytes = Convert.FromHexString(a.GetProperty("hex").GetString()!);
                var to = I("to");
                if (to == 0) s.Lobby.Broadcast(bytes, ch); else s.Lobby.Send(to, bytes, ch);
                return new { };
            }
            case "hash_at": return new { hash = s.HashAt(a.GetProperty("tick").GetInt64()) };
            case "state": return s.State();
            default: throw new InvalidOperationException("unknown op " + op);
        }
    }

    internal static PeerChannel ChannelOf(string name) => name switch
    {
        "fast" => PeerChannel.Fast,
        "voice" => PeerChannel.Voice,
        _ => PeerChannel.Reliable,
    };

    internal static string Name(PeerChannel c) => c switch { PeerChannel.Fast => "fast", PeerChannel.Voice => "voice", _ => "reliable" };
}

internal sealed class Session : IDisposable
{
    private readonly Transport _transport;
    private readonly LobbyClient _client;
    private readonly GridpaintGame _game;
    private readonly Dictionary<long, ulong> _hashes = new();
    private readonly int _hashEvery;
    private readonly bool _raw;
    public Lobby Lobby { get; }

    public Session(JsonElement a)
    {
        var role = a.GetProperty("role").GetString()!;
        var code = a.GetProperty("code").GetString()!;
        var me = a.GetProperty("peerId").GetInt32();
        var hostId = a.GetProperty("hostId").GetInt32();
        var peers = a.TryGetProperty("peers", out var p) ? p.EnumerateArray().Select(x => x.GetInt32()).ToList() : new List<int>();
        var tickRate = a.TryGetProperty("tickRate", out var tr) ? tr.GetInt32() : 20;
        _hashEvery = a.TryGetProperty("hashEvery", out var he) ? he.GetInt32() : tickRate;
        _raw = a.TryGetProperty("mode", out var m) && m.GetString() == "raw";
        var name = a.TryGetProperty("name", out var nm) ? nm.GetString() ?? "dotnet" : "dotnet";
        if (!peers.Contains(me)) peers.Add(me);
        if (!peers.Contains(hostId)) peers.Add(hostId);

        _transport = new Transport(this, code, role, me, hostId, peers.Distinct().OrderBy(x => x).ToList(), tickRate, _raw);
        var cfg = new KeepaliveConfig(GridpaintGame.GameId, GridpaintGame.NetVersion, new Uri("ws://scripted/ws"),
            _raw ? SyncMode.Raw : SyncMode.Lockstep, tickRate, _hashEvery, name);
        _client = new LobbyClient(cfg, _transport);
        var task = role == "host"
            ? _client.HostAsync(new LobbyOptions("conformance", 16, Visibility.Unlisted))
            : _client.JoinAsync(code);
        for (var i = 0; i < 20 && !task.IsCompleted; i++) _client.Pump();
        Lobby = task.GetAwaiter().GetResult();
        _game = new GridpaintGame(Lobby.Code);
        var ls = Lobby.Lockstep;
        if (ls != null)
        {
            ls.Snapshot = () => _game.Snapshot();
            ls.Restore = (t, b) =>
            {
                _game.Restore(t, b.Span);
                _hashes.Clear();
                Program.Emit(new { ev = "snapshot_restored", tick = t });
            };
            ls.Desync += d => Program.Emit(new { ev = "desync", tick = d.Tick, hostHash = d.HostHash.ToString(), yourHash = d.LocalHash.ToString() });
        }
        Lobby.HostChanged += h => Program.Emit(new { ev = "host_changed", hostId = h, epoch = Lobby.Epoch });
        Lobby.PeerLeft += (peer, reason) => { if (reason == "desync") Program.Emit(new { ev = "peer_dropped", peerId = peer.PeerId, reason }); };
        Lobby.MessageReceived += (from, payload, ch) =>
            Program.Emit(new { ev = "raw", from, channel = ch == Channel.Fast ? "fast" : "reliable", hex = Hex(payload.Span) });
        Lobby.Chat.Received += l => Program.Emit(new { ev = "chat", peerId = l.PeerId, id = l.Id, ts = l.Ts, text = l.Text });
        Lobby.Chat.HistoryLoaded += lines =>
            Program.Emit(new { ev = "chat_history", lines = lines.Select(l => new { peerId = l.PeerId, id = l.Id, ts = l.Ts, text = l.Text }).ToArray() });
        Lobby.Chat.Rejected += (id, reason) =>
            Program.Emit(new { ev = "chat_rejected", id, reason = reason switch { "rate" => 1, "length" => 2, _ => 3 } });
        Lobby.Voice.Observer = (peer, seq, flags, frames) =>
            Program.Emit(new { ev = "voice", peerId = peer, seq, flags = (int)flags, frames = frames.Select(f => Hex(f)).ToArray() });
        Lobby.SnapshotChunkSize = a.TryGetProperty("chunkSize", out var cs) ? Math.Max(1, cs.GetInt32()) : Wire.ChunkPayload;
        _transport.Armed = true;
    }

    /// <summary>A link the harness opens to a peer the library has no link to yet: simulate the server/peer event that creates it.</summary>
    public AdapterLink EnsureLink(int peerId)
    {
        if (_transport.Links.TryGetValue(peerId, out var l) && !l.Failed) return l;
        if (!Lobby.Peers.Any(p => p.PeerId == peerId))
            _transport.Inject("{\"t\":\"peer_joined\",\"peer\":{\"peerId\":" + peerId + ",\"name\":\"peer" + peerId + "\"}}");
        if (!Lobby.IsHost)
            _transport.Inject("{\"t\":\"signal\",\"from\":" + peerId + ",\"sdp\":{\"type\":\"offer\",\"sdp\":\"x\"}}");
        for (var i = 0; i < 3; i++) _client.Pump();
        return Link(peerId);
    }

    public AdapterLink Link(int peerId) => _transport.Links.TryGetValue(peerId, out var l) ? l : throw new InvalidOperationException("no link to peer " + peerId);

    public void Pump()
    {
        _client.Pump();
        var ls = Lobby.Lockstep;
        if (ls == null) return;
        while (ls.TryNextFrame(out var f))
        {
            _game.Apply(f.Tick, f.Commands);
            _hashes[f.Tick] = _game.Hash();
            _hashes.Remove(f.Tick - 600);
            if (f.Tick % _hashEvery == 0) ls.ReportHash(f.Tick, _game.Hash());
        }
    }

    public string? HashAt(long tick) => _hashes.TryGetValue(tick, out var h) ? h.ToString() : null;

    public object State() => new
    {
        tick = _game.Tick, hash = _game.Hash().ToString(), started = _game.Tick > 0 || Lobby.IsReady,
        hostMode = Lobby.IsHost, hostId = Lobby.HostPeerId, epoch = Lobby.Epoch,
    };

    public static string Hex(ReadOnlySpan<byte> b) => Convert.ToHexString(b).ToLowerInvariant();

    public void Dispose()
    {
        try { _ = Lobby.LeaveAsync(); } catch (InvalidOperationException) { }
        _transport.Dispose();
    }
}

internal sealed class Transport : ITransport, IDisposable
{
    private static readonly Stopwatch Clock = Stopwatch.StartNew();
    private readonly string _code, _role;
    private readonly int _me, _hostId, _tickRate;
    private readonly List<int> _peers;
    private readonly bool _raw;
    public readonly Dictionary<int, AdapterLink> Links = new();
    public bool Armed;

    public Transport(Session s, string code, string role, int me, int hostId, List<int> peers, int tickRate, bool raw)
    {
        _code = code; _role = role; _me = me; _hostId = hostId; _peers = peers; _tickRate = tickRate; _raw = raw;
    }

    public long NowMs => Clock.ElapsedMilliseconds;
    public void Poll() { }

    private Socket? _sock;
    public void Inject(string json) => _sock?.Push(json);
    public ISignalingSocket ConnectSignaling(Uri url) => _sock = new Socket(this);

    public IPeerLink CreatePeerLink(PeerLinkOptions o)
    {
        var l = new AdapterLink(o.RemotePeerId);
        if (Links.TryGetValue(o.RemotePeerId, out var old)) old.Dispose();
        Links[o.RemotePeerId] = l;
        if (Armed) Program.Emit(new { ev = "dial", peerId = o.RemotePeerId });
        return l;
    }

    public void Dispose() { foreach (var l in Links.Values) { l.ClosedByHarness = true; l.Dispose(); } }

    private string LobbyJson() => Signaling.Build(w =>
    {
        w.WriteString("t", "lobby"); w.WriteString("code", _code); w.WriteString("gameId", GridpaintGame.GameId);
        w.WriteString("netVersion", GridpaintGame.NetVersion); w.WriteNumber("hostId", _hostId); w.WriteNumber("you", _me);
        w.WriteString("mode", _raw ? "raw" : "lockstep"); w.WriteNumber("tickRate", _tickRate); w.WriteBoolean("lateJoin", true);
        w.WriteString("phase", "lobby"); w.WriteStartObject("meta"); w.WriteEndObject();
        w.WriteStartArray("peers");
        foreach (var p in _peers) { w.WriteStartObject(); w.WriteNumber("peerId", p); w.WriteString("name", "peer" + p); w.WriteNumber("joinedAt", 0); w.WriteEndObject(); }
        w.WriteEndArray();
        w.WriteString("resumeToken", "scripted");
    });

    private sealed class Socket : ISignalingSocket
    {
        private readonly Transport _t;
        private readonly Queue<string> _in = new();
        public Socket(Transport t) { _t = t; }
        public void Push(string json) => _in.Enqueue(json);
        public SocketState State { get; private set; } = SocketState.Open;
        public string? CloseReason => null;
        public void Send(string text)
        {
            using var doc = JsonDocument.Parse(text);
            switch (Signaling.Str(doc.RootElement, "t"))
            {
                case "hello":
                    _in.Enqueue("{\"t\":\"welcome\",\"ice\":[],\"serverTime\":0,\"limits\":{\"maxMsg\":16384,\"maxPlayers\":64}}");
                    break;
                case "create":
                case "join":
                    _in.Enqueue(_t.LobbyJson());
                    break;
            }
        }
        public bool TryReceive(out string text)
        {
            if (_in.Count > 0) { text = _in.Dequeue(); return true; }
            text = "";
            return false;
        }
        public void Dispose() { State = SocketState.Closed; }
    }
}

internal sealed class AdapterLink : IPeerLink
{
    private readonly int _peer;
    public readonly Queue<(PeerChannel, byte[])> Inbox = new();
    public bool Open, Failed, ClosedByHarness, Disposed;

    public AdapterLink(int peer) { _peer = peer; }

    public bool IsOpen => Open && !Failed && !Disposed;
    public bool IsFailed => Failed;
    public int PingMs => 0;
    public bool Relayed => false;
    public void StartOffer() { }
    public void ApplySignal(PeerSignal signal) { }
    public bool TryTakeSignal(out PeerSignal signal) { signal = null!; return false; }

    public void Send(PeerChannel channel, ReadOnlySpan<byte> frame) =>
        Program.Emit(new { ev = "send", to = _peer, channel = Program.Name(channel), hex = Session.Hex(frame) });

    public bool TryReceive(out PeerChannel channel, out byte[] frame)
    {
        if (Inbox.Count > 0) { (channel, frame) = Inbox.Dequeue(); return true; }
        channel = PeerChannel.Reliable; frame = Array.Empty<byte>();
        return false;
    }

    public void Dispose()
    {
        if (Disposed) return;
        Disposed = true;
        if (!ClosedByHarness && Open) Program.Emit(new { ev = "close", peerId = _peer });
    }
}
