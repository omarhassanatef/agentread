import type { FacilitatorClient } from "@x402/core/server";
import { loadConfig, type AppConfig, type Bindings } from "../config/env.js";
import type { Services } from "../extraction/operations.js";
import { createDohHostGuard, noopHostGuard, type Fetcher, type HostGuard } from "../security/dns.js";
import { workersAiConverter, type MarkdownConverter } from "../extraction/lite.js";
import { durableFreeTier, type FreeTier } from "../payments/free-tier.js";
import { logError } from "../utils/log.js";
import { createFacilitatorClient } from "../payments/x402.js";
import { AppError } from "../utils/errors.js";

/** Injection points. Production uses the defaults; tests replace the network edges. */
export interface AppDeps {
  /** Outbound fetch for target pages and DoH lookups. */
  fetcher?: Fetcher;
  /** Overrides the DNS guard (default: DoH when DNS_CHECK=doh). */
  hostGuard?: HostGuard;
  /** Overrides the x402 facilitator (default: HTTP facilitator from config). */
  facilitator?: FacilitatorClient;
  /** Overrides the lite engine's Markdown converter (default: Workers AI toMarkdown). */
  markdownConverter?: MarkdownConverter;
  /** Overrides the free daily allowance (default: FREE_QUOTA Durable Object; absent → no free tier). */
  freeTier?: FreeTier | null;
}

const configCache = new WeakMap<object, AppConfig>();

export function getConfig(env: Bindings): AppConfig {
  let cfg = configCache.get(env);
  if (!cfg) {
    cfg = loadConfig(env);
    configCache.set(env, cfg);
  }
  return cfg;
}

/** Memoise DNS checks within one request so redirect hops / pre-validation do not repeat lookups. */
function memoizeGuard(guard: HostGuard): HostGuard {
  const seen = new Map<string, Promise<void>>();
  return (hostname, signal) => {
    let p = seen.get(hostname);
    if (!p) {
      p = guard(hostname, signal);
      seen.set(hostname, p);
    }
    return p;
  };
}

/** Per-request services. Built per request because Workers I/O cannot be shared across requests. */
export function createServices(cfg: AppConfig, deps: AppDeps, env: Bindings = {}): Services {
  const fetcher: Fetcher = deps.fetcher ?? ((input, init) => fetch(input, init));
  const guard = deps.hostGuard ?? (cfg.dnsCheck === "doh" ? createDohHostGuard(fetcher, cfg.dohUrl) : noopHostGuard);
  const svc: Services = { fetcher, hostGuard: memoizeGuard(guard), limits: cfg.limits };
  if (cfg.engine === "lite") {
    const converter = deps.markdownConverter ?? (env.AI ? workersAiConverter(env.AI) : undefined);
    if (converter) svc.markdownConverter = converter;
    else logError("config.lite_engine_without_ai", { fallback: "readability" });
  }
  return svc;
}

export function getFacilitator(cfg: AppConfig, deps: AppDeps): FacilitatorClient {
  if (!cfg.payment) throw paymentsUnavailable();
  return deps.facilitator ?? createFacilitatorClient(cfg.payment);
}

export function paymentsUnavailable(): AppError {
  return new AppError("payments_unavailable", "Paid operations are temporarily unavailable on this deployment.");
}

/** Best-effort per-location rate limiting via the Workers Rate Limiting binding, if bound. */
export async function checkRateLimit(limiter: RateLimit | undefined, key: string): Promise<void> {
  if (!limiter) return;
  let success = true;
  try {
    ({ success } = await limiter.limit({ key }));
  } catch {
    return; // never fail a request because the limiter is unavailable
  }
  if (!success) throw new AppError("rate_limited", "Too many requests. Slow down and retry shortly.");
}

export function clientKey(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

/** Free daily allowance for paid operations, or null when disabled / not bound. */
export function getFreeTier(cfg: AppConfig, deps: AppDeps, env: Bindings): FreeTier | null {
  if (deps.freeTier !== undefined) return deps.freeTier;
  if (!env.FREE_QUOTA || cfg.freeTier.perClient <= 0) return null;
  return durableFreeTier(env.FREE_QUOTA, cfg.freeTier.perClient, cfg.freeTier.global);
}

/** True when the request carries an x402 payment (such requests never use the free allowance). */
export function hasPaymentHeader(req: Request): boolean {
  return req.headers.has("payment-signature") || req.headers.has("x-payment");
}
