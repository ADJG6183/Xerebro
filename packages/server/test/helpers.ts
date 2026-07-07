import type { PlaidGateway, PlaidSyncPage, PlaidTransaction } from "../src/plaid/gateway.js";
import { InMemoryEventStore } from "../src/eventStore.js";
import { InMemoryItemStore, InMemoryTxnRegistry } from "../src/plaid/stores.js";
import type { AppDeps } from "../src/app.js";
import { DEV_TRUST_ALL_VERIFIER } from "../src/app.js";

export function plaidTxn(overrides: Partial<PlaidTransaction> & { transaction_id: string }): PlaidTransaction {
  return {
    account_id: "plaid-acc-1",
    amount: 12.4, // float dollars, positive = outflow (Plaid convention)
    iso_currency_code: "USD",
    pending: false,
    pending_transaction_id: null,
    date: "2026-07-07",
    authorized_date: null,
    name: "MERCHANT",
    personal_finance_category: { primary: "FOOD_AND_DRINK" },
    ...overrides,
  };
}

export function page(partial: Partial<PlaidSyncPage>, next_cursor: string, has_more = false): PlaidSyncPage {
  return { added: [], modified: [], removed: [], next_cursor, has_more, ...partial };
}

/** Scripted gateway: returns pages keyed by cursor; records calls. */
export class FakePlaidGateway implements PlaidGateway {
  readonly calls: string[] = [];
  constructor(private readonly pages: Record<string, PlaidSyncPage>) {}
  async transactionsSync(_token: string, cursor: string): Promise<PlaidSyncPage> {
    this.calls.push(cursor);
    const page = this.pages[cursor];
    if (!page) throw new Error(`fake gateway: no page scripted for cursor "${cursor}"`);
    return page;
  }
}

export async function makeDeps(pages: Record<string, PlaidSyncPage>): Promise<AppDeps> {
  let eventCounter = 0;
  const items = new InMemoryItemStore();
  await items.put({ itemId: "item-1", userId: "user-1", accessTokenRef: "tok-ref", cursor: "" });
  return {
    plaid: new FakePlaidGateway(pages),
    events: new InMemoryEventStore(),
    items,
    registry: new InMemoryTxnRegistry(),
    now: () => "2026-07-07T12:00:00.000Z",
    newEventId: () => `evt-${++eventCounter}`,
    webhookVerifier: DEV_TRUST_ALL_VERIFIER,
  };
}
