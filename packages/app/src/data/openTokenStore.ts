/** Native: iOS Keychain / Android Keystore via expo-secure-store. */
import * as SecureStore from "expo-secure-store";
import type { StoredTokens, TokenStore } from "./tokenStore";

const KEY = "xerebro.auth.tokens";

export async function openTokenStore(): Promise<TokenStore> {
  return {
    async get() {
      const raw = await SecureStore.getItemAsync(KEY);
      return raw ? (JSON.parse(raw) as StoredTokens) : null;
    },
    async set(tokens) {
      await SecureStore.setItemAsync(KEY, JSON.stringify(tokens));
    },
    async clear() {
      await SecureStore.deleteItemAsync(KEY);
    },
  };
}
