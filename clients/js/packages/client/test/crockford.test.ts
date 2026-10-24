import { describe, expect, it } from "vitest";
import { decodeCrockford, encodeCrockford, formatCode, normalizeCode } from "../src/index.js";
import { specJson } from "./spec.js";

const codes = specJson("codes.json");

describe("Crockford codes (spec/codes.json)", () => {
  for (const v of codes.valid) {
    it(`accepts ${JSON.stringify(v.input)}`, () => {
      expect(normalizeCode(v.input)).toBe(v.canonical);
    });
  }
  for (const v of codes.invalid) {
    it(`rejects ${JSON.stringify(v.input)} (${v.why})`, () => {
      expect(normalizeCode(v.input)).toBeNull();
    });
  }
  it("formats 3+3", () => {
    expect(formatCode("7hq4k2")).toBe("7HQ 4K2");
  });
  it("decodes and encodes numeric values", () => {
    expect(decodeCrockford("0")).toBe(0n);
    expect(decodeCrockford("10")).toBe(32n);
    expect(decodeCrockford("zz")).toBe(1023n);
    expect(decodeCrockford("iL1o0")).toBe(decodeCrockford("11100"));
    expect(encodeCrockford(decodeCrockford("7HQ4K2"), 6)).toBe("7HQ4K2");
    expect(() => decodeCrockford("U")).toThrow();
  });
});
