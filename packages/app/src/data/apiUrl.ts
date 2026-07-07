/**
 * Where is the dev server? The answer differs by how you're running:
 *
 *  - iOS simulator / web browser: it shares the Mac's network, so
 *    http://localhost:3000 works.
 *  - Expo Go on a REAL phone: "localhost" is the phone itself — the server
 *    is on your computer. Luckily Expo already knows your computer's LAN
 *    address (that's how the phone fetches the JS bundle): it's in
 *    Constants.expoConfig.hostUri, e.g. "192.168.1.23:8081". We reuse that
 *    host with the API port.
 *
 * EXPO_PUBLIC_API_URL always wins when set (real deployments set it).
 */
import Constants from "expo-constants";

const API_PORT = 3000;

export function resolveApiUrl(): string {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  if (explicit) return explicit;

  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const host = hostUri.split(":")[0];
    if (host) return `http://${host}:${API_PORT}`;
  }

  return `http://localhost:${API_PORT}`;
}
