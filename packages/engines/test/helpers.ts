import fc from "fast-check";
import type {
  TransactionEvent,
  TransactionPostedPayload,
  EventSource,
} from "../src/events";

let counter = 0;
export function envelope<T extends TransactionEvent["type"], P>(
  type: T,
  payload: P,
  sequence: number,
  source: EventSource = "plaid",
) {
  counter += 1;
  return {
    eventId: `evt-${sequence}-${counter}`,
    sequence,
    type,
    schemaVersion: 1,
    occurredAt: "2026-07-07T00:00:00.000Z",
    source,
    idempotencyKey: `idem-${sequence}-${counter}`,
    payload,
  };
}

export function posted(
  txnId: string,
  amountMinor: number,
  sequence: number,
  overrides: Partial<TransactionPostedPayload> = {},
): TransactionEvent {
  return envelope(
    "TransactionPosted",
    {
      txnId,
      accountId: "acc-1",
      amountMinor,
      currency: "USD",
      status: "posted",
      postedDate: "2026-07-07",
      merchantRaw: `merchant-${txnId}`,
      categorySource: "plaid",
      ...overrides,
    } satisfies TransactionPostedPayload,
    sequence,
  ) as TransactionEvent;
}

/**
 * Arbitrary consistent event log: a set of posts followed by interleaved
 * updates/removes/annotations that reference (mostly) known txnIds.
 */
export const arbEventLog: fc.Arbitrary<TransactionEvent[]> = fc
  .tuple(
    fc.integer({ min: 1, max: 12 }), // number of transactions
    fc.array(
      fc.record({
        kind: fc.constantFrom("update", "remove", "annotate", "unknownRef"),
        target: fc.nat(),
        amount: fc.integer({ min: -500_000, max: 500_000 }),
      }),
      { maxLength: 24 },
    ),
  )
  .map(([nTxns, ops]) => {
    const events: TransactionEvent[] = [];
    let seq = 1;
    for (let i = 0; i < nTxns; i++) {
      events.push(posted(`txn-${i}`, -1000 * (i + 1), seq++));
    }
    for (const op of ops) {
      const txnId = op.kind === "unknownRef" ? `ghost-${op.target}` : `txn-${op.target % nTxns}`;
      if (op.kind === "update") {
        events.push(
          envelope("TransactionUpdated", {
            txnId,
            changes: { amountMinor: op.amount, status: "posted" as const },
          }, seq++) as TransactionEvent,
        );
      } else if (op.kind === "remove") {
        events.push(
          envelope("TransactionRemoved", { txnId, reason: "test" }, seq++) as TransactionEvent,
        );
      } else {
        events.push(
          envelope("TransactionAnnotated", {
            txnId,
            categoryOverride: `cat-${op.target % 5}`,
          }, seq++, "user") as TransactionEvent,
        );
      }
    }
    return events;
  });

/** Deep-comparable plain form (Maps/Sets → sorted objects/arrays). */
export function projectionToPlain(p: {
  transactions: ReadonlyMap<string, unknown>;
  annotations: ReadonlyMap<string, unknown>;
  appliedEventIds: ReadonlySet<string>;
  lastSequence: number;
  warnings: readonly string[];
}) {
  return {
    transactions: Object.fromEntries([...p.transactions.entries()].sort()),
    annotations: Object.fromEntries([...p.annotations.entries()].sort()),
    appliedEventIds: [...p.appliedEventIds].sort(),
    lastSequence: p.lastSequence,
    warnings: [...p.warnings],
  };
}
