/**
 * Balance sync: Plaid account balances → AccountUpserted events
 * (docs/EventArchitecture.md notes AccountUpserted with source "plaid"
 * carries aggregator metadata "when balance sync lands" — this is it).
 *
 * Why it matters beyond display: verification's freshness window scores
 * `balanceAsOf` on aggregator accounts (docs/verificationEngine.md). Without
 * balance events there is nothing to score, which is why the refresh-race
 * has so far only been exercised against seeded data.
 *
 * Same anti-corruption discipline as transactions: Plaid's float dollars and
 * type vocabulary die here, converted to integer minor units and our own
 * account types.
 */
import type { Account, AccountType } from "@xerebro/engines";
import type { UnsequencedEvent } from "../eventStore";
import { accessTokenOf, type AclDeps } from "./acl";
import type { PlaidAccount } from "./gateway";

/** Plaid type/subtype → our AccountType (docs/DataModel.md). */
export function toAccountType(plaidType: string, subtype: string | null): AccountType {
  if (plaidType === "credit") return "credit";
  if (plaidType === "loan") return "loan";
  if (plaidType === "investment") return "investment";
  if (plaidType === "depository") {
    if (subtype === "savings") return "savings";
    if (subtype === "cash management" || subtype === "prepaid") return "cash";
    return "checking";
  }
  return "cash"; // unknown types are treated as plain cash, never dropped
}

/** Float dollars → integer minor units; null stays null. */
function toMinor(dollars: number | null): number | undefined {
  return dollars === null ? undefined : Math.round(dollars * 100);
}

export function toAccountEvent(
  plaidAccount: PlaidAccount,
  itemId: string,
  observedAt: string,
): Account {
  const current = toMinor(plaidAccount.balances.current) ?? 0;
  const available = toMinor(plaidAccount.balances.available);
  return {
    accountId: plaidAccount.account_id,
    type: toAccountType(plaidAccount.type, plaidAccount.subtype),
    source: "plaid",
    name: plaidAccount.name,
    currency: plaidAccount.balances.iso_currency_code ?? "USD",
    balanceCurrentMinor: current,
    ...(available !== undefined ? { balanceAvailableMinor: available } : {}),
    // The freshness anchor: when WE observed it, which is what verification
    // scores. Plaid doesn't promise a per-balance timestamp.
    balanceAsOf: observedAt,
    status: "active",
    plaidItemId: itemId,
  };
}

export interface BalanceSyncOutcome {
  accounts: number;
  appended: number;
}

/**
 * Fetch balances for an item and append one AccountUpserted per account.
 * Idempotent per (item, observation): the batch key includes the timestamp,
 * so a repeated call in the same second appends nothing.
 */
export async function syncPlaidBalances(
  deps: AclDeps,
  itemId: string,
): Promise<BalanceSyncOutcome> {
  const item = await deps.items.get(itemId);
  if (!item) throw new Error(`unknown plaid item ${itemId}`);
  if (!deps.plaid.accountsBalanceGet) return { accounts: 0, appended: 0 };

  const observedAt = deps.now();
  const accounts = await deps.plaid.accountsBalanceGet(accessTokenOf(deps, item));

  const events: UnsequencedEvent[] = accounts.map((plaidAccount) => {
    const eventId = deps.newEventId();
    return {
      eventId,
      type: "AccountUpserted",
      schemaVersion: 1,
      occurredAt: observedAt,
      source: "plaid",
      idempotencyKey: `plaid-balance:${plaidAccount.account_id}:${observedAt}`,
      payload: toAccountEvent(plaidAccount, itemId, observedAt),
    };
  });

  if (events.length === 0) return { accounts: 0, appended: 0 };
  const result = await deps.events.appendBatch(
    item.userId,
    events,
    `plaid-balances:${itemId}:${observedAt}`,
  );
  return { accounts: accounts.length, appended: result.appended.length };
}
