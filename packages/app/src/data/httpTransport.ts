/**
 * HTTP implementation of SyncTransport for the app runtime (fetch is global
 * in React Native). Tests use an inject-based transport against the real
 * server app instead — same interface, no network.
 */
import type { EventEnvelope } from "@xerebro/engines";
import type { SyncTransport } from "./syncClient";

export function httpTransport(baseUrl: string): SyncTransport {
  return {
    async getEventsSince(userId, since) {
      const res = await fetch(
        `${baseUrl}/events?userId=${encodeURIComponent(userId)}&since=${since}`,
      );
      if (!res.ok) throw new Error(`sync pull failed: HTTP ${res.status}`);
      return (await res.json()) as { events: EventEnvelope[]; lastSequence: number };
    },
    async postEvents(userId, events) {
      const res = await fetch(`${baseUrl}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, events }),
      });
      if (!res.ok) throw new Error(`sync push failed: HTTP ${res.status}`);
    },
    async refreshItem(itemId) {
      const res = await fetch(`${baseUrl}/items/${encodeURIComponent(itemId)}/refresh`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`refresh failed: HTTP ${res.status}`);
    },
    async getExplanation(request) {
      const res = await fetch(`${baseUrl}/explanations`, {
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
