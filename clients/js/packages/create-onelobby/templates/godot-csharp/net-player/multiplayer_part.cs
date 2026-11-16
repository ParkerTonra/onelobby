
    // ---- the networked player (sync.player in onelobby.json), both ways ----
    // On the same two peers: each machine gets a spawner with the game's Player.tscn. The joiner's player appears on the host, follows the
    // joiner, and the joiner's one jump arrives once; then the host's player appears on the joiner, follows the host, and the host's one jump
    // arrives once. One line per way when it passes (MULTIPLAYER_PLAYER ...); a failure is MULTIPLAYER_FAIL player: <what>.
    // It uses the game's own Player.tscn: if you change that scene a lot, adjust or drop this check.
    private bool _playerPhase; // true while the spawners' layers pump the two lobbies (a layer pumps its own lobby)

    private async Task<bool> CheckPlayer(Blueprint bp)
    {
        var scene = GD.Load<PackedScene>("res://Player.tscn");
        _playerPhase = true;
        var holders = new List<Node>();
        var spawners = new List<OneLobbyNetPlayerSpawner>();
        foreach (var lobby in new[] { _host!, _guest! })
        {
            var holder = new Node(); // one world per machine: both are in this one process
            AddChild(holder);
            var sp = new OneLobbyNetPlayerSpawner { Scene = scene };
//@if 3d
            sp.SpawnPoint = peer => new Vector3(peer * 2f, 1f, 0f);
//@end
//@if 2d
            sp.SpawnPoint2D = peer => new Vector2(peer * 80f, -16f);
//@end
//@if host
            sp.StepFunction = Player.Step;
//@end
            holder.AddChild(sp);
            sp.Start(lobby, bp);
            holders.Add(holder);
            spawners.Add(sp);
        }
        var up = await PlayerWay("the joiner's", _guest!.LocalPeerId, spawners[1], spawners[0], "host");
        if (up == null) return false;
        GD.Print("MULTIPLAYER_PLAYER " + up);
        var down = await PlayerWay("the host's", _host!.LocalPeerId, spawners[0], spawners[1], "joiner");
        if (down == null) return false;
        GD.Print("MULTIPLAYER_PLAYER " + down);
        foreach (var h in holders) h.QueueFree();
        await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);
        _playerPhase = false;
        return true;
    }

    // One way: the player of `peer` lives on the machine of `from` (its owner) and is watched on the machine of `to`. The owner moves it and
    // jumps once; the watcher's copy must appear, follow and see one jump. Returns the line to print, or null (after failing the test).
    private async Task<string?> PlayerWay(string whose, int peer, OneLobbyNetPlayerSpawner from, OneLobbyNetPlayerSpawner to, string watcher)
    {
        var me = from.CharacterOf(peer) as Player; // this player on its own machine
        if (me == null) return PlayerFail($"{whose} player never got a character of its own");
        me.SetPhysicsProcess(false); // the test places this player itself: the character's own script (keys, gravity, no floor here) stays out of it
        if (!await Until(() => to.CharacterOf(peer) is Player { Visible: true })) return PlayerFail($"{whose} player never appeared on the {watcher}");
        var copy = (Player)to.CharacterOf(peer)!; // the same player as the other machine sees it
        var jumps = 0;
        copy.Net.Jumped += () => jumps++;
        var startX = copy.GlobalPosition.X;
//@if owner
//@if 3d
        me.GlobalPosition += new Vector3(6f, 0f, 0f); // the owner places its own player (authority "owner")
//@end
//@if 2d
        me.GlobalPosition += new Vector2(6f, 0f); // the owner places its own player (authority "owner")
//@end
//@end
        var follows = await Until(() =>
        {
//@if host
            me.Net.SetInput(new global::OneLobby.Replication.NetPlayerInput { MoveX = 1.0 }); // the host places every player from its inputs (authority "host"): hold "right"
//@end
            return copy.GlobalPosition.X > startX + 2f;
        }, 20000);
        if (!follows) return PlayerFail($"{whose} player moved but its copy on the {watcher} stayed at x = {copy.GlobalPosition.X:0.00} (it was at {startX:0.00})");
        me.Net.Jump();
        if (!await Until(() => jumps > 0)) return PlayerFail($"{whose} jump never arrived on the {watcher}");
        for (var i = 0; i < 90 && !_done; i++) await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame); // a second arrival would show here
        if (jumps != 1) return PlayerFail($"{whose} jump arrived {jumps} times on the {watcher}");
        return $"{whose} player (peer {peer}) moved from x = {startX:0.00} to x = {copy.GlobalPosition.X:0.00} on the {watcher}, one jump arrived once";
    }

    private string? PlayerFail(string what)
    {
        Finish(false, "player: " + what);
        return null;
    }
