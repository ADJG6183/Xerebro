/**
 * The UI boundary where typed dollars become integer cents — using STRING
 * parsing and integer math only. `parseFloat(text) * 100` would reintroduce
 * the float problem at the exact door the architecture kills it
 * (docs/DataModel.md: money is integer minor units, no floats ever).
 */
const MONEY_RE = /^\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/;

/** "1,234.5" → 123450 ¢; "$600" → 60000 ¢; garbage/negative → null. */
export function parseDollarsToMinor(text: string): number | null {
  const match = text.trim().match(MONEY_RE);
  if (!match) return null;
  const dollars = Number.parseInt(match[1]!.replace(/,/g, ""), 10);
  const centsPart = match[2] ?? "";
  const cents = centsPart.length === 0 ? 0 : Number.parseInt(centsPart.padEnd(2, "0"), 10);
  const minor = dollars * 100 + cents;
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Local dates only, YYYY-MM-DD, and must be a real calendar day. */
export function parseLocalDate(text: string): string | null {
  const t = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const d = new Date(`${t}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? null : t;
}
