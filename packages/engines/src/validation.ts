/**
 * Event-payload validation — the poison-pill defense (docs/adr/ADR-003).
 *
 * The event log is append-only: a malformed event that gets in can never be
 * removed, and a fold that THROWS on it would brick every reader forever.
 * Defense in two layers, one vocabulary:
 *  - the server validates at the door (POST /events → 400, nothing appended);
 *  - the folds validate on read: skip-and-warn, never throw (survive
 *    anything history already contains).
 *
 * The universal rule: any key ending in "Minor" is money and MUST be a safe
 * integer — enforced by a deep scan, so nested money (audit records,
 * tradeoffs) is covered without per-type ceremony. Fold-critical types get
 * structural checks on top.
 */

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isSafeIntOrAbsent(v: unknown): boolean {
  return v === undefined || (typeof v === "number" && Number.isSafeInteger(v));
}

/** Deep scan: every *Minor key anywhere in the payload must be integer money. */
export function findMoneyViolations(value: unknown, path = "payload"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findMoneyViolations(v, `${path}[${i}]`));
  }
  if (value === null || typeof value !== "object") return [];
  const violations: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (key.endsWith("Minor")) {
      if (!(typeof v === "number" && Number.isSafeInteger(v))) {
        violations.push(`${path}.${key} must be integer minor units (got ${JSON.stringify(v)})`);
        continue;
      }
    }
    violations.push(...findMoneyViolations(v, `${path}.${key}`));
  }
  return violations;
}

const TXN_STATUS = new Set(["pending", "posted"]);

type Shape = Record<string, unknown>;

/** Structural checks for the types the folds depend on. */
function structuralViolations(type: string, p: Shape): string[] {
  const v: string[] = [];
  switch (type) {
    case "TransactionPosted":
      if (!isNonEmptyString(p.txnId)) v.push("txnId must be a non-empty string");
      if (!isNonEmptyString(p.accountId)) v.push("accountId must be a non-empty string");
      if (!Number.isSafeInteger(p.amountMinor)) v.push("amountMinor must be integer minor units");
      if (!TXN_STATUS.has(p.status as string)) v.push(`status must be pending|posted`);
      if (typeof p.merchantRaw !== "string") v.push("merchantRaw must be a string");
      break;
    case "TransactionUpdated": {
      if (!isNonEmptyString(p.txnId)) v.push("txnId must be a non-empty string");
      const changes = p.changes;
      if (changes === null || typeof changes !== "object") {
        v.push("changes must be an object");
      } else {
        const c = changes as Shape;
        if (!isSafeIntOrAbsent(c.amountMinor)) v.push("changes.amountMinor must be integer minor units");
        if (c.status !== undefined && !TXN_STATUS.has(c.status as string)) v.push("changes.status must be pending|posted");
      }
      break;
    }
    case "TransactionRemoved":
    case "TransactionAnnotated":
      if (!isNonEmptyString(p.txnId)) v.push("txnId must be a non-empty string");
      break;
    case "AccountUpserted":
      if (!isNonEmptyString(p.accountId)) v.push("accountId must be a non-empty string");
      if (!Number.isSafeInteger(p.balanceCurrentMinor)) v.push("balanceCurrentMinor must be integer minor units");
      if (!isSafeIntOrAbsent(p.openingBalanceMinor)) v.push("openingBalanceMinor must be integer minor units");
      if (!isNonEmptyString(p.balanceAsOf)) v.push("balanceAsOf must be a timestamp string");
      if (p.source !== "plaid" && p.source !== "manual") v.push("source must be plaid|manual");
      break;
    case "BucketUpserted":
      if (!isNonEmptyString(p.bucketId)) v.push("bucketId must be a non-empty string");
      if (!Number.isSafeInteger(p.allocatedMinor)) v.push("allocatedMinor must be integer minor units");
      break;
    case "BillUpserted":
      if (!isNonEmptyString(p.billId)) v.push("billId must be a non-empty string");
      if (!Number.isSafeInteger(p.expectedAmountMinor)) v.push("expectedAmountMinor must be integer minor units");
      if (!isNonEmptyString(p.nextDue)) v.push("nextDue must be a local date string");
      break;
    default:
      break; // unknown types: money scan only (catalog evolves)
  }
  return v.map((msg) => `${type}: ${msg}`);
}

/** Empty array = valid. */
export function validateEventPayload(type: string, payload: unknown): string[] {
  if (payload === null || typeof payload !== "object") {
    return [`${type}: payload must be an object`];
  }
  return [...structuralViolations(type, payload as Shape), ...findMoneyViolations(payload)];
}
