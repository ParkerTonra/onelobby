// Argument parsing: no dependencies. Every answer flag maps to one blueprint key (docs/design/blueprint.md s.6).

export class CliError extends Error {
  constructor(code, message, path) {
    super(message);
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

const BOOL = "bool";
const INT = "int";
const STR = "str";
const ENUM = "enum";

/** One row per answer flag, in schema section order. `words`: also accepts `--voice no` / `--chat yes`. */
export const ANSWER_FLAGS = [
  { flag: "game-id", key: "game.id", type: STR, hint: "<reverse.dns>" },
  { flag: "title", key: "game.title", type: STR, hint: "<text>" },
  { flag: "net-version", key: "game.netVersion", type: STR, hint: "<text>" },
  { flag: "lobby-server", key: "hosting.lobbyServer", type: STR, hint: "<url>" },
  { flag: "port", key: "hosting.directPort", type: INT, hint: "<n>" },
  { flag: "open-port", key: "hosting.openPort", type: BOOL },
  { flag: "relay-only", key: "hosting.relayOnly", type: BOOL },
  { flag: "max-players", key: "lobby.maxPlayers", type: INT, hint: "<n>" },
  { flag: "listed", key: "lobby.listed", type: BOOL },
  { flag: "approve-joins", key: "lobby.approveJoins", type: BOOL },
  { flag: "password", key: "lobby.password", type: BOOL },
  { flag: "late-join", key: "lobby.lateJoin", type: BOOL },
  { flag: "rejoin", key: "lobby.rejoin", type: BOOL },
  { flag: "join-link", key: "lobby.joinLink", type: BOOL },
  { flag: "mode", key: "sync.mode", type: ENUM, hint: "<raw|lockstep|replication>" },
  { flag: "tick-rate", key: "sync.tickRate", type: INT, hint: "<n>" },
  { flag: "identity", key: "players.identity", type: ENUM, hint: "<name|anonymous|platform>" },
  { flag: "chat", key: "chat.text", type: BOOL, words: true },
  { flag: "voice", key: "chat.voice", type: BOOL, words: true },
  { flag: "voice-mode", key: "chat.voiceMode", type: ENUM, hint: "<pushToTalk|voiceActivity>" },
  { flag: "host-leaves", key: "session.hostLeaves", type: ENUM, hint: "<end|migrate>" },
  { flag: "pause", key: "session.pause", type: ENUM, hint: "<off|host|anyone>" },
  { flag: "steam", key: "platforms.steam", type: "steam" },
  { flag: "epic", key: "platforms.epic", type: BOOL },
  { flag: "discord", key: "platforms.discord", type: BOOL },
  { flag: "ui", key: "ui.kind", type: ENUM, hint: "<drop-in|generated|none>" },
  { flag: "ui-entry", key: "ui.entry", type: STR, hint: "<text>" },
];

/** Plain switches and value options that are not blueprint keys. */
const OPTION_FLAGS = {
  template: "value",
  into: "value",
  from: "value",
  hosting: "value",
  set: "value",
  "onelobby-version": "value",
  yes: "bool",
  y: "bool",
  "no-input": "bool",
  "dry-run": "bool",
  json: "bool",
  "no-install": "bool",
  "no-git": "bool",
  force: "bool",
  help: "bool",
  h: "bool",
  version: "bool",
};

const YES = new Set(["yes", "true", "on", "1"]);
const NO = new Set(["no", "false", "off", "0"]);

export function setPath(obj, dotted, value) {
  const keys = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== "object" || cur[keys[i]] === null || Array.isArray(cur[keys[i]])) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

export function getPath(obj, dotted) {
  let cur = obj;
  for (const k of dotted.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = cur[k];
  }
  return cur;
}

function parseSetValue(path, raw) {
  if (path.startsWith("lobby.meta.")) return raw; // meta values are always strings
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Parse argv (without node and script). Returns
 * `{ dir, opts, given }` where `given` is an ordered list of `[dottedKey, value]` answers from flags and `--set`.
 * Throws CliError("bad_flag") for an unknown flag or a bad value.
 */
export function parseArgs(argv) {
  const byFlag = new Map(ANSWER_FLAGS.map((f) => [f.flag, f]));
  const opts = {
    template: undefined,
    into: undefined,
    from: undefined,
    yes: false,
    noInput: false,
    dryRun: false,
    json: false,
    noInstall: false,
    noGit: false,
    force: false,
    help: false,
    version: false,
    onelobbyVersion: undefined,
  };
  const given = [];
  const positional = [];
  const bad = (flag, why) => new CliError("bad_flag", `--${flag}: ${why}`);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    let name = arg.replace(/^--?/, "");
    let inline;
    const eq = name.indexOf("=");
    if (eq >= 0) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const takeValue = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && next.length > 2)) throw bad(name, "needs a value");
      i++;
      return next;
    };

    // plain options
    if (name in OPTION_FLAGS) {
      if (OPTION_FLAGS[name] === "value") {
        const v = takeValue();
        if (name === "template") opts.template = v;
        else if (name === "into") opts.into = v;
        else if (name === "from") opts.from = v;
        else if (name === "onelobby-version") opts.onelobbyVersion = v;
        else if (name === "hosting") {
          if (!["direct", "server", "both"].includes(v)) throw bad(name, "must be direct, server or both");
          given.push(["hosting.direct", v !== "server"], ["hosting.server", v !== "direct"]);
        } else if (name === "set") {
          const j = v.indexOf("=");
          if (j <= 0) throw bad(name, `expected key=value, got "${v}"`);
          const path = v.slice(0, j);
          given.push([path, parseSetValue(path, v.slice(j + 1))]);
        }
      } else {
        const on = inline === undefined ? true : YES.has(inline) ? true : NO.has(inline) ? false : null;
        if (on === null) throw bad(name, "expects true or false");
        if (name === "y" || name === "yes") opts.yes = on;
        else if (name === "no-input") opts.noInput = on;
        else if (name === "dry-run") opts.dryRun = on;
        else if (name === "json") opts.json = on;
        else if (name === "no-install") opts.noInstall = on;
        else if (name === "no-git") opts.noGit = on;
        else if (name === "force") opts.force = on;
        else if (name === "help" || name === "h") opts.help = on;
        else if (name === "version") opts.version = on;
      }
      continue;
    }

    // answer flags: --x, --no-x, --x=value, --x value
    let negated = false;
    let def = byFlag.get(name);
    if (!def && name.startsWith("no-")) {
      def = byFlag.get(name.slice(3));
      negated = !!def;
    }
    if (!def) throw new CliError("bad_flag", `unknown option: ${arg}. Try --help.`);
    const shown = negated ? `no-${def.flag}` : def.flag;

    if (def.type === BOOL) {
      let on = !negated;
      if (inline !== undefined) {
        if (YES.has(inline)) on = !negated;
        else if (NO.has(inline)) on = negated;
        else throw bad(shown, "expects true or false");
      } else if (def.words && argv[i + 1] !== undefined && (YES.has(argv[i + 1]) || NO.has(argv[i + 1]))) {
        const w = argv[++i];
        on = YES.has(w) ? !negated : negated;
      }
      given.push([def.key, on]);
    } else if (def.type === "steam") {
      if (negated) given.push([def.key, false]);
      else if (inline !== undefined || /^\d+$/.test(argv[i + 1] ?? "")) {
        const raw = inline ?? argv[++i];
        if (!/^\d+$/.test(raw)) throw bad(shown, "appId must be a positive integer");
        given.push([def.key, { appId: Number(raw) }]);
      } else given.push([def.key, true]);
    } else {
      if (negated) throw new CliError("bad_flag", `unknown option: ${arg}. Try --help.`);
      const v = takeValue();
      if (def.type === INT) {
        if (!/^-?\d+$/.test(v)) throw bad(shown, `expected a whole number, got "${v}"`);
        given.push([def.key, Number(v)]);
      } else given.push([def.key, v]);
    }
  }
  if (positional.length > 1) throw new CliError("bad_flag", `expected one directory, got: ${positional.join(" ")}`);
  return { dir: positional[0], opts, given };
}

export const USAGE = `create-onelobby: scaffold a multiplayer game with OneLobby (writes onelobby.json, the glue and a two-player test)

Usage: create-onelobby [dir] [options]

  --template <web|node-browser|godot-csharp|unity|dotnet>   only "web" in this release; the rest are planned for v2
  --into <dir>                 add to an existing project: writes onelobby.json, multiplayer/ and test/ only
  --from <onelobby.json>       take every answer from this file (flags still override it)
  --game-id <reverse.dns>  --title <text>  --net-version <text>
  --max-players <n>  --listed  --approve-joins  --password  --no-late-join  --no-rejoin  --no-join-link
  --mode <raw|lockstep|replication>  --tick-rate <n>
  --hosting <direct|server|both>  --lobby-server <url>  --port <n>  --no-open-port  --relay-only
  --identity <name|anonymous|platform>
  --chat / --no-chat  --voice / --no-voice  --voice-mode <pushToTalk|voiceActivity>
  --host-leaves <end|migrate>  --pause <off|host|anyone>
  --steam [appId]  --epic  --discord
  --ui <drop-in|generated|none>  --ui-entry <text>
  --set <key=value>            any schema key by dotted path (repeatable), e.g. --set lobby.meta.mode=fast
  -y, --yes                    defaults for everything not given (game id: com.example.<folder-name>)
  --no-input                   never prompt; a missing required answer is an error (CI=true implies it)
  --dry-run                    print the plan and onelobby.json, write nothing
  --json                       print one JSON object { ok, dir, template, blueprint, files, next } and nothing else
  --no-install  --no-git       skip "npm install" / "git init" in a new project
  --force                      overwrite existing files (--into) or write into a non-empty folder
  -h, --help  --version

Every --flag has a --no-flag form when it is a yes/no answer. Prompts appear only when stdin is a terminal and neither
--yes nor --no-input is set; the prompt text is each key's description from the schema.
`;
