/**
 * Small persistence interfaces the ACL depends on, with in-memory reference
 * implementations (Postgres adapters come with the persistence milestone).
 */

export interface PlaidItem {
  itemId: string;
  userId: string;
  /** Opaque reference — the actual access token lives in encrypted storage
   * server-side only (docs/SecurityPrivacy.md). */
  accessTokenRef: string;
  cursor: string;
}

export interface ItemStore {
  get(itemId: string): Promise<PlaidItem | undefined>;
  put(item: PlaidItem): Promise<void>;
  setCursor(itemId: string, cursor: string): Promise<void>;
}

/**
 * Remembers which user a link token was issued to, so /plaid/complete can
 * refuse a token that isn't the caller's. Without this, anyone holding a
 * link token could complete someone else's bank connection into their own
 * account (docs/SecurityPrivacy.md).
 *
 * Deliberately in-memory: link tokens expire in ~4h, so a restart only means
 * the user re-links. That is a far better failure mode than a new table.
 */
export interface LinkTokenOwners {
  remember(linkToken: string, userId: string): Promise<void>;
  ownerOf(linkToken: string): Promise<string | undefined>;
}

/** Link tokens Plaid issues are valid ~4h; forget ours a little after that. */
const LINK_TOKEN_TTL_MS = 5 * 60 * 60 * 1000;

export class InMemoryLinkTokenOwners implements LinkTokenOwners {
  private readonly owners = new Map<string, { userId: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async remember(linkToken: string, userId: string) {
    this.sweep();
    this.owners.set(linkToken, { userId, expiresAt: this.now() + LINK_TOKEN_TTL_MS });
  }

  async ownerOf(linkToken: string) {
    const entry = this.owners.get(linkToken);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.owners.delete(linkToken);
      return undefined;
    }
    return entry.userId;
  }

  /** Bounded memory: drop expired entries whenever we add one. */
  private sweep() {
    const now = this.now();
    for (const [token, entry] of this.owners) {
      if (entry.expiresAt <= now) this.owners.delete(token);
    }
  }
}

/**
 * Which canonical transaction ids a user already has, plus the alias from a
 * posted Plaid id back to the canonical (originally pending) id. Needed for
 * the pending→posted rewrite (docs/adr/ADR-003-events.md).
 */
export interface TxnRegistry {
  has(userId: string, txnId: string): Promise<boolean>;
  add(userId: string, txnId: string): Promise<void>;
  aliasFor(userId: string, plaidId: string): Promise<string | undefined>;
  addAlias(userId: string, plaidId: string, canonicalId: string): Promise<void>;
}

export class InMemoryItemStore implements ItemStore {
  private readonly items = new Map<string, PlaidItem>();
  async get(itemId: string) {
    return this.items.get(itemId);
  }
  async put(item: PlaidItem) {
    // Ownership is immutable — mirrors the Postgres adapter's guarded upsert.
    const existing = this.items.get(item.itemId);
    if (existing && existing.userId !== item.userId) return;
    this.items.set(item.itemId, { ...item });
  }
  async setCursor(itemId: string, cursor: string) {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`unknown plaid item ${itemId}`);
    item.cursor = cursor;
  }
}

export class InMemoryTxnRegistry implements TxnRegistry {
  private readonly known = new Map<string, Set<string>>();
  private readonly aliases = new Map<string, Map<string, string>>();

  async has(userId: string, txnId: string) {
    return this.known.get(userId)?.has(txnId) ?? false;
  }
  async add(userId: string, txnId: string) {
    let set = this.known.get(userId);
    if (!set) this.known.set(userId, (set = new Set()));
    set.add(txnId);
  }
  async aliasFor(userId: string, plaidId: string) {
    return this.aliases.get(userId)?.get(plaidId);
  }
  async addAlias(userId: string, plaidId: string, canonicalId: string) {
    let map = this.aliases.get(userId);
    if (!map) this.aliases.set(userId, (map = new Map()));
    map.set(plaidId, canonicalId);
  }
}
