/** Web preview: session-only outbox, same trade as openDeviceLog.web.ts. */
import { InMemoryOutbox, type Outbox } from "./outbox";

export async function openOutbox(): Promise<Outbox> {
  return new InMemoryOutbox();
}
