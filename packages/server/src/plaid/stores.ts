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
