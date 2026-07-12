import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseDollarsToMinor, parseLocalDate } from "../src/data/money";

describe("parseDollarsToMinor (the UI integer boundary)", () => {
  it("parses dollars and cents with integer math", () => {
    expect(parseDollarsToMinor("600")).toBe(60_000);
    expect(parseDollarsToMinor("$1,234.56")).toBe(123_456);
    expect(parseDollarsToMinor("0.09")).toBe(9);
    expect(parseDollarsToMinor("  12.5 ")).toBe(1_250); // one decimal → tenths
    expect(parseDollarsToMinor("1,000,000")).toBe(100_000_000);
  });

  it("rejects junk, negatives, and over-precise input", () => {
    for (const bad of ["", "abc", "-5", "1.234", "$", "1..2", "1,00", "12,3"]) {
      expect(parseDollarsToMinor(bad), bad).toBeNull();
    }
  });

  it("PROPERTY: never returns a non-integer, and round-trips whole dollars", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (dollars) => {
        const minor = parseDollarsToMinor(String(dollars));
        expect(minor).toBe(dollars * 100);
        expect(Number.isSafeInteger(minor!)).toBe(true);
      }),
    );
  });

  it("PROPERTY: the classic float trap is impossible here", () => {
    // parseFloat('0.1'+... )*100 would drift; string parsing cannot.
    expect(parseDollarsToMinor("0.10")! + parseDollarsToMinor("0.20")!).toBe(30);
  });
});

describe("parseLocalDate", () => {
  it("accepts real calendar days, rejects malformed or impossible ones", () => {
    expect(parseLocalDate("2026-07-12")).toBe("2026-07-12");
    expect(parseLocalDate("2026-02-30")).toBeNull(); // not a real day
    expect(parseLocalDate("2026-7-1")).toBeNull(); // not zero-padded
    expect(parseLocalDate("garbage")).toBeNull();
  });
});
