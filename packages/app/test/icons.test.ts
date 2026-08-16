/**
 * Icon selection and category display. The rule under test: a transaction
 * row ALWAYS renders something sensible — a merchant logo when we have one,
 * a category icon when we don't, and a generic icon when we know nothing.
 * (The runtime image-load failure path is handled by onError in bits.tsx;
 * this covers the selection logic that decides what to attempt.)
 */
import { describe, expect, it } from "vitest";
import { humanizeCategory, iconSpecFor } from "../src/ui/categoryDisplay";

describe("category icons", () => {
  it("matches our friendly manual-entry labels", () => {
    expect(iconSpecFor("Groceries").icon).toBe("cart");
    expect(iconSpecFor("groceries").icon).toBe("cart");
    expect(iconSpecFor("Food & Drinks").icon).toBe("restaurant");
  });

  it("ALSO matches Plaid's SHOUTING_SNAKE vocabulary (bank feeds)", () => {
    // Before normalization these all silently fell through to the generic icon.
    expect(iconSpecFor("FOOD_AND_DRINK").icon).toBe("restaurant");
    expect(iconSpecFor("TRANSPORTATION").icon).toBe("car");
    expect(iconSpecFor("TRAVEL").icon).toBe("airplane");
    expect(iconSpecFor("GENERAL_MERCHANDISE").icon).toBe("bag-handle");
    expect(iconSpecFor("LOAN_PAYMENTS").icon).toBe("trending-down");
  });

  it("normalizes spacing, case, and ampersands to the same spec", () => {
    const canonical = iconSpecFor("food_and_drink");
    expect(iconSpecFor("  Food & Drinks  ")).toEqual(canonical);
    expect(iconSpecFor("FOOD_AND_DRINK")).toEqual(canonical);
  });

  it("falls back to a generic icon for unknown or missing categories", () => {
    const generic = iconSpecFor(undefined);
    expect(generic.icon).toBe("card");
    expect(iconSpecFor("SOME_FUTURE_PLAID_CATEGORY")).toEqual(generic);
    expect(iconSpecFor("")).toEqual(generic);
  });
});

describe("category labels", () => {
  it("humanizes aggregator categories without touching human ones", () => {
    expect(humanizeCategory("FOOD_AND_DRINK")).toBe("Food & Drink");
    expect(humanizeCategory("TRANSPORTATION")).toBe("Transportation");
    expect(humanizeCategory("GENERAL_MERCHANDISE")).toBe("General Merchandise");
    // Already human — left exactly as the user typed it.
    expect(humanizeCategory("Groceries")).toBe("Groceries");
    expect(humanizeCategory("Blue Bottle run")).toBe("Blue Bottle run");
  });
});
