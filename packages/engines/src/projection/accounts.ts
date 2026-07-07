/**
 * Account events + fold.
 *
 * Catalog addition (extends docs/EventArchitecture.md): `AccountUpserted`
 * carries the full Account shape (docs/DataModel.md). Manual accounts are
 * created on-device (source "user"); Plaid account metadata/balances will be
 * emitted by the ACL (source "plaid") when balance sync lands. Last write by
 * server sequence wins per account — the fold is deterministic because the
 * event list is ordered.
 */
import type { EventEnvelope } from "../events";
import type { Account } from "../state/financialState";

export type AccountUpserted = EventEnvelope<"AccountUpserted", Account>;

export function isAccountUpserted(event: EventEnvelope): event is AccountUpserted {
  return event.type === "AccountUpserted";
}

export function foldAccounts(events: readonly EventEnvelope[]): Account[] {
  const byId = new Map<string, Account>();
  for (const event of events) {
    if (isAccountUpserted(event)) byId.set(event.payload.accountId, { ...event.payload });
  }
  return [...byId.values()];
}
