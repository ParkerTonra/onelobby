// Interactive questions, `node:readline` only. Order = the schema's section order; the question text is the key's
// `description` from the schema, so this list, the skill and the schema cannot drift.
import { createInterface } from "node:readline";
import { describeKey } from "./blueprint.js";
import { getPath } from "./flags.js";

/**
 * Keys worth asking about (the long tail is `--set`). `when(answers)` skips a question that no longer applies.
 * `def` is the default shown; it is also what an empty answer means.
 */
export function questions(template) {
  const web = template === "web";
  return [
    { key: "game.id", type: "str", required: true },
    { key: "game.title", type: "str" },
    // a browser cannot listen on a port, so web has no direct/server choice
    ...(web ? [] : [{ key: "hosting", type: "hosting", text: "Where players host: direct (join code, no server), server (lobby server) or both." }]),
    { key: "hosting.lobbyServer", type: "str", def: "" },
    { key: "lobby.maxPlayers", type: "int", def: 4 },
    { key: "lobby.listed", type: "bool", def: false },
    { key: "lobby.approveJoins", type: "bool", def: false, when: (a) => getPath(a, "lobby.listed") !== true },
    { key: "lobby.password", type: "bool", def: false },
    { key: "lobby.lateJoin", type: "bool", def: true },
    { key: "lobby.rejoin", type: "bool", def: true },
    { key: "lobby.joinLink", type: "bool", def: true },
    { key: "sync.mode", type: "enum", values: web ? ["lockstep", "raw"] : ["raw", "lockstep", "replication"], def: web ? "lockstep" : "raw" },
    { key: "sync.tickRate", type: "int", def: 20 },
    { key: "players.identity", type: "enum", values: ["name", "anonymous", "platform"], def: "name" },
    { key: "chat.text", type: "bool", def: true },
    { key: "chat.voice", type: "bool", def: false },
    { key: "chat.voiceMode", type: "enum", values: ["pushToTalk", "voiceActivity"], def: "pushToTalk", when: (a) => getPath(a, "chat.voice") === true },
    { key: "session.hostLeaves", type: "enum", values: ["end", "migrate"], def: "end" },
    { key: "session.pause", type: "enum", values: ["off", "host", "anyone"], def: "off" },
    { key: "ui.entry", type: "str", def: web ? "Main page" : "" },
  ];
}

export function createPrompter(input, output) {
  const rl = createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(text, def) {
      output.write(`${text}${def !== undefined && def !== "" ? ` (${def})` : ""}: `);
      const { value, done } = await lines.next();
      if (done) {
        output.write("\n");
        return undefined;
      }
      const v = value.trim();
      return v === "" ? undefined : v;
    },
    close() {
      rl.close();
    },
  };
}

const YES = new Set(["y", "yes", "true", "on"]);
const NO = new Set(["n", "no", "false", "off"]);

/** Ask one question; returns the typed answer coerced to the key's type, or undefined to keep the default. */
export async function askOne(prompter, q, output) {
  const text = q.text ?? describeKey(q.key);
  for (;;) {
    let raw;
    if (q.type === "bool") raw = await prompter.ask(`${text} [y/n]`, q.def ? "y" : "n");
    else if (q.type === "enum") raw = await prompter.ask(`${text} [${q.values.join("/")}]`, q.def);
    else raw = await prompter.ask(text, q.def);
    if (raw === undefined) return undefined;
    if (q.type === "bool") {
      if (YES.has(raw.toLowerCase())) return true;
      if (NO.has(raw.toLowerCase())) return false;
      output.write("Please answer y or n.\n");
    } else if (q.type === "int") {
      if (/^-?\d+$/.test(raw)) return Number(raw);
      output.write("Please type a whole number.\n");
    } else if (q.type === "enum") {
      if (q.values.includes(raw)) return raw;
      output.write(`Please choose one of: ${q.values.join(", ")}.\n`);
    } else if (q.type === "hosting") {
      if (["direct", "server", "both"].includes(raw)) return raw;
      output.write("Please choose direct, server or both.\n");
    } else return raw;
  }
}
