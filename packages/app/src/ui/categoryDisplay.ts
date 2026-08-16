/**
 * Category → icon/label mapping. Deliberately platform-FREE (no React, no
 * native icon imports) so the selection rules are directly testable — the
 * same split as crypto/storedEnvelope.ts. bits.tsx renders what this decides.
 */
import { theme } from "./theme";

/** Ionicons glyph name; typed loosely here to avoid importing the native lib. */
export interface IconSpec {
  icon: string;
  bg: string;
  fg: string;
}

/**
 * Keyed by BOTH our friendly labels (manual entries, where the user types
 * "Groceries") and Plaid's PERSONAL_FINANCE_CATEGORY vocabulary (bank feeds,
 * which send FOOD_AND_DRINK). Lookup normalizes, so "Food & Drinks",
 * "food_and_drink", and "FOOD_AND_DRINK" all land here — before this, every
 * aggregator transaction silently used the generic icon.
 */
const CATEGORY_ICONS: Record<string, IconSpec> = {
  groceries: { icon: "cart", bg: "#dcfce7", fg: theme.primaryDark },
  income: { icon: "briefcase", bg: "#d1fae5", fg: theme.primaryDeep },
  housing: { icon: "home", bg: "#e0f2fe", fg: "#0369a1" },
  entertainment: { icon: "tv", bg: "#fee2e2", fg: "#b91c1c" },
  transport: { icon: "car", bg: "#ede9fe", fg: "#6d28d9" },
  transportation: { icon: "car", bg: "#ede9fe", fg: "#6d28d9" },
  travel: { icon: "airplane", bg: "#e0e7ff", fg: "#4338ca" },
  utilities: { icon: "flash", bg: "#fef3c7", fg: theme.amber },
  shopping: { icon: "bag-handle", bg: "#ffedd5", fg: "#c2410c" },
  general_merchandise: { icon: "bag-handle", bg: "#ffedd5", fg: "#c2410c" },
  "food & drinks": { icon: "restaurant", bg: "#fee2e2", fg: "#b91c1c" },
  food_and_drink: { icon: "restaurant", bg: "#fee2e2", fg: "#b91c1c" },
  coffee: { icon: "cafe", bg: "#fef3c7", fg: theme.amber },
  loan_payments: { icon: "trending-down", bg: "#fee2e2", fg: "#b91c1c" },
  rent_and_utilities: { icon: "home", bg: "#e0f2fe", fg: "#0369a1" },
  medical: { icon: "medkit", bg: "#fee2e2", fg: "#b91c1c" },
  personal_care: { icon: "sparkles", bg: "#fce7f3", fg: "#be185d" },
  transfer_in: { icon: "arrow-down", bg: "#d1fae5", fg: theme.primaryDeep },
  transfer_out: { icon: "arrow-up", bg: "#fee2e2", fg: "#b91c1c" },
  bank_fees: { icon: "card", bg: "#fef3c7", fg: theme.amber },
  government_and_non_profit: { icon: "business", bg: "#e0e7ff", fg: "#4338ca" },
};

export const FALLBACK_ICON: IconSpec = { icon: "card", bg: theme.chipBg, fg: theme.slate };

/** "Food & Drinks" and "FOOD_AND_DRINK" resolve to the same icon. */
export function iconSpecFor(category?: string): IconSpec {
  if (!category) return FALLBACK_ICON;
  const key = category.trim().toLowerCase();
  return CATEGORY_ICONS[key] ?? CATEGORY_ICONS[key.replace(/[\s&]+/g, "_")] ?? FALLBACK_ICON;
}

/**
 * Aggregator categories arrive SHOUTING in snake_case (FOOD_AND_DRINK).
 * Manual ones are already human ("Groceries"). Render both readably without
 * touching the stored value — the raw category stays the source fact.
 */
export function humanizeCategory(category: string): string {
  if (!/_/.test(category) && category !== category.toUpperCase()) return category;
  return category
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((word) => (word === "and" ? "&" : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}
