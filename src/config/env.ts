import { z } from "zod";

/**
 * Worker bindings. Vars come from wrangler.jsonc, secrets from `wrangler secret put`
 * (or .dev.vars locally). Everything is optional at the type level and validated by
 * `loadConfig` so a misconfigured deployment fails closed instead of misbehaving.
 */
export interface Bindings {
  ENVIRONMENT?: string;
  X402_NETWORK?: string;
  X402_PAY_TO?: string;
  X402_FACILITATOR_URL?: string;
  PRICE_EXTRACT_USD?: string;
  PRICE_EXTRACT_STRUCTURED_USD?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  DNS_CHECK?: string;
  DOH_URL?: string;
  FETCH_TIMEOUT_MS?: string;
  MAX_RESPONSE_BYTES?: string;
  INSPECT_MAX_BYTES?: string;
  MAX_REDIRECTS?: string;
  MAX_URL_LENGTH?: string;
  MAX_REQUEST_BODY_BYTES?: string;
  DEFAULT_MAX_CHARACTERS?: string;
  MAX_CHARACTERS_LIMIT?: string;
  MAX_LINKS?: string;
  MAX_HEADINGS?: string;
  INSPECT_RATE_LIMITER?: RateLimit;
  PAID_RATE_LIMITER?: RateLimit;
}

export const SERVICE_NAME = "AgentRead";
export const SERVICE_VERSION = "0.1.0";

/** Networks this service knows how to price. Verified against docs.x402.org (Oct 2026). */
export const SUPPORTED_NETWORKS = {
  "eip155:84532": { name: "Base Sepolia", testnet: true },
  "eip155:8453": { name: "Base", testnet: false },
} as const;
export type SupportedNetwork = keyof typeof SUPPORTED_NETWORKS;

export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
export const TESTNET_FACILITATOR_URL = "https://x402.org/facilitator";

/** Hard ceiling on any configured price, to catch typos like "3" instead of "0.003". */
const MAX_PRICE_USD = 1;

export interface Limits {
  fetchTimeoutMs: number;
  maxResponseBytes: number;
  inspectMaxBytes: number;
  maxRedirects: number;
  maxUrlLength: number;
  maxRequestBodyBytes: number;
  defaultMaxCharacters: number;
  maxCharactersLimit: number;
  maxLinks: number;
  maxHeadings: number;
}

export const DEFAULT_LIMITS: Limits = {
  fetchTimeoutMs: 10_000,
  maxResponseBytes: 3_000_000,
  inspectMaxBytes: 65_536,
  maxRedirects: 5,
  maxUrlLength: 2048,
  maxRequestBodyBytes: 8192,
  defaultMaxCharacters: 20_000,
  maxCharactersLimit: 100_000,
  maxLinks: 200,
  maxHeadings: 100,
};

export interface PaymentConfig {
  network: SupportedNetwork;
  payTo: `0x${string}`;
  facilitatorUrl: string;
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
  /** Dollar-string prices in the format the x402 SDK expects, e.g. "$0.003". */
  prices: { extract: string; extractStructured: string };
}

export interface AppConfig {
  environment: "development" | "testnet" | "production" | "test";
  limits: Limits;
  dnsCheck: "doh" | "off";
  dohUrl: string;
  /** null when payments are misconfigured; `paymentConfigError` explains why. */
  payment: PaymentConfig | null;
  paymentConfigError: string | null;
}

const priceSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,6})?$/, "must be a decimal USD amount with at most 6 decimals (USDC precision)")
  .refine((v) => Number(v) > 0 && Number(v) <= MAX_PRICE_USD, `must be > 0 and <= ${MAX_PRICE_USD}`);

const addressSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte EVM address")
  .refine((v) => !/^0x0{40}$/.test(v), "must not be the zero address placeholder");

function intVar(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`invalid integer config value "${raw}" (expected ${min}..${max})`);
  }
  return n;
}

export function loadLimits(env: Bindings): Limits {
  const d = DEFAULT_LIMITS;
  return {
    fetchTimeoutMs: intVar(env.FETCH_TIMEOUT_MS, d.fetchTimeoutMs, 1000, 30_000),
    maxResponseBytes: intVar(env.MAX_RESPONSE_BYTES, d.maxResponseBytes, 10_000, 10_000_000),
    inspectMaxBytes: intVar(env.INSPECT_MAX_BYTES, d.inspectMaxBytes, 1024, 262_144),
    maxRedirects: intVar(env.MAX_REDIRECTS, d.maxRedirects, 0, 10),
    maxUrlLength: intVar(env.MAX_URL_LENGTH, d.maxUrlLength, 64, 8192),
    maxRequestBodyBytes: intVar(env.MAX_REQUEST_BODY_BYTES, d.maxRequestBodyBytes, 512, 65_536),
    defaultMaxCharacters: intVar(env.DEFAULT_MAX_CHARACTERS, d.defaultMaxCharacters, 100, 500_000),
    maxCharactersLimit: intVar(env.MAX_CHARACTERS_LIMIT, d.maxCharactersLimit, 100, 500_000),
    maxLinks: intVar(env.MAX_LINKS, d.maxLinks, 0, 2000),
    maxHeadings: intVar(env.MAX_HEADINGS, d.maxHeadings, 0, 1000),
  };
}

export function loadPaymentConfig(env: Bindings, environment: AppConfig["environment"]): PaymentConfig {
  const network = (env.X402_NETWORK ?? "").trim();
  if (!(network in SUPPORTED_NETWORKS)) {
    throw new Error(`X402_NETWORK "${network}" is not supported (supported: ${Object.keys(SUPPORTED_NETWORKS).join(", ")})`);
  }
  const net = network as SupportedNetwork;
  const isTestnet = SUPPORTED_NETWORKS[net].testnet;

  // Make the testnet/production switch explicit and impossible to cross by accident.
  if (environment === "production" && isTestnet) {
    throw new Error("ENVIRONMENT=production requires a mainnet X402_NETWORK");
  }
  if (environment !== "production" && !isTestnet) {
    throw new Error(`mainnet X402_NETWORK requires ENVIRONMENT=production (got ${environment})`);
  }

  const payTo = addressSchema.safeParse(env.X402_PAY_TO ?? "");
  if (!payTo.success) throw new Error(`X402_PAY_TO ${payTo.error.issues[0]?.message ?? "is invalid"}`);

  const extract = priceSchema.safeParse(env.PRICE_EXTRACT_USD ?? "");
  if (!extract.success) throw new Error(`PRICE_EXTRACT_USD ${extract.error.issues[0]?.message}`);
  const structured = priceSchema.safeParse(env.PRICE_EXTRACT_STRUCTURED_USD ?? "");
  if (!structured.success) throw new Error(`PRICE_EXTRACT_STRUCTURED_USD ${structured.error.issues[0]?.message}`);

  const facilitatorUrl = (env.X402_FACILITATOR_URL ?? "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^\s]+$/.test(facilitatorUrl)) {
    throw new Error("X402_FACILITATOR_URL must be an https URL");
  }
  if (!isTestnet && facilitatorUrl === TESTNET_FACILITATOR_URL) {
    throw new Error("x402.org/facilitator only supports testnets; configure a mainnet facilitator");
  }
  const cdpApiKeyId = env.CDP_API_KEY_ID?.trim() || undefined;
  const cdpApiKeySecret = env.CDP_API_KEY_SECRET?.trim() || undefined;
  if (facilitatorUrl === CDP_FACILITATOR_URL && (!cdpApiKeyId || !cdpApiKeySecret)) {
    throw new Error("the CDP facilitator requires CDP_API_KEY_ID and CDP_API_KEY_SECRET secrets");
  }

  return {
    network: net,
    payTo: payTo.data as `0x${string}`,
    facilitatorUrl,
    cdpApiKeyId,
    cdpApiKeySecret,
    prices: { extract: `$${extract.data}`, extractStructured: `$${structured.data}` },
  };
}

export function loadConfig(env: Bindings): AppConfig {
  const rawEnv = (env.ENVIRONMENT ?? "development").trim();
  const environment = (["development", "testnet", "production", "test"] as const).find((e) => e === rawEnv);
  if (!environment) throw new Error(`ENVIRONMENT "${rawEnv}" is not recognised`);

  let payment: PaymentConfig | null = null;
  let paymentConfigError: string | null = null;
  try {
    payment = loadPaymentConfig(env, environment);
  } catch (err) {
    paymentConfigError = err instanceof Error ? err.message : String(err);
  }

  const dnsCheck = (env.DNS_CHECK ?? "doh").trim() === "off" ? "off" : "doh";
  return {
    environment,
    limits: loadLimits(env),
    dnsCheck,
    dohUrl: env.DOH_URL?.trim() || "https://cloudflare-dns.com/dns-query",
    payment,
    paymentConfigError,
  };
}
