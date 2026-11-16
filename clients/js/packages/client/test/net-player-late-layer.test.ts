import { describe, expect, it } from "vitest";
import { NetPlayers } from "../src/index.js";
import { drive, scene, walkStep } from "./net-player-scenario.js";
import { pathAt } from "./player-rig.js";

describe("a second networked-player layer on a lobby that is already playing", () => {
  for (const mode of ["owner", "host"] as const) {
    it(mode === "owner" ? "owner authority: it sees the other players within a few ticks" : "host authority: its layer sends no input before its first snapshot, so the ack 0 rule cannot help it (documented limit)", async () => {
      const s = await scene(mode);
      drive(s);
      await s.rig.run(4); // the lobby is playing: B holds snapshots, the host has B's ack
      expect(s.bl.get(s.a.peerId), "the first layer of B sees A").toBeDefined();
      expect(s.rig.host.session.ackedTick(s.b.peerId)).toBeGreaterThan(0);

      // B's layer and session are made again (a scene reload): a new session on the same lobby holds no snapshot
      s.bl.dispose();
      s.b.session.dispose();
      s.b.attach({ adaptiveDelay: true });
      const layer = new NetPlayers(s.b.session, { authority: mode, step: walkStep });
      s.rig.layers.set("b", layer);
      expect(layer.get(s.a.peerId)).toBeUndefined();
      // B plays on in its new layer (a layer with nothing to send is silent until its first snapshot: see the spec, section 13)
      layer.on("tick", () => {
        if (mode === "owner") {
          const { teleport: _t, ...rest } = pathAt(s.rig.nowMs, 1);
          layer.setLocalState(rest);
        } else layer.setLocalInput({ moveX: 0.5, moveY: 0.5, yaw: 90 });
      });

      const t0 = s.rig.nowMs;
      let seen = -1;
      for (let i = 0; i < 400 && seen < 0; i++) {
        await s.rig.step();
        if (layer.get(s.a.peerId)) seen = s.rig.nowMs - t0;
      }
      const ticks = seen / s.host.session.clock.tickMs;
      console.log(`late layer (${mode}): sees the other players after ${seen} ms (${ticks.toFixed(1)} ticks)`);
      expect(seen).toBeGreaterThanOrEqual(0);
      if (mode === "owner") expect(ticks, "ticks until the second layer sees A (render delay included)").toBeLessThanOrEqual(24);
      else expect(seen, "it still gets there (the host's history runs out or the keyframe comes)").toBeLessThan(6000);
    });
  }
});
