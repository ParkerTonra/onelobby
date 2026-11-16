#nullable enable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using OneLobby;
using OneLobby.Replication;
using OneLobby.Unity;
using UnityEngine;

/// <summary>
/// Players in the world with no player sync of your own: add this script to an empty GameObject in any scene and press Play (the scene needs
/// no camera, light or floor: the sample builds its own). The drop-in menu hosts and joins by itself; when the host starts (the second player
/// is in), a flat floor appears with one capsule per player, a colour per seat, a name over each head and a camera on yours. Walk with WASD or the
/// arrow keys, jump with space. All the networking is <see cref="OneLobbyNetPlayerSpawner"/> and the <see cref="OneLobbyNetPlayer"/> on each capsule.
///   Player.exe --host --local --name=Sam
///   Player.exe --join=127.0.0.1:47810 --local --name=Alex
/// (`--local` keeps both on 127.0.0.1.) Add `--netplayer-test` to both and run them with -batchmode -nographics: the joiner walks a scripted path
/// and jumps once, sends its own trace to the host, and the host logs NETPLAYER_NUMBERS and then NETPLAYER_OK or NETPLAYER_FAIL &lt;why&gt;
/// (clients/unity/net-player-test.sh runs exactly that). The sample reads the old Input class; with only the Input System package active, the keys
/// are ignored (the code says where to swap them). The floor and capsules use Unity's default material, which a URP or HDRP project draws pink.
/// </summary>
public sealed class NetPlayerSample : MonoBehaviour
{
    // The blueprint (what a game keeps in Assets/Resources/onelobby.json), built in code so the sample needs no file. sync.mode "replication" turns the
    // player layer on; "player": {} means the defaults (owner authority, 3D); try { "authority": "host" } with a step function for a competitive game.
    const string BlueprintJson = @"{
  ""version"": 1,
  ""game"": { ""id"": ""com.example.netplayerdemo"", ""netVersion"": ""1"", ""title"": ""Networked player demo"" },
  ""engine"": ""unity"",
  ""hosting"": { ""direct"": true, ""server"": false },
  ""lobby"": { ""maxPlayers"": 4 },
  ""room"": { ""autoStart"": ""players"", ""autoStartPlayers"": 2, ""countdownSeconds"": 1 },
  ""sync"": { ""mode"": ""replication"", ""player"": {} },
  ""chat"": { ""text"": true }
}";

    static readonly Color[] Colors =
    {
        new Color(0.9f, 0.3f, 0.3f), new Color(0.3f, 0.5f, 0.95f), new Color(0.3f, 0.8f, 0.4f), new Color(0.95f, 0.8f, 0.25f),
        new Color(0.7f, 0.4f, 0.9f), new Color(0.3f, 0.85f, 0.85f), new Color(0.95f, 0.55f, 0.2f), new Color(0.8f, 0.8f, 0.8f),
    };

    OneLobbyMenu _menu = null!;
    OneLobbyNetPlayerSpawner? _spawner;
    Lobby? _lobby;
    Camera? _camera;
    Transform? _local;
    readonly Dictionary<int, string> _names = new();

    void Awake()
    {
        _menu = gameObject.AddComponent<OneLobbyMenu>();
        _menu.Blueprint = new TextAsset(BlueprintJson);
        _menu.GameStarted += StartGame;
        Application.runInBackground = true;
        if (Testing)
        {
            QualitySettings.vSyncCount = 0;
            Application.targetFrameRate = 60;
        }
    }

    /// <summary>--netplayer-test on the command line.</summary>
    public static bool Testing => Environment.GetCommandLineArgs().Contains("--netplayer-test");

    void StartGame(Lobby lobby)
    {
        Debug.Log("NETPLAYER_GAME_STARTED");
        if (_spawner != null) return; // the game started once; a rematch would stop the spawner first
        _lobby = lobby;
        BuildWorld();
        _spawner = gameObject.AddComponent<OneLobbyNetPlayerSpawner>();
        _spawner.Factory = MakeCapsule;
        _spawner.SpawnPoint = peer => new Vector3(-6f + 3f * Seat(peer), 1f, 0f);
        _spawner.PlayerSpawned += OnSpawned;
        _spawner.PlayerRemoved += (peer, _) => _names.Remove(peer);
        // the layer: sync.player of the blueprint (owner authority, 3D); the spawner pumps it every frame and makes one capsule per player
        _spawner.Begin(lobby, Blueprint.Parse(BlueprintJson));
        if (Testing) gameObject.AddComponent<NetPlayerSampleTest>().Attach(_spawner, lobby);
    }

    int Seat(int peer) => Math.Max(0, _lobby?.Room.Player(peer)?.Seat ?? 0);
    string NameOf(int peer) => _lobby?.Room.Player(peer)?.Name ?? "player " + peer;

    void OnSpawned(int peer, GameObject character, bool isLocal)
    {
        _names[peer] = NameOf(peer);
        if (!isLocal) return; // the other capsules get their colour from the team that arrives with their state
        _local = character.transform;
        character.GetComponent<OneLobbyNetPlayer>().Team = Seat(peer);
    }

    static GameObject MakeCapsule(int peer)
    {
        var root = new GameObject("capsule");
        var cc = root.AddComponent<CharacterController>();
        cc.height = 2f; cc.radius = 0.5f; cc.center = Vector3.zero;
        var body = GameObject.CreatePrimitive(PrimitiveType.Capsule);
        body.name = "Body";
        Destroy(body.GetComponent<Collider>());
        body.transform.SetParent(root.transform, false);
        // a nose, so the facing can be seen
        var nose = GameObject.CreatePrimitive(PrimitiveType.Cube);
        Destroy(nose.GetComponent<Collider>());
        nose.transform.SetParent(root.transform, false);
        nose.transform.localScale = new Vector3(0.25f, 0.25f, 0.5f);
        nose.transform.localPosition = new Vector3(0, 0.5f, 0.55f);
        root.AddComponent<OneLobbyNetPlayer>();   // the whole networking of this character
        root.AddComponent<NetPlayerSampleCharacter>();
        return root;
    }

    void BuildWorld()
    {
        var floor = GameObject.CreatePrimitive(PrimitiveType.Cube);
        floor.name = "Floor";
        floor.transform.position = new Vector3(0, -0.5f, 0);
        floor.transform.localScale = new Vector3(40, 1, 40);
        floor.GetComponent<Renderer>().material.color = new Color(0.35f, 0.4f, 0.35f);
        var sun = new GameObject("Sun").AddComponent<Light>();
        sun.type = LightType.Directional;
        sun.transform.rotation = Quaternion.Euler(55, 30, 0);
        _camera = new GameObject("Camera").AddComponent<Camera>();
        _camera.tag = "MainCamera";
        _camera.clearFlags = CameraClearFlags.SolidColor;
        _camera.backgroundColor = new Color(0.55f, 0.7f, 0.9f);
        _camera.transform.position = new Vector3(0, 9, 11);
        _camera.transform.LookAt(Vector3.zero);
    }

    int _roster;

    void Update()
    {
        // one log line each time the roster changes, so a log shows who is in the lobby
        var lobby = _menu.Model?.Lobby;
        var count = lobby?.Room.Players.Count ?? 0;
        if (count == _roster) return;
        _roster = count;
        if (lobby != null) Debug.Log("Lobby: " + count + " players: " + string.Join(", ", lobby.Room.Players.Select(p => p.Name)));
    }

    void LateUpdate()
    {
        if (_camera == null || _local == null) return;
        var p = _local.position;
        _camera.transform.position = Vector3.Lerp(_camera.transform.position, p + new Vector3(0, 9, 11), 0.1f);
        _camera.transform.LookAt(p);
    }

    void OnGUI()
    {
        if (_spawner == null || _camera == null) return;
        foreach (var kv in _spawner.Characters)
        {
            if (kv.Value == null || !_names.TryGetValue(kv.Key, out var label)) continue;
            var sp = _camera.WorldToScreenPoint(kv.Value.transform.position + Vector3.up * 1.6f);
            if (sp.z > 0) GUI.Label(new Rect(sp.x - 60, Screen.height - sp.y - 10, 120, 24), label, new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter });
        }
    }

    public static Color ColorOfTeam(int team) => Colors[Math.Abs(team) % Colors.Length];
}

/// <summary>
/// One capsule. The local one walks and jumps (the game moves its own character exactly as it always did: CharacterController.Move, nothing about the network
/// except <c>Net.Jump()</c> when it jumps); every other one is moved by its OneLobbyNetPlayer, so this script only moves the local player.
/// </summary>
public sealed class NetPlayerSampleCharacter : MonoBehaviour
{
    const float Speed = 5f, JumpSpeed = 6f, Gravity = 18f;

    /// <summary>The headless test drives the local player with this instead of the keyboard: (move: x right, y forward; jump).</summary>
    public Func<(Vector2 Move, bool Jump)>? Scripted;

    OneLobbyNetPlayer _net = null!;
    CharacterController _cc = null!;
    Renderer[] _renderers = Array.Empty<Renderer>();
    int _color = -1;
    float _vy;
    bool _inputWarned;

    void Awake()
    {
        _net = GetComponent<OneLobbyNetPlayer>();
        _cc = GetComponent<CharacterController>();
        _renderers = GetComponentsInChildren<Renderer>();
    }

    void FixedUpdate()
    {
        if (!_net.IsLocal || !_cc.enabled) return; // on the other machines the component moves this character
        var (move, jump) = Scripted != null ? Scripted() : ReadKeys();
        var dt = Time.fixedDeltaTime;
        if (_cc.isGrounded)
        {
            _vy = -1f;
            if (jump) { _vy = JumpSpeed; _net.Jump(); } // the others see (and hear) it at the right moment
        }
        else _vy -= Gravity * dt;
        _cc.Move(new Vector3(move.x * Speed, _vy, move.y * Speed) * dt);
        if (move.sqrMagnitude > 0.0001f) transform.rotation = Quaternion.Euler(0, Mathf.Atan2(move.x, move.y) * Mathf.Rad2Deg, 0);
    }

    void Update()
    {
        if (_color == _net.Team) return;
        _color = _net.Team;
        foreach (var r in _renderers) r.material.color = NetPlayerSample.ColorOfTeam(_color);
    }

    (Vector2, bool) ReadKeys()
    {
        try
        {
            // the old Input class; with the Input System package active only, swap these lines for its Keyboard.current reads
            var m = Vector2.zero;
            if (Input.GetKey(KeyCode.A) || Input.GetKey(KeyCode.LeftArrow)) m.x -= 1;
            if (Input.GetKey(KeyCode.D) || Input.GetKey(KeyCode.RightArrow)) m.x += 1;
            if (Input.GetKey(KeyCode.W) || Input.GetKey(KeyCode.UpArrow)) m.y += 1;
            if (Input.GetKey(KeyCode.S) || Input.GetKey(KeyCode.DownArrow)) m.y -= 1;
            return (Vector2.ClampMagnitude(m, 1f), Input.GetKey(KeyCode.Space));
        }
        catch (InvalidOperationException e)
        {
            if (!_inputWarned) { _inputWarned = true; Debug.LogWarning("NetPlayerSample: the old Input class is off in this project; keys are ignored (" + e.Message + ")"); }
            return (Vector2.zero, false);
        }
    }
}

/// <summary>
/// The headless two-process check (--netplayer-test on both sides): the joiner walks a scripted path and jumps once; the host records where its copy of
/// the joiner's character is; the joiner sends its own trace to the host over the lobby at the end; the host compares the two paths and logs
/// NETPLAYER_NUMBERS, then NETPLAYER_OK or NETPLAYER_FAIL &lt;why&gt;. Both read the same wall clock (one PC), so the traces line up; the comparison looks
/// for the one constant lag at which they match best (the render delay plus the link), like D1 of spec/net-player.md. Passes when the worst error is under 0.5 m,
/// the mean under 0.15 m, the joiner jumped once, the host's copy of it jumped once, and the copy ended near where the joiner stopped.
/// </summary>
public sealed class NetPlayerSampleTest : MonoBehaviour
{
    const double MaxError = 0.5, MeanError = 0.15, SettleMs = 1500, WalkEndMs = 6500, TimeoutMs = 45000;
    const int Chunk = 20;
    const byte Marker = 0x54; // 'T': raw messages that are not replication ones (those start with 0x52)

    OneLobbyNetPlayerSpawner _spawner = null!;
    Lobby _lobby = null!;
    bool _isHost, _done, _sent, _jumpDone;
    double _boot, _tStart = -1, _sampleAt;
    int _peer, _jumpsSeen, _jumpsOwn;
    readonly List<(double T, Vector3 P)> _own = new(), _copy = new(), _remote = new();
    int _remoteJumps = -1;
    Vector3 _remoteFinal;

    static double Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public void Attach(OneLobbyNetPlayerSpawner spawner, Lobby lobby)
    {
        _spawner = spawner;
        _lobby = lobby;
        _isHost = lobby.IsHost;
        _boot = Now;
        _lobby.MessageReceived += OnMessage;
        Debug.Log("NETPLAYER_" + (_isHost ? "HOST" : "JOINER") + "_READY");
    }

    void OnDestroy()
    {
        if (_lobby != null) _lobby.MessageReceived -= OnMessage;
    }

    void Update()
    {
        if (_done || _spawner == null) return;
        var now = Now;
        if (now - _boot > TimeoutMs) { Finish(false, "timeout: the other player or its trace never came"); return; }
        var me = _spawner.CharacterOf(_lobby.LocalPeerId);
        if (_peer == 0)
        {
            if (me == null) return;
            foreach (var kv in _spawner.Characters)
            {
                if (kv.Key == _lobby.LocalPeerId || kv.Value == null) continue;
                if (!kv.Value.GetComponent<OneLobbyNetPlayer>().HasState) continue;
                _peer = kv.Key;
                _tStart = now + SettleMs;
                Watch(me, kv.Value);
                break;
            }
            return;
        }
        if (now - _sampleAt < 50) return;
        _sampleAt = now;
        var elapsed = now - _tStart;
        if (_isHost)
        {
            var c = _spawner.CharacterOf(_peer);
            if (c != null && elapsed > -SettleMs && c.GetComponent<OneLobbyNetPlayer>().HasState) _copy.Add((now, c.transform.position));
        }
        else if (me != null)
        {
            if (elapsed >= 0) _own.Add((now, me.transform.position));
            if (elapsed >= WalkEndMs && !_sent) SendTrace(me.transform.position);
        }
    }

    void Watch(GameObject me, GameObject other)
    {
        other.GetComponent<OneLobbyNetPlayer>().Jumped += () => _jumpsSeen++;
        if (_isHost) return; // the host's own capsule just stands
        me.GetComponent<OneLobbyNetPlayer>().Jumped += () => _jumpsOwn++;
        me.GetComponent<NetPlayerSampleCharacter>().Scripted = Script;
    }

    /// <summary>The joiner's path: stand 1 s, walk +x for 2.5 s (jump once at 2 s), walk +z for 1.5 s, stand.</summary>
    (Vector2, bool) Script()
    {
        var t = Now - _tStart;
        var move = Vector2.zero;
        if (t >= 1000 && t < 3500) move = new Vector2(1, 0);
        else if (t >= 3500 && t < 5000) move = new Vector2(0, 1);
        var jump = false;
        if (t >= 2000 && !_jumpDone) { _jumpDone = true; jump = true; }
        return (move, jump);
    }

    static string F(double v) => v.ToString("F3", CultureInfo.InvariantCulture);

    void SendTrace(Vector3 final)
    {
        _sent = true;
        var host = _lobby.HostPeerId;
        for (var i = 0; i < _own.Count; i += Chunk)
        {
            var part = _own.Skip(i).Take(Chunk).Select(s => string.Join(",", ((long)s.T).ToString(CultureInfo.InvariantCulture), F(s.P.x), F(s.P.y), F(s.P.z)));
            Send(host, "T|" + string.Join(";", part));
        }
        Send(host, "E|" + _jumpsOwn + "|" + F(final.x) + "|" + F(final.y) + "|" + F(final.z));
        Debug.Log("NETPLAYER_JOINER_DONE samples=" + _own.Count + " jumps=" + _jumpsOwn);
        Invoke(nameof(JoinerEnd), 2f);
    }

    void JoinerEnd() => Finish(true, "");

    void Send(int to, string text)
    {
        var body = Encoding.UTF8.GetBytes(text);
        var msg = new byte[body.Length + 1];
        msg[0] = Marker;
        Buffer.BlockCopy(body, 0, msg, 1, body.Length);
        _lobby.Send(to, msg, Channel.Reliable);
    }

    void OnMessage(int from, ReadOnlyMemory<byte> payload, Channel channel)
    {
        if (!_isHost || payload.Length < 2 || payload.Span[0] != Marker) return;
        var text = Encoding.UTF8.GetString(payload.Span.Slice(1));
        var f = text.Split('|');
        if (f[0] == "T" && f.Length > 1)
        {
            foreach (var s in f[1].Split(';'))
            {
                var c = s.Split(',');
                if (c.Length == 4) _remote.Add((double.Parse(c[0], CultureInfo.InvariantCulture), new Vector3(P(c[1]), P(c[2]), P(c[3]))));
            }
        }
        else if (f[0] == "E" && f.Length == 5)
        {
            _remoteJumps = int.Parse(f[1], CultureInfo.InvariantCulture);
            _remoteFinal = new Vector3(P(f[2]), P(f[3]), P(f[4]));
            Evaluate();
        }
    }

    static float P(string s) => float.Parse(s, CultureInfo.InvariantCulture);

    void Evaluate()
    {
        var r = ComparePaths(_remote, _copy);
        var copyFinal = _copy.Count > 0 ? _copy[_copy.Count - 1].P : new Vector3(1e9f, 0, 0);
        var endGap = new Vector2(copyFinal.x - _remoteFinal.x, copyFinal.z - _remoteFinal.z).magnitude;
        Debug.Log("NETPLAYER_NUMBERS lag " + r.Lag + " ms, mean " + F(r.Mean) + " m, worst " + F(r.Max) + " m, compared " + r.N + " samples, joiner jumps " + _remoteJumps +
                  ", copy jumps " + _jumpsSeen + ", end gap " + endGap.ToString("F2", CultureInfo.InvariantCulture) + " m");
        string why = "";
        if (r.N < 20) why = "too few samples to compare (" + r.N + ")";
        else if (r.Max >= MaxError) why = "worst error " + F(r.Max) + " m is over " + MaxError + " m";
        else if (r.Mean >= MeanError) why = "mean error " + F(r.Mean) + " m is over " + MeanError + " m";
        else if (_remoteJumps != 1) why = "the joiner jumped " + _remoteJumps + " times, expected 1";
        else if (_jumpsSeen != 1) why = "the host's copy jumped " + _jumpsSeen + " times, expected 1";
        else if (endGap > 1f) why = "the copy ended " + endGap.ToString("F2", CultureInfo.InvariantCulture) + " m from where the joiner stopped";
        Finish(why.Length == 0, why);
    }

    void Finish(bool ok, string why)
    {
        if (_done) return;
        _done = true;
        if (_isHost) Debug.Log(ok ? "NETPLAYER_OK" : "NETPLAYER_FAIL " + why);
        else if (!ok) Debug.Log("NETPLAYER_FAIL " + why);
        Application.Quit(ok ? 0 : 1);
    }

    /// <summary>The owner's position at time t (ms), interpolated between its samples; false outside the path.</summary>
    static bool At(List<(double T, Vector3 P)> path, double t, out Vector3 p)
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

    /// <summary>Two paths a render delay apart: the one constant lag (0 to 600 ms, 8 ms steps) at which the watched path is closest to the owner's on average.</summary>
    public static (int Lag, double Mean, double Max, int N) ComparePaths(List<(double T, Vector3 P)> owner, List<(double T, Vector3 P)> watched)
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
}
