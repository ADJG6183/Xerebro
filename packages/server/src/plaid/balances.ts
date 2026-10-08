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
import { buildSnapshot, validateEventPayload, type Account, type AccountType } from "@xerebro/engines";
import type { UnsequencedEvent } from "../eventStore";
import { EventSequenceConflict } from "../eventStore";
import { continuityProposals, readHistory } from "../accountContinuity";
import { accessTokenOf, type AclDeps } from "./acl";
import type { PlaidAccount } from "./gateway";

/** Plaid type/subtype → our AccountType (docs/DataModel.md). */
export function toAccountType(plaidType: string, subtype: string | null): AccountType {
  if (plaidType === "credit") return "credit";
  if (plaidType === "loan") return "loan";
  if (plaidType === "investment") return "investment";
  if (plaidType === "depository") {
    if (subtype === "checking") return "checking";
    if (subtype === "savings" || subtype === "money market") return "savings";
    if (subtype === "cash management" || subtype === "prepaid") return "cash";
    // Locked or restricted deposits — cd, hsa, and anything unfamiliar —
    // are NOT spendable today. financialState.ts counts checking/savings/cash
    // toward available cash, so classifying a CD there would inflate the
    // number the purchase-approval rules trust. "investment" keeps it in net
    // worth but out of spendable cash. (Caught against real sandbox data,
    // where Plaid returns a "Plaid CD" depository account.)
    return "investment";
  }
  return "unknown"; // retained for display, never assumed spendable
}

/** Float dollars → integer minor units; null stays null. */
function toMinor(dollars: number | null): number | undefined {
  if (dollars === null) return undefined;
  if (!Number.isFinite(dollars)) throw new TypeError("invalid Plaid balance");
  const minor = Math.round(dollars * 100);
  if (!Number.isSafeInteger(minor)) throw new TypeError("Plaid balance exceeds safe range");
  return minor;
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
    ...(plaidAccount.mask ? { mask: plaidAccount.mask } : {}),
    currency: plaidAccount.balances.iso_currency_code ?? "UNKNOWN",
    balanceCurrentMinor: current,
    ...(plaidAccount.balances.current === null ? { balanceCurrentKnown: false } : {}),
    ...(available !== undefined ? { balanceAvailableMinor: available } : {}),
    // The freshness anchor: when WE observed it, which is what verification
    // scores. Plaid doesn't promise a per-balance timestamp.
    balanceAsOf: observedAt,
    status: "active",
    plaidItemId: itemId,
    reconciliationStatus: "unknown",
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
  if (item.status === "disconnecting" || item.status === "disconnected") {
    throw new Error(`Plaid item ${itemId} is disconnected`);
  }
  if (!deps.plaid.accountsBalanceGet) return { accounts: 0, appended: 0 };

  const observedAt = deps.now();
  const accounts = await deps.plaid.accountsBalanceGet(accessTokenOf(deps, item));
  if (!Array.isArray(accounts)) throw new TypeError("invalid Plaid accounts balance response");

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

  const violations = events.flatMap((event) => validateEventPayload(event.type, event.payload));
  if (violations.length > 0) throw new TypeError(`invalid normalized Plaid account: ${violations[0]}`);

  if (events.length === 0) return { accounts: 0, appended: 0 };
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = buildSnapshot(await readHistory(deps.events, item.userId));
    const latest = await deps.items.get(itemId);
    if (!latest || latest.status === "disconnecting" || latest.status === "disconnected") throw new Error("Bank disconnected during refresh");
    const proposals = continuityProposals(snapshot, events.map((event) => event.payload as Account));
    const reviewEvents: UnsequencedEvent[] = proposals.map((payload) => ({
      eventId: deps.newEventId(), type: "AccountContinuitySet", schemaVersion: 1,
      occurredAt: observedAt, source: "system", idempotencyKey: `account-continuity:${payload.accountId}`, payload,
    }));
    try {
      // Account facts and their guard arrive together, before any transactions.
      const result = await deps.events.appendBatch(item.userId, [...events, ...reviewEvents],
        `plaid-balances:${itemId}:${observedAt}`, snapshot.lastSequence);
      return { accounts: accounts.length, appended: result.appended.length };
    } catch (error) {
      if (!(error instanceof EventSequenceConflict) || attempt === 2) throw error;
    }
  }
  throw new EventSequenceConflict();
}
