/**
 * The seam between Xerebro and Plaid (docs/adr/ADR-002-stack.md: the
 * anti-corruption layer keeps the vendor swappable).
 *
 * These are OUR types for the boundary, not Plaid SDK types — "never trust
 * external APIs" (docs/engineeringPrinciples.md) starts with not letting a
 * vendor's type system leak into ours. httpGateway.ts implements this
 * interface against the real API; tests use a scripted fake.
 *
 * Plaid conventions preserved here, translated in acl.ts:
 *  - amounts are FLOAT DOLLARS, positive = money OUT
 *  - a pending charge that posts shows up as `removed` (the pending id)
 *    plus `added` (a new id carrying pending_transaction_id)
 */
export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  /** Float dollars; positive = outflow. Converted to signed integer cents in the ACL. */
  amount: number;
  iso_currency_code: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
  date: string; // YYYY-MM-DD
  authorized_date: string | null;
  name: string;
  /** Cleaned merchant name; absent for merchants Plaid can't resolve. */
  merchant_name?: string | null;
  logo_url?: string | null;
  /** Some accounts report only an unofficial currency code. */
  unofficial_currency_code?: string | null;
  /** online | in store | other — how the money moved. */
  payment_channel?: string | null;
  personal_finance_category?: {
    primary: string;
    detailed?: string | null;
    /** VERY_HIGH | HIGH | MEDIUM | LOW — Plaid tells us when it's guessing. */
    confidence_level?: string | null;
  } | null;
}

export interface PlaidSyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
  next_cursor: string;
  has_more: boolean;
}

/** Account metadata + balances, as accounts/balance/get returns them. */
export interface PlaidAccount {
  account_id: string;
  name: string;
  mask: string | null;
  type: string; // depository | credit | loan | investment
  subtype: string | null;
  balances: {
    /** Float dollars; null when the institution doesn't report it. */
    current: number | null;
    available: number | null;
    iso_currency_code: string | null;
  };
}

export interface PlaidGateway {
  /** transactions/sync for one item from the given cursor ("" = from scratch). */
  transactionsSync(accessTokenRef: string, cursor: string): Promise<PlaidSyncPage>;
  /** Current balances for an item's accounts. Optional: the fake gateways in
   * tests implement only what they exercise. */
  accountsBalanceGet?(accessTokenRef: string): Promise<PlaidAccount[]>;
}

/** Link-token issuing + public-token exchange — the connection handshake.
 * Separate from PlaidGateway because the ACL never needs it. */
export interface PlaidLinkGateway {
  createLinkToken(userId: string): Promise<{
    linkToken: string;
    expiration: string;
    /** Plaid-hosted Link page; present when hosted_link was requested. The
     * app opens THIS rather than constructing a URL itself. */
    hostedLinkUrl?: string;
  }>;
  /** Exchange the short-lived public token from Link for a durable access
   * token. The access token is a SECRET: it never leaves the server
   * (docs/SecurityPrivacy.md). */
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  /**
   * Ask Plaid whether a Hosted Link session finished, and get its public
   * token. Needed because Hosted Link without a registered redirect URI
   * shows its OWN completion screen and never returns to the app — polling
   * is the only way to learn the user succeeded. */
  getLinkSessionPublicToken?(linkToken: string): Promise<string | null>;
}
