        // ---- the networked player (sync.player in onelobby.json), both ways ----
        // On the same two peers: each machine gets a spawner with the game's own GamePlayer.Make. The joiner's player appears on the host, follows the
        // joiner, and the joiner's one jump arrives once; then the host's player appears on the joiner, follows the host, and the host's one jump
        // arrives once. It uses the game's own character (Assets/Scripts/GamePlayer.cs): if you change that a lot, adjust or drop this check.
        // It logs one MULTIPLAYER_PLAYER <numbers> line per way when it passes; a failure is MULTIPLAYER_FAIL player: <what>.
        bool _playerPhase; // true while the spawners' layers pump the two lobbies (a layer pumps its own lobby)

        async Task<bool> CheckPlayer(Blueprint bp)
        {
            if (bp.Sync.Mode != "replication") return true; // the game moved off replication: there is no player layer to check
            _playerPhase = true;
            var holders = new List<GameObject>();
            try
            {
                var spawners = new List<OneLobbyNetPlayerSpawner>();
                foreach (var lobby in new[] { _host!, _guest! })
                {
                    var holder = new GameObject("player check world"); // one world per machine: both are in this one process
                    holders.Add(holder);
                    var sp = holder.AddComponent<OneLobbyNetPlayerSpawner>();
                    sp.Factory = GamePlayer.Make;
                    sp.Parent = holder.transform;
//@if 3d
                    sp.SpawnPoint = peer => new Vector3(peer * 2f, 1f, 0f);
//@end
//@if 2d
                    sp.SpawnPoint = peer => new Vector3(peer * 2f, 0.5f, 0f);
//@end
//@if host
                    sp.Step = GamePlayer.Step;
//@end
                    sp.Begin(lobby, bp);
                    spawners.Add(sp);
                }
                var up = await PlayerWay("the joiner's", _guest!.LocalPeerId, spawners[1], spawners[0], "host");
                if (up == null) return false;
                Debug.Log("MULTIPLAYER_PLAYER " + up);
                var down = await PlayerWay("the host's", _host!.LocalPeerId, spawners[0], spawners[1], "joiner");
                if (down == null) return false;
                Debug.Log("MULTIPLAYER_PLAYER " + down);
                return true;
            }
            finally
            {
                foreach (var h in holders) UnityEngine.Object.Destroy(h); // each spawner stops its layer when it goes
                await Task.Yield();
                _playerPhase = false;
            }
        }

        // One way: the player of `peer` lives on the machine of `from` (its owner) and is watched on the machine of `to`. The owner moves it and
        // jumps once; the watcher's copy must appear, follow and see one jump. Returns the line to log, or null (after failing the test).
        async Task<string?> PlayerWay(string whose, int peer, OneLobbyNetPlayerSpawner from, OneLobbyNetPlayerSpawner to, string watcher)
        {
            if (!await Until(() => from.CharacterOf(peer) != null)) return PlayerFail($"{whose} player got no character of its own");
            var me = from.CharacterOf(peer)!; // this player on its own machine
            me.GetComponent<GamePlayer>().enabled = false; // the test places this player itself: the character's own script (keys, gravity, no floor here) stays out of it
            var net = me.GetComponent<OneLobbyNetPlayer>();
            if (!await Until(() => to.CharacterOf(peer)?.GetComponent<OneLobbyNetPlayer>().HasState == true)) return PlayerFail($"{whose} player never appeared on the {watcher}");
            var copy = to.CharacterOf(peer)!; // the same player as the other machine sees it
            var jumps = 0;
            copy.GetComponent<OneLobbyNetPlayer>().Jumped += () => jumps++;
            var startX = copy.transform.position.x;
//@if owner
//@if 3d
            me.GetComponent<CharacterController>().Move(new Vector3(6f, 0f, 0f)); // the owner places its own player (authority "owner")
//@end
//@if 2d
            me.transform.position += new Vector3(6f, 0f, 0f); // the owner places its own player (authority "owner")
//@end
//@end
            var follows = await Until(() =>
            {
//@if host
                net.SetInput(new OneLobby.Replication.NetPlayerInput { MoveX = 1.0 }); // the host places every player from its inputs (authority "host"): hold "right"
//@end
                return copy.transform.position.x > startX + 2f;
            }, 20000);
            if (!follows) return PlayerFail($"{whose} player moved but its copy on the {watcher} stayed at x = {copy.transform.position.x:0.00} (it was at {startX:0.00})");
            net.Jump();
            if (!await Until(() => jumps > 0)) return PlayerFail($"{whose} jump never arrived on the {watcher}");
            await Until(() => false, 1500); // a second arrival would show here
            if (jumps != 1) return PlayerFail($"{whose} jump arrived {jumps} times on the {watcher}");
            return $"{whose} player (peer {peer}) moved from x = {startX:0.00} to x = {copy.transform.position.x:0.00} on the {watcher}, one jump arrived once";
        }

        string? PlayerFail(string what)
        {
            Finish(false, "player: " + what);
            return null;
        }
