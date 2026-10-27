using System;
using System.Collections.Generic;

namespace OneLobby
{
    /// <summary>
    /// The shared pause: who holds the match paused. <see cref="ByPeer"/> is the peer that paused (while
    /// <see cref="Paused"/>) or that last resumed it; <see cref="PauserLeft"/> says the pauser left and the host now
    /// holds the pause (<see cref="ByPeer"/> is then the host).
    /// </summary>
    public readonly record struct PauseState(bool Paused, int ByPeer, bool PauserLeft);

    /// <summary>
    /// Shared co-op pause (docs/recipes/pause.md): any player asks the host to pause or resume the match for everyone.
    /// The host validates (phase, rate, policy), keeps the state and broadcasts it. OneLobby moves the state and, in
    /// lockstep, stops the host's frames; scaling time, menus and banners stay in the game. Outside the sim: never put
    /// it in a lockstep command or hash.
    /// </summary>
    public sealed class SharedPause
    {
        /// <summary>The least time between two accepted requests from one peer.</summary>
        public const int MinRequestGapMs = 500;

        private readonly Lobby _lobby;
        private readonly Dictionary<int, long> _lastAccepted = new();
        private PauseState _state;

        internal SharedPause(Lobby lobby) { _lobby = lobby; }

        /// <summary>The current shared state (the same on every peer once the host's broadcast has arrived).</summary>
        public PauseState State => _state;

        /// <summary>True when the local peer may resume now under the default policy: the pauser or the host (a host-only blueprint: the host). A custom <see cref="Policy"/> lives on the host, so on a joiner this is a hint.</summary>
        public bool CanResume => _state.Paused && DefaultAllows(_lobby.LocalPeerId, false);

        /// <summary>The state changed (paused, resumed, pauser left, cleared). Fires on every peer, inside Pump on a joiner.</summary>
        public event Action<PauseState>? Changed;

        /// <summary>A request of this peer was refused: <see cref="LobbyErrorCodes.NotInGame"/>, <see cref="LobbyErrorCodes.RateLimited"/> or <see cref="LobbyErrorCodes.NotAllowed"/>.</summary>
        public event Action<string>? Refused;

        /// <summary>
        /// Host: replaces the default policy. Called with (requesting peer, true to pause / false to resume); return true
        /// to allow. Default: anyone pauses, the pauser or the host resumes. A blueprint with <c>session.pause</c>
        /// "host" makes the default host-only. Phase and rate checks run first.
        /// </summary>
        public Func<int, bool, bool>? Policy { get; set; }

        /// <summary>
        /// Ask to pause (true) or resume (false) the match for everyone. Throws <c>pause_disabled</c> when the blueprint
        /// says session.pause is "off" (the default; set it to "anyone" or "host" in onelobby.json). Works only while the
        /// lobby is in game (<see cref="LobbyPhase.InGame"/>, after <c>StartAsync</c>): before that the host refuses with
        /// <c>not_in_game</c>. The result arrives as <see cref="Changed"/> or <see cref="Refused"/>; asking for the state
        /// that already holds does nothing.
        /// </summary>
        public void Request(bool paused)
        {
            if (_lobby.Blueprint is { Session: { Pause: "off" } })
                throw new OneLobbyException(LobbyErrorCodes.PauseDisabled, "pause is off in onelobby.json (session.pause is \"off\"); set session.pause to \"anyone\" or \"host\" to turn it on");
            if (_lobby.IsHost) HostHandle(_lobby.LocalPeerId, paused);
            else _lobby.SendToHost(PeerChannel.Reliable, Wire.BuildPauseRequest(paused));
        }

        /// <summary>
        /// Host only: unpause at once, skipping the policy and the rate limit. Call it before a restart or game over so
        /// the next round does not start frozen. Does nothing when not paused.
        /// </summary>
        public void Clear()
        {
            if (!_lobby.IsHost) throw new InvalidOperationException("only the host clears the pause");
            if (!_state.Paused) return;
            Set(new PauseState(false, _lobby.LocalPeerId, false), broadcast: true);
        }

        // ---- internals ------------------------------------------------------------------------------------------

        private bool DefaultAllows(int peer, bool wantPaused)
        {
            if (_lobby.Blueprint is { Session: { Pause: "host" } }) return peer == _lobby.HostPeerId;
            return wantPaused || peer == _state.ByPeer || peer == _lobby.HostPeerId;
        }

        /// <summary>Host side: validate a request from <paramref name="from"/> (the local host included) and apply it.</summary>
        internal void HostHandle(int from, bool want)
        {
            if (_lobby.Blueprint is { Session: { Pause: "off" } }) { Refuse(from, want, Wire.PauseRefusedNotAllowed); return; }
            if (_lobby.Phase != LobbyPhase.InGame) { Refuse(from, want, Wire.PauseRefusedNotInGame); return; }
            if (want == _state.Paused) return;
            var now = _lobby.NowMs;
            if (_lastAccepted.TryGetValue(from, out var last) && now - last < MinRequestGapMs) { Refuse(from, want, Wire.PauseRefusedRate); return; }
            var ok = Policy != null ? Policy(from, want) : DefaultAllows(from, want);
            if (!ok) { Refuse(from, want, Wire.PauseRefusedNotAllowed); return; }
            _lastAccepted[from] = now;
            Set(new PauseState(want, from, false), broadcast: true);
        }

        private void Refuse(int to, bool want, byte reason)
        {
            if (to == _lobby.LocalPeerId) Refused?.Invoke(ReasonName(reason));
            else _lobby.SendToPeer(to, PeerChannel.Reliable, Wire.BuildPauseRefuse(want, reason));
        }

        internal static string ReasonName(byte r) => r switch
        {
            Wire.PauseRefusedNotInGame => LobbyErrorCodes.NotInGame,
            Wire.PauseRefusedRate => LobbyErrorCodes.RateLimited,
            Wire.PauseRefusedNotAllowed => LobbyErrorCodes.NotAllowed,
            _ => "unknown",
        };

        internal void OnRefuse(byte reason) => Refused?.Invoke(ReasonName(reason));

        /// <summary>Joiner: the host's state arrived.</summary>
        internal void OnState(bool paused, int byPeer, bool pauserLeft) => Set(new PauseState(paused, byPeer, pauserLeft), broadcast: false);

        private void Set(PauseState next, bool broadcast)
        {
            var prev = _state;
            _state = next;
            _lobby.Lockstep?.Hold(next.Paused);
            if (broadcast) _lobby.BroadcastAll(PeerChannel.Reliable, Wire.BuildPauseState(next.Paused, next.ByPeer, next.PauserLeft));
            if (prev != next) Changed?.Invoke(next);
        }

        /// <summary>Host: a late joiner's link is up; it gets the state when there is one to tell.</summary>
        internal void SendTo(Lobby.PeerRec rec)
        {
            if (_state.Paused) _lobby.SendToPeer(rec.Id, PeerChannel.Reliable, Wire.BuildPauseState(true, _state.ByPeer, _state.PauserLeft));
        }

        /// <summary>A peer is gone: the host takes over the pause its leaver held.</summary>
        internal void OnPeerGone(int peerId)
        {
            _lastAccepted.Remove(peerId);
            if (_lobby.IsHost && _state.Paused && !_state.PauserLeft && _state.ByPeer == peerId)
                Set(new PauseState(true, _lobby.LocalPeerId, true), broadcast: true);
        }

        /// <summary>This peer just became the host (migration): it keeps the state as is, and takes over a pause whose holder is gone.</summary>
        internal void OnBecameHost()
        {
            _lobby.Lockstep?.Hold(_state.Paused);
            if (_state.Paused && !_state.PauserLeft && !_lobby.HasPeer(_state.ByPeer))
                Set(new PauseState(true, _lobby.LocalPeerId, true), broadcast: true);
        }

        /// <summary>The lobby went back to the Lobby phase: nothing stays paused.</summary>
        internal void OnLobbyPhase()
        {
            if (!_state.Paused) return;
            Set(new PauseState(false, _lobby.HostPeerId, false), broadcast: _lobby.IsHost);
        }
    }
}
