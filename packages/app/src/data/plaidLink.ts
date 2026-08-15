/**
 * Bank linking from the app (docs/SecurityPrivacy.md).
 *
 * Uses Plaid's HOSTED Link in a web session rather than the native
 * react-native-plaid-link-sdk, because that SDK requires custom native code
 * and therefore a development build — Expo Go cannot load it. Hosted Link is
 * the same Plaid flow, opened in a secure in-app browser, and works today.
 * Swapping to the native SDK later is a change to this file alone.
 *
 * The security shape is what matters and it is identical either way:
 *  - the device only ever holds SHORT-LIVED tokens (link token, then the
 *    public token Link returns);
 *  - the durable ACCESS token is exchanged and stored server-side, and never
 *    travels to the device.
 */
import type { SyncTransport } from "./syncClient";

export type LinkOutcome =
  | { status: "linked"; itemId: string }
  | { status: "cancelled" }
  | { status: "unavailable" } // server has no Plaid credentials configured
  | { status: "failed"; reason: string };

/** Opens a URL and resolves with the redirect that returns to the app. */
export interface WebAuthOpener {
  open(url: string, redirectUrl: string): Promise<{ type: string; url?: string }>;
}

/** Extract Plaid's public_token from the redirect URL it sends us back to. */
export function publicTokenFrom(redirectUrl: string): string | null {
  const match = redirectUrl.match(/[?&#]public_token=([^&#]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}

export async function linkBankAccount(
  transport: SyncTransport,
  opener: WebAuthOpener,
  redirectUrl: string,
): Promise<LinkOutcome> {
  if (!transport.createLinkToken || !transport.exchangePublicToken) {
    return { status: "unavailable" };
  }

  let linkToken: string;
  try {
    ({ linkToken } = await transport.createLinkToken());
  } catch (err) {
    // 503 = the server has no Plaid keys; anything else is a real failure.
    return String(err).includes("503")
      ? { status: "unavailable" }
      : { status: "failed", reason: "could not start bank linking" };
  }

  const result = await opener.open(
    `https://secure.plaid.com/link?isWebview=true&token=${encodeURIComponent(linkToken)}`,
    redirectUrl,
  );
  if (result.type !== "success" || !result.url) return { status: "cancelled" };

  const publicToken = publicTokenFrom(result.url);
  if (!publicToken) return { status: "cancelled" };

  try {
    const { itemId } = await transport.exchangePublicToken(publicToken);
    return { status: "linked", itemId };
  } catch {
    return { status: "failed", reason: "could not finish linking your bank" };
  }
}
