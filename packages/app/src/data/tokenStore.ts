/**
 * Where the device keeps its auth tokens. Native: expo-secure-store (iOS
 * Keychain / Android Keystore — the phone's hardware vault, per
 * docs/SecurityPrivacy.md). Web preview: localStorage (dev convenience).
 * InMemoryTokenStore is the test reference.
 */
export interface StoredTokens {
  userId: string;
  deviceId: string;
  accessToken: string;
  refreshToken: string;
}

export interface TokenStore {
  get(): Promise<StoredTokens | null>;
  set(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryTokenStore implements TokenStore {
  private tokens: StoredTokens | null = null;
  async get() {
    return this.tokens;
  }
  async set(tokens: StoredTokens) {
    this.tokens = tokens;
  }
  async clear() {
    this.tokens = null;
  }
}
