// Regenerates spec/vectors/lan-discovery.json. Run: node spec/reference/gen-lan-discovery.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as L from "./lan-discovery.mjs";

const hex = (u) => Buffer.from(u).toString("hex");
const unhex = (h) => Uint8Array.from(Buffer.from(h, "hex"));
const n1 = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
const n2 = Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11]);

const baseAnswer = { nonce: n1, port: 47810, players: 2, maxPlayers: 4, password: false, gameId: "com.example.ants", netVersion: "3", lobbyName: "Sam's game", hostName: "Sam" };
const answerFields = (a) => ({ ...a, nonce: hex(a.nonce) });

const questions = [
  { name: "basic", nonce: hex(n1), gameId: "com.example.ants" },
  { name: "longest_game_id", nonce: hex(n2), gameId: "g".repeat(64) },
  { name: "one_char_game_id", nonce: hex(n1), gameId: "a" },
].map((q) => ({ ...q, hex: hex(L.encodeQuestion(unhex(q.nonce), q.gameId)) }));

const answerCases = [
  ["basic", baseAnswer],
  ["password_full", { ...baseAnswer, nonce: n2, players: 4, password: true }],
  ["empty_names", { ...baseAnswer, lobbyName: "", hostName: "", players: 0, maxPlayers: 255, port: 65535 }],
  ["non_ascii_names", { ...baseAnswer, lobbyName: "Café ☕ \u{1F41C}", hostName: "Åsa" }],
  ["longest", { ...baseAnswer, gameId: "g".repeat(64), netVersion: "v".repeat(32), lobbyName: "€".repeat(24), hostName: "h".repeat(72) }],
];
const answers = answerCases.map(([name, a]) => ({ name, fields: answerFields(a), hex: hex(L.encodeAnswer(a)) }));

const q = L.encodeQuestion(n1, "com.example.ants");
const a = L.encodeAnswer(baseAnswer);
const patch = (u, at, v) => { const c = Uint8Array.from(u); c[at] = v; return c; };
const cat = (...xs) => Uint8Array.from(xs.flatMap((x) => [...x]));
const fill = (n, v) => new Uint8Array(n).fill(v);

const dropQuestions = [
  ["bad_magic", hex(patch(q, 0, 0x58))],
  ["other_wire_version", hex(patch(q, 4, 2))],
  ["wrong_type_answer", hex(patch(q, 5, 2))],
  ["too_short", hex(q.slice(0, 13))],
  ["empty", ""],
  ["game_id_length_zero", hex(cat(q.slice(0, 14), [0]))],
  ["game_id_over_limit", hex(cat(q.slice(0, 14), [65], fill(65, 0x61)))],
  ["game_id_cut_short", hex(q.slice(0, q.length - 1))],
  ["trailing_byte", hex(cat(q, [0]))],
  ["padded_to_600_bytes", hex(cat(q, new Uint8Array(600 - q.length)))],
  ["game_id_bad_utf8", hex(cat(q.slice(0, 14), [2, 0xc3, 0x28]))],
].map(([name, h]) => ({ name, hex: h }));

// layout of `a`: header 14, port 2, players, max, flags (19), gameId 1+16, netVersion 1+1, lobbyName 1+10, hostName 1+3
const nvAt = 19 + 17;
const lnAt = nvAt + 2;
const dropAnswers = [
  ["bad_magic", hex(patch(a, 3, 0x4d))],
  ["other_wire_version", hex(patch(a, 4, 9))],
  ["wrong_type_question", hex(patch(a, 5, 1))],
  ["too_short", hex(a.slice(0, 18))],
  ["port_zero", hex(cat(a.slice(0, 14), [0, 0], a.slice(16)))],
  ["players_over_max", hex(patch(a, 16, 9))],
  ["max_zero", hex(patch(patch(a, 17, 0), 16, 0))],
  ["game_id_over_limit", hex(cat(a.slice(0, 19), [65], fill(65, 0x61), a.slice(19 + 17)))],
  ["net_version_over_limit", hex(cat(a.slice(0, nvAt), [33], fill(33, 0x61), a.slice(lnAt)))],
  ["net_version_empty", hex(cat(a.slice(0, nvAt), [0], a.slice(lnAt)))],
  ["lobby_name_over_limit", hex(cat(a.slice(0, lnAt), [73], fill(73, 0x61), a.slice(lnAt + 11)))],
  ["string_runs_past_end", hex(a.slice(0, a.length - 1))],
  ["trailing_byte", hex(cat(a, [0]))],
  ["host_name_bad_utf8", hex(cat(a.slice(0, a.length - 4), [3, 0xff, 0xfe, 0xfd]))],
  ["padded_to_600_bytes", hex(cat(a, new Uint8Array(600 - a.length)))],
].map(([name, h]) => ({ name, hex: h }));

for (const d of dropQuestions) if (L.decodeQuestion(unhex(d.hex))) throw new Error("question should drop: " + d.name);
for (const d of dropAnswers) if (L.decodeAnswer(unhex(d.hex))) throw new Error("answer should drop: " + d.name);
for (const d of questions) if (!L.decodeQuestion(unhex(d.hex))) throw new Error("question should decode: " + d.name);
for (const d of answers) if (!L.decodeAnswer(unhex(d.hex))) throw new Error("answer should decode: " + d.name);

const sources = ["127.0.0.1", "127.255.0.9", "10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.1.20", "169.254.7.7", "172.15.0.1", "172.32.0.1", "8.8.8.8", "100.64.0.1", "192.169.0.1", "::1", "fe80::1", "300.1.1.1", ""];
const sourceClasses = sources.map((ip) => ({ ip, class: L.sourceClass(ip) }));

const hostRules = [
  ["good_loopback", "com.example.ants", "127.0.0.1", hex(q), "answer"],
  ["good_private", "com.example.ants", "192.168.1.20", hex(q), "answer"],
  ["good_link_local", "com.example.ants", "169.254.7.7", hex(q), "answer"],
  ["public_source", "com.example.ants", "8.8.8.8", hex(q), "bad_source"],
  ["cgnat_source_is_public", "com.example.ants", "100.64.0.1", hex(q), "bad_source"],
  ["other_game_id", "com.example.bees", "127.0.0.1", hex(q), "wrong_game"],
  ["bad_magic", "com.example.ants", "127.0.0.1", dropQuestions[0].hex, "malformed"],
  ["too_long", "com.example.ants", "127.0.0.1", dropQuestions[9].hex, "malformed"],
  ["public_and_malformed_is_bad_source", "com.example.ants", "8.8.8.8", dropQuestions[0].hex, "bad_source"],
].map(([name, ownGameId, source, h, expect]) => ({ name, ownGameId, source, question: h, expect }));

const ans = (o) => hex(L.encodeAnswer({ ...baseAnswer, ...o }));
const finderRules = [
  ["same_version", "3", hex(n1), "192.168.1.20", ans({}), "ok"],
  ["other_version", "4", hex(n1), "192.168.1.20", ans({}), "other_version"],
  ["wrong_nonce", "3", hex(n2), "192.168.1.20", ans({}), "wrong_nonce"],
  ["other_game_id", "3", hex(n1), "192.168.1.20", ans({ gameId: "com.example.bees" }), "wrong_game"],
  ["public_source", "3", hex(n1), "8.8.8.8", ans({}), "bad_source"],
  ["loopback_source", "3", hex(n1), "127.0.0.1", ans({}), "ok"],
  ["malformed", "3", hex(n1), "192.168.1.20", dropAnswers[0].hex, "malformed"],
].map(([name, ownNetVersion, sent, source, h, expect]) => ({ name, ownGameId: "com.example.ants", ownNetVersion, sentNonces: [sent], source, answer: h, expect }));

const out = {
  description: "Vectors for spec/lan-discovery.md. All hex is lowercase. questions / answers: encode(fields) = hex and decode(hex) = fields. dropQuestions / dropAnswers: decode returns nothing. sourceClasses: class null = public (or not IPv4). hostRules: a host with ownGameId and a lobby open, no rate state, given the question from source: expect \"answer\" or the drop counter. finderRules: a finder with ownGameId, ownNetVersion and sentNonces given the answer from source: expect \"ok\", \"other_version\" (kept, marked) or the drop reason. A host checks in the order source, decode, game id; a finder in the order decode, source, nonce, game id.",
  constants: { magic: "OLAN", wireVersion: 1, maxDatagram: L.MAX_DATAGRAM, defaultPort: L.DEFAULT_PORT, limits: L.LIMITS },
  questions, answers, dropQuestions, dropAnswers, sourceClasses, hostRules, finderRules,
};
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "vectors", "lan-discovery.json"), JSON.stringify(out, null, 2) + "\n");
console.log("wrote", questions.length, "questions,", answers.length, "answers,", dropQuestions.length + dropAnswers.length, "drops");
