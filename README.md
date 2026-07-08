# Xerebro

AI-native financial copilot. Local-first mobile app; deterministic engines; the LLM only explains. Architecture lives in [docs/](docs/) — start with [docs/vision.md](docs/vision.md) and the ADRs in [docs/adr/](docs/adr/).

## Packages

| Package | What it is |
|---|---|
| `@xerebro/engines` | Pure TypeScript financial core (fold, state, decisions, verification). Runs identically on device and server. |
| `@xerebro/server` | Thin backend: Plaid webhook ingestion → event log, device sync endpoints, (soon) LLM proxy. |
| `@xerebro/app` | Expo app. Renders only from the on-device event log; syncs in the background. |

## Dev quickstart

```bash
npm install
npm test                         # all packages
```

Run the app against the dev server:

```bash
# terminal 1 — API on :3000 (in-memory, resets on restart)
npm run dev -w @xerebro/server

# optional: enable AI explanations (otherwise template explanations are used)
# one-time setup: cp packages/server/.env.example packages/server/.env
# then fill in OPENAI_API_KEY and OPENAI_MODEL — the dev server reads it on start
# (.env is gitignored; never commit keys)

# terminal 2 — Expo
npm start -w @xerebro/app
```

Then press `i` (iOS simulator), `a` (Android), or scan the QR with Expo Go on your phone.

- **Phone via Expo Go:** the app auto-detects your computer's LAN address from Expo, so the API just works — but phone and computer must be on the **same Wi-Fi**, and macOS firewall must allow Node to accept connections on port 3000.
- **Web (`w`):** works as a preview; storage is session-only there (native SQLite is the real store).
- Override the API location any time with `EXPO_PUBLIC_API_URL=http://<host>:3000 npm start -w @xerebro/app`.

First screen: tap **Add demo checking account**, watch the dashboard fill in. Stop the server and reload — the app renders saved data with an "Offline" label (that's the local-first invariant working).

## Rules of the repo

See [CLAUDE.md](CLAUDE.md). Short version: SQL calculates, rules decide, LLM explains, verification protects; money is integer cents; the event log is append-only; every displayed number carries its data age.
