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

/**
 * No fetch here may wait forever: a stalled network must fail fast enough
 * that a caller's own fallback (offline cache, CANT_VERIFY, template
 * explanation) can run within its documented budget (performanceBudget.md).
 * This is a blunt, uniform safety net, not a tuned per-surface budget — the
 * purchase-check path layers its own tighter bound on top (decisionFlow.ts).
 *
 * The bound covers headers AND body: `fetch()`'s own promise resolves as
 * soon as headers arrive, before the body is read, so clearing the timer
 * there (an earlier version of this code did exactly that) leaves a stalled
 * response body completely unbounded. The timer here stays alive until the
 * caller is done with the response — `res.json()` on the SAME signal is
 * aborted the same way the initial request would have been — one deadline
 * for the whole exchange, not a fresh one per phase.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

interface BoundedResponse {
  res: Response;
  url: string;
  timeoutMs: number;
  aborted: () => boolean;
  /** Call once done reading the body. Not calling it just lets the timer
   * fire harmlessly later (abort on a response nobody reads anymore) — it
   * exists to let a FAST exchange stop holding its timer open, not for
   * correctness. */
  clear: () => void;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<BoundedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return {
      res,
      url,
      timeoutMs,
      aborted: () => controller.signal.aborted,
      clear: () => clearTimeout(timer),
    };
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new Error(`request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

/** Read the body under the SAME bound the request was made under (see
 * fetchWithTimeout above) — a stalled body throws the same timeout error a
 * stalled request would, instead of hanging past the deadline. */
async function readJson<T>(bounded: BoundedResponse): Promise<T> {
  try {
    return (await bounded.res.json()) as T;
  } catch (err) {
    if (bounded.aborted()) {
      throw new Error(`request to ${bounded.url} timed out after ${bounded.timeoutMs}ms`);
    }
    throw err;
  } finally {
    bounded.clear();
  }
}

export function authedHttpTransport(
  baseUrl: string,
  tokens: TokenStore,
  deviceName = "xerebro-app",
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): SyncTransport {
  async function register(): Promise<AuthPair> {
    const bounded = await fetchWithTimeout(
      `${baseUrl}/auth/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceName }),
      },
      requestTimeoutMs,
    );
    if (!bounded.res.ok) {
      bounded.clear();
      throw new Error(`register failed: HTTP ${bounded.res.status}`);
    }
    const pair = await readJson<AuthPair>(bounded);
    await tokens.set(pair);
    return pair;
  }

  async function refresh(pair: AuthPair): Promise<AuthPair | null> {
    const bounded = await fetchWithTimeout(
      `${baseUrl}/auth/refresh`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: pair.refreshToken }),
      },
      requestTimeoutMs,
    );
    if (!bounded.res.ok) {
      bounded.clear();
      return null;
    }
    const next = await readJson<AuthPair>(bounded);
    await tokens.set(next);
    return next;
  }

  async function fetchAuthed(path: string, init?: RequestInit): Promise<BoundedResponse> {
    let pair = (await tokens.get()) ?? (await register());
    const attempt = (p: AuthPair) =>
      fetchWithTimeout(
        `${baseUrl}${path}`,
        {
          ...init,
          headers: { ...init?.headers, authorization: `Bearer ${p.accessToken}` },
        },
        requestTimeoutMs,
      );

    let bounded = await attempt(pair);
    if (bounded.res.status === 401) {
      bounded.clear();
      pair = (await refresh(pair)) ?? (await register());
      bounded = await attempt(pair);
    }
    return bounded;
  }

  return {
    async getEventsSince(since) {
      const bounded = await fetchAuthed(`/events?since=${since}`);
      if (!bounded.res.ok) {
        const status = bounded.res.status;
        bounded.clear();
        throw new Error(`sync pull failed: HTTP ${status}`);
      }
      return readJson<{ events: EventEnvelope[]; lastSequence: number }>(bounded);
    },
    async postEvents(events) {
      const bounded = await fetchAuthed(`/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events }),
      });
      const status = bounded.res.status;
      bounded.clear();
      if (!bounded.res.ok) throw new Error(`sync push failed: HTTP ${status}`);
    },
    async refreshItem(itemId) {
      const bounded = await fetchAuthed(`/items/${encodeURIComponent(itemId)}/refresh`, {
        method: "POST",
      });
      if (!bounded.res.ok) {
        const status = bounded.res.status;
        // Carry the server's SEMANTIC classification on the error so callers
        // can show why syncing failed (data/aggregatorStatus.ts).
        const body = await readJson<{ failure?: unknown }>(bounded).catch(() => ({}) as { failure?: unknown });
        const error = new Error(`refresh failed: HTTP ${status}`) as Error & { failure?: unknown };
        if (body.failure) error.failure = body.failure;
        throw error;
      }
      bounded.clear();
    },
    async getExplanation(request) {
      const bounded = await fetchAuthed(`/explanations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!bounded.res.ok) {
        const status = bounded.res.status;
        bounded.clear();
        throw new Error(`explanation failed: HTTP ${status}`);
      }
      return readJson<{
        text: string;
        provider: string;
        model: string;
        promptTemplateVersion: string;
      }>(bounded);
    },
    async chat(question, todayLocal) {
      const bounded = await fetchAuthed(`/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, todayLocal }),
      });
      if (!bounded.res.ok) {
        const status = bounded.res.status;
        bounded.clear();
        throw new Error(`chat failed: HTTP ${status}`);
      }
      return readJson<import("./chat").CopilotAnswer>(bounded);
    },
    async createLinkToken() {
      const bounded = await fetchAuthed(`/plaid/link-token`, { method: "POST" });
      if (!bounded.res.ok) {
        const status = bounded.res.status;
        bounded.clear();
        throw new Error(`link token failed: HTTP ${status}`);
      }
      return readJson<{
        linkToken: string;
        expiration: string;
        hostedLinkUrl?: string;
      }>(bounded);
    },
    async completeLink(linkToken) {
      const bounded = await fetchAuthed(`/plaid/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ linkToken }),
      });
      if (!bounded.res.ok) {
        const status = bounded.res.status;
        bounded.clear();
        throw new Error(`complete failed: HTTP ${status}`);
      }
      return readJson<{ linked: boolean; itemId?: string }>(bounded);
    },
    async exchangePublicToken(publicToken) {
      const bounded = await fetchAuthed(`/plaid/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicToken }),
      });
      if (!bounded.res.ok) {
        const status = bounded.res.status;
        bounded.clear();
        throw new Error(`exchange failed: HTTP ${status}`);
      }
      return readJson<{ itemId: string }>(bounded);
    },
    async listItems() {
      const bounded = await fetchAuthed(`/items`);
      if (!bounded.res.ok) {
        const status = bounded.res.status;
        bounded.clear();
        throw new Error(`items failed: HTTP ${status}`);
      }
      return readJson<{ items: import("./syncClient").ConnectedItem[] }>(bounded);
    },
    async reviewAccountHistory(command) {
      const bounded = await fetchAuthed(`/accounts/history-review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!bounded.res.ok) {
        const body = await readJson<{ error?: string }>(bounded).catch(() => ({}) as { error?: string });
        throw new Error(body.error ?? "Could not save the review. Reconnect and try again.");
      }
      bounded.clear();
    },
    async disconnectItem(itemId) {
      const bounded = await fetchAuthed(`/items/${encodeURIComponent(itemId)}/disconnect`, {
        method: "POST",
      });
      if (!bounded.res.ok && bounded.res.status !== 202) {
        const status = bounded.res.status;
        bounded.clear();
        throw new Error(`disconnect failed: HTTP ${status}`);
      }
      return readJson<{
        status: import("./syncClient").ConnectedItem["status"];
        message?: string;
      }>(bounded);
    },
  };
}
