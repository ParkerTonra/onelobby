# Documentation~

Copies of the OneLobby docs a game team needs, so the package tarball is self-contained. Unity ignores folders ending
in `~`, so nothing here is imported.

The files are build output, not tracked: `clients/unity/build-unity-package.ps1` (and `.sh`) copy them from the repo on
every run:

- `unity.md`, `direct-ip.md`, `pause.md`, `game-console.md`, `replication.md`, `voice-and-chat.md` from `docs/recipes/`
- `nostr-signaling.md` from `spec/`
- `AGENTS.md` from the repo root (the API summary and rules)

Start with `unity.md`. Edit the originals in the repo, never the copies here.
