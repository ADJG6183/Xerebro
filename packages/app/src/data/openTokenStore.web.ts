/** Web preview: localStorage — dev convenience, not a vault. */
import type { StoredTokens, TokenStore } from "./tokenStore";

const KEY = "xerebro.auth.tokens";

export async function openTokenStore(): Promise<TokenStore> {
  return {
    async get() {
      const raw = globalThis.localStorage?.getItem(KEY);
      return raw ? (JSON.parse(raw) as StoredTokens) : null;
    },
    async set(tokens) {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(tokens));
    },
    async clear() {
      globalThis.localStorage?.removeItem(KEY);
    },
  };
}
