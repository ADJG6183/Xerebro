/**
 * Device-token authentication (staged path to SecurityPrivacy.md's passkey
 * end-state — see the "Staging" note there). Anonymous account per install:
 * register once, then every request proves itself with a bearer token and
 * the server derives userId FROM the token. No request-supplied identity,
 * ever again.
 *
 * Token hygiene:
 *  - tokens are 256-bit random, shown once; the server stores only SHA-256
 *    hashes (a database leak leaks nothing usable);
 *  - access tokens are short-lived (1h); refresh tokens rotate on every use;
 *  - a rotated-out refresh token being presented again is the classic sign
 *    of token theft → the device is revoked outright (both parties locked
 *    out; the honest one re-registers).
 *
 * InMemoryAuthStore is the reference; PostgresAuthStore must pass the same
 * contract tests.
 */
import { createHash, randomBytes } from "node:crypto";

export const ACCESS_TTL_MS = 60 * 60 * 1000; // 1h
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d

export interface AuthSession {
  userId: string;
  deviceId: string;
}

export interface RegisterResult {
  userId: string;
  deviceId: string;
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
}

export interface AuthStore {
  registerDevice(deviceName: string): Promise<RegisterResult>;
  /** null = missing/expired/revoked. */
  verifyAccess(accessToken: string): Promise<AuthSession | null>;
  /** Rotates the pair. null = invalid; presenting a ROTATED-OUT token
   * revokes the device (theft signal). */
  refresh(refreshToken: string): Promise<RegisterResult | null>;
}

export interface AuthDeps {
  now: () => string;
  newId: () => string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(prefix: "xat" | "xrt"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export interface DeviceRow {
  deviceId: string;
  userId: string;
  name: string;
  accessHash: string;
  accessExpiresAt: string;
  refreshHash: string;
  refreshExpiresAt: string;
  /** Previous refresh hash — presenting it again means theft. */
  prevRefreshHash: string | null;
  revoked: boolean;
}

/** Mint a fresh pair for a device row (shared by both implementations). */
export function mintPair(deps: AuthDeps): {
  accessToken: string;
  refreshToken: string;
  fields: Pick<DeviceRow, "accessHash" | "accessExpiresAt" | "refreshHash" | "refreshExpiresAt">;
} {
  const accessToken = newToken("xat");
  const refreshToken = newToken("xrt");
  const nowMs = Date.parse(deps.now());
  return {
    accessToken,
    refreshToken,
    fields: {
      accessHash: hashToken(accessToken),
      accessExpiresAt: new Date(nowMs + ACCESS_TTL_MS).toISOString(),
      refreshHash: hashToken(refreshToken),
      refreshExpiresAt: new Date(nowMs + REFRESH_TTL_MS).toISOString(),
    },
  };
}

export class InMemoryAuthStore implements AuthStore {
  private readonly devices = new Map<string, DeviceRow>();

  constructor(private readonly deps: AuthDeps) {}

  async registerDevice(deviceName: string): Promise<RegisterResult> {
    const userId = this.deps.newId();
    const deviceId = this.deps.newId();
    const { accessToken, refreshToken, fields } = mintPair(this.deps);
    this.devices.set(deviceId, {
      deviceId,
      userId,
      name: deviceName,
      ...fields,
      prevRefreshHash: null,
      revoked: false,
    });
    return {
      userId,
      deviceId,
      accessToken,
      accessExpiresAt: fields.accessExpiresAt,
      refreshToken,
      refreshExpiresAt: fields.refreshExpiresAt,
    };
  }

  async verifyAccess(accessToken: string): Promise<AuthSession | null> {
    const hash = hashToken(accessToken);
    for (const d of this.devices.values()) {
      if (d.accessHash === hash) {
        if (d.revoked || Date.parse(d.accessExpiresAt) <= Date.parse(this.deps.now())) return null;
        return { userId: d.userId, deviceId: d.deviceId };
      }
    }
    return null;
  }

  async refresh(refreshToken: string): Promise<RegisterResult | null> {
    const hash = hashToken(refreshToken);
    for (const d of this.devices.values()) {
      if (d.prevRefreshHash === hash) {
        // Theft signal: a rotated-out refresh token came back. Revoke.
        d.revoked = true;
        return null;
      }
      if (d.refreshHash === hash) {
        if (d.revoked || Date.parse(d.refreshExpiresAt) <= Date.parse(this.deps.now())) return null;
        const { accessToken, refreshToken: nextRefresh, fields } = mintPair(this.deps);
        d.prevRefreshHash = d.refreshHash;
        Object.assign(d, fields);
        return {
          userId: d.userId,
          deviceId: d.deviceId,
          accessToken,
          accessExpiresAt: fields.accessExpiresAt,
          refreshToken: nextRefresh,
          refreshExpiresAt: fields.refreshExpiresAt,
        };
      }
    }
    return null;
  }
}
