/**
 * THE AuthStore contract — in-memory reference and Postgres adapter must
 * behave identically (same pattern as storeContract.ts).
 */
import { describe, expect, it } from "vitest";
import type { AuthStore } from "../src/auth/store";

export function authStoreContract(name: string, make: () => Promise<AuthStore>) {
  describe(`AuthStore contract: ${name}`, () => {
    it("register → verify round-trips; garbage tokens verify to null", async () => {
      const store = await make();
      const reg = await store.registerDevice("phone");
      expect(reg.accessToken).toMatch(/^xat_/);
      expect(reg.refreshToken).toMatch(/^xrt_/);
      expect(await store.verifyAccess(reg.accessToken)).toEqual({
        userId: reg.userId,
        deviceId: reg.deviceId,
      });
      expect(await store.verifyAccess("xat_garbage")).toBeNull();
    });

    it("refresh rotates: new pair works, old refresh becomes a theft trigger", async () => {
      const store = await make();
      const reg = await store.registerDevice("phone");

      const next = await store.refresh(reg.refreshToken);
      expect(next).not.toBeNull();
      expect(next!.userId).toBe(reg.userId);
      expect(await store.verifyAccess(next!.accessToken)).not.toBeNull();

      // Replaying the rotated-out token revokes the device entirely.
      expect(await store.refresh(reg.refreshToken)).toBeNull();
      expect(await store.verifyAccess(next!.accessToken)).toBeNull();
      expect(await store.refresh(next!.refreshToken)).toBeNull();
    });

    it("two registrations are fully independent identities", async () => {
      const store = await make();
      const a = await store.registerDevice("phone-a");
      const b = await store.registerDevice("phone-b");
      expect(a.userId).not.toBe(b.userId);
      const sessionA = await store.verifyAccess(a.accessToken);
      const sessionB = await store.verifyAccess(b.accessToken);
      expect(sessionA!.userId).not.toBe(sessionB!.userId);
    });
  });
}
