# {{title}}: multiplayer with OneLobby

A Godot 4 (GDScript) game with OneLobby multiplayer wired in by `create-onelobby`. Read the recipe, not the add-on:
{{recipeUrl}} (section "By hand" has every step this folder already did).

## What is here

- `onelobby.json`: the multiplayer blueprint (game id, lobby size, hosting, sync mode). Change choices there.
- `addons/onelobby/`: the OneLobby GDScript add-on, plain scripts with `class_name`s, no plugin to enable. Do not edit it:
  `addons/onelobby/PIN.json` lists the SHA-256 of each file so an untouched copy can be told from an edited one.
- `addons/godot_webrtc/`: Godot's WebRTC extension (webrtc-native {{webrtcVersion}}). Not committed (`.gitignore`); a fresh clone
  gets it back with `npx create-onelobby --into . --template godot-gdscript`, which changes nothing else.
- `net.gd`: the autoload `Net`, the game's one `OneLobbyClient` (`Net.client`), built from `onelobby.json`.
- `main.tscn` / `main.gd`: the drop-in menu (`addons/onelobby/menu/menu.tscn`) plus a label that shows the roster on `game_started`.
  Start your game in the `game_started` handler; end it on `returned_to_lobby` or `left`. The menu doc: docs/recipes/menu.md in the OneLobby repo.
- `tests/multiplayer.gd`: two peers in one process on 127.0.0.1 (no Nostr, no public server), host, join by code, one message each way.

## Run it

```
godot --headless --import --path .        # once on a fresh clone: registers the WebRTC extension and the add-on's classes
godot --path . -- --host --local --name=Sam   # one window hosts (--local: 127.0.0.1 only)
godot --path . -- --join=127.0.0.1:47810 --local --name=Ann   # a second window joins
```

## Test it (headless, loopback only)

```
godot --headless --audio-driver Dummy --path . -s res://tests/multiplayer.gd
```

It prints `MULTIPLAYER_OK` and exits 0, or `MULTIPLAYER_FAIL <what>` and exits 1. Always pass `--headless --audio-driver Dummy`.

## Rules

- Messages go through `lobby.send(peer_id, bytes)` / `lobby.broadcast(bytes)` and the `message_received` signal; a joiner's send goes via the host.
- Windows export: ship `libwebrtc_native.windows.template_release.x86_64.dll` beside the exe, and add `*.json` to the export filters so `onelobby.json` is packed.
- Keep a player's data out of `user://` file names that two instances on one PC would share (give each a suffix).
