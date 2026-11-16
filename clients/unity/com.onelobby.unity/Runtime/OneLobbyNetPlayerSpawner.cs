#nullable enable
using System;
using System.Collections.Generic;
using OneLobby.Replication;
using UnityEngine;

namespace OneLobby.Unity
{
    /// <summary>
    /// Makes one character per seated player. Give it the lobby (the menu's <c>GameStarted</c> lobby), the game's blueprint, and a
    /// character prefab (with an <see cref="OneLobbyNetPlayer"/> on it or inside it) or a <see cref="Factory"/>; it creates the layer
    /// (<see cref="NetPlayers.FromConfig"/>), pumps it once per frame, creates this machine's own character at once (in owner authority the
    /// other machines learn of a player from its first state, so waiting for <c>PlayerJoined</c> would wait for ever), one character per
    /// <c>PlayerJoined</c>, and destroys it on <c>PlayerLeft</c>.
    /// <code>
    /// var spawner = gameObject.AddComponent&lt;OneLobbyNetPlayerSpawner&gt;();
    /// spawner.Prefab = characterPrefab;
    /// spawner.SpawnPoint = peer =&gt; new Vector3(peer * 2f, 1f, 0f);
    /// spawner.PlayerSpawned += (peer, character, isLocal) =&gt; { if (isLocal) AttachCamera(character); };
    /// spawner.Begin(lobby, blueprint);   // blueprint: Blueprint.Parse(json), or null for the defaults (owner authority, 3D)
    /// </code>
    /// A game that wants to do this itself uses <see cref="NetPlayers"/> and <see cref="OneLobbyNetPlayer"/> directly (this is a few dozen lines on top).
    /// </summary>
    [DefaultExecutionOrder(-50)] // pumps the layer before the game's own Update
    public sealed class OneLobbyNetPlayerSpawner : MonoBehaviour
    {
        [Tooltip("The game's character: a prefab with a OneLobbyNetPlayer on it or inside it. Or set Factory in code.")]
        public GameObject? Prefab;
        [Tooltip("Where characters go in the hierarchy. Empty: the scene root.")]
        public Transform? Parent;
        [Tooltip("True: the spawner pumps the layer every frame (switch it off when your own code calls NetPlayers.Pump()).")]
        public bool PumpLayer = true;

        /// <summary>Makes a character for a peer instead of <see cref="Prefab"/> (a game with no prefab). It returns an object with a <see cref="OneLobbyNetPlayer"/> on it or inside it.</summary>
        public Func<int, GameObject>? Factory;
        /// <summary>
        /// Where a player starts (the 2D layer uses x and y). The character is placed there, and with authority "host" it is the player's place on the
        /// host. Default: where the prefab or factory puts it (the origin).
        /// </summary>
        public Func<int, Vector3>? SpawnPoint;
        /// <summary>Authority "host": the movement step that goes to the layer (every machine needs the same one).</summary>
        public PlayerStepFunc? Step;

        /// <summary>A character was created. <c>isLocal</c> is true for the player this machine controls: attach your camera and input to it.</summary>
        public event Action<int, GameObject, bool>? PlayerSpawned;
        /// <summary>A character is about to be destroyed (its player left, or became a spectator).</summary>
        public event Action<int, GameObject>? PlayerRemoved;

        private NetPlayers? _players;
        private bool _ownsLayer;
        private readonly Dictionary<int, GameObject> _characters = new();
        private readonly List<int> _scratch = new();

        /// <summary>The layer, after <see cref="Begin"/> or <see cref="Use"/>.</summary>
        public NetPlayers? Players => _players;
        /// <summary>The characters by peer id (a live view).</summary>
        public IReadOnlyDictionary<int, GameObject> Characters => _characters;

        /// <summary>The character of a peer, or null.</summary>
        public GameObject? CharacterOf(int peer) => _characters.TryGetValue(peer, out var c) ? c : null;

        /// <summary>
        /// Make the layer from a raw-mode lobby and start spawning. <paramref name="blueprint"/>: the game's loaded <c>onelobby.json</c>
        /// (<c>sync.player</c> and <c>sync.tickRate</c>); null: the defaults of the layer. <paramref name="extra"/> adds layer options (its <c>Step</c> and
        /// <c>Spawn</c> win over <see cref="Step"/> and <see cref="SpawnPoint"/>). The spawner owns this layer: <see cref="Stop"/> disposes it and its session.
        /// </summary>
        public NetPlayers Begin(Lobby lobby, Blueprint? blueprint = null, NetPlayersOptions? extra = null)
        {
            Stop();
            var step = extra?.Step ?? Step;
            Func<int, PlayerState>? spawn = extra?.Spawn;
            if (spawn == null && SpawnPoint != null) spawn = SpawnState;
            var options = new NetPlayersOptions
            {
                Step = step, Spawn = spawn, AdaptiveDelay = extra?.AdaptiveDelay ?? true, Session = extra?.Session,
                Authority = extra?.Authority ?? PlayerAuthority.Owner, Space = extra?.Space ?? "3d", Range = extra?.Range ?? 300,
                VelocityRange = extra?.VelocityRange ?? 32, Limits = extra?.Limits ?? new PlayerLimits(null, null, null, null), Omit = extra?.Omit ?? Array.Empty<string>(),
            };
            var layer = blueprint != null ? NetPlayers.FromConfig(lobby, blueprint, options) : new NetPlayers(lobby, options);
            Use(layer, owns: true);
            return layer;
        }

        /// <summary>Spawn for a layer you made yourself (it stays yours: <see cref="Stop"/> does not dispose it).</summary>
        public void Use(NetPlayers layer) => Use(layer, owns: false);

        private void Use(NetPlayers layer, bool owns)
        {
            Stop();
            _players = layer ?? throw new ArgumentNullException(nameof(layer));
            _ownsLayer = owns;
            layer.PlayerJoined += OnJoined;
            layer.PlayerLeft += OnLeft;
            var me = layer.LocalPeerId;
            if (!IsSpectator(layer, me)) OnJoined(me); // this machine's own character at once: its state is what makes the player appear on the others
            var now = new List<int>(layer.Players);
            foreach (var peer in now) OnJoined(peer);
        }

        /// <summary>Stop spawning and destroy the characters; dispose the layer when <see cref="Begin"/> made it.</summary>
        public void Stop()
        {
            var layer = _players;
            if (layer != null)
            {
                layer.PlayerJoined -= OnJoined;
                layer.PlayerLeft -= OnLeft;
            }
            _scratch.Clear();
            _scratch.AddRange(_characters.Keys);
            foreach (var peer in _scratch) OnLeft(peer);
            _players = null;
            if (layer != null && _ownsLayer)
            {
                layer.Dispose();
                layer.Session.Dispose();
            }
            _ownsLayer = false;
        }

        private void Update()
        {
            var layer = _players;
            if (layer == null) return;
            if (PumpLayer)
            {
                // authority "host" with no step: the layer would throw from Pump() every tick; the component has logged the one clear error,
                // so only the lobby is pumped until a Step is set
                if (layer.Authority == PlayerAuthority.Host && layer.Step == null) layer.Session.Lobby.Pump();
                else layer.Pump();
            }
            // The roster says Player for a joiner's own peer when the join returns and Spectator a little later, and the layer never announces a
            // local spectator: look now and then, take the local character back when the roster says spectator, make it again when it says player.
            if (Time.frameCount % 8 == 0) CheckLocalRole(layer);
        }

        private void CheckLocalRole(NetPlayers layer)
        {
            var me = layer.LocalPeerId;
            var has = _characters.ContainsKey(me);
            var spectator = IsSpectator(layer, me);
            if (spectator && has) OnLeft(me);
            else if (!spectator && !has && IsPlayer(layer, me)) OnJoined(me);
        }

        private static bool IsPlayer(NetPlayers layer, int peer)
        {
            try { return layer.Session.Lobby.Room.Player(peer)?.Role == RoomRole.Player; }
            catch (Exception) { return false; }
        }

        private void OnDestroy() => Stop();

        private PlayerState SpawnState(int peer)
        {
            var at = SpawnPoint!(peer);
            var s = new PlayerState { X = at.x, Y = at.y };
            if (_players == null || _players.Codec.Is3D) s.Z = at.z;
            return s;
        }

        private static bool IsSpectator(NetPlayers layer, int peer)
        {
            try { return layer.Session.Lobby.Room.Player(peer)?.Role == RoomRole.Spectator; }
            catch (Exception) { return false; }
        }

        private void OnJoined(int peer)
        {
            if (_characters.ContainsKey(peer) || _players == null) return;
            GameObject? go;
            if (Factory != null) go = Factory(peer);
            else if (Prefab != null) go = Instantiate(Prefab, Parent);
            else { Debug.LogError("OneLobbyNetPlayerSpawner: set Prefab (a character with a OneLobbyNetPlayer) or Factory"); return; }
            if (go == null) { Debug.LogError("OneLobbyNetPlayerSpawner: the Factory returned no character for peer " + peer); return; }
            var np = go.GetComponentInChildren<OneLobbyNetPlayer>(true);
            if (np == null)
            {
                Debug.LogError("OneLobbyNetPlayerSpawner: the character \"" + go.name + "\" has no OneLobbyNetPlayer on it or inside it");
                Destroy(go);
                return;
            }
            go.name = "Player" + peer;
            if (Factory != null && Parent != null) go.transform.SetParent(Parent, false);
            np.PeerId = peer;
            if (SpawnPoint != null) np.SetPosition(SpawnPoint(peer));
            if (Step != null) np.Step = Step;
            np.Bind(_players);
            _characters[peer] = go;
            PlayerSpawned?.Invoke(peer, go, np.IsLocal);
        }

        private void OnLeft(int peer)
        {
            if (!_characters.TryGetValue(peer, out var go)) return;
            _characters.Remove(peer);
            PlayerRemoved?.Invoke(peer, go);
            if (go != null)
            {
                var np = go.GetComponentInChildren<OneLobbyNetPlayer>(true);
                if (np != null) np.Unbind();
                Destroy(go);
            }
        }
    }
}
