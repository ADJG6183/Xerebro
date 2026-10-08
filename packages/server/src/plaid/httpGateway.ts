/**
 * The real Plaid HTTP adapter — the only file that talks to Plaid's API.
 *
 * Plain fetch rather than the SDK, deliberately: the SDK's generated types
 * would leak Plaid's vocabulary into our codebase, which is exactly what the
 * anti-corruption layer exists to prevent (ADR-002). This file speaks HTTP to
 * Plaid and returns OUR boundary types; acl.ts turns those into our events.
 *
 * Failure policy (docs/Reliability.md): a bounded timeout, retries only on
 * transient failures (429/5xx/network) with backoff, and never on 4xx — a
 * bad request retried is still bad. Callers already degrade gracefully
 * (refresh-race falls back to CANT_VERIFY), so we fail fast rather than hang.
 */
import type {
  PlaidAccount,
  PlaidGateway,
  PlaidLinkGateway,
  PlaidSyncPage,
  PlaidTransaction,
} from "./gateway";

export type PlaidEnv = "sandbox" | "production";

export interface PlaidConfig {
  clientId: string;
  secret: string;
  env: PlaidEnv;
  /** Where Plaid should POST item updates. Omit in local dev (no public URL). */
  webhookUrl?: string;
  /** Where Hosted Link returns the user when they finish. Omit and Plaid
   * shows its own completion screen (fine in dev; the app then polls). */
  linkCompletionUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

const BASE_URL: Record<PlaidEnv, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export class PlaidApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly plaidErrorCode?: string,
  ) {
    super(message);
  }
}

/** True for failures where retrying is meaningful. */
function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

export function createPlaidHttpClient(config: PlaidConfig) {
  const timeoutMs = config.timeoutMs ?? 8_000;
  const maxRetries = config.maxRetries ?? 2;

  return async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
      try {
        const res = await fetch(`${BASE_URL[config.env]}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Credentials travel in the body, per Plaid's API contract.
          body: JSON.stringify({
            client_id: config.clientId,
            secret: config.secret,
            ...body,
          }),
          signal: controller.signal,
        });

        if (res.ok) {
          console.log(`  ↳ plaid ${path} attempt ${attempt} OK in ${Date.now() - startedAt}ms`);
          return (await res.json()) as T;
        }

        const detail = (await res.json().catch(() => ({}))) as {
          error_code?: string;
          error_message?: string;
        };
        const error = new PlaidApiError(
          `plaid ${path} failed: ${res.status} ${detail.error_code ?? ""} ${detail.error_message ?? ""}`.trim(),
          res.status,
          detail.error_code,
        );
        // 4xx means WE sent something wrong (bad token, revoked item):
        // retrying can't help and would just burn the caller's budget.
        if (!isTransient(res.status)) throw error;
        lastError = error;
      } catch (err) {
        console.log(`  ↳ plaid ${path} attempt ${attempt} FAILED after ${Date.now() - startedAt}ms: ${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof PlaidApiError && !isTransient(err.status)) throw err;
        lastError = err;
      } finally {
        clearTimeout(timer);
      }

      if (attempt < maxRetries) await sleep(250 * 2 ** attempt); // 250ms, 500ms
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** transactions/sync + accounts/balance/get against the real API. */
export function plaidHttpGateway(config: PlaidConfig): PlaidGateway {
  const call = createPlaidHttpClient(config);
  return {
    async transactionsSync(accessToken, cursor) {
      const page = await call<{
        added: PlaidTransaction[];
        modified: PlaidTransaction[];
        removed: { transaction_id: string }[];
        next_cursor: string;
        has_more: boolean;
      }>("/transactions/sync", {
        access_token: accessToken,
        // "" is not a valid cursor to Plaid — omit it to start from scratch.
        ...(cursor ? { cursor } : {}),
        count: 500,
      });
      // Do not coerce malformed upstream fields to empty arrays. The ACL
      // validates this untrusted response before any cursor can advance.
      return {
        added: page.added,
        modified: page.modified,
        removed: page.removed,
        next_cursor: page.next_cursor,
        has_more: page.has_more,
      } satisfies PlaidSyncPage;
    },

    async accountsBalanceGet(accessToken) {
      const res = await call<{ accounts: PlaidAccount[] }>("/accounts/balance/get", {
        access_token: accessToken,
      });
      // Preserve malformed responses so the balance ACL rejects them before
      // they can masquerade as a successful empty refresh.
      return res.accounts;
    },

    async itemRemove(accessToken) {
      await call<{ request_id: string }>("/item/remove", { access_token: accessToken });
    },
  };
}

/** Link-token creation and public-token exchange. */
export function plaidHttpLinkGateway(config: PlaidConfig): PlaidLinkGateway {
  const call = createPlaidHttpClient(config);
  return {
    async createLinkToken(userId) {
      // `hosted_link: {}` asks Plaid to host the Link UI and return a URL we
      // can open in a browser. Without it there is no legitimate way to open
      // Link outside the native SDK — hand-built secure.plaid.com URLs are
      // rejected ("access denied"), which is exactly what we hit.
      const res = await call<{
        link_token: string;
        expiration: string;
        hosted_link_url?: string;
      }>("/link/token/create", {
        client_name: "Xerebro",
        language: "en",
        country_codes: ["US"],
        user: { client_user_id: userId },
        products: ["transactions"],
        hosted_link: {
          // Where Plaid sends the user when Link finishes. Plaid appends the
          // public token; the app captures it and exchanges server-side.
          ...(config.linkCompletionUrl ? { completion_redirect_uri: config.linkCompletionUrl } : {}),
        },
        ...(config.webhookUrl ? { webhook: config.webhookUrl } : {}),
      });
      return {
        linkToken: res.link_token,
        expiration: res.expiration,
        ...(res.hosted_link_url ? { hostedLinkUrl: res.hosted_link_url } : {}),
      };
    },

    async getLinkSessionPublicToken(linkToken) {
      const res = await call<{
        link_sessions?: {
          // Plaid's REAL shape (verified against a live sandbox response,
          // 2026-08-31): `results` is a SINGLE object per session, not an
          // array, and the field is `item_add_results` (plural, an array) —
          // not the singular `item_add_result` the docs implied when this
          // was first written. Getting this wrong threw "object is not
          // iterable" on every completed link.
          results?: { item_add_results?: { public_token?: string }[] };
        }[];
      }>("/link/token/get", { link_token: linkToken });
      // Newest session first; a finished bank-add carries the public token.
      for (const session of [...(res.link_sessions ?? [])].reverse()) {
        for (const result of session.results?.item_add_results ?? []) {
          if (result.public_token) return result.public_token;
        }
      }
      return null;
    },

    async exchangePublicToken(publicToken) {
      const res = await call<{ access_token: string; item_id: string }>(
        "/item/public_token/exchange",
        { public_token: publicToken },
      );
      return { accessToken: res.access_token, itemId: res.item_id };
    },
  };
}
