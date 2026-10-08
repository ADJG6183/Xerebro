/**
 * The ACL is where aggregator reality meets our invariants — these tests
 * encode the exact failure modes the architecture review flagged: unit/sign
 * translation, pending→posted rewriting, phantom removals, hold releases,
 * (itemId, cursor) idempotency, and multi-page drains.
 *
 * The end-to-end tests fold the ACL's events through the ENGINES' reference
 * projection: the two packages meeting is the point — Plaid's wire format in,
 * correct available-cash math out.
 */
import { describe, expect, it } from "vitest";
import {
  applyEvents,
  emptyProjection,
  effectiveTransactions,
  type TransactionEvent,
} from "@xerebro/engines";
import { syncPlaidItem, toMinorUnits } from "../src/plaid/acl";
import { PlaidApiError } from "../src/plaid/httpGateway";
import { makeDeps, page, plaidTxn } from "./helpers";

async function foldUserLog(deps: Awaited<ReturnType<typeof makeDeps>>) {
  const events = (await deps.events.eventsSince("user-1", 0)) as TransactionEvent[];
  return applyEvents(emptyProjection(), events);
}

describe("unit and sign translation (float dies at the boundary)", () => {
  it("converts Plaid float dollars to signed integer cents, outflow negative", () => {
    expect(toMinorUnits(12.4)).toBe(-1_240); // $12.40 charge
    expect(toMinorUnits(-2400)).toBe(240_000); // $2,400 paycheck (Plaid negative = inflow)
    expect(toMinorUnits(0.1 + 0.2)).toBe(-30); // the classic float trap, rounded away
  });
});

describe("untrusted upstream data", () => {
  it("does not advance the cursor when a transaction is malformed", async () => {
    const deps = await makeDeps({
      "": page(
        { added: [{ ...plaidTxn({ transaction_id: "malformed" }), amount: Number.NaN }] },
        "c1",
      ),
    });

    await expect(syncPlaidItem(deps, "item-1")).rejects.toThrow(/invalid transaction/);
    expect((await deps.items.get("item-1"))?.cursor).toBe("");
    expect(await deps.events.eventsSince("user-1", 0)).toEqual([]);
  });
});

describe("pending → posted (ADR-003: same canonical transaction)", () => {
  it.each(["pending-first", "posted-first"] as const)(
    "resolves both page orderings inside one update: %s",
    async (ordering) => {
      const pending = plaidTxn({ transaction_id: "pend-same-update", pending: true });
      const posted = plaidTxn({
        transaction_id: "post-same-update",
        pending: false,
        pending_transaction_id: "pend-same-update",
        amount: 19.75,
      });
      const first = ordering === "pending-first" ? pending : posted;
      const second = ordering === "pending-first" ? posted : pending;
      const deps = await makeDeps({
        "": page(
          {
            added: [first],
            removed: [{ transaction_id: "pend-same-update" }],
          },
          "c1",
          true,
        ),
        c1: page({ added: [second] }, "c2"),
      });

      await syncPlaidItem(deps, "item-1");

      const projection = await foldUserLog(deps);
      expect(effectiveTransactions(projection)).toEqual([
        expect.objectContaining({
          txnId: "pend-same-update",
          status: "posted",
          amountMinor: -1_975,
        }),
      ]);
      expect(projection.transactions.get("pend-same-update")?.removed).toBe(false);
    },
  );

  it("pairs a removal and posting split across pages of one update", async () => {
    const deps = await makeDeps({
      "": page(
        { added: [plaidTxn({ transaction_id: "pend-cross", pending: true })] },
        "c1",
      ),
      c1: page({ removed: [{ transaction_id: "pend-cross" }] }, "c2", true),
      c2: page(
        {
          added: [
            plaidTxn({
              transaction_id: "post-cross",
              pending: false,
              pending_transaction_id: "pend-cross",
              amount: 14.25,
            }),
          ],
        },
        "c3",
      ),
    });

    await syncPlaidItem(deps, "item-1");
    await syncPlaidItem(deps, "item-1");

    const projection = await foldUserLog(deps);
    const transactions = effectiveTransactions(projection);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      txnId: "pend-cross",
      status: "posted",
      amountMinor: -1_425,
    });
  });

  it("rewrites Plaid's remove+add pair into one TransactionUpdated, no tombstone", async () => {
    const deps = await makeDeps({
      "": page(
        { added: [plaidTxn({ transaction_id: "pend-1", pending: true, amount: 12.4 })] },
        "c1",
      ),
      c1: page(
        {
          added: [
            plaidTxn({
              transaction_id: "post-9",
              pending: false,
              pending_transaction_id: "pend-1",
              amount: 12.9, // posted amount differs (tip added)
              name: "Blue Bottle",
            }),
          ],
          removed: [{ transaction_id: "pend-1" }], // Plaid's phantom removal
        },
        "c2",
      ),
    });

    await syncPlaidItem(deps, "item-1"); // initial page
    await syncPlaidItem(deps, "item-1"); // posting page

    const projection = await foldUserLog(deps);
    const txns = effectiveTransactions(projection);

    expect(txns).toHaveLength(1); // ONE canonical transaction, not remove+add
    expect(txns[0]?.txnId).toBe("pend-1"); // canonical id is the original pending id
    expect(txns[0]?.status).toBe("posted");
    expect(txns[0]?.amountMinor).toBe(-1_290); // updated to the posted amount
    expect(txns[0]?.merchantRaw).toBe("Blue Bottle");
    expect(projection.transactions.get("pend-1")?.removed).toBe(false); // no tombstone
  });

  it("later modifications addressed to the posted Plaid id resolve to the canonical id", async () => {
    const deps = await makeDeps({
      "": page(
        { added: [plaidTxn({ transaction_id: "pend-1", pending: true })] },
        "c1",
      ),
      c1: page(
        {
          added: [
            plaidTxn({ transaction_id: "post-9", pending_transaction_id: "pend-1" }),
          ],
          removed: [{ transaction_id: "pend-1" }],
        },
        "c2",
      ),
      c2: page(
        { modified: [plaidTxn({ transaction_id: "post-9", amount: 15, name: "Enriched Name" })] },
        "c3",
      ),
    });

    await syncPlaidItem(deps, "item-1");
    await syncPlaidItem(deps, "item-1");
    await syncPlaidItem(deps, "item-1");

    const projection = await foldUserLog(deps);
    expect(projection.warnings).toHaveLength(0); // no "unknown txnId" — alias resolved
    expect(projection.transactions.get("pend-1")?.merchantRaw).toBe("Enriched Name");
  });

  it("a hold that never posts becomes a REAL removal (the hotel-hold trace, wire-to-fold)", async () => {
    const deps = await makeDeps({
      "": page(
        { added: [plaidTxn({ transaction_id: "hold-1", pending: true, amount: 150, name: "HOTEL AUTH" })] },
        "c1",
      ),
      c1: page({ removed: [{ transaction_id: "hold-1" }] }, "c2"),
    });

    await syncPlaidItem(deps, "item-1");
    await syncPlaidItem(deps, "item-1");

    const projection = await foldUserLog(deps);
    expect(effectiveTransactions(projection)).toHaveLength(0); // gone from spendable view
    expect(projection.transactions.get("hold-1")?.removed).toBe(true); // tombstone, log intact
  });
});

describe("idempotency on (itemId, cursor) — docs/adr/ADR-003-events.md", () => {
  it("replaying the same webhook appends nothing new", async () => {
    const deps = await makeDeps({
      "": page({ added: [plaidTxn({ transaction_id: "t-1" })] }, "c1"),
      c1: page({}, "c1"), // second drain starts at c1: empty page, same cursor
    });

    const first = await syncPlaidItem(deps, "item-1");
    expect(first.appended).toBe(1);

    const replay = await syncPlaidItem(deps, "item-1"); // webhook delivered twice
    expect(replay.appended).toBe(0);

    expect(await deps.events.lastSequence("user-1")).toBe(1); // exactly one event, ever
  });

  it("rejects has_more without cursor progress and commits none of the update", async () => {
    // A misbehaving aggregator (or a bug) could otherwise spin forever inside
    // a webhook handler. The drain must be bounded, not merely well-behaved.
    const deps = await makeDeps({
      "": page({ added: [plaidTxn({ transaction_id: "t-stuck" })] }, "", true), // same cursor!
    });
    await expect(syncPlaidItem(deps, "item-1")).rejects.toThrow(/cursor did not advance/);
    expect(await deps.events.lastSequence("user-1")).toBe(0);
    expect((await deps.items.get("item-1"))?.cursor).toBe("");
  });

  it("does not advance the cursor when a later page fails", async () => {
    const deps = await makeDeps({
      "": page({ added: [plaidTxn({ transaction_id: "t-before-failure" })] }, "c1", true),
      // c1 intentionally absent: the fake throws before the complete update exists.
    });

    await expect(syncPlaidItem(deps, "item-1")).rejects.toThrow(/no page scripted/);
    expect(await deps.events.lastSequence("user-1")).toBe(0);
    expect((await deps.items.get("item-1"))?.cursor).toBe("");
  });

  it("restarts the complete update after Plaid mutates during pagination", async () => {
    const deps = await makeDeps({});
    const calls: string[] = [];
    let firstPageCalls = 0;
    deps.plaid.transactionsSync = async (_token, cursor) => {
      calls.push(cursor);
      if (cursor === "") {
        firstPageCalls += 1;
        return firstPageCalls === 1
          ? page({ added: [plaidTxn({ transaction_id: "discard-me" })] }, "c1", true)
          : page({ added: [plaidTxn({ transaction_id: "kept" })] }, "c2");
      }
      throw new PlaidApiError(
        "mutated during pagination",
        400,
        "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
      );
    };

    const result = await syncPlaidItem(deps, "item-1");
    expect(result).toMatchObject({ pages: 1, appended: 1 });
    expect(calls).toEqual(["", "c1", ""]);
    const transactions = effectiveTransactions(await foldUserLog(deps));
    expect(transactions.map((txn) => txn.txnId)).toEqual(["kept"]);
  });

  it("drains a multi-page update into one atomic commit", async () => {
    const deps = await makeDeps({
      "": page({ added: [plaidTxn({ transaction_id: "t-1" })] }, "c1", true),
      c1: page({ added: [plaidTxn({ transaction_id: "t-2" })] }, "c2", true),
      c2: page({ added: [plaidTxn({ transaction_id: "t-3" })] }, "c3"),
    });

    const outcome = await syncPlaidItem(deps, "item-1");
    expect(outcome).toEqual({ pages: 3, appended: 3, dedupedPages: 0 });

    const events = await deps.events.eventsSince("user-1", 0);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]); // gapless server order
  });
});
