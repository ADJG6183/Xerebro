/**
 * Web preview: hosted Link in a popup is unreliable across browsers and the
 * web target is a dev convenience, not the product (docs/V1Scope.md). Report
 * unavailable so the UI degrades honestly rather than half-working.
 */
import type { WebAuthOpener } from "./plaidLink";

export const webAuthOpener: WebAuthOpener = {
  async open() {
    return { type: "dismiss" };
  },
};
