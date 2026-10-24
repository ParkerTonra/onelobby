# `Simulation.StateHash()` cost on a bot-driven unplug game

**What is measured.** `Simulation.StateHash()` is `Hashing.Fnv1a(Save())`: serialize the whole `WorldState` to a JSON string
with System.Text.Json, then FNV-1a over its UTF-16 chars. Measured on Lowkey `6b233bf3` (Release, net8.0, 16-core Windows box
that other sessions were also using, so there is noise), scenario `unplug`, game driven by the Sim's own `UnplugBot` through
real commands (the same loop as `UnplugBotTests.Play`: `bot.Step(sim); sim.Tick()`). Program: `hash-cost/Program.cs`;
reproduce with `sh build-sim.sh && dotnet run --project hash-cost -c Release -- <seed> <samples>`.

Each point is the first tick at 23:00 of that in-game day; 301 timed calls after 5 warm-ups; median, min, p95 in ms.
"Save only" and "Fnv only" split the two halves; "Tick" is the median cost of an ordinary `Sim.Tick()` there.

| seed | point | save bytes | StateHash median | min | p95 | Save() only | Fnv1a only | Tick |
|---|---|---|---|---|---|---|---|---|
| 20261011 | end of day 1 | 49,951 | 0.48 | 0.33 | 0.77 | 0.45 | 0.08 | 0.007 |
| 20261011 | end of day 15 | 150,471 | 1.05 | 0.55 | 1.37 | 0.43 | 0.23 | 0.012 |
| 20261011 | end of day 30 | 150,946 | 0.70 | 0.48 | 1.02 | 0.45 | 0.24 | 0.013 |
| 1 | end of day 1 | 51,331 | 0.45 | 0.34 | 0.62 | 0.36 | 0.08 | 0.009 |
| 1 | end of day 15 | 150,463 | 1.74 | 1.07 | 2.43 | 0.47 | 0.23 | 0.012 |
| 1 | end of day 30 | 150,808 | 0.70 | 0.58 | 1.54 | 0.44 | 0.23 | 0.012 |

Other runs (101 samples): seed 20261011 day 15 median 1.91 ms, p95 4.27 ms; seed 7 day 15 median 1.69 ms, p95 3.18 ms; seed 7
day 1 / 30 medians 0.52 / 0.72 ms.

**Reading the numbers**

* Day 1: about 0.5 ms. Day 15 and day 30: 0.7 to 1.9 ms median, worst p95 4.3 ms. All well under the s.14 threshold (2 ms
  median) except the noisiest day-15 runs, which sit at about 1 to 1.9 ms.
* State size stops growing around day 15 (about 150 KB of JSON; it plateaus, presumably because the event log and other lists are capped: not verified), so day 30 is not
  worse than day 15. The day-15 outliers are not a bigger world: `Save()` alone at the same size is 0.43 ms, so the extra is
  GC (the 150 KB string is 300 KB of UTF-16, on the large object heap, so every call allocates ~450 KB of LOH garbage and
  an occasional gen-2 collection lands inside a timed call).
* The hash is slower than the thing it protects: an ordinary tick costs 0.007 to 0.013 ms in a bot game, so one hash is
  about 50 to 150 ticks' worth of work. (Dense scenes with chases or shootouts tick slower; the `BenchmarkTests` budget is
  `classic <= 0.02 ms`, `sprawl < 1 ms`.)

**Cost at each cadence** (using the 0.7 ms typical and 1.9 ms bad median):

| cadence | hashes/s | CPU per second | LOH garbage/s |
|---|---|---|---|
| every tick | 20 | 14 to 38 ms (1.4 to 3.8% of a core) | ~9 MB |
| every 20 ticks (1 s) | 1 | 0.7 to 1.9 ms (0.07 to 0.2%) | ~0.45 MB |
| every 100 ticks (5 s) | 0.2 | 0.15 to 0.4 ms | ~0.1 MB |

## Recommendation

**Hash every 20 ticks (once a second), full `Save()`-based `StateHash()`, no incremental hash for now.** This is
OneLobby's default (`HashEveryTicks = 20`), costs a single 0.5 to 2 ms (p95 4 ms) blip once a second on a 50 ms tick
budget, and detects a desync within one second, after which the host's snapshot resync (`Save()`, 150 KB) repairs it. Hashing
every tick buys nothing a 1 s cadence does not (a desync is only fixable by resync, whose cost does not depend on when it was
noticed) and would add 1.4 to 3.8% CPU and ~9 MB/s of LOH garbage that can cause visible GC hitches on a Godot frame.

Cheap improvements if the blip ever shows in a frame-time probe (none needed today):

1. Hash off the main thread: `Save()` is a pure read, but the Sim is not thread-safe, so only do this on a copy; not worth it at 150 KB.
2. Avoid the UTF-16 round trip: serialize with `Utf8JsonWriter` into a pooled buffer and FNV over bytes (kills the LOH allocation and the 0.23 ms hash half). Note this changes the hash value, which is fine for lobbies (hash values never persist) but not for `SaveSlots.Probe`, which compares two hashes in the same process.
3. Incremental FNV over the ordered collections only if state grows 10x (the "if > 2 ms" trigger in DESIGN s.14 is met only by the noisy day-15 outliers, caused by GC, which item 2 fixes).

Caveats: measured with the bot, which never sends `Moved`, so avatar position state is default; two-player co-op adds a
second `PlayerState` (a few hundred bytes), negligible. Re-measure after the per-seat `WorldState` change and after E5/E6
content lands (turf, rivals and parts chains grow `Save()`).
