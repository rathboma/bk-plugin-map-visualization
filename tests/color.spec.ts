import { describe, expect, it } from "vitest";
import { CATEGORICAL_DARK, CATEGORICAL_LIGHT, hexToHsv, hsvToHex, normalizeHex } from "../src/lib/color";

describe("colour picker helpers", () => {
  it("converts between hex and HSV", () => {
    expect(hexToHsv("#ff0000")).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv("#000000")).toEqual({ h: 0, s: 0, v: 0 });
    expect(hexToHsv("#00ff00").h).toBe(120);
    expect(hsvToHex({ h: 240, s: 1, v: 1 })).toBe("#0000ff");
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe("#ff0000");
    expect(hsvToHex({ h: 200, s: 0, v: 1 })).toBe("#ffffff");
  });

  it("round-trips the palette", () => {
    for (const c of [...CATEGORICAL_LIGHT, ...CATEGORICAL_DARK]) expect(hsvToHex(hexToHsv(c))).toBe(c);
  });

  it("normalizes typed hex values", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex(" 2a78d6 ")).toBe("#2a78d6");
    expect(normalizeHex("#2a78d")).toBeNull();
    expect(normalizeHex("blue")).toBeNull();
  });
});
