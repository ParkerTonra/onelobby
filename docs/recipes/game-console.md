# Recipe: a dev console a tool can reach (`ogc1`)

"OneLobby game console v1" (`ogc1`) lets a local tool (a launcher, a test script, an agent) send dev and server
commands to a running game: `round 10`, `kill all`, `god on`. The game runs a tiny HTTP server on loopback, off by
default. It is not part of the lobby: commands never cross the network, and the lobby's join code is never an admin
credential. The command set stays in your game; `ogc1` only carries lines in and lines out.

## 1. The protocol

All bodies are UTF-8 JSON. The game binds `127.0.0.1:<port>` only. `<token>` is read from the token file the game names
in its log line:

```
[console] listening http://127.0.0.1:<port> token file <path>
```

| Request | Auth | Response |
|---|---|---|
| `GET /healthz` | none | `200` text `ok` (liveness only; no game data) |
| `GET /info` | `Authorization: Bearer <token>` | `200 {"proto":"ogc1","game":"com.you.game","netVersion":"1","role":"solo\|host\|client\|connecting","players":2,"round":5,"cheats":true,"commands":[{"name":"round","args":"<n>","scope":"host","access":"cheat","help":"jump to round n"}, ...]}` |
| `POST /cmd` body `{"line":"round 10"}` | bearer | `200 {"ok":true,"lines":["round 10 in 1 s"],"ms":3}`; a refused or failed command is still `200` with `"ok":false` and its lines (the HTTP status is about the transport, `ok` about the game) |
| anything else | | `404 {"ok":false,"error":"not found"}`; bad or missing token `401`; non-loopback caller `403`; `OPTIONS` `403`; body over 4 KB `413`; game thread busy over 2 s `504` |

Rules:

- One line per `POST`. `line` is at most 200 characters; `lines` holds at most 50 entries of at most 400 characters.
- `ms` is the time the command took on the game's main thread.
- `game` is the lobby's `GameId` and `netVersion` its `NetVersion`, so a tool can match a console to a lobby.
- `commands` is what a tool's Tab completion reads; `help` is one line. `round`, `players` and `cheats` are optional
  game fields; a game may add its own.
- Run each line on the main thread, through the same code path as the in-game console, and wait for it at most 2 s.

## 2. The rules that make it safe

1. **Loopback only, off by default.** Bind `http://127.0.0.1:<port>/` exactly (not `+`, `*`, `0.0.0.0` or `localhost`,
   which can resolve to `::1`). Open it only when the player passes a flag; `--console-port=N` is the recommended name.
   Refuse any request whose remote address is not loopback.
2. **A fresh token in a user-only file, never logged.** Make 128 random bits per process (32 lower-case hex characters
   from a cryptographic RNG), write them to a file in the user's own app-data folder, and delete it on quit. The log
   prints the file's path, never the token. The file never goes into a repo, a log upload or a bug report. Compare
   tokens in constant time.

Also: send no CORS headers, ever, and answer `OPTIONS` with `403`. The `Authorization` header forces a browser to
preflight, so a web page cannot send a command to the console; with no CORS it cannot read a reply either.

## 3. Ports

OneLobby direct-IP hosting uses 47810-47819, so start game consoles at 47820 (for example 47820 for the host or a solo
game and 47821 for a joiner on the same machine).

## 4. A tool's side

Read the token file fresh on every call (the game writes a new one each launch) and keep it out of any web view. Use a
short timeout (3 s). Report "file missing" as "game not running", `401` as "stale token file", and a refused
connection as "console off".

```
curl -s http://127.0.0.1:47820/healthz
curl -s -H "Authorization: Bearer $(cat /path/to/console-47820.token)" http://127.0.0.1:47820/info
curl -s -H "Authorization: Bearer $(cat /path/to/console-47820.token)" -d '{"line":"round 10"}' http://127.0.0.1:47820/cmd
```

## 5. Unity: `GameConsoleServer`

The Unity package ships the server side (`OneLobby.Unity.GameConsoleServer`). Your game supplies two callbacks, both
run on the main thread from `Pump()`: `run` takes one line and returns `(ok, lines)` through the same path as your
in-game console, and `info` returns the `/info` JSON body.

```csharp
using OneLobby.Unity;

GameConsoleServer? console;

void Start()
{
    if (GameConsoleServer.PortFromArgs() is int port)   // --console-port=47820; no flag, no server
        console = GameConsoleServer.Start(port, line => MyConsole.Run(line), () => MyConsole.InfoJson(), Debug.Log);
}

void Update() => console?.Pump();
void OnDestroy() => console?.Stop();                    // closes the port and deletes the token file
```

The token file defaults to `Application.persistentDataPath/onelobby-console/console-<port>.token`; pass a path as the
second argument to choose another. `Start` returns null (and logs why) when the port is busy or the file cannot be
written.

## Done when

- `GET /healthz` answers `ok` with the flag, and nothing listens without it.
- `GET /info` without the token is `401`; with it, `proto` is `ogc1` and `commands` lists your commands.
- `POST /cmd` runs a command and shows its lines; a refused command answers `200` with `"ok":false`.
- The game's log names the token file and does not contain the token.
