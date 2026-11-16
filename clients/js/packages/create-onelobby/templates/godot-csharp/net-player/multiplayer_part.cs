
    // ---- the networked player (sync.player in onelobby.json) ----
    // On the same two peers: each machine gets a spawner with the game's Player.tscn, the joiner's player appears on the host with a position
    // that follows the joiner, and the joiner's one jump arrives once. It uses the game's own Player.tscn: if you change that scene a lot,
    // adjust or drop this check.
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
        var guestPeer = _guest!.LocalPeerId;
        var me = (Player)spawners[1].CharacterOf(guestPeer)!; // the joiner's own player, on the joiner
        me.SetPhysicsProcess(false); // the test places this player itself: the character's own script (keys, gravity, no floor here) stays out of it
        if (!await Until(() => spawners[0].CharacterOf(guestPeer) is Player { Visible: true })) return PlayerFail("the joiner's player never appeared on the host");
        var copy = (Player)spawners[0].CharacterOf(guestPeer)!; // the same player as the host sees it
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
        if (!follows) return PlayerFail($"the joiner's player moved but the host's copy stayed at x = {copy.GlobalPosition.X:0.00} (it was at {startX:0.00})");
        me.Net.Jump();
        if (!await Until(() => jumps > 0)) return PlayerFail("the joiner's jump never arrived on the host");
        for (var i = 0; i < 90 && !_done; i++) await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);
        if (jumps != 1) return PlayerFail($"one jump arrived {jumps} times on the host");
        foreach (var h in holders) h.QueueFree();
        await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);
        _playerPhase = false;
        return true;
    }

    private bool PlayerFail(string what)
    {
        Finish(false, "player: " + what);
        return false;
    }
