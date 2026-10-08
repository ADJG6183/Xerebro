import { describe, expect, it } from "vitest";
import { formatLocalDate } from "../src/data/localDate";

describe("formatLocalDate", () => {
  it("formats the device's local calendar fields instead of the UTC date", () => {
    const localClock = {
      getFullYear: () => 2026,
      getMonth: () => 0,
      getDate: () => 2,
    };

    expect(formatLocalDate(localClock)).toBe("2026-01-02");
  });
});
