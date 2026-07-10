import { randomUUID } from "node:crypto";
import { InMemoryAuthStore } from "../src/auth/store";
import { authStoreContract } from "./authContract";

authStoreContract(
  "in-memory (reference)",
  async () =>
    new InMemoryAuthStore({ now: () => new Date().toISOString(), newId: () => randomUUID() }),
);
