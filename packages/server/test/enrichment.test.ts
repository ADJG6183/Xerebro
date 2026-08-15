/**
 * Field mapping and its edge cases, plus semantic error classification.
 * The edge cases here are the ones real aggregator feeds actually produce —
 * blank strings, missing merchant names, null currencies, low-confidence
 * categories — each of which would otherwise leak junk into the event log.
 */
import { describe, expect, it } from "vitest";
import { applyEvents, effectiveTransactions, emptyProjection, type TransactionEvent } from "@xerebro/engines";
import { syncPlaidItem } from "../src/plaid/acl";
import { classifyAggregatorError } from "../src/plaid/errors";
import { PlaidApiError } from "../src/plaid/httpGateway";
import { makeDeps, page, plaidTxn } from "./helpers";

async function eventsFor(txn: Parameters<typeof plaidTxn>[0]) {
  const deps = await makeDeps({ "": page({ added: [plaidTxn(txn)] }, "c1") });
  await syncPlaidItem(deps, "item-1");
  const events = await deps.events.eventsSince("user-1", 0);
  return events[0]!.payload as Record<string, unknown>;
}

describe("transaction enrichment", () => {
  it("keeps the clean merchant name alongside the raw description", async () => {
    const payload = await eventsFor({
      transaction_id: "t-uber",
      name: "Uber 063015 SF**POOL**",
      merchant_name: "Uber",
      logo_url: "https://plaid-merchant-logos.plaid.com/uber_1060.png",
      payment_channel: "online",
      personal_finance_category: {
        primary: "TRANSPORTATION",
        detailed: "TRANSPORTATION_TAXIS_AND_RIDE_SHARES",
        confidence_level: "LOW",
      },
    });

    expect(payload.merchantRaw).toBe("Uber 063015 SF**POOL**"); // source fact preserved
    expect(payload.merchantName).toBe("Uber"); // display name
    expect(payload.categoryDetailed).toBe("TRANSPORTATION_TAXIS_AND_RIDE_SHARES");
    expect(payload.categoryConfidence).toBe("low"); // honesty about a guess
    expect(payload.paymentChannel).toBe("online");
    expect(payload.merchantLogoUrl).toContain("https://");
  });

  it("EDGE: omits a merchant name that merely duplicates the raw description", async () => {
    const payload = await eventsFor({
      transaction_id: "t-dup",
      name: "STARBUCKS",
      merchant_name: "STARBUCKS",
    });
    expect(payload.merchantRaw).toBe("STARBUCKS");
    expect(payload).not.toHaveProperty("merchantName"); // nothing gained, not stored
  });

  it("EDGE: rejects a 'clean' name that is really a truncation (real sandbox case)", async () => {
    // Plaid returned merchant_name "FUN" for the description "SparkFun" —
    // an interior fragment, strictly worse than the bank's own text.
    const truncated = await eventsFor({
      transaction_id: "t-sparkfun",
      name: "SparkFun",
      merchant_name: "FUN",
    });
    expect(truncated).not.toHaveProperty("merchantName"); // raw wins

    // A leading prefix IS a genuine cleanup and is kept.
    const prefix = await eventsFor({
      transaction_id: "t-uber2",
      name: "Uber 072515 SF**POOL**",
      merchant_name: "Uber",
    });
    expect(prefix.merchantName).toBe("Uber");

    // A true resolution that shares no text is kept too.
    const resolved = await eventsFor({
      transaction_id: "t-sq",
      name: "SQ *BLUE BOTTLE",
      merchant_name: "Blue Bottle Coffee",
    });
    expect(resolved.merchantName).toBe("Blue Bottle Coffee");
  });

  it("EDGE: blank and whitespace-only strings are treated as absent", async () => {
    const payload = await eventsFor({
      transaction_id: "t-blank",
      name: "  Corner   Store  ",
      merchant_name: "   ",
      payment_channel: "",
    });
    expect(payload.merchantRaw).toBe("Corner Store"); // whitespace collapsed
    expect(payload).not.toHaveProperty("merchantName");
    expect(payload).not.toHaveProperty("paymentChannel");
  });

  it("EDGE: a non-https logo URL is dropped", async () => {
    const payload = await eventsFor({
      transaction_id: "t-logo",
      name: "Shop",
      logo_url: "http://insecure.example.com/logo.png",
    });
    expect(payload).not.toHaveProperty("merchantLogoUrl");
  });

  it("EDGE: falls back to unofficial_currency_code when iso is null", async () => {
    const payload = await eventsFor({
      transaction_id: "t-cur",
      name: "Crypto Exchange",
      iso_currency_code: null,
      unofficial_currency_code: "XBT",
    });
    expect(payload.currency).toBe("XBT");
  });

  it("EDGE: confidence is only recorded alongside a category", async () => {
    const payload = await eventsFor({
      transaction_id: "t-nocat",
      name: "Mystery",
      personal_finance_category: null,
    });
    expect(payload).not.toHaveProperty("category");
    expect(payload).not.toHaveProperty("categoryConfidence");
  });

  it("display prefers the clean name; user renames still win over both", async () => {
    const deps = await makeDeps({
      "": page(
        { added: [plaidTxn({ transaction_id: "t-1", name: "SQ *BLUE BOTTLE", merchant_name: "Blue Bottle" })] },
        "c1",
      ),
    });
    await syncPlaidItem(deps, "item-1");
    const events = (await deps.events.eventsSince("user-1", 0)) as TransactionEvent[];
    const withPlaidName = applyEvents(emptyProjection(), events);
    expect(effectiveTransactions(withPlaidName)[0]?.effectiveMerchant).toBe("Blue Bottle");
  });
});

describe("semantic error classification", () => {
  const plaidError = (code: string, status = 400) =>
    new PlaidApiError(`plaid failed: ${code}`, status, code);

  it("tells the user to re-authenticate when only they can fix it", () => {
    const failure = classifyAggregatorError(plaidError("ITEM_LOGIN_REQUIRED"));
    expect(failure.kind).toBe("reauth_required");
    expect(failure.needsUserAction).toBe(true);
    expect(failure.retryable).toBe(false);
    expect(failure.userMessage).toMatch(/sign in again/i);
  });

  it("distinguishes a bank outage (wait) from our misconfiguration (our fault)", () => {
    const down = classifyAggregatorError(plaidError("INSTITUTION_DOWN"));
    expect(down.kind).toBe("institution_down");
    expect(down.retryable).toBe(true);
    expect(down.needsUserAction).toBe(false);

    const config = classifyAggregatorError(plaidError("INVALID_API_KEYS", 401));
    expect(config.kind).toBe("config");
    expect(config.needsUserAction).toBe(false); // the USER can't fix our keys
    expect(config.userMessage).not.toMatch(/api|key|token/i); // no internals leaked
  });

  it("treats rate limits and 5xx as retryable, unknown 4xx as permanent", () => {
    expect(classifyAggregatorError(plaidError("RATE_LIMIT", 429)).kind).toBe("rate_limited");
    expect(classifyAggregatorError(plaidError("INTERNAL_SERVER_ERROR", 500)).retryable).toBe(true);
    expect(classifyAggregatorError(plaidError("SOMETHING_NEW", 400)).kind).toBe("permanent");
  });

  it("network errors with no status are retryable, never a crash", () => {
    const failure = classifyAggregatorError(new Error("fetch failed: ECONNRESET"));
    expect(failure.kind).toBe("transient");
    expect(failure.retryable).toBe(true);
    expect(failure.userMessage).toBeTruthy();
  });

  it("every classification yields a user-safe message", () => {
    for (const code of ["ITEM_LOGIN_REQUIRED", "INSTITUTION_DOWN", "INVALID_ACCESS_TOKEN", "RATE_LIMIT"]) {
      const failure = classifyAggregatorError(plaidError(code));
      expect(failure.userMessage.length).toBeGreaterThan(10);
      expect(failure.userMessage).not.toContain("access_token");
      expect(failure.userMessage).not.toContain(code); // no vendor jargon shown
    }
  });
});
