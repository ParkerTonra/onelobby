# Futures backlog

Tidyings and extension points that buy optionality. Each `/futures` pass writes a brief in `docs/futures/` and ticks
items here with commit hashes.

Latest brief: `docs/futures/2026-10-26.md`.

- [ ] Nostr limits vector `spec/vectors/nostr-limits.json` + named constants in JS and C#, one pin test each
- [ ] Startup-line vectors replayed by `formatHostLog` / `FormatHostLog` tests
- [ ] Relay list single source: code defaults checked against `spec/blueprint.schema.json`
- [ ] `RelayPool.attempted/settled` (end the 1.5 s rest-wait early) + FakeRelays on the test clock
- [ ] Mono crypto seam: probe `crypto` mode proves the AES-GCM fallback on Unity's Mono
- [ ] AGENTS.md diet, `docs/direct-ip.md` -> `docs/design/`, regen docs/api
- [ ] JoinCodeKind shared constant + mapper parity test
- [ ] `hostNostr` case in the live relay tests (JS + C#)
- [ ] Tests for voice-core.ts / voice-browser.ts
