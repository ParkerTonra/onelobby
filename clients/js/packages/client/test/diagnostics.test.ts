import { describe, expect, it } from "vitest";
import { specJson } from "./spec.js";
import {
  CAUSE_TEXT,
  NetLog,
  STAGE_TEXT,
  checkVerdict,
  classifyNat,
  cleanReport,
  diagnose,
  explainCause,
  hostLine,
  maskText,
  stageOf,
} from "../src/internals.js";
import { bytesOf, hexOf, parseStunResponse, stunBindingRequest } from "../src/connection-check.js";

const V = specJson("vectors/diagnostics.json");

describe("diagnostics vectors: causes and stages", () => {
  it("the cause table matches the vectors text for text", () => {
    expect(Object.keys(CAUSE_TEXT).sort()).toEqual(V.causes.map((c: any) => c.code).sort());
    for (const c of V.causes) expect(CAUSE_TEXT[c.code as keyof typeof CAUSE_TEXT], c.code).toEqual({ message: c.message, hint: c.hint, hostHint: c.hostHint, short: c.short });
  });
  it("stage text and the reached to stage table match", () => {
    expect(STAGE_TEXT).toEqual(V.stageText);
    for (const [reached, stage] of Object.entries(V.stageOf)) expect(stageOf(reached as any), reached).toBe(stage);
  });
});

describe("diagnostics vectors: diagnose", () => {
  for (const c of V.diagnose) {
    it(c.name, () => expect(diagnose(c.facts)).toEqual(c.expect));
  }
  it("host lines", () => {
    for (const c of V.hostLine) expect(hostLine(c.input.name, c.input.cause, c.input.stage, c.input.elapsedMs)).toBe(c.expect);
  });
  it("sentences built from a report", () => {
    for (const c of V.explain) {
      const e = explainCause(c.input.cause, { stage: c.input.stage, elapsedMs: c.input.elapsedMs, mine: c.input.mine, theirs: c.input.theirs });
      expect({ message: e.message, hint: e.hint, hostHint: e.hostHint }, JSON.stringify(c.input)).toEqual(c.expect);
    }
  });
});

describe("diagnostics vectors: masking and the log", () => {
  for (const c of V.mask) {
    it(c.name, () => {
      expect(maskText(c.input, false)).toBe(c.masked);
      expect(maskText(c.input, true)).toBe(c.included);
    });
  }

  it("export format, masked and with addresses", () => {
    let now = 0;
    const log = new NetLog({ clock: { now: () => now }, meta: V.export.meta, raw: true, capacity: 10 });
    for (const e of V.export.entries) {
      now = e.t;
      log.add(e.kind, e.text, { addr: e.addr, code: e.code });
    }
    // the log's clock starts at its creation (0 here), so t is the entry's own time
    expect(log.export()).toBe(V.export.masked);
    expect(log.export({ includeAddresses: true })).toBe(V.export.included);
  });

  it("the ring drops the oldest and the sequence keeps counting", () => {
    const log = new NetLog({ capacity: V.ring.capacity });
    for (let i = 1; i <= V.ring.add.count; i++) log.add(V.ring.add.kind, V.ring.add.text.replace("{i}", String(i)));
    expect(log.entries.length).toBe(V.ring.expect.kept);
    expect(log.dropped).toBe(V.ring.expect.dropped);
    expect(log.entries[0].seq).toBe(V.ring.expect.firstSeq);
    expect(log.entries.at(-1)!.seq).toBe(V.ring.expect.lastSeq);
    expect(log.export().split("\n")[2]).toBe(V.ring.expect.headerEntries);
  });

  it("the default capacity is 500 and a game's value is clamped to 50..5000", () => {
    const n = (c?: number) => {
      const l = new NetLog({ capacity: c });
      for (let i = 0; i < 6000; i++) l.add("info", "x");
      return l.entries.length;
    };
    expect([n(), n(10), n(100000), n(120)]).toEqual([500, 50, 5000, 120]);
  });

  it("entry text is cut at 200 characters", () => {
    const log = new NetLog();
    log.add("info", "x".repeat(300));
    expect(log.entries[0].text.length).toBe(200);
  });

  it("an address in the text is masked even though a client should keep it in addr", () => {
    const log = new NetLog();
    log.add("info", "reached 10.1.2.3:5555 and 2001:db8::7 and turn credential=abc");
    const out = log.export();
    expect(out).not.toMatch(/10\.1\.2\.3|2001:db8|abc/);
    expect(log.export({ includeAddresses: true })).not.toMatch(/credential=abc/);
  });
});

describe("diagnostics vectors: report", () => {
  it("the limits are the spec's", () => {
    expect(V.report.maxFrameBytes).toBe(1024);
    expect(V.report.perMinute).toBe(3);
  });
  for (const c of V.report.valid) it(`valid: ${c.name}`, () => expect(cleanReport(c.input)).toEqual(c.output));
  for (const c of V.report.invalid) it(`invalid: ${c.name}`, () => expect(cleanReport(c.input)).toBeNull());
  it("key order of a rebuilt report follows the spec", () => {
    const r = cleanReport(V.report.valid[1].input)!;
    expect(Object.keys(r)).toEqual(["cause", "stage", "elapsedMs", "relaySet", "natType", "candidateTypes", "clientVersion"]);
  });
});

describe("diagnostics vectors: connection check", () => {
  for (const c of V.check.verdict) it(`verdict: ${c.name}`, () => expect(checkVerdict(c.input)).toEqual({ verdict: c.verdict, message: c.message }));
  for (const c of V.check.classify) it(`classify: ${c.name}`, () => expect(classifyNat(c.asked, c.answers, c.local)).toEqual(c.expect));
  it("STUN request and response bytes", () => {
    const tid = bytesOf(V.stun.request.transactionId);
    expect(hexOf(stunBindingRequest(tid))).toBe(V.stun.request.bytes);
    for (const r of V.stun.responses) expect(parseStunResponse(bytesOf(r.bytes), bytesOf(r.transactionId)), r.name).toEqual(r.expect);
  });
});
