# Recipe: replicated state (host-authoritative real-time games)

Use `OneLobby.Replication` when the host runs the real simulation (physics, AI, NavMesh: anything non-deterministic)
and the other players see it: shooters, brawlers, co-op horde games. It sits on a `raw`-mode lobby and gives you a tick
clock, entity spawn/despawn, delta snapshots (about 100 kbit/s per client for 50 moving enemies), interpolation, a
redundant input stream, reliable events, local-player prediction and lag-compensated hitscan. No engine types: the same
DLL runs under Unity, Godot C# and plain .NET; your engine code only copies transforms in and out.
Design: DESIGN s.19. Wire format: `spec/replication.md`. Snippets tagged `csharp compile` are compiled by
`docs/check-snippets.mjs`.

Connect first (`docs/recipes/dotnet-generic.md` or `godot-csharp.md`) with `SyncMode.Raw`, then add this.

```
dotnet add package OneLobby.Replication      # or reference clients/dotnet/OneLobby.Replication
```

## 1. Describe your entities (shared by host and client)

One writer class per entity type on the host (`IReplicatedEntity`), one state struct on the client
(`IReplicatedState<T>`). Write **quantized** values: an alien in 8 bytes instead of 30.

```csharp compile file=Shared.cs
using OneLobby.Replication;

public static class Types { public const ushort Player = 1, Alien = 2, Door = 3; }

// Host side: the game object (or an adapter around a Unity Transform / Godot Node3D) writes its state each tick.
public sealed class AlienEntity : IReplicatedEntity
{
    public float X, Y, Z, Yaw;     // world metres, degrees
    public byte Anim, Health;      // 0..15, 0..127
    public void Write(NetWriter w)
    {
        w.WriteQuantized(X, -256, 256, 16);   // 7.8 mm steps on a 512 m map
        w.WriteQuantized(Y, -32, 32, 12);
        w.WriteQuantized(Z, -256, 256, 16);
        w.WriteAngle(Yaw, 9);                  // 0.7 degree steps
        w.WriteBits(Anim, 4);
        w.WriteBits(Health, 7);
    }
}

// Client side: the same fields read back in the same order, plus how to blend two snapshots.
public struct AlienState : IReplicatedState<AlienState>
{
    public float X, Y, Z, Yaw;
    public byte Anim, Health;
    public void Read(NetReader r)
    {
        X = r.ReadQuantized(-256, 256, 16);
        Y = r.ReadQuantized(-32, 32, 12);
        Z = r.ReadQuantized(-256, 256, 16);
        Yaw = r.ReadAngle(9);
        Anim = (byte)r.ReadBits(4);
        Health = (byte)r.ReadBits(7);
    }
    public AlienState Interpolate(in AlienState to, float t) => new AlienState
    {
        X = NetMath.Lerp(X, to.X, t), Y = NetMath.Lerp(Y, to.Y, t), Z = NetMath.Lerp(Z, to.Z, t),
        Yaw = NetMath.LerpAngle(Yaw, to.Yaw, t),
        Anim = t < 0.5f ? Anim : to.Anim, Health = t < 0.5f ? Health : to.Health,   // discrete values snap
    };
}

// What a client sends every tick: movement, look and buttons in 6 bytes.
public struct PlayerInput
{
    public sbyte MoveX, MoveY;     // -127..127
    public float Yaw;              // degrees
    public bool Fire;
    public float AimX, AimZ;       // where the shot went, for the host to check (hitscan sketch)

    public byte[] Encode()
    {
        var w = new NetWriter();
        w.WriteBits((byte)MoveX, 8); w.WriteBits((byte)MoveY, 8); w.WriteAngle(Yaw, 12); w.WriteBool(Fire);
        w.WriteQuantized(AimX, -256, 256, 16); w.WriteQuantized(AimZ, -256, 256, 16);
        return w.ToArray();
    }
    public static PlayerInput Decode(System.ReadOnlyMemory<byte> bytes)
    {
        var r = new NetReader(bytes.ToArray());
        return new PlayerInput
        {
            MoveX = (sbyte)r.ReadBits(8), MoveY = (sbyte)r.ReadBits(8), Yaw = r.ReadAngle(12), Fire = r.ReadBool(),
            AimX = r.ReadQuantized(-256, 256, 16), AimZ = r.ReadQuantized(-256, 256, 16),
        };
    }
}
```

## 2. Host loop

The host owns every entity. Per frame: `Pump()`, then one fixed step per due tick: read each client's input, step the
sim, record hit volumes for lag compensation, send the snapshot. The host's own player is applied directly (no input
message). Points, door openings, power-ups and downs go out as reliable events.

```csharp compile file=HostLoop.cs
using System.Collections.Generic;
using OneLobby;
using OneLobby.Replication;

public sealed class HostLoop
{
    readonly ReplicationSession _rep;
    readonly Dictionary<NetId, AlienEntity> _aliens = new();
    readonly HistoryRing<(float X, float Z)> _history;          // ~1 s of alien positions for hitscan rewind

    public HostLoop(Lobby lobby)                              // lobby: SyncMode.Raw, IsHost
    {
        _rep = new ReplicationSession(lobby);                 // 30 Hz, 100 ms interpolation, 4x input redundancy
        _history = new HistoryRing<(float X, float Z)>(_rep.Config.TickRate, (a, b, t) => (NetMath.Lerp(a.X, b.X, t), NetMath.Lerp(a.Z, b.Z, t)));
        lobby.PeerReady += p => _rep.Spawn(Types.Player, p.PeerId, new AlienEntity());   // their avatar (use your own type)
    }

    public NetId SpawnAlien(float x, float z)
    {
        var a = new AlienEntity { X = x, Z = z, Health = 100 };
        var id = _rep.Spawn(Types.Alien, 0, a);                // owner 0 = host-owned
        _aliens[id] = a;
        return id;
    }

    public void Frame()                                        // call from your engine's per-frame update
    {
        _rep.Pump();
        while (_rep.Clock.TryAdvance())
        {
            var tick = _rep.Clock.Tick;
            foreach (var peer in _rep.Clients)
            {
                if (!_rep.TryGetInput(peer, out var frame)) continue;   // nothing from this player yet
                var input = PlayerInput.Decode(frame.Bytes);
                // move that player's avatar with input.MoveX / MoveY ... (the same step function the client predicts with)
                if (input.Fire && !frame.Repeated) Shoot(peer, input, _rep.RewindTick(frame));
            }
            foreach (var kv in _aliens)
            {
                kv.Value.X += 0.1f;                            // your AI / NavMesh / physics step goes here
                _history.Record(tick, kv.Key, (kv.Value.X, kv.Value.Z));
            }
            _rep.SendSnapshot();
        }
    }

    void Shoot(int shooter, PlayerInput input, double rewindTick)
    {
        foreach (var kv in _aliens)
        {
            // test against where the alien was on the shooter's screen, not where it is now
            if (!_history.TrySample(kv.Key, rewindTick, out var then)) continue;
            var dx = then.X - input.AimX; var dz = then.Z - input.AimZ;
            if (dx * dx + dz * dz > 0.5f * 0.5f) continue;
            kv.Value.Health = (byte)System.Math.Max(0, kv.Value.Health - 25);
            if (kv.Value.Health == 0)
            {
                _rep.Despawn(kv.Key);
                _history.Forget(kv.Key);
                _aliens.Remove(kv.Key);
                _rep.SendEvent(new byte[] { 1, (byte)shooter });   // "kill, +100 points" (your own event layout)
            }
            break;
        }
    }
}
```

## 3. Client loop

Remote entities are drawn at `RenderTick` (100 ms behind the host) with `TrySample`: smooth even at 5% loss. Your own
avatar is predicted with `Reconciler` so movement responds at once; each snapshot corrects it.

```csharp compile file=ClientLoop.cs
using System.Collections.Generic;
using OneLobby;
using OneLobby.Replication;

public sealed class ClientLoop
{
    readonly ReplicationSession _rep;
    readonly HashSet<NetId> _visible = new();
    NetId _me;
    readonly Reconciler<PlayerInput, AlienState> _predict;

    public ClientLoop(Lobby lobby)                            // lobby: SyncMode.Raw, joiner
    {
        _rep = new ReplicationSession(lobby);
        _predict = new Reconciler<PlayerInput, AlienState>(default, Move);
        _rep.EntitySpawned += e =>                             // create the engine object (prefab per e.TypeId)
        {
            if (_rep.IsMine(e) && e.TypeId == Types.Player) _me = e.Id; else _visible.Add(e.Id);
        };
        _rep.EntityDespawned += e => _visible.Remove(e.Id);   // destroy it (play the death effect here)
        _rep.EventReceived += (from, tick, payload) => { /* points, doors, power-ups: payload is your layout */ };
        _rep.HostLost += () => { /* no host migration in replicated games: end the match, show the menu */ };
    }

    // Same movement step as the host runs for this player.
    static AlienState Move(AlienState s, PlayerInput i)
    {
        s.X += i.MoveX / 127f * 0.2f; s.Z += i.MoveY / 127f * 0.2f; s.Yaw = i.Yaw;
        return s;
    }

    public void Frame(PlayerInput current)                     // current = this frame's sticks/mouse/buttons
    {
        _rep.Pump();
        while (_rep.Clock.TryAdvance())
        {
            var seq = _rep.SubmitInput(current.Encode());
            _predict.Predict(seq, current);
            current.Fire = false;                              // one shot per press
        }
        if (!_me.IsNone && _rep.TryGetLatest<AlienState>(_me, out var auth, out _))
            _predict.Reconcile(auth, _rep.LastProcessedInput);
        // draw my avatar at _predict.Current

        foreach (var id in _visible)
            if (_rep.TrySample<AlienState>(id, out var s))
            {
                // copy s.X / s.Y / s.Z / s.Yaw into the engine transform, s.Anim into the animator
            }
    }
}
```

## 4. Engine adapters (documentation only)

Unity (`MonoBehaviour` on the host's alien prefab) and Godot are thin: write the transform in, read it out.

```csharp
// Unity host: register the prefab instance and let the session read its transform every tick
public sealed class NetAlien : MonoBehaviour, IReplicatedEntity
{
    public void Write(NetWriter w)
    {
        var p = transform.position;
        w.WriteQuantized(p.x, -256, 256, 16); w.WriteQuantized(p.y, -32, 32, 12); w.WriteQuantized(p.z, -256, 256, 16);
        w.WriteAngle(transform.eulerAngles.y, 9); w.WriteBits((uint)animState, 4); w.WriteBits((uint)health, 7);
    }
}
// Unity client, in Update(): if (rep.TrySample<AlienState>(id, out var s)) transform.SetPositionAndRotation(
//     new Vector3(s.X, s.Y, s.Z), Quaternion.Euler(0, s.Yaw, 0));
// Godot client: GlobalPosition = new Vector3(s.X, s.Y, s.Z); Rotation = new Vector3(0, Mathf.DegToRad(s.Yaw), 0);
```

## Rules

- Call `rep.Pump()` every frame instead of `lobby.Pump()`, and step the sim only inside `while (rep.Clock.TryAdvance())`.
- The host is truth: clients send inputs, never positions. Validate inputs at the host (speed, fire rate, ammo).
- Continuous state (positions, health bars) goes in entity state; one-off facts (points, kills, door opened) go in
  `SendEvent` (reliable). Never put a one-off in state only: a client may skip that snapshot.
- Your own raw messages may still use `lobby.Send`; their first byte must not be `0x52` (`ReplicationSession.IsReplicationPayload`).
- Bump `netVersion` when an entity layout or input layout changes.
- Keep a snapshot under ~1200 bytes: about 120 moving 8-byte entities. Check `rep.Stats.LargestSnapshot`.
- No host migration: handle `HostLost` by ending the match.

## Done when

- The snippets compile (`node docs/check-snippets.mjs`).
- Two players: the joiner sees aliens move smoothly while the host plays, its own avatar responds without delay, and a
  shot that hits an alien on the joiner's screen kills it on the host.
- `rep.Stats` on the host shows `FullSnapshotsSent` growing only when someone joins.
- Under a test with `InMemoryNetwork` (`DropUnreliable`, `ExtraDelayMs`), the same checks hold at 5% loss.
