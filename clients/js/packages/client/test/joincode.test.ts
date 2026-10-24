import { describe, expect, it } from "vitest";
import { decodeJoinCode, encodeJoinCode, looksLikeJoinCode } from "../src/joincode.js";
import { parseDirectAddress } from "../src/direct-address.js";
import { specJson } from "./spec.js";

const v = specJson("vectors/joincode.json");

describe("dc1 join codes (spec/vectors/joincode.json)", () => {
  it("valid vectors encode and decode", () => {
    for (const c of v.valid) {
      expect(encodeJoinCode(c.ip, c.port)).toBe(c.code);
      expect(decodeJoinCode(c.code)).toEqual({ ip: c.ip, port: c.port });
    }
  });
  it("aliases decode", () => {
    for (const a of v.aliases) expect(decodeJoinCode(a.input)).toEqual({ ip: a.ip, port: a.port });
  });
  it("invalid vectors fail with their error", () => {
    for (const a of v.invalid) expect(decodeJoinCode(a.input)).toEqual({ error: a.error });
  });
  it("every single-character typo is caught", () => {
    expect(v.singleTypos.inputs.length).toBe(11 * 31);
    for (const t of v.singleTypos.inputs) expect("error" in decodeJoinCode(t)).toBe(true);
  });
  it("tells codes from addresses", () => {
    expect(looksLikeJoinCode("6B01-RGFE-P2B")).toBe(true);
    expect(looksLikeJoinCode("6b01 rgfe p2x")).toBe(true);
    expect(looksLikeJoinCode("192.168.1.20")).toBe(false);
    expect(looksLikeJoinCode("mypc")).toBe(false);
  });
});

describe("direct addresses", () => {
  it.each([
    ["192.168.1.20", 47810, "192.168.1.20:47810", "192.168.1.20"],
    [" 192.168.1.20:5000 ", 47810, "192.168.1.20:5000", "192.168.1.20"],
    ["ws://203.0.113.7:47810/", 47810, "203.0.113.7:47810", "203.0.113.7"],
    ["[2001:db8::1]:5000", 47810, "[2001:db8::1]:5000", "2001:db8::1"],
    ["2001:db8::1", 47810, "[2001:db8::1]:47810", "2001:db8::1"],
    ["my-pc.tailnet.ts.net:47811", 47810, "my-pc.tailnet.ts.net:47811", "my-pc.tailnet.ts.net"],
  ])("%s", (input, def, display, host) => {
    const a = parseDirectAddress(input, def);
    expect(a && `${a.display}`).toBe(display);
    expect(a?.host).toBe(host);
  });
  it.each(["", "1.2.3.4:0", "1.2.3.4:70000", "1.2.3.4:abc", "[::1", "bad host!"])("rejects %j", (input) => {
    expect(parseDirectAddress(input, 47810)).toBeNull();
  });
});
