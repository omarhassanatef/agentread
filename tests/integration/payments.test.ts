import { describe, expect, it } from "vitest";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { ARTICLE_HTML } from "../fixtures/pages.js";
import { BASE_SEPOLIA_USDC, PAY_TO, harness, payingClient, postJson } from "../helpers/app.js";
import { html } from "../helpers/upstream.js";
import { extractResultSchema, structuredResultSchema } from "../../src/schemas/index.js";

const PAGE = "https://ocean.example.com/guides/tide-pools";
const routes = { [PAGE]: html(ARTICLE_HTML) };

async function paymentRequired(res: Response): Promise<PaymentRequired> {
  const header = res.headers.get("payment-required");
  expect(header, "PAYMENT-REQUIRED header").toBeTruthy();
  return decodePaymentRequiredHeader(header!);
}

/** Sign a payment for the first accepted requirement, returning the header value. */
async function signFor(res: Response, client = payingClient().client): Promise<string> {
  const required = await paymentRequired(res);
  const payload = await client.createPaymentPayload(required);
  return encodePaymentSignatureHeader(payload);
}

describe("x402 on HTTP — unpaid requests", () => {
  it("returns a protocol-compatible 402 with correct price, asset, network and recipient", async () => {
    const h = harness(routes);
    const res = await h.fetch("/v1/extract", postJson({ url: PAGE }));
    expect(res.status).toBe(402);
    const required = await paymentRequired(res);
    expect(required.x402Version).toBe(2);
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:84532",
      amount: "3000", // $0.003 in 6-decimal USDC
      asset: BASE_SEPOLIA_USDC,
      payTo: PAY_TO,
    });
    expect(required.resource?.url).toBe("https://agentread.test/v1/extract");
    // Bazaar discovery metadata (CDP Bazaar / agentic.market indexing).
    const bazaar = (required.extensions as Record<string, { info: { input: Record<string, unknown> }; schema: unknown }> | undefined)?.bazaar;
    expect(bazaar?.info.input).toMatchObject({ type: "http", method: "POST", bodyType: "json" });
    expect(bazaar?.schema).toBeDefined();
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("payment_required");
    // No work is done before payment.
    expect(h.upstream.calls).toHaveLength(0);
    expect(h.facilitator.calls.verify).toBe(0);
  });

  it("prices structured extraction separately", async () => {
    const h = harness(routes);
    const res = await h.fetch("/v1/extract/structured", postJson({ url: PAGE }));
    expect(res.status).toBe(402);
    expect((await paymentRequired(res)).accepts[0]!.amount).toBe("5000");
  });

  it("validates input before requesting payment (400, not 402)", async () => {
    const h = harness(routes);
    for (const body of [{ url: "" }, { url: 42 }, { url: PAGE, maxCharacters: 10 }, { url: PAGE, extra: true }]) {
      const res = await h.fetch("/v1/extract", postJson(body));
      expect(res.status).toBe(400);
      expect(res.headers.get("payment-required")).toBeNull();
    }
    const blocked = await h.fetch("/v1/extract", postJson({ url: "http://169.254.169.254/latest/meta-data/" }));
    expect(blocked.status).toBe(400);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("blocked_destination");
    expect(blocked.headers.get("payment-required")).toBeNull();
    const notJson = await h.fetch("/v1/extract", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    expect(notJson.status).toBe(400);
  });

  it("treats an empty body as a discovery probe: 402 with requirements, never charged", async () => {
    const h = harness(routes);
    for (const body of ["", "{}"]) {
      const res = await h.fetch("/v1/extract", { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(res.status).toBe(402);
      expect(res.headers.get("payment-required")).toBeTruthy();
    }
    // Paying for a probe gets a 400 and is not settled.
    const res = await wrapFetchWithPayment(h.appFetch, payingClient().client)("https://agentread.test/v1/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    expect(h.facilitator.calls.verify).toBe(1);
    expect(h.facilitator.chain.settlements).toHaveLength(0);
    expect(h.upstream.calls).toHaveLength(0);
  });

  it("rejects hosts that fail the DNS guard before requesting payment", async () => {
    const h = harness(routes, {}, async () => {
      const { AppError } = await import("../../src/utils/errors.js");
      throw new AppError("host_not_found", "The hostname does not exist (NXDOMAIN).");
    });
    const res = await h.fetch("/v1/extract", postJson({ url: PAGE }));
    expect(res.status).toBe(422);
    expect(res.headers.get("payment-required")).toBeNull();
  });

  it("returns 503 (not a free result) when payments are misconfigured", async () => {
    const h = harness(routes, { X402_PAY_TO: "" });
    const res = await h.fetch("/v1/extract", postJson({ url: PAGE }));
    expect(res.status).toBe(503);
    expect(h.upstream.calls).toHaveLength(0);
    // Free inspection keeps working.
    expect((await h.fetch("/v1/inspect", postJson({ url: PAGE }))).status).toBe(200);
  });
});

describe("x402 on HTTP — invalid payments", () => {
  it("rejects a garbage PAYMENT-SIGNATURE header without doing work", async () => {
    const h = harness(routes);
    for (const sig of ["not-base64!!", btoa("{}"), btoa(JSON.stringify({ x402Version: 2, paymentVerified: true }))]) {
      const res = await h.fetch("/v1/extract", postJson({ url: PAGE }, { "payment-signature": sig }));
      expect(res.status).toBe(402);
    }
    expect(h.upstream.calls).toHaveLength(0);
    expect(h.facilitator.chain.settlements).toHaveLength(0);
  });

  it("rejects a tampered authorization (signature no longer matches)", async () => {
    const h = harness(routes);
    const first = await h.fetch("/v1/extract", postJson({ url: PAGE }));
    const required = await paymentRequired(first);
    const payload = await payingClient().client.createPaymentPayload(required);
    const auth = (payload.payload as { authorization: { value: string } }).authorization;
    auth.value = "1"; // try to pay less than signed... signature now invalid
    const res = await h.fetch("/v1/extract", postJson({ url: PAGE }, { "payment-signature": encodePaymentSignatureHeader(payload) }));
    expect(res.status).toBe(402);
    // Readable reason in the body, not just the base64 header.
    expect(await res.json()).toMatchObject({ error: { code: "payment_invalid", details: { reason: "invalid_exact_evm_signature" } } });
    expect(h.upstream.calls).toHaveLength(0);
    expect(h.facilitator.chain.settlements).toHaveLength(0);
  });

  it("rejects a payment for a cheaper operation (amount mismatch)", async () => {
    const h = harness(routes);
    const cheap = await h.fetch("/v1/extract", postJson({ url: PAGE }));
    const sig = await signFor(cheap); // signed for $0.003
    const res = await h.fetch("/v1/extract/structured", postJson({ url: PAGE }, { "payment-signature": sig })); // costs $0.005
    expect(res.status).toBe(402);
    expect(h.facilitator.chain.settlements).toHaveLength(0);
  });

  it("rejects a payment addressed to a different recipient", async () => {
    const h = harness(routes);
    const first = await h.fetch("/v1/extract", postJson({ url: PAGE }));
    const required = await paymentRequired(first);
    required.accepts[0]!.payTo = "0x2222222222222222222222222222222222222222";
    const payload = await payingClient().client.createPaymentPayload(required);
    const res = await h.fetch("/v1/extract", postJson({ url: PAGE }, { "payment-signature": encodePaymentSignatureHeader(payload) }));
    expect(res.status).toBe(402);
    expect(h.facilitator.chain.settlements).toHaveLength(0);
  });

  it("rejects a replayed payment authorization", async () => {
    const h = harness(routes);
    const sig = await signFor(await h.fetch("/v1/extract", postJson({ url: PAGE })));
    const ok = await h.fetch("/v1/extract", postJson({ url: PAGE }, { "payment-signature": sig }));
    expect(ok.status).toBe(200);
    const replay = await h.fetch("/v1/extract", postJson({ url: PAGE }, { "payment-signature": sig }));
    expect(replay.status).toBe(402);
    expect(await replay.text()).not.toContain("Tide pools are shallow");
    expect(h.facilitator.chain.settlements).toHaveLength(1);
  });
});

describe("x402 on HTTP — successful and failed paid requests", () => {
  it("completes the full 402 → sign → retry flow with @x402/fetch and returns clean Markdown", async () => {
    const h = harness(routes);
    const { client, account } = payingClient();
    const payFetch = wrapFetchWithPayment(h.appFetch, client);
    const res = await payFetch("https://agentread.test/v1/extract", postJson({ url: PAGE, maxCharacters: 5000 }));
    expect(res.status).toBe(200);

    const result = extractResultSchema.parse(await res.json());
    expect(result.markdown).toContain("Tide pools are shallow basins");
    expect(result.markdown).not.toContain("We use cookies");
    expect(result.title).toBe("How Tide Pools Work | Ocean Notes");
    expect(result.extraction.method).toBe("readability");

    const receipt = new x402HTTPClient(client).getPaymentSettleResponse((n) => res.headers.get(n));
    expect(receipt.success).toBe(true);
    expect(receipt.network).toBe("eip155:84532");
    expect(receipt.transaction).toMatch(/^0x[0-9a-f]{64}$/);

    expect(h.facilitator.chain.settlements).toHaveLength(1);
    expect(h.facilitator.chain.settlements[0]).toMatchObject({ value: 3000n });
    expect(h.facilitator.chain.settlements[0]!.from.toLowerCase()).toBe(account.address.toLowerCase());
    expect(h.facilitator.chain.settlements[0]!.to.toLowerCase()).toBe(PAY_TO);
    expect(res.headers.get("cache-control")).toContain("private");
  });

  it("structured extraction returns the stable schema and settles $0.005", async () => {
    const h = harness(routes);
    const payFetch = wrapFetchWithPayment(h.appFetch, payingClient().client);
    const res = await payFetch("https://agentread.test/v1/extract/structured", postJson({ url: PAGE }));
    expect(res.status).toBe(200);
    const result = structuredResultSchema.parse(await res.json());
    expect(result.metadata.canonicalUrl).toBe("https://ocean.example.com/guides/tide-pools");
    expect(result.metadata.language).toBe("en-GB");
    expect(result.links.length).toBeGreaterThan(0);
    expect(result.headings.some((x) => x.level === 3 && x.text === "Field tips")).toBe(true);
    expect(h.facilitator.chain.settlements[0]!.value).toBe(5000n);
    expect(decodePaymentResponseHeader(res.headers.get("payment-response")!).success).toBe(true);
  });

  it("does not settle when extraction fails after payment verification (upstream 404)", async () => {
    const h = harness({ [PAGE]: { status: 404, body: "<h1>Not found</h1>", headers: { "content-type": "text/html" } } });
    const payFetch = wrapFetchWithPayment(h.appFetch, payingClient().client);
    const res = await payFetch("https://agentread.test/v1/extract", postJson({ url: PAGE }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string; details: { status: number } } }).error).toMatchObject({
      code: "upstream_http_error",
      details: { status: 404 },
    });
    expect(h.facilitator.calls.verify).toBe(1);
    expect(h.facilitator.calls.settle).toBe(0);
    expect(h.facilitator.chain.settlements).toHaveLength(0);
    expect(res.headers.get("payment-response")).toBeNull();
  });

  it("does not settle when the page requires JavaScript", async () => {
    const { SPA_HTML } = await import("../fixtures/pages.js");
    const h = harness({ [PAGE]: html(SPA_HTML) });
    const res = await wrapFetchWithPayment(h.appFetch, payingClient().client)("https://agentread.test/v1/extract", postJson({ url: PAGE }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("javascript_required");
    expect(h.facilitator.chain.settlements).toHaveLength(0);
  });

  it("does not settle on upstream timeout", async () => {
    const h = harness({ [PAGE]: { hang: true } });
    const res = await wrapFetchWithPayment(h.appFetch, payingClient().client)("https://agentread.test/v1/extract", postJson({ url: PAGE }));
    expect(res.status).toBe(504);
    expect(h.facilitator.chain.settlements).toHaveLength(0);
  });

  it("withholds content when settlement fails on-chain (tx reverted)", async () => {
    const h = harness(routes);
    h.facilitator.chain.settleMode = "revert";
    const sig = await signFor(await h.fetch("/v1/extract", postJson({ url: PAGE })));
    const res = await h.fetch("/v1/extract", postJson({ url: PAGE }, { "payment-signature": sig }));
    expect(res.status).toBe(402);
    const text = await res.text();
    expect(text).toContain("payment_settlement_failed");
    expect(text).not.toContain("Tide pools are shallow");
    expect(h.facilitator.chain.settlements).toHaveLength(0);
  });

  it("withholds content when the settlement RPC errors", async () => {
    const h = harness(routes);
    h.facilitator.chain.settleMode = "throw";
    const sig = await signFor(await h.fetch("/v1/extract", postJson({ url: PAGE })));
    const res = await h.fetch("/v1/extract", postJson({ url: PAGE }, { "payment-signature": sig }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).not.toContain("Tide pools are shallow");
  });

  it("fails closed when the facilitator is unreachable", async () => {
    const h = harness(routes);
    h.facilitator.supportedFails = true;
    const res = await h.fetch("/v1/extract", postJson({ url: PAGE }));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(h.upstream.calls).toHaveLength(0);
  });
});

describe("x402 on HTTP — lite engine (EXTRACTION_ENGINE=lite)", () => {
  const converter = async () => "---\ntitle: T\n---\n\n<!doctype html>\n\n## Converted heading\n\nConverted body text that is long enough to count as content.";

  it("paid extraction uses the converter and settles", async () => {
    const h = harness(routes, { EXTRACTION_ENGINE: "lite" }, undefined, converter);
    const res = await wrapFetchWithPayment(h.appFetch, payingClient().client)("https://agentread.test/v1/extract", postJson({ url: PAGE }));
    expect(res.status).toBe(200);
    const r = extractResultSchema.parse(await res.json());
    expect(r.extraction.method).toBe("lite");
    expect(r.markdown).toBe("## Converted heading\n\nConverted body text that is long enough to count as content.");
    expect(r.title).toBe("How Tide Pools Work | Ocean Notes"); // from <head>, not the converter
    expect(h.facilitator.chain.settlements).toHaveLength(1);
  });

  it("converter outage → error, not charged", async () => {
    const h = harness(routes, { EXTRACTION_ENGINE: "lite" }, undefined, async () => {
      const { AppError } = await import("../../src/utils/errors.js");
      throw new AppError("internal_error", "The Markdown conversion service is unavailable. Try again later.");
    });
    const res = await wrapFetchWithPayment(h.appFetch, payingClient().client)("https://agentread.test/v1/extract", postJson({ url: PAGE }));
    expect(res.status).toBe(500);
    expect(h.facilitator.chain.settlements).toHaveLength(0);
  });

  it("rejects an unknown engine name at config time", async () => {
    const h = harness(routes, { EXTRACTION_ENGINE: "turbo" });
    expect((await h.fetch("/health")).status).toBe(500);
  });
});

describe("x402 on HTTP — Bazaar declaration ordering", () => {
  // @x402/hono validates Bazaar route metadata with ajv only if routes declare it when the
  // middleware is created; ajv code generation is forbidden on Workers (the test runtime
  // allows it, so the failure itself is only observable in wrangler dev / production).
  it("routes carry no Bazaar declaration at middleware creation; attaching adds it", async () => {
    const { checkIfBazaarNeeded } = await import("@x402/core/server");
    const { paidRoutes } = await import("../../src/payments/x402.js");
    const { attachHttpDiscovery } = await import("../../src/payments/discovery.js");
    const { loadPaymentConfig, DEFAULT_LIMITS } = await import("../../src/config/env.js");
    const { TEST_ENV } = await import("../helpers/app.js");
    const routes = paidRoutes(loadPaymentConfig(TEST_ENV, "test")) as Record<string, { extensions?: Record<string, unknown> }>;
    expect(checkIfBazaarNeeded(routes as never)).toBe(false);
    attachHttpDiscovery(routes, { "POST /v1/extract": "extract_url", "POST /v1/extract/structured": "extract_url_structured" }, DEFAULT_LIMITS);
    expect(checkIfBazaarNeeded(routes as never)).toBe(true);
  });
});
