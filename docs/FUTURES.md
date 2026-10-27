# Futures backlog

Tidyings and extension points that buy optionality. Each `/futures` pass writes a brief in `docs/futures/` and ticks
items here with commit hashes.

Latest brief: `docs/futures/2026-10-26.md`.

## Done (pass 2026-10-26)

- [x] Nostr limits vector `spec/vectors/nostr-limits.json` + named constants in JS and C#, one pin test each (32fecf1)
- [x] Startup-line vectors replayed by `formatHostLog` / `FormatHostLog` tests (f27530a)
- [x] Relay list single source: code defaults checked against `spec/blueprint.schema.json` (5f0a67d)
- [x] `RelayPool.settled` (e140a06); rest-wait ends once every relay answered + hostDirect first relay 3 s (ffc539d, breadth)
- [x] Mono crypto seam: probe `crypto` mode proves the AES-GCM fallback on Unity's Mono (b039b07)
- [x] AGENTS.md diet (b58ec5e), `docs/direct-ip.md` -> `docs/design/` (b02389e), DESIGN.md residue (21bee58), regen docs/api
- [x] JoinCodeKind shared constant + mapper parity test (87ae9d6)
- [x] `hostNostr` case in the live relay tests, JS (974e764; C# has no Nostr-only host API)
- [x] Tests for voice-core.ts (36993db)

## Open

- [ ] FakeRelays on the test clock: the no-relay test uses real WebRTC and timers, so it needs a different seam (now ~3 s)
- [ ] Tests for voice-browser.ts through the `advanced.createMic` / `createSink` seams (fake audio, headless)
- [ ] `NostrCrypto.FallbackLog` has no wiring; on Unity's Mono the fallback runs every time, so wire it only if a runtime
      appears where the fallback is news
- [ ] C# `LobbyErrorCodes` has 28 codes vs JS `ErrorCodes` 32: a parity vector like join-code-kinds.json
- [ ] 49 literal `"bad_request"` reasons in JS: named constants
- [ ] hardening.test.ts token-bucket cases assert wall-clock bounds (1800 / 2800 ms) and fail under machine load; run
      the bridge on an injected clock instead
