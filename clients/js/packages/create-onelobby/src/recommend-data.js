// The rules of `create-onelobby --recommend`, as DATA. The matcher in recommend.js reads this and decides nothing itself, so a later
// package that lets another engine predict, or moves the side that decides movement, is an edit to this file and not to the code.
// Source of every shape and every "why": docs/design/one-shot.md section 5 (the table is mirrored there by id; a test keeps them in
// step); every key and value is one the blueprint schema allows (docs/design/blueprint.md section 4). Reasons are plain words and
// name no game. A term is words separated by spaces (matched on whole words, the last one also in its plural); a number after it is
// its weight: 1-2 is a weak hint, 3 or more is strong evidence.

/** A proposal needs this much evidence in total, and must beat the runner-up by this much; otherwise the answer is "unknown". */
export const MIN_SCORE = 3;
export const MIN_MARGIN = 2;

/** The five game shapes of one-shot.md section 5, in the table's order. `modes`: the modes to propose, best first. */
export const SHAPES = [
  {
    id: "lockstep",
    name: "Deterministic fixed-tick game",
    summary: "party minigames, an RTS on a seeded simulation: every peer runs the same sim and only small inputs cross the network",
    terms: [
      ["deterministic", 6],
      ["lockstep", 6],
      ["fixed tick", 5],
      ["fixed timestep", 5],
      ["fixed time step", 5],
      ["seeded", 3],
      ["minigame", 3],
      ["mini game", 3],
      ["party game", 3],
      ["party", 2],
      ["rts", 3],
      ["real time strategy", 3],
      ["strategy", 1],
    ],
    modes: [
      { mode: "lockstep", why: "every peer runs the same fixed-tick simulation and only the small inputs cross the network, so there is no state to sync" },
      { mode: "raw", why: "the host broadcasts its state and joiners send intents (nearest mode the template can write)" },
    ],
    tickRate: { value: 20, why: "lockstep sends one frame per tick, so this is your simulation's fixed step: set it to the rate your sim runs at (20 until you know)", fromText: "your description gives the tick rate" },
    hashEveryTicks: { value: 60, why: "a state hash about every 60 ticks finds a drift between peers early (a mismatch raises Desync)" },
    pause: { value: "off", why: "a real-time round cannot wait for one player to find the pause key" },
    players: { value: 4, why: "2-4 players is the default", partyValue: 8, partyWhy: "a party game defaults to 8 players", partyTerms: ["party", "minigame", "mini game", "party game"] },
  },
  {
    id: "coop-snapshots",
    name: "Free-roam co-op with rich state",
    summary: "survival, sandbox: the host runs the world and sends snapshots, each joiner predicts its own actions",
    terms: [
      ["sandbox", 3],
      ["open world", 3],
      ["free roam", 3],
      ["host runs the world", 3],
      ["host sends snapshots", 3],
      ["host sends the world", 3],
      ["cooperative", 3],
      ["co op", 3],
      ["coop", 3],
      ["base building", 2],
      ["survival", 1],
      ["crafting", 1],
    ],
    modes: [
      { mode: "replication", why: "the host runs the world and sends binary delta snapshots; sending the whole state as text outgrew the link in a real game" },
      { mode: "raw", why: "the host holds the world and broadcasts its state; joiners send intents (nearest mode the template can write)" },
    ],
    tickRate: { value: 15, why: "snapshots at about 10-20 Hz carry a rich world without outgrowing the link (15 is the middle)" },
    playerAuthority: { value: "owner", why: "co-op: each player's own PC places its player, so movement answers at once and the host trusts its friends (one-shot.md section 5)" },
    pause: { value: "host", why: "the host's machine runs the world, so the host decides when it stops" },
    players: { value: 4, why: "2-4 players is the default" },
  },
  {
    id: "replication",
    name: "Shooter or physics game, host-authoritative",
    summary: "shooters, physics, AI: the host decides, joiners get interpolated snapshots and send inputs; anything that is not deterministic",
    terms: [
      ["first person shooter", 4],
      ["third person shooter", 4],
      ["shooter", 4],
      ["fps", 4],
      ["hitscan", 3],
      ["hit scan", 3],
      ["battle royale", 3],
      ["brawler", 3],
      ["racing", 3],
      ["physics", 3],
      ["nondeterministic", 4],
    ],
    modes: [
      { mode: "replication", why: "the host decides, joiners interpolate its snapshots and send inputs; a physics or AI game is not deterministic, so lockstep is out" },
      { mode: "raw", why: "the host broadcasts its state and joiners send intents (nearest mode the template can write)" },
    ],
    tickRate: { value: 30, why: "a 30 Hz simulation with snapshots sent at about 20 Hz is fast enough for shooting and light on the link" },
    playerAuthority: { value: "host", why: "competitive: the host steps every player and each owner predicts the same step, so a player cannot place itself (one-shot.md section 5)" },
    pause: { value: "off", why: "real-time action: a pause would freeze every other player mid-fight" },
    players: { value: 4, why: "2-4 players is the default" },
  },
  {
    id: "turn-based",
    name: "Turn-based, card or board game",
    summary: "nothing to sync between turns: the host is the truth and raw messages are enough, with no tick",
    terms: [
      ["turn based", 4],
      ["chess", 4],
      ["checkers", 4],
      ["tic tac toe", 4],
      ["backgammon", 4],
      ["board game", 3],
      ["boardgame", 3],
      ["card game", 3],
      ["card", 3],
      ["poker", 3],
      ["trivia", 3],
      ["quiz", 3],
      ["bingo", 3],
      ["tabletop", 3],
      ["word game", 3],
    ],
    modes: [{ mode: "raw", why: "nothing needs syncing between turns: the host is the truth, joiners send their move and the host validates it and broadcasts the result" }],
    tickRate: null,
    pause: null,
    pauseModifiers: false, // nothing runs between turns, so there is nothing to pause
    players: { value: 4, why: "2-4 players is the default", fixedByTerms: [{ terms: ["chess", "checkers", "tic tac toe", "backgammon"], value: 2, why: "the game is for two players" }] },
  },
  {
    id: "own-server",
    name: "An existing server-style game",
    summary: "the game keeps its own server loop and OneLobby only carries the bytes, shaped like a WebSocket",
    terms: [
      ["own server loop", 6],
      ["own server", 4],
      ["server loop", 4],
      ["existing server", 4],
      ["own backend", 3],
      ["websocket", 3],
      ["web socket", 3],
    ],
    modes: [{ mode: "raw", why: "the game keeps its own server loop, so OneLobby only moves its messages (the host runs that loop)" }],
    tickRate: null,
    pause: null,
    players: { value: 4, why: "2-4 players is the default" },
  },
];

/**
 * A new game has no code to survey, so its sentence is the only input. When no shape clears MIN_SCORE / MIN_MARGIN but the sentence
 * has WORLD_TERMS (players who run, jump or move around a place together), the proposal is a world the players move in:
 * the better of the two player-world shapes (a tie goes to the first), unless a WORLD_BLOCKERS word says it is another kind of game.
 * Terms are weighted like SHAPES.terms, but their weights only decide that the fallback applies (one match is enough).
 */
export const WORLD_TERMS = [
  ["run", 1],
  ["running", 1],
  ["jump", 1],
  ["jumping", 1],
  ["arena", 1],
  ["platform", 1],
  ["platformer", 1],
  ["move around", 1],
  ["moving around", 1],
  ["walk around", 1],
  ["roam", 1],
  ["explore", 1],
  ["co op", 1],
  ["coop", 1],
  ["cooperative", 1],
];
export const WORLD_SHAPES = ["replication", "coop-snapshots"];
export const WORLD_BLOCKERS = ["turn based", "puzzle", "deterministic", "lockstep", "board game", "card game", "chess", "own server"];
export const WORLD_NOTE =
  "your description names a world the players move in but no shape word clearly (no code to survey): this proposes the nearest player-world shape. Add 'turn based', 'puzzle', 'deterministic' or 'lockstep' if the game is one of those; the `candidates` list has the runners-up.";

/**
 * The look of the player, read from the description: "2d" (side view, top-down, platformer) or null. An explicit "3d" keeps the
 * schema default (3d), so no row is written for it.
 */
export const SPACE_TERMS = {
  "2d": ["2d", "side view", "sideview", "side scroller", "side scrolling", "side on", "top down", "topdown", "platformer"],
  "3d": ["3d", "first person", "third person"],
};

/** Things that change one key across shapes. First match wins, in this order. */
export const PAUSE_MODIFIERS = [
  { value: "host", terms: ["host runs the world", "host authoritative", "host is authoritative"], why: "your description says the host runs the world, so the host decides when it stops" },
  { value: "anyone", terms: ["rts", "real time strategy", "strategy", "city builder", "4x"], why: "a strategy game is worth pausing: any player can ask, and the host stops the frames" },
];

/** Words that make a game competitive: with one of these a co-op sentence is still a host-decides game (see the first VETOES row). */
export const COMPETITIVE_TERMS = ["shooter", "fps", "hitscan", "hit scan", "battle royale", "brawler", "racing", "physics", "pvp", "versus", "competitive", "deathmatch"];

/** A veto on one shape. `engine`: only for that engine; `unless`: terms in the description that lift a penalty; `ban`: the shape can never win. */
export const VETOES = [
  // a co-op game whose host runs the world is a snapshot game even when it says "not deterministic" or "host authoritative": that wording alone
  // is the replication shape's strongest hint, so without a competitive word the co-op words win
  { shape: "replication", terms: ["co op", "coop", "cooperative"], unless: COMPETITIVE_TERMS, penalty: 3, note: "your description says co-op and nothing competitive, so the proposal is the co-op snapshot shape (the host runs the world), not the competitive one: add a word like shooter or versus if the host decides everything" },
  { shape: "lockstep", terms: ["nondeterministic"], ban: true, note: "your description says the simulation is not deterministic, so lockstep is out: the peers would drift apart" },
  { shape: "lockstep", engine: "unity", terms: ["physics", "rigidbody", "ragdoll", "racing", "vehicle"], ban: true, note: "Unity physics is not deterministic, so lockstep is out" },
  { shape: "lockstep", terms: ["physics", "rigidbody", "ragdoll"], unless: ["deterministic", "lockstep"], penalty: 3, note: "physics does not run the same on every peer unless you say it is deterministic" },
];

/**
 * A term does not count when one of these words stands right before it ("no physics", "non-deterministic"), or before it with one
 * filler word between ("not a shooter", "not fully deterministic"). A term that itself starts with one ("not deterministic") still matches.
 */
export const NEGATORS = ["not", "non", "no", "never", "without", "isn't", "aren't", "wasn't", "doesn't", "don't"];
export const NEGATION_FILLERS = ["a", "an", "the", "any", "fully", "really", "quite", "use", "have", "need"];
/** A denied word that means something of its own: it is read as this one word ("not fully deterministic" counts as "nondeterministic"). */
export const DENIED_WORDS = { deterministic: "nondeterministic" };
/** After "for <number>" these words mean the number is not a player count ("for 3 rounds"). Each is a regular expression piece. */
export const NOT_PLAYERS_AFTER_FOR = ["hz", "ticks?", "kb", "min", "minutes?", "sec", "seconds?", "hours?", "days?", "rounds?", "turns?", "laps?", "levels?", "maps?", "lives", "teams?"];

/** Words that decide a spectator row, the player count and the tick rate. */
export const SPECTATOR_TERMS = ["spectator", "spectate", "spectating", "watch", "watching", "watcher", "observer"];
export const SPECTATOR_DEFAULT = { value: 4, why: "your description mentions watching; spectators do not count against lobby.maxPlayers" };
export const DETERMINISM_WORD = "deterministic";
export const DUEL_TERMS = ["duel", "1v1", "head to head", "two player", "2 player"];
export const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, sixteen: 16 };

/**
 * Engine names in a description (single words). The first row that matches wins, so the specific ones come first.
 * `anyOf`: any of these words; `allOf`: one word from every group; `settledBy`: if one of these words is also there, the language is
 * settled (otherwise the answer is the assumed one and the "godotLanguage" question is asked); `notBefore`: a word does not name the
 * engine when one of these follows it ("web socket" is a transport, not the browser; "node graph" is not a Node host). "node" and "nodejs" name
 * node-browser (a Node process hosts and serves the page); it sits after the Godot rows, whose games talk about nodes too.
 */
export const ENGINE_TERMS = [
  { engine: "unity", anyOf: ["unity", "unity3d"] },
  { engine: "godot-csharp", allOf: [["godot"], ["c#", "csharp", "mono", "dotnet"]] },
  { engine: "godot-gdscript", anyOf: ["gdscript", "godot"], settledBy: ["gdscript"] },
  { engine: "node-browser", anyOf: ["node", "nodejs"], notBefore: { node: ["graph", "graphs", "tree", "trees", "based", "editor"] } },
  { engine: "web", anyOf: ["browser", "web", "html5", "javascript", "typescript", "webgl", "phaser", "js"], notBefore: { web: ["socket", "sockets"] } },
  { engine: "dotnet", anyOf: ["dotnet", "monogame", "csharp", "c#"] },
];

/**
 * What each engine value can do today (one-shot.md sections 1 and 7, the client READMEs and recipes; `proof` names where).
 *   template   "built": create-onelobby writes a project for it now; "planned": it stops with template_planned.
 *   canListen  can host direct (a browser page cannot: the schema makes hosting.direct true an error for "web").
 *   modes      the sync.mode values the template writes today (the web template refuses replication, see src/cli.js).
 *   features   what its client library has: prediction (Reconciler), hitRewind (HistoryRing / RewindTick), asWebSocket.
 */
export const ENGINES = {
  web: {
    label: "web (a browser game)",
    template: "built",
    canListen: false,
    modes: ["lockstep", "raw"],
    modeRefusal: { replication: "the web template writes the lockstep and raw sample game only; a replication game needs a ReplicationSession the template does not write yet (docs/recipes/replication.md section 5)" },
    features: { prediction: true, hitRewind: true, asWebSocket: true },
  },
  "node-browser": {
    label: "node-browser (a Node host serving a browser page)",
    template: "built", // --into only: it writes the blueprint and the glue into the game that already has the Node server
    recipe: "docs/recipes/browser-game.md",
    canListen: true,
    modes: ["lockstep", "raw", "replication"],
    features: { prediction: true, hitRewind: true, asWebSocket: true },
  },
  "godot-gdscript": {
    label: "Godot 4 GDScript",
    template: "built",
    canListen: true,
    modes: ["lockstep", "raw", "replication"],
    features: { prediction: false, hitRewind: false, asWebSocket: false },
  },
  "godot-csharp": {
    label: "Godot 4 C#",
    template: "built",
    recipe: "docs/recipes/godot-csharp.md",
    canListen: true,
    modes: ["lockstep", "raw", "replication"],
    features: { prediction: true, hitRewind: true, asWebSocket: false },
  },
  unity: {
    label: "Unity 6",
    template: "built",
    recipe: "docs/recipes/unity.md",
    canListen: true,
    modes: ["lockstep", "raw", "replication"],
    features: { prediction: true, hitRewind: true, asWebSocket: false },
  },
  dotnet: {
    label: ".NET (console, MonoGame)",
    template: "planned",
    recipe: "docs/recipes/dotnet-generic.md",
    canListen: true,
    modes: ["lockstep", "raw", "replication"],
    features: { prediction: true, hitRewind: true, asWebSocket: false },
  },
};

/** Where each engine feature is proven (shown by the tests and the README; keep it true). */
export const FEATURE_PROOF = {
  prediction: "docs/recipes/replication.md section 3 (C# and JS Reconciler, PredictionSmoother; docs/recipes/net-player.md for the JS player layer); GDScript only exposes last_processed_input for prediction you write yourself (same recipe, section 6); the Unity package ships the C# assembly (docs/recipes/unity.md section 3)",
  hitRewind: "docs/recipes/replication.md section 2 (C# and JS HistoryRing, rewindTick); GDScript has try_sample_at to rewind by hand (section 6)",
  asWebSocket: "docs/recipes/browser-game.md (JS lobby.asWebSocket); AGENTS.md; no GDScript or C# equivalent",
  lockstepFastInputs: "docs/recipes/godot-gdscript.md section 4: input redundancy on the fast channel is not in the wire yet (commands travel on the reliable channel); no JS or C# lockstep helper repeats inputs either",
  templates: "docs/design/one-shot.md section 1 (Scaffolder row): web, godot-gdscript, godot-csharp and unity are built; src/cli.js refuses sync.mode replication for the web template",
};

/**
 * Advice that is not a blueprint key (no key is invented for it). `status` per engine feature or fixed:
 *   { feature }  built-in where engines[x].features[feature], else "by-hand" (`how.byHand` says with which pieces);
 *   { fixed }    the same on every engine.
 * `shapes`: the shapes it applies to.
 */
export const ADVICE = [
  {
    id: "lockstep-fast-inputs",
    shapes: ["lockstep"],
    text: "Send inputs on the fast channel with the last few ticks repeated",
    why: "a reliable ordered input channel stalled one game about half its frames at 80 ms and 2% loss; redundancy on the fast channel fixed it",
    status: { fixed: "by-hand" },
    how: { byHand: "no lockstep helper does this yet (its commands travel on the reliable channel); send your own input packets on the fast channel (Channel.Fast in C#, { channel: 'fast' } in JS) beside the lockstep frames" },
    doc: "docs/recipes/raw-mode.md",
  },
  {
    id: "adaptive-input-delay",
    shapes: ["lockstep"],
    text: "Use an adaptive input delay (a few ticks, grown when the round trip grows)",
    why: "a fixed delay is either too laggy on a good link or too stuttery on a bad one",
    status: { fixed: "by-hand" },
    how: { byHand: "no client has it yet: measure the round trip yourself and schedule each command a few ticks ahead" },
    doc: "docs/recipes/raw-mode.md",
  },
  {
    id: "bots-take-seats",
    shapes: ["lockstep"],
    text: "Let bots take the seats of dropped players",
    why: "a lockstep game cannot wait for a player who left; a bot keeps the simulation moving",
    status: { fixed: "built-in" },
    how: { builtIn: "room.on(\"seatDropped\", s => spawnBot(s.seat)) fires once the rejoin window has passed (room.seatDropped / rejoinWindowSeconds)" },
    doc: "docs/recipes/room.md",
  },
  {
    id: "replicated-fast-inputs",
    shapes: ["coop-snapshots", "replication"],
    text: "Inputs ride the fast channel with the last few ticks repeated",
    why: "one lost packet then costs nothing",
    status: { fixed: "built-in" },
    how: { builtIn: "ReplicationSession sends each client's input every tick with its last few ticks repeated (InputRedundancy)" },
    doc: "docs/recipes/replication.md",
  },
  {
    id: "predict-own-actions",
    shapes: ["coop-snapshots", "replication"],
    text: "Let each joiner predict its own actions and blend the host's corrections",
    why: "movement answers at once instead of a round trip later",
    status: { feature: "prediction" },
    how: {
      builtIn: "Reconciler and PredictionSmoother (C# and JS, section 3 of the recipe; the JS NetPlayers layer with authority \"host\" does it for a player, docs/recipes/net-player.md)",
      byHand: "the GDScript client has no Reconciler yet: step your own copy of the movement with each input and compare it with rep.try_get_latest and rep.last_processed_input",
    },
    doc: "docs/recipes/replication.md",
  },
  {
    id: "binary-deltas",
    shapes: ["coop-snapshots", "replication"],
    text: "Send binary deltas against an acked baseline once the state passes about 3 KB",
    why: "whole-state JSON at 10 Hz outgrew the link in one game",
    status: { fixed: "built-in" },
    how: { builtIn: "ReplicationSession (C#), ReplicationSession (JS) and OneLobbyReplicationSession (GDScript) already do it: bit-packed snapshots, deltas against the last tick the client acked" },
    doc: "docs/recipes/replication.md",
  },
  {
    id: "reliable-keyframe",
    shapes: ["coop-snapshots", "replication"],
    text: "Send a reliable keyframe every few seconds and on join",
    why: "a joiner or a client that lost a delta baseline recovers without waiting",
    status: { fixed: "built-in" },
    how: { builtIn: "the host sends a full snapshot on the reliable channel when a link comes up and every keyframeSeconds (default 5)" },
    doc: "docs/recipes/replication.md",
  },
  {
    id: "hit-rewind",
    shapes: ["replication"],
    text: "Judge hits on the host with hit rewind, capped near 350 ms",
    why: "the shooter sees the target where it was on their screen; the cap keeps a laggy player from shooting around corners",
    status: { feature: "hitRewind" },
    how: {
      builtIn: "HistoryRing and ReplicationSession.RewindTick / rewindTick (C# and JS, section 2 of the recipe)",
      byHand: "the GDScript client has no HistoryRing yet: keep your own history of positions per tick and rewind with try_sample_at, clamped to 350 ms",
    },
    doc: "docs/recipes/replication.md",
  },
  {
    id: "host-validates-moves",
    shapes: ["turn-based"],
    text: "Let joiners send moves as intents and have the host check each one before broadcasting the result",
    why: "the host is the truth, so a player cannot play out of turn or make an illegal move",
    status: { fixed: "by-hand" },
    how: { byHand: "game logic on the host: pattern in docs/recipes/raw-mode.md (joiners send intents, the host decides)" },
    doc: "docs/recipes/raw-mode.md",
  },
  {
    id: "as-websocket",
    shapes: ["own-server"],
    text: "Keep the game's server loop and give joiners lobby.asWebSocket()",
    why: "it keeps the game's own server loop and existing WebSocket client code runs unchanged",
    status: { feature: "asWebSocket" },
    how: {
      builtIn: "lobby.onConnection on the host and lobby.asWebSocket() in the page (JS)",
      byHand: "asWebSocket exists in the JS client only: here, send the loop messages as raw bytes and wrap them yourself",
    },
    doc: "docs/recipes/browser-game.md",
  },
];

/** The facts a description did not give and that would change the answer. `add`: words to put in the description to settle it. */
export const QUESTIONS = {
  determinism: {
    question:
      "Is the simulation deterministic? Lockstep needs the same commands in the same order to give the same state on every peer: a fixed tick, in-state seeded random numbers, no wall clock, no unordered iteration, no floats that differ by platform (AGENTS.md rule 3).",
    add: "deterministic with a fixed tick and seeded random numbers (or: not deterministic)",
  },
  tickRate: { question: "What fixed tick rate does the simulation run at?", add: "at 30 ticks per second" },
  engine: { question: "Which engine or platform is it for? It changes hosting, the modes the scaffolder writes today and which helpers (prediction, hit rewind) exist.", add: "in Godot (GDScript or C#), in Unity, or in the browser" },
  godotLanguage: { question: "GDScript or C#? Assumed GDScript, the default Godot template (the C# one is --template godot-csharp).", add: "in Godot with GDScript, or in Godot with C#" },
  players: { question: "How many players?", add: "for 4 players, or up to 8 players, or a 1v1 duel" },
  stateSize: { question: "Roughly how large is the world state? Binary deltas matter once it passes about 3 KB.", add: "with a world state of about 10 KB" },
  shape: {
    question: "What kind of game is it? The description did not clearly match one shape.",
    add: "one of: deterministic fixed-tick party minigames; co-op survival sandbox; shooter or physics game; turn-based card game; a game with its own server loop",
  },
};
