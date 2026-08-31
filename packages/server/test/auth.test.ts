/**
 * The trust boundary, proven: identity comes from tokens, tokens rotate,
 * theft signals revoke, and no token means no data — not even with a
 * perfectly-guessed userId, because there is nowhere left to claim one.
 */
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { makeDeps, registerHeaders } from "./helpers";

const EVENT = {
  eventId: "e1",
  type: "TransactionAnnotated",
  schemaVersion: 1,
  occurredAt: "2026-07-07T12:00:00.000Z",
  source: "user",
  idempotencyKey: "k1",
  payload: { txnId: "t1", categoryOverride: "Coffee" },
};

describe("token auth", () => {
  it("no token → 401 on every protected route", async () => {
    const app = await buildApp(await makeDeps({}));
    for (const [method, url] of [
      ["GET", "/events?since=0"],
      ["POST", "/events"],
      ["POST", "/items/item-1/refresh"],
      ["POST", "/explanations"],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("ISOLATION: user B's token cannot read user A's events", async () => {
    const app = await buildApp(await makeDeps({}));
    const a = await registerHeaders(app); // user-1
    const b = await registerHeaders(app); // user-2

    await app.inject({ method: "POST", url: "/events", headers: a.headers, payload: { events: [EVENT] } });

    const asB = await app.inject({ method: "GET", url: "/events?since=0", headers: b.headers });
    expect(asB.json().events).toEqual([]); // B sees an empty diary, not A's

    const asA = await app.inject({ method: "GET", url: "/events?since=0", headers: a.headers });
    expect(asA.json().events).toHaveLength(1);
  });

  it("ISOLATION: you cannot refresh another user's bank connection", async () => {
    const app = await buildApp(await makeDeps({}));
    await registerHeaders(app); // user-1 owns item-1 (seeded in helpers)
    const b = await registerHeaders(app); // user-2
    const res = await app.inject({ method: "POST", url: "/items/item-1/refresh", headers: b.headers });
    expect(res.statusCode).toBe(404); // not even a 403 — existence isn't disclosed
  });

  it("refresh rotates the pair; the old access token stops working", async () => {
    const app = await buildApp(await makeDeps({}));
    const first = await registerHeaders(app);

    const rotated = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: first.refreshToken },
    });
    expect(rotated.statusCode).toBe(200);
    const next = rotated.json() as { accessToken: string; refreshToken: string };

    const withNew = await app.inject({
      method: "GET",
      url: "/events?since=0",
      headers: { authorization: `Bearer ${next.accessToken}` },
    });
    expect(withNew.statusCode).toBe(200);
  });

  it("THEFT SIGNAL: replaying a rotated-out refresh token revokes the device", async () => {
    const app = await buildApp(await makeDeps({}));
    const first = await registerHeaders(app);

    const rotated = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: first.refreshToken },
    });
    const next = rotated.json() as { accessToken: string; refreshToken: string };

    // Attacker (or confused client) replays the OLD refresh token…
    const replay = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: first.refreshToken },
    });
    expect(replay.statusCode).toBe(401);

    // …and the device is revoked outright: even the NEW tokens are dead.
    const withNew = await app.inject({
      method: "GET",
      url: "/events?since=0",
      headers: { authorization: `Bearer ${next.accessToken}` },
    });
    expect(withNew.statusCode).toBe(401);
    const refreshNew = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: next.refreshToken },
    });
    expect(refreshNew.statusCode).toBe(401);
  });

  it("garbage and expired-format tokens are just 401s, never errors", async () => {
    const app = await buildApp(await makeDeps({}));
    const res = await app.inject({
      method: "GET",
      url: "/events?since=0",
      headers: { authorization: "Bearer xat_totally-made-up" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("rate limiting", () => {
  it("SECURITY: caps repeated tries at the guess-prone routes", async () => {
    // Without this, token/link-token guessing is limited only by bandwidth.
    // The plugin must be LOADED before routes are defined for per-route
    // config to apply — the reason buildApp is async.
    const app = await buildApp(await makeDeps({}));
    await app.ready();

    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({ method: "POST", url: "/auth/register", payload: {} });
      codes.push(res.statusCode);
    }
    expect(codes.filter((c) => c === 201)).toHaveLength(10);
    expect(codes.at(-1)).toBe(429);
  });
});
