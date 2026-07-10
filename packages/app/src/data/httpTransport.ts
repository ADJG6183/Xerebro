/**
 * Authenticated HTTP transport. Identity lives in the token, so no method
 * takes a userId anymore — the server derives it (SecurityPrivacy.md trust
 * boundary).
 *
 * Lifecycle, all invisible to the caller:
 *  - no stored tokens → register an anonymous device account, store the pair
 *    in the platform vault;
 *  - 401 → refresh (rotating the pair) and retry once;
 *  - refresh rejected too → last resort: register a FRESH account. Until
 *    identity linking ships (staged auth, SecurityPrivacy.md), that means a
 *    new empty diary — acceptable for the anonymous stage, impossible to
 *    confuse with data loss because the old account's data still exists
 *    under the old user.
 */
import type { EventEnvelope } from "@xerebro/engines";
import type { SyncTransport } from "./syncClient";
import type { TokenStore } from "./tokenStore";

interface AuthPair {
  userId: string;
  deviceId: string;
  accessToken: string;
  refreshToken: string;
}

export function authedHttpTransport(
  baseUrl: string,
  tokens: TokenStore,
  deviceName = "xerebro-app",
): SyncTransport {
  async function register(): Promise<AuthPair> {
    const res = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceName }),
    });
    if (!res.ok) throw new Error(`register failed: HTTP ${res.status}`);
    const pair = (await res.json()) as AuthPair;
    await tokens.set(pair);
    return pair;
  }

  async function refresh(pair: AuthPair): Promise<AuthPair | null> {
    const res = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: pair.refreshToken }),
    });
    if (!res.ok) return null;
    const next = (await res.json()) as AuthPair;
    await tokens.set(next);
    return next;
  }

  async function fetchAuthed(path: string, init?: RequestInit): Promise<Response> {
    let pair = (await tokens.get()) ?? (await register());
    const attempt = (p: AuthPair) =>
      fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { ...init?.headers, authorization: `Bearer ${p.accessToken}` },
      });

    let res = await attempt(pair);
    if (res.status === 401) {
      pair = (await refresh(pair)) ?? (await register());
      res = await attempt(pair);
    }
    return res;
  }

  return {
    async getEventsSince(since) {
      const res = await fetchAuthed(`/events?since=${since}`);
      if (!res.ok) throw new Error(`sync pull failed: HTTP ${res.status}`);
      return (await res.json()) as { events: EventEnvelope[]; lastSequence: number };
    },
    async postEvents(events) {
      const res = await fetchAuthed(`/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events }),
      });
      if (!res.ok) throw new Error(`sync push failed: HTTP ${res.status}`);
    },
    async refreshItem(itemId) {
      const res = await fetchAuthed(`/items/${encodeURIComponent(itemId)}/refresh`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`refresh failed: HTTP ${res.status}`);
    },
    async getExplanation(request) {
      const res = await fetchAuthed(`/explanations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!res.ok) throw new Error(`explanation failed: HTTP ${res.status}`);
      return (await res.json()) as {
        text: string;
        provider: string;
        model: string;
        promptTemplateVersion: string;
      };
    },
  };
}
