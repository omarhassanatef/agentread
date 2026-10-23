import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, loadConfig, loadPaymentConfig, type Bindings } from "../../src/config/env.js";
import { paidRoutes, priceFor } from "../../src/payments/x402.js";
import { AppError, errorBody, toAppError } from "../../src/utils/errors.js";
import { extractInputSchema, inspectInputSchema } from "../../src/schemas/index.js";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const testnet: Bindings = {
  ENVIRONMENT: "testnet",
  X402_NETWORK: "eip155:84532",
  X402_PAY_TO: PAY_TO,
  X402_FACILITATOR_URL: "https://x402.org/facilitator",
  PRICE_EXTRACT_USD: "0.003",
  PRICE_EXTRACT_STRUCTURED_USD: "0.005",
};

describe("payment configuration", () => {
  it("parses a valid testnet config into SDK dollar prices", () => {
    const cfg = loadPaymentConfig(testnet, "testnet");
    expect(cfg.network).toBe("eip155:84532");
    expect(cfg.prices).toEqual({ extract: "$0.003", extractStructured: "$0.005" });
    expect(priceFor(cfg, "extract_url")).toBe("$0.003");
    expect(priceFor(cfg, "extract_url_structured")).toBe("$0.005");
  });

  it("builds x402 routes with the configured price, network and recipient", () => {
    const routes = paidRoutes(loadPaymentConfig(testnet, "testnet")) as unknown as Record<string, { accepts: Record<string, unknown> }>;
    expect(Object.keys(routes)).toEqual(["POST /v1/extract", "POST /v1/extract/structured"]);
    expect(routes["POST /v1/extract"]!.accepts).toMatchObject({ scheme: "exact", price: "$0.003", network: "eip155:84532", payTo: PAY_TO });
    expect(routes["POST /v1/extract/structured"]!.accepts).toMatchObject({ price: "$0.005" });
  });

  const bad: Array<[string, Bindings, string, RegExp]> = [
    ["unknown network", { ...testnet, X402_NETWORK: "eip155:1" }, "testnet", /not supported/],
    ["mainnet outside production", { ...testnet, X402_NETWORK: "eip155:8453" }, "testnet", /requires ENVIRONMENT=production/],
    ["testnet in production", testnet, "production", /requires a mainnet/],
    ["zero-address placeholder", { ...testnet, X402_PAY_TO: "0x0000000000000000000000000000000000000000" }, "testnet", /zero address/],
    ["malformed address", { ...testnet, X402_PAY_TO: "0x1234" }, "testnet", /EVM address/],
    ["too many decimals", { ...testnet, PRICE_EXTRACT_USD: "0.0000001" }, "testnet", /6 decimals/],
    ["zero price", { ...testnet, PRICE_EXTRACT_USD: "0" }, "testnet", /> 0/],
    ["absurd price", { ...testnet, PRICE_EXTRACT_STRUCTURED_USD: "5" }, "testnet", /<= 1/],
    ["non-https facilitator", { ...testnet, X402_FACILITATOR_URL: "http://x402.org/facilitator" }, "testnet", /https/],
    [
      "testnet facilitator for mainnet",
      { ...testnet, ENVIRONMENT: "production", X402_NETWORK: "eip155:8453" },
      "production",
      /only supports testnets/,
    ],
    [
      "CDP facilitator without keys",
      { ...testnet, ENVIRONMENT: "production", X402_NETWORK: "eip155:8453", X402_FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402" },
      "production",
      /CDP_API_KEY_ID/,
    ],
  ];
  for (const [name, env, environment, msg] of bad) {
    it(`rejects ${name}`, () => {
      expect(() => loadPaymentConfig(env, environment as never)).toThrow(msg);
    });
  }

  it("accepts a production CDP config with secrets", () => {
    const cfg = loadPaymentConfig(
      {
        ...testnet,
        X402_NETWORK: "eip155:8453",
        X402_FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
        CDP_API_KEY_ID: "id",
        CDP_API_KEY_SECRET: "secret",
      },
      "production",
    );
    expect(cfg.network).toBe("eip155:8453");
  });

  it("loadConfig fails closed: bad payment config disables payments but not the service", () => {
    const cfg = loadConfig({ ...testnet, X402_PAY_TO: "" });
    expect(cfg.payment).toBeNull();
    expect(cfg.paymentConfigError).toMatch(/X402_PAY_TO/);
    expect(cfg.limits).toEqual(DEFAULT_LIMITS);
  });

  it("validates numeric limits", () => {
    expect(() => loadConfig({ ...testnet, FETCH_TIMEOUT_MS: "abc" })).toThrow(/invalid integer/);
    expect(loadConfig({ ...testnet, MAX_REDIRECTS: "2" }).limits.maxRedirects).toBe(2);
  });
});

describe("input schemas", () => {
  const ex = extractInputSchema(DEFAULT_LIMITS);
  it("accepts minimal and full input", () => {
    expect(ex.parse({ url: "https://a.example.com" })).toEqual({ url: "https://a.example.com" });
    expect(ex.parse({ url: "https://a.example.com", maxCharacters: 500, includeLinks: false }).includeLinks).toBe(false);
  });
  it("rejects bad types, limits and unknown fields", () => {
    expect(ex.safeParse({}).success).toBe(false);
    expect(ex.safeParse({ url: 5 }).success).toBe(false);
    expect(ex.safeParse({ url: "https://a.example.com", maxCharacters: 50 }).success).toBe(false);
    expect(ex.safeParse({ url: "https://a.example.com", maxCharacters: DEFAULT_LIMITS.maxCharactersLimit + 1 }).success).toBe(false);
    expect(ex.safeParse({ url: "https://a.example.com", maxCharacters: 1.5 }).success).toBe(false);
    expect(ex.safeParse({ url: "https://a.example.com", includeLinks: "yes" }).success).toBe(false);
    expect(ex.safeParse({ url: "https://a.example.com", paymentVerified: true }).success).toBe(false);
    expect(inspectInputSchema(DEFAULT_LIMITS).safeParse({ url: "x".repeat(3000) }).success).toBe(false);
  });
});

describe("error normalisation", () => {
  it("passes AppErrors through with their status", () => {
    const e = toAppError(new AppError("upstream_timeout", "slow"));
    expect(e.status).toBe(504);
    expect(errorBody(e)).toEqual({ error: { code: "upstream_timeout", message: "slow" } });
  });
  it("hides details of unexpected errors", () => {
    const e = toAppError(new Error("ECONNREFUSED 10.0.0.3:5432 secret=abc"));
    expect(e.code).toBe("internal_error");
    expect(e.status).toBe(500);
    expect(JSON.stringify(errorBody(e))).not.toMatch(/10\.0\.0\.3|secret/);
  });
});
