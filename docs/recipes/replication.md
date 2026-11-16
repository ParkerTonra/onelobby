# Recipe: replicated state (host-authoritative real-time games)

Use `OneLobby.Replication` (C#), `ReplicationSession` from `onelobby` (JS, section 5) or `OneLobbyReplicationSession` (GDScript, section 6) when the host runs the real simulation (physics, AI, NavMesh: anything non-deterministic)
and the other players see it: shooters, brawlers, co-op horde games. It sits on a `raw`-mode lobby and gives you a tick
clock, entity spawn/despawn, delta snapshots (about 100 kbit/s per client for 50 moving enemies), interpolation, a
redundant input stream, reliable events, local-player prediction and lag-compensated hitscan. No engine types: the same
DLL runs under Unity, Godot C# and plain .NET; your engine code only copies transforms in and out.
Design: DESIGN s.18. Wire format: `spec/replication.md`. Snippets tagged `csharp compile`, `ts compile` and `gdscript compile` are
checked by `docs/check-snippets.mjs`. The three clients speak the same wire: a host in one engine serves clients in the others.
Not sure which mode fits? `npx create-onelobby --recommend "<one line about your game>"` proposes one with a reason per choice (`--json` for an agent).

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
    public AlienState Interpolate(in AlienState to, float t)
    {
        // more than 2 m between two ticks is a teleport: jump, don't streak (pick > the fastest legal move per tick)
        var (x, y, z) = NetMath.LerpOrSnap((X, Y, Z), (to.X, to.Y, to.Z), t, maxDistance: 2f);
        return new AlienState
        {
            X = x, Y = y, Z = z,
            Yaw = NetMath.LerpAngle(Yaw, to.Yaw, t),
            Anim = t < 0.5f ? Anim : to.Anim, Health = t < 0.5f ? Health : to.Health,   // discrete values snap
        };
    }
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
avatar is predicted with `Reconciler` so movement responds at once; each snapshot corrects it, and `PredictionSmoother`
turns small corrections into a 100 ms glide (over 2 m horizontal or 0.5 m vertical it snaps). For teleports, put a
counter in the player's state that the host bumps on every teleport and pass it as `sequence:`: a change always snaps.

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
    readonly PredictionSmoother _smooth = new();               // 100 ms glide, snap past 2.0 m / 0.5 m

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

    public void Frame(PlayerInput current, float deltaMs)      // current = this frame's sticks/mouse/buttons
    {
        _rep.Pump();
        while (_rep.Clock.TryAdvance())
        {
            var seq = _rep.SubmitInput(current.Encode());
            _predict.Predict(seq, current);
            current.Fire = false;                              // one shot per press
        }
        if (!_me.IsNone && _rep.TryGetLatest<AlienState>(_me, out var auth, out _))
        {
            var before = _predict.Current;
            var after = _predict.Reconcile(auth, _rep.LastProcessedInput);
            _smooth.Correct(after.X - before.X, after.Y - before.Y, after.Z - before.Z);   // + sequence: your teleport counter
        }
        _smooth.Update(deltaMs);
        // draw my avatar at _predict.Current + _smooth.Offset

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

## 5. JavaScript (browser and Node)

`onelobby` has the same layer: `ReplicationSession` over a `mode: "raw"` lobby, byte for byte compatible with the C#
host and clients (same `spec/replication.md`, same vectors), so a browser client can join a .NET or Godot C# host and the
other way round. The names are the C# ones in camelCase; ids are plain numbers; events are emitter events. Set
`sync.mode: "replication"` in `onelobby.json` and `OneLobby.fromConfig` gives you the raw lobby to build it on (it works
for every engine).

A state schema is one object that writes (host), reads (client) and blends two snapshots (`lerp`):

```ts compile file=replication-state.ts
import { NetMath, type StateSchema } from "onelobby";

export interface Alien { x: number; y: number; z: number; yaw: number; anim: number; hp: number }

export const ALIEN = 7;

export const alienSchema: StateSchema<Alien> = {
  write(w, s) {
    w.writeQuantized(s.x, -256, 256, 16);
    w.writeQuantized(s.y, -32, 32, 12);
    w.writeQuantized(s.z, -256, 256, 16);
    w.writeAngle(s.yaw, 9);
    w.writeBits(s.anim, 4);
    w.writeBits(s.hp, 7);
  },
  read(r) {
    return { x: r.readQuantized(-256, 256, 16), y: r.readQuantized(-32, 32, 12), z: r.readQuantized(-256, 256, 16), yaw: r.readAngle(9), anim: r.readBits(4), hp: r.readBits(7) };
  },
  lerp(a, b, t) {
    return { x: NetMath.lerp(a.x, b.x, t), y: NetMath.lerp(a.y, b.y, t), z: NetMath.lerp(a.z, b.z, t), yaw: NetMath.lerpAngle(a.yaw, b.yaw, t), anim: t < 0.5 ? a.anim : b.anim, hp: t < 0.5 ? a.hp : b.hp };
  },
};
```

Host loop: spawn, one sim step per clock tick, read inputs, send the snapshot. Call `pump()` every frame (the lobby
delivers messages on its own; `pump()` runs the clock-driven parts):

```ts compile file=replication-host.ts
import { ReplicationSession, replicated, type Lobby } from "onelobby";
import { ALIEN, alienSchema, type Alien } from "./replication-state";

export function runHost(lobby: Lobby): void {
  const rep = new ReplicationSession(lobby);                       // host: 30 Hz tick, a delta snapshot per tick per client
  const alien: Alien = { x: 0, y: 0, z: 10, yaw: 0, anim: 0, hp: 100 };
  rep.spawn(ALIEN, 0, replicated(alienSchema, () => alien));        // owner 0 = the host (AI, doors)
  rep.on("clientReady", (peer) => rep.spawn(1, peer, replicated(alienSchema, () => ({ ...alien, hp: 100 }))));   // an avatar per joiner
  rep.on("eventReceived", (from, _tick, payload) => console.log("event from", from, payload.length, "bytes"));
  const frame = () => {
    rep.pump();
    while (rep.clock.tryAdvance()) {
      for (const peer of rep.clients) {
        const input = rep.tryGetInput(peer);                        // the client's input for this tick (repeated if none arrived)
        if (input) alien.x += (input.bytes[0] - 128) * 0.01;        // game rules decide what an input means
      }
      alien.yaw = (alien.yaw + 3) % 360;
      rep.sendSnapshot();                                           // once per tick, after the sim step
    }
    requestAnimationFrame(frame);
  };
  frame();
  rep.sendEvent(new TextEncoder().encode("round start"));            // reliable, to every client; { to, channel: "fast", stream } optional
}
```

Client loop: one input per tick, render at `renderTick` (100 ms behind the host):

```ts compile file=replication-client.ts
import { ReplicationSession, type Lobby } from "onelobby";
import { alienSchema } from "./replication-state";

export function runClient(lobby: Lobby, readStick: () => number): void {
  const rep = new ReplicationSession(lobby);
  const objects = new Map<number, { x: number; z: number }>();      // your game objects, by entity id
  rep.on("entitySpawned", (e) => objects.set(e.id, { x: 0, z: 0 })); // e = { id, typeId, owner }; create the object here
  rep.on("entityDespawned", (e) => objects.delete(e.id));
  rep.on("eventDelivered", (ev) => console.log("event", ev.stream, ev.seq, new TextDecoder().decode(ev.payload)));
  rep.on("hostLost", () => console.log("the host left: end the match"));
  const frame = () => {
    rep.pump();
    while (rep.clock.tryAdvance()) rep.submitInput(Uint8Array.of(readStick()));   // sent with the last 3 inputs on the fast channel
    for (const [id, obj] of objects) {
      const s = rep.trySample(id, alienSchema);                     // interpolated at rep.renderTick, undefined if not visible
      if (s) { obj.x = s.x; obj.z = s.z; }
    }
    requestAnimationFrame(frame);
  };
  frame();
  rep.sendEvent(new TextEncoder().encode("ready"));                  // client to host
}
```

Prediction and hit rewind in JS: `Reconciler`, `PredictionSmoother` and `HistoryRing` are exported from `onelobby` (the same behaviour and
numbers as the C# ones of section 3 and section 2: a correction blended over 100 ms, a snap past 2.0 m on the ground plane or 0.5 m vertically),
and `rep.rewindTick(input)` clamps a rewind to `maxRewindMs`. For players you do not need to wire them yourself:
`NetPlayers` (`docs/recipes/net-player.md`) does position, prediction, events and hit rewind for you. The config option
`adaptiveDelay` (default off) grows and shrinks the render delay with the link's jitter (`spec/replication.md` "Clock and render time").

Also: `rep.tryGetLatest(id, schema)` (newest snapshot, not interpolated, with `rep.lastProcessedInput` for prediction),
`rep.trySampleAt(id, tick, schema)`, `rep.sendFullSnapshot(peer)`, `rep.rttMs`, `rep.snapshotAgeMs`, `rep.stats`,
`rep.trafficRates` (bytes per second sent and received over the last second: snapshots, inputs, events, total) and
`rep.config` (`new ReplicationSession(lobby, { tickRate, interpolationDelayMs, keyframeSeconds, ... })`).
A host sends each new client a full snapshot on the reliable channel when its link comes up and again every
`keyframeSeconds` (default 5; 0 turns keyframes off). Raw payloads that do not start with `0x52` come out as the
`otherMessage` event, untouched.

Debug view: the wire stays binary. `rep.describe(bytes)` (or `describeReplication(bytes)`) turns any replication message into a
plain object (`kind`, `tick`, `records` with `op` and ids, state bytes as hex); `rep.packetLog = true` writes one such line per packet
(`rep out 2 fast {"kind":"snapshot",...}`, at most 20 a second) to the kit's net log, or pass a function to get the lines.

Tests: `onelobby/testing` has `ManualClock` and `MemoryNetwork`; set `net.clock`, `net.latencyMs`, `net.dropFast`,
`net.extraDelayMs`, `net.dropReliable`, `net.duplicateReliable` and `net.reorderReliable` for latency, loss and jitter
(see `clients/js/packages/client/test/replication-rig.ts`).

## 6. GDScript (Godot 4, no .NET)

`OneLobbyReplicationSession` in `clients/gdscript/addons/onelobby` is the same layer on the same wire: a GDScript host can
serve C#, JS and GDScript clients and the other way round (`spec/replication.md`, the same vectors; the engine-smoke
`--replication` scenario runs every pair of the three). Set `sync.mode: "replication"` in `onelobby.json` and
`OneLobbyClient.from_config` hosts or joins a raw lobby; build the session on it. Names are the JS ones in snake_case;
events are signals; entity infos and input frames are dictionaries (`{id, type_id, owner}`, `{seq, view_tick, bytes, repeated}`).
Call `pump()` every frame (the client pumps the lobby itself).

A state schema is any object with `write(w, state)` (host), `read(r)` (client) and `interpolate(a, b, t)` (blend two snapshots);
the state is whatever you like (a dictionary here). A host entity is that schema bound to a getter, or any object with `write(w)`:

```gdscript compile file=replication_game.gd
extends Node

const ALIEN := 7
const AVATAR := 1


class AlienSchema:
	extends RefCounted

	func write(w: OneLobbyNetWriter, s: Dictionary) -> void:
		w.write_quantized(float(s["x"]), -256.0, 256.0, 16)   # 7.8 mm steps on a 512 m map
		w.write_quantized(float(s["y"]), -32.0, 32.0, 12)
		w.write_quantized(float(s["z"]), -256.0, 256.0, 16)
		w.write_angle(float(s["yaw"]), 9)                      # 0.7 degree steps
		w.write_bits(int(s["anim"]), 4)
		w.write_bits(int(s["hp"]), 7)

	func read(r: OneLobbyNetReader) -> Dictionary:
		return {"x": r.read_quantized(-256.0, 256.0, 16), "y": r.read_quantized(-32.0, 32.0, 12), "z": r.read_quantized(-256.0, 256.0, 16),
			"yaw": r.read_angle(9), "anim": r.read_bits(4), "hp": r.read_bits(7)}

	func interpolate(a: Dictionary, b: Dictionary, t: float) -> Dictionary:
		return {"x": OneLobbyNetMath.lerp_value(float(a["x"]), float(b["x"]), t), "y": OneLobbyNetMath.lerp_value(float(a["y"]), float(b["y"]), t),
			"z": OneLobbyNetMath.lerp_value(float(a["z"]), float(b["z"]), t), "yaw": OneLobbyNetMath.lerp_angle(float(a["yaw"]), float(b["yaw"]), t),
			"anim": a["anim"] if t < 0.5 else b["anim"], "hp": a["hp"] if t < 0.5 else b["hp"]}


var _rep: OneLobbyReplicationSession
var _schema := AlienSchema.new()
var _alien := {"x": 0.0, "y": 0.0, "z": 10.0, "yaw": 0.0, "anim": 0, "hp": 100}
var _objects := {}   # your game objects, by entity id


## `lobby` comes from a client made with `OneLobbyClient.from_config` (sync.mode "replication") or `sync_mode = "raw"`.
func start(lobby: OneLobbyLobby) -> void:
	_rep = OneLobbyReplicationSession.new(lobby)                     # 30 Hz tick, a delta snapshot per tick per client
	_rep.event_delivered.connect(func(ev: Dictionary) -> void: print("event ", ev["stream"], " ", ev["seq"]))
	if lobby.is_host:
		_rep.spawn(ALIEN, 0, OneLobbyReplicationSession.replicated(_schema, func() -> Dictionary: return _alien))   # owner 0 = the host
		_rep.client_ready.connect(func(peer: int) -> void:                                       # an avatar per joiner
			_rep.spawn(AVATAR, peer, OneLobbyReplicationSession.replicated(_schema, func() -> Dictionary: return _alien)))
		_rep.send_event("round start".to_utf8_buffer())                                           # reliable, to every client
	else:
		_rep.entity_spawned.connect(func(e: Dictionary) -> void:                                 # e = {id, type_id, owner}: create the object here
			var node := Node3D.new()
			add_child(node)
			_objects[e["id"]] = node)
		_rep.entity_despawned.connect(func(e: Dictionary) -> void:
			var node: Node3D = _objects.get(e["id"])
			if node != null:
				node.queue_free()
			_objects.erase(e["id"]))
		_rep.host_lost.connect(func() -> void: print("the host left: end the match"))
		_rep.send_event("ready".to_utf8_buffer())                                                 # client to host


func _process(_delta: float) -> void:
	_rep.pump()
	while _rep.clock.try_advance():                                   # one sim step (host) or one input (client) per tick
		if _rep.is_host:
			for peer: int in _rep.clients():
				var input := _rep.try_get_input(peer)                  # {seq, view_tick, bytes, repeated}; repeated when none arrived
				if not input.is_empty():
					_alien["x"] = float(_alien["x"]) + (int((input["bytes"] as PackedByteArray)[0]) - 128) * 0.01   # your rules decide what an input means
			_alien["yaw"] = fmod(float(_alien["yaw"]) + 3.0, 360.0)
			_rep.send_snapshot()                                        # once per tick, after the sim step
		else:
			_rep.submit_input(PackedByteArray([128]))                  # sent with the last 3 inputs on the fast channel
	if not _rep.is_host:
		for id: int in _objects:
			var s: Variant = _rep.try_sample(id, _schema)              # interpolated at _rep.render_tick, null if not visible
			if s != null:
				var state: Dictionary = s
				(_objects[id] as Node3D).position = Vector3(float(state["x"]), float(state["y"]), float(state["z"]))
```

Also: `rep.try_get_latest(id, schema)` (`{state, tick}` of the newest snapshot, not interpolated; with `rep.last_processed_input` for
prediction you write yourself), `try_sample_at(id, tick, schema)`, `send_full_snapshot(peer)`, `rep.rtt_ms`, `rep.snapshot_age_ms`,
`rep.stats` (an `OneLobbyReplicationStats`: `snapshots_sent`, `largest_snapshot`, `malformed`, ...), `rep.traffic_rates` (bytes per second
sent and received over the last second: `snapshots_sent`, `inputs_sent`, `events_sent`, `total_sent` and the `_received` ones) and
`rep.config` (`OneLobbyReplicationSession.new(lobby, {"tick_rate": 20, "interpolation_delay_ms": 150, "keyframe_seconds": 0})`).
Events: `rep.send_event(bytes, to, channel, stream)` (`OneLobbyWire.RELIABLE` is the default; a numbered `stream` 1-255 is reliable only
and gives `event_delivered` a `seq` and `event_gap` a `{from, stream, first_missing, next_delivered}`); `event_received(from, tick, payload)`
fires for every event. Raw payloads that do not start with `0x52` come out as `other_message`. A host sends each new client a full
snapshot on the reliable channel when its link comes up and again every `keyframe_seconds` (default 5; 0 turns keyframes off).

Debug view: `rep.describe(bytes)` turns any replication message into a dictionary (`kind`, `tick`, `records`, state bytes as hex);
`rep.packet_log = true` writes one line per packet (`rep out 2 fast {"kind":"snapshot",...}`, at most 20 a second) to the lobby's
net log (`lobby.get_net_log()`), or set `rep.packet_log_sink = func(line: String) -> void: ...` to get the lines.

Cost, as a plain fact: one delta snapshot of 50 entities with 16-byte states (5 bytes changed in each, 407 bytes on the wire) took
about 0.14 ms to encode and 0.23 ms to decode in GDScript (average of 200 runs, Godot 4.7.2 headless on Windows, a 2024 desktop CPU;
`tests/replication_bench.gd`). A host pays the encode once per client per tick.

Tests: `clients/gdscript/tests/replication_rig.gd` is an in-memory network with a virtual clock (`net.latency_ms`, `net.drop_fast`,
`net.extra_delay_ms`, `net.drop_reliable`, `net.duplicate_reliable`, `net.reorder_reliable`) for latency, loss and jitter; the session
tests are `tests/replication.gd`. The session only needs a lobby with `mode`, `local_peer_id`, `host_peer_id`, `is_host`,
`now_ms()`, `send()`, `peers()`, `is_peer_ready()`, `ping_ms()`, the signals `message_received`, `peer_joined`, `peer_ready`,
`peer_left`, `host_changed` (and `get_net_log()` for the packet log), so your own test double works too.

## Rules

- Call `rep.Pump()` every frame instead of `lobby.Pump()`, and step the sim only inside `while (rep.Clock.TryAdvance())`.
- The host is truth: clients send inputs, never positions. Validate inputs at the host (speed, fire rate, ammo).
- Continuous state (positions, health bars) goes in entity state; one-off facts (points, kills, door opened) go in
  `SendEvent` (reliable). Never put a one-off in state only: a client may skip that snapshot.
- Your own raw messages may still use `lobby.Send`; their first byte must not be `0x52` (`ReplicationSession.IsReplicationPayload`).
- Bump `netVersion` when an entity layout or input layout changes.
- Keep a snapshot under ~1200 bytes: about 120 moving 8-byte entities. Check `rep.Stats.LargestSnapshot`.
- No host migration: handle `HostLost` by ending the match.
- Quitting the match on purpose: send the last events (match over, final score), then
  `await rep.FlushAsync(TimeSpan.FromSeconds(1))` while still pumping, then `LeaveAsync()`. The other side reads
  everything the leaver sent before it raises `PeerLeft` / `HostLost`.
- `rep.Clients` (host) lists peers whose link is up (`lobby.PeerReady`), not every peer the server announced; a peer
  is added with its first snapshot a full one, and `rep.ClientReady` fires then (spawn its avatar there).
  `rep.IsClientReady(peer)` asks for one peer.
- `rep.HostPeerId` and `rep.LocalPeerId` are on the session; other lobby facts (`IsHost`, `Peers`) live on `rep.Lobby`.
- Every session event (`ClientReady`, `EntitySpawned`, `EventReceived`, `HostLost`, ...) and every lobby event
  (`SessionEnded`, `PeerLeft`, ...) fires synchronously inside `rep.Pump()`, on the thread that calls it. Pump from your
  engine's main loop (Unity `Update`, Godot `_Process`) and call engine APIs straight from the handlers; no queue needed.
- An event is stamped with the sender's tick when sent: the host's `Clock.Tick`, or a client's `floor(ServerTick)`, which
  is ahead of what that client sees on screen. A client event that refers to what the player saw (a hit claim) must
  carry its own view tick in the payload (`rep.RenderTick`), or go through input so the host can use `RewindTick(frame)`.
- An event may arrive before the snapshot of the same tick. `new ReplicationConfig(HoldEventsForTicks: 8)` makes a client
  hold each event (in arrival order) until the snapshot of its tick is in, or 8 ticks at most.
- Reliable events are ordered and exactly once per link on every transport (the `IPeerLink` contract). For per-topic
  sequence numbers, pass a stream: `rep.SendEvent(bytes, peer, Channel.Reliable, stream: 3)`; subscribe to
  `rep.EventDelivered` (a `ReplicatedEvent` with `From`, `Tick`, `Stream`, `Seq`, `Payload`) instead of `EventReceived`.
  The session drops duplicates, reorders, and raises `rep.EventGap` with a `StreamGap` (`From`, `Stream`,
  `FirstMissing`, `NextDelivered`, `Missing`) if a number never comes; counters `Stats.EventsDuplicate` / `EventsOutOfOrder` / `EventsGap` stay 0 on a healthy link.
  `rep.ReliableEventBytesSentTo(peer)` counts reliable event bytes per peer.
- Event size: up to about 15 KiB goes in one frame; larger payloads are split and reassembled on the reliable channel
  (also when `Channel.Fast` was asked for), up to 64 MiB. Keep frequent events small (a few hundred bytes).
- Diagnostics for an overlay: `rep.RttMs` (client, to the host), `rep.PeerRttMs(peer)` (host, per client),
  `rep.SnapshotAgeMs` (client: ms since the newest snapshot), `rep.InputStatsFor(peer)` (host: `Repeated`, `Skipped`,
  `Lost`, `BufferDepth` per client), `rep.BytesSentTo(peer)`. RTT comes from OneLobby's own 1 s pings.
- A client that reports a gap or asks to resync: `rep.SendFullSnapshot(peer)` on the host; its next snapshot is full and
  deltas resume after it acknowledges one.
- A second session made on the same lobby (a scene reload, a layer made again) needs no call of yours: it sends `ack` 0 with
  its first input, and the host sends it a full snapshot at once and takes its input numbers from 1 again (at most one such
  resync per client per 64 ticks, and not within 500 ms of the first ack of the session before). A host from before this
  change ignores that and the new session waits about 2 s. A session that has nothing to send stays silent until its first
  snapshot: submit an input at once or call `SendFullSnapshot(peer)` yourself when it starts.

## Done when

- The snippets compile (`node docs/check-snippets.mjs`).
- Two players: the joiner sees aliens move smoothly while the host plays, its own avatar responds without delay, and a
  shot that hits an alien on the joiner's screen kills it on the host.
- `rep.Stats` on the host shows `FullSnapshotsSent` growing only when someone joins.
- JS: the same checks over `MemoryNetwork` with `net.dropFast` at 5% (`clients/js/packages/client/test/replication-session.test.ts`).
- GDScript: the same checks over the in-memory rig with `net.drop_fast` at 5% (`clients/gdscript/tests/replication.gd`).
- Under a test with `InMemoryNetwork` (`DropUnreliable`, `ExtraDelayMs`), the same checks hold at 5% loss.
  `DropReliable`, `ReorderReliable` and `DuplicateReliable` break the reliable contract on purpose, to test your own
  handling of `EventGap` and resync.
