/**
 * Every request this transport makes must be bounded — a stalled network
 * must fail fast, not hang forever (performanceBudget.md: the UI never
 * blocks on network). See decisionFlow.ts for the purchase-check-specific
 * bound layered on top of this generic safety net.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { authedHttpTransport } from "../src/data/httpTransport";
import { InMemoryTokenStore } from "../src/data/tokenStore";

describe("authedHttpTransport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("times out a stalled request instead of hanging forever", async () => {
    // A real fetch rejects when its signal aborts; a dumb "never resolves"
    // stub would NOT exercise that path and this test would just hang, so
    // the stub must honor the signal like the real implementation does.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    const transport = authedHttpTransport("http://test.invalid", new InMemoryTokenStore(), "dev", 25);

    const started = Date.now();
    await expect(transport.getEventsSince(0)).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("a stalled response BODY also times out, not just a stalled request", async () => {
    // fetch()'s own promise resolves once HEADERS arrive, before the body is
    // read — a response that answers fast but then stalls mid-body must
    // still be bounded. The register call resolves fast and normally; only
    // the events call's body hangs, to isolate which phase is covered.
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith("/auth/register")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ userId: "u1", deviceId: "d1", accessToken: "tok", refreshToken: "ref" }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        } as unknown as Response);
      }),
    );
    const transport = authedHttpTransport("http://test.invalid", new InMemoryTokenStore(), "dev", 25);

    const started = Date.now();
    await expect(transport.getEventsSince(0)).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("still completes normally when the network responds in time", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/auth/register")) {
          return new Response(
            JSON.stringify({
              userId: "u1",
              deviceId: "d1",
              accessToken: "tok",
              refreshToken: "ref",
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ events: [], lastSequence: 0 }), { status: 200 });
      }),
    );
    const transport = authedHttpTransport("http://test.invalid", new InMemoryTokenStore(), "dev", 5_000);
    await expect(transport.getEventsSince(0)).resolves.toEqual({ events: [], lastSequence: 0 });
  });
});
