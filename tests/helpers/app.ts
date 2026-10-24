import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../../src/api/app.js";
import type { Bindings } from "../../src/config/env.js";
import type { HostGuard } from "../../src/security/dns.js";
import type { MarkdownConverter } from "../../src/extraction/lite.js";
import type { FreeTier } from "../../src/payments/free-tier.js";
import { LocalFacilitator } from "./facilitator.js";
import { mockUpstream, type UpstreamRoute } from "./upstream.js";

export const PAY_TO = "0x1111111111111111111111111111111111111111";
export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export const TEST_ENV: Bindings = {
  ENVIRONMENT: "test",
  X402_NETWORK: "eip155:84532",
  X402_PAY_TO: PAY_TO,
  X402_FACILITATOR_URL: "https://x402.org/facilitator",
  PRICE_EXTRACT_USD: "0.003",
  PRICE_EXTRACT_STRUCTURED_USD: "0.005",
  DNS_CHECK: "off",
  FETCH_TIMEOUT_MS: "1000",
};

export interface Harness {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** A fetch-compatible function bound to the app (for SDK clients). */
  appFetch: typeof globalThis.fetch;
  facilitator: LocalFacilitator;
  upstream: ReturnType<typeof mockUpstream>;
  env: Bindings;
}

export function harness(
  routes: Record<string, UpstreamRoute> = {},
  envOverrides: Partial<Bindings> = {},
  hostGuard?: HostGuard,
  markdownConverter?: MarkdownConverter,
  freeTier?: FreeTier | null,
): Harness {
  const upstream = mockUpstream(routes);
  const facilitator = new LocalFacilitator();
  const app = createApp({ fetcher: upstream.fetcher, hostGuard: hostGuard ?? (async () => {}), facilitator, ...(markdownConverter ? { markdownConverter } : {}), freeTier: freeTier ?? null });
  // A fresh env object per harness → fresh config cache entry.
  const env: Bindings = { ...TEST_ENV, ...envOverrides };
  const appFetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    app.fetch(new Request(input as RequestInfo, init), env)) as typeof globalThis.fetch;
  return {
    fetch: (path, init) => appFetch(`https://agentread.test${path}`, init),
    appFetch,
    facilitator,
    upstream,
    env,
  };
}

export function postJson(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

/** A real x402 client with a throwaway local wallet (signatures are genuine EIP-712). */
export function payingClient() {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client().register("eip155:84532", new ExactEvmScheme(toClientEvmSigner(account)));
  return { account, client };
}
