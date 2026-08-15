/**
 * Platform WebAuthOpener: opens Plaid's hosted Link in a secure in-app
 * browser session and waits for the redirect back to the app.
 * Native only; the web build supplies its own (openWebAuth.web.ts).
 */
import * as WebBrowser from "expo-web-browser";
import type { WebAuthOpener } from "./plaidLink";

export const webAuthOpener: WebAuthOpener = {
  async open(url, redirectUrl) {
    const result = await WebBrowser.openAuthSessionAsync(url, redirectUrl);
    return result.type === "success"
      ? { type: "success", url: result.url }
      : { type: result.type };
  },
};
