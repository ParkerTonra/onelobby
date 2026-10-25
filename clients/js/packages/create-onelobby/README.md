# create-onelobby

Scaffold a multiplayer browser game with [OneLobby](https://github.com/ParkerTonra/onelobby).

```
npm create onelobby@latest my-game -- --template web --yes
cd my-game && npm start      # the game; set the lobby server in the page or in onelobby.json
npm test                     # two players, a message each way (in-memory; LOBBY_SERVER=ws://... uses a real server)
```

It writes `onelobby.json` (the blueprint: every multiplayer setting, with a description per key in its schema), the glue
that reads it at runtime, a starter game and the test. Edit `onelobby.json` by hand and reload: no rebuild.

`create-onelobby --help` lists every flag (one per setting, plus `--set key=value`). `--dry-run` writes nothing,
`--json` prints one machine-readable result, `--into <dir>` adds only `onelobby.json`, `multiplayer/` and the test to an
existing project. Only the `web` template exists so far; `node-browser`, `godot-csharp`, `unity` and `dotnet` are planned.

Zero runtime dependencies; Node 18 or newer. Design: `docs/design/blueprint.md` in the repository.
