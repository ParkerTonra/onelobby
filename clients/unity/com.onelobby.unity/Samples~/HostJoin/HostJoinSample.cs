#nullable enable
using System;
using System.Text;
using OneLobby;
using OneLobby.Unity;
using UnityEngine;

/// <summary>
/// Minimal Host / Join menu (IMGUI, no scene setup): add this to an empty GameObject in any scene and press Play.
/// It adds a <see cref="OneLobbyRunner"/>, hosts or joins by code, sends a reliable "hello" with a button and plays
/// voice while V is held. Start a local server first: dotnet run --project server/OneLobby.Server -- --listen :8080
/// </summary>
public sealed class HostJoinSample : MonoBehaviour
{
    public string LobbyServer = "ws://127.0.0.1:8080/ws";
    public bool EnableVoice = true;

    OneLobbyRunner _net = null!;
    UnityVoiceAudio? _voice;
    string _code = "";
    string _status = "Not connected (the game still runs offline).";
    string _log = "";

    void Awake()
    {
        _net = gameObject.AddComponent<OneLobbyRunner>();
        _net.LobbyServer = LobbyServer;
        _net.GameId = "com.onelobby.sample.hostjoin";
        _net.NetVersion = "1";
        _net.Mode = SyncMode.Raw;
        _net.DisplayName = "Unity " + Environment.UserName;
        _net.Error += e => _status = "Server: " + e.Message;
        _net.LobbyChanged += OnLobbyChanged;
    }

    void OnLobbyChanged(Lobby? lobby)
    {
        _voice?.Dispose();
        _voice = null;
        if (lobby == null) { _status = "Left the lobby."; return; }
        lobby.MessageReceived += (from, payload, channel) => _log += $"\n{from} ({channel}): {Encoding.UTF8.GetString(payload.Span)}";
        lobby.PeerJoined += p => _log += $"\n{p.Name} joined";
        lobby.PeerLeft += (p, why) => _log += $"\n{p.Name} left ({why})";
        lobby.Ready += () => _status = lobby.IsHost ? $"Hosting {lobby.Code}" : $"Connected to {lobby.Code}";
        lobby.SessionEnded += reason => _status = "Session ended: " + reason;
        if (EnableVoice)
        {
            _voice = UnityVoiceAudio.Attach(transform, lobby.Voice);
            lobby.Voice.Enabled = true;
        }
    }

    void Update()
    {
        var lobby = _net.Lobby;
        if (lobby != null && _voice != null) lobby.Voice.PushToTalk(TalkHeld());
    }

    static bool TalkHeld()
    {
#if ENABLE_INPUT_SYSTEM
        return UnityEngine.InputSystem.Keyboard.current?.vKey.isPressed ?? false;
#elif ENABLE_LEGACY_INPUT_MANAGER
        return Input.GetKey(KeyCode.V);
#else
        return false;
#endif
    }

    async void HostClicked()
    {
        try
        {
            var lobby = await _net.HostAsync(new LobbyOptions("Unity sample", MaxPlayers: 4, Visibility: Visibility.Unlisted));
            _status = $"Hosting. Share this code: {lobby.Code.Substring(0, 3)} {lobby.Code.Substring(3)}";
        }
        catch (Exception e) { _status = "Multiplayer unavailable: " + e.Message; }
    }

    async void JoinClicked()
    {
        try
        {
            var lobby = await _net.JoinAsync(_code);
            _status = "Joined, connecting to host...";
            await lobby.ReadyAsync;
        }
        catch (Exception e) { _status = "Multiplayer unavailable: " + e.Message; }
    }

    void OnGUI()
    {
        GUILayout.BeginArea(new Rect(16, 16, 420, 600));
        GUILayout.Label(_status);
        var lobby = _net.Lobby;
        if (lobby == null)
        {
            if (GUILayout.Button("Host")) HostClicked();
            GUILayout.BeginHorizontal();
            _code = GUILayout.TextField(_code, 9, GUILayout.Width(120));
            if (GUILayout.Button("Join")) JoinClicked();
            GUILayout.EndHorizontal();
        }
        else
        {
            GUILayout.Label($"Lobby {lobby.Code}, you are peer {lobby.LocalPeerId}, {lobby.Peers.Count} player(s)");
            if (GUILayout.Button("Say hello (reliable)")) lobby.Broadcast(Encoding.UTF8.GetBytes("hello from " + _net.DisplayName));
            if (_voice != null) GUILayout.Label("Hold V to talk");
            if (GUILayout.Button("Leave")) _ = _net.LeaveAsync();
        }
        GUILayout.Label(_log);
        GUILayout.EndArea();
    }
}
