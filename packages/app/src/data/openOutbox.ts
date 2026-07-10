/** Native: durable SQLite outbox. Metro picks openOutbox.web.ts for web. */
import type { Outbox } from "./outbox";
import { openSqliteOutbox } from "./sqliteOutbox";

export function openOutbox(): Promise<Outbox> {
  return openSqliteOutbox();
}
