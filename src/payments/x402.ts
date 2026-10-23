import { createFacilitatorConfig } from "@coinbase/x402";
import {
  HTTPFacilitatorClient,
  x402ResourceServer,
  type FacilitatorClient,
  type HTTPRequestContext,
  type RoutesConfig,
} from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { CDP_FACILITATOR_URL, SUPPORTED_NETWORKS, type PaymentConfig } from "../config/env.js";
import { DISCOVERY_TAGS } from "./discovery.js";
import { logError, logEvent, payerId } from "../utils/log.js";

/** Paid operations and the HTTP routes that sell them. Single source of truth for pricing. */
export const PAID_OPERATIONS = {
  extract_url: { method: "POST", path: "/v1/extract", priceKey: "extract" },
  extract_url_structured: { method: "POST", path: "/v1/extract/structured", priceKey: "extractStructured" },
} as const;
export type PaidOperation = keyof typeof PAID_OPERATIONS;

export function priceFor(cfg: PaymentConfig, op: PaidOperation): string {
  return cfg.prices[PAID_OPERATIONS[op].priceKey];
}

/** How long a facilitator's /supported response is reused within one isolate. */
const SUPPORTED_TTL_MS = 10 * 60 * 1000;
const supportedCache = new Map<string, { value: SupportedResponse; expires: number }>();

/**
 * Wraps a facilitator so `getSupported()` is fetched at most once per TTL per isolate.
 * Only the *resolved JSON* is cached (never a pending promise): Workers forbids sharing
 * I/O between requests, so the resource server itself is rebuilt for every request.
 */
export class CachedSupportedFacilitator implements FacilitatorClient {
  constructor(
    private readonly inner: FacilitatorClient,
    private readonly cacheKey: string,
  ) {}

  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.inner.verify(payload, requirements);
  }

  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return this.inner.settle(payload, requirements);
  }

  async getSupported(): Promise<SupportedResponse> {
    const hit = supportedCache.get(this.cacheKey);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await this.inner.getSupported();
    supportedCache.set(this.cacheKey, { value, expires: Date.now() + SUPPORTED_TTL_MS });
    return value;
  }
}

export function clearSupportedCache(): void {
  supportedCache.clear();
}

/** CDP facilitator (mainnet) gets JWT auth from @coinbase/x402; anything else is a plain HTTP facilitator. */
export function createFacilitatorClient(cfg: PaymentConfig): FacilitatorClient {
  const inner =
    cfg.facilitatorUrl === CDP_FACILITATOR_URL
      ? new HTTPFacilitatorClient(createFacilitatorConfig(cfg.cdpApiKeyId, cfg.cdpApiKeySecret))
      : new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });
  return new CachedSupportedFacilitator(inner, cfg.facilitatorUrl);
}

/** Resource server for one request, with privacy-preserving payment logging hooks. */
export function createResourceServer(cfg: PaymentConfig, facilitator: FacilitatorClient): x402ResourceServer {
  const server = new x402ResourceServer(facilitator).register(cfg.network, new ExactEvmScheme());
  server.registerExtension(bazaarResourceServerExtension);

  server.onAfterVerify(async ({ result, requirements }) => {
    if (!result.isValid) {
      logEvent("payment.verify_rejected", {
        network: requirements.network,
        amount: requirements.amount,
        reason: result.invalidReason ?? null,
        payer: (await payerId(result.payer)) ?? null,
      });
    }
  });
  server.onVerifyFailure(async ({ requirements, error }) => {
    logError("payment.verify_error", { network: requirements.network, error: error.name });
  });
  server.onAfterSettle(async ({ result, requirements }) => {
    logEvent(result.success ? "payment.settled" : "payment.settle_rejected", {
      network: result.network,
      amount: requirements.amount,
      transaction: result.transaction || null, // public on-chain hash
      reason: result.errorReason ?? null,
      payer: (await payerId(result.payer)) ?? null,
    });
  });
  server.onSettleFailure(async ({ requirements, error }) => {
    logError("payment.settle_error", { network: requirements.network, amount: requirements.amount, error: error.name });
  });
  return server;
}

function unpaidBody(cfg: PaymentConfig, op: PaidOperation) {
  return (_ctx: HTTPRequestContext) => ({
    contentType: "application/json",
    body: {
      error: {
        code: "payment_required",
        message: `This operation costs ${priceFor(cfg, op)} (USDC on ${SUPPORTED_NETWORKS[cfg.network].name}). Retry with an x402 PAYMENT-SIGNATURE header; requirements are in the PAYMENT-REQUIRED response header.`,
        details: { operation: op, price: priceFor(cfg, op), network: cfg.network, x402Version: 2 },
      },
    },
  });
}

function settlementFailedBody(op: PaidOperation) {
  return () => ({
    contentType: "application/json",
    body: {
      error: {
        code: "payment_settlement_failed",
        message:
          "Payment settlement failed, so no content was returned. You may retry with a new payment authorization. AgentRead does not issue automatic refunds; if a transfer for this authorization appears on-chain, contact the operator.",
        details: { operation: op },
      },
    },
  });
}

/** x402 route table for @x402/hono's paymentMiddleware. */
export function paidRoutes(cfg: PaymentConfig): RoutesConfig {
  const route = (op: PaidOperation, description: string) => ({
    accepts: {
      scheme: "exact",
      price: priceFor(cfg, op),
      network: cfg.network,
      payTo: cfg.payTo,
      maxTimeoutSeconds: 120,
    },
    description,
    mimeType: "application/json",
    serviceName: "AgentRead",
    tags: DISCOVERY_TAGS,
    // Bazaar `extensions` are attached after middleware creation (see attachHttpDiscovery).
    unpaidResponseBody: unpaidBody(cfg, op),
    settlementFailedResponseBody: settlementFailedBody(op),
  });
  return {
    [`${PAID_OPERATIONS.extract_url.method} ${PAID_OPERATIONS.extract_url.path}`]: route(
      "extract_url",
      "Clean Markdown extraction of a public web page.",
    ),
    [`${PAID_OPERATIONS.extract_url_structured.method} ${PAID_OPERATIONS.extract_url_structured.path}`]: route(
      "extract_url_structured",
      "Structured extraction (metadata, Markdown, headings, links) of a public web page.",
    ),
  };
}
