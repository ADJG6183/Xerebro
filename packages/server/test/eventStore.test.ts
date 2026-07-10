import { InMemoryEventStore } from "../src/eventStore";
import { eventStoreContract } from "./storeContract";

eventStoreContract("in-memory (reference)", async () => new InMemoryEventStore());
