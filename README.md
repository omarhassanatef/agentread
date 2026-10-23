# AgentRead

**Clean web content for AI agents, paid per request.**

AgentRead is a Cloudflare Worker that turns public web pages into clean, structured Markdown for LLMs and autonomous agents. It is exposed as both an HTTP API and a remote MCP server. Paid operations are charged per successful request with [x402](https://docs.x402.org) micropayments (USDC on Base). There are no accounts, API keys or subscriptions.

| Operation | HTTP | MCP tool | Price (default) |
|---|---|---|---|
| Inspect a URL | `POST /v1/inspect` | `inspect_url` | free |
| Clean Markdown extraction | `POST /v1/extract` | `extract_url` | $0.003 |
| Structured extraction | `POST /v1/extract/structured` | `extract_url_structured` | $0.005 |

Prices are configuration, not code (see [Configuration](#configuration)).

> **Status: MVP, live.**
> - **Production (Base mainnet, real USDC):** https://agentread.omar-cv.workers.dev. Payments settle via the CDP facilitator to `0xb866dD8C8401438Efb29b538ec4df11b6b407Ce6`.
> - **Testnet:** no hosted testnet. `npm run dev` runs locally against Base Sepolia and the free x402.org facilitator.
>
> What has been verified:
> - **Automated tests:** all pass (233 tests, run inside the Workers runtime).
> - **Local smoke test (9/9):** run against `wrangler dev` using the **live x402.org facilitator**. A genuinely signed payment from an unfunded wallet passes signature and requirement checks and is rejected for `insufficient_balance`, so the live wire path is proven up to the transfer itself.
> - **Production deployment:** passes all smoke checks from GitHub Actions (`gh workflow run CI`). The live CDP facilitator authenticates AgentRead and verifies signed payments. The development network blocks the `workers.dev` IP range, hence the CI vantage point.
> - **Runs on the Workers Free plan.** The deployed `lite` engine had no CPU-limit kills in about 180 benchmark requests on Cloudflare's edge (Free account); the `readability` engine was killed in up to 84% of them. See [Extraction engines](#extraction-engines).
> - **Not yet exercised on the deployed edge:** a *paid* extraction through the product Worker. The same extraction code was benchmarked on the edge, but no funded payment has gone through.
>
> **A funded payment has not yet been made** (see [Testnet payment demo](#testnet-payment-demo)). Read [Limitations](#limitations) before relying on it.

---

## Why an agent would pay for this

Raw HTML is mostly noise: navigation, cookie banners, ads, scripts, styling. An agent that fetches pages itself wastes tokens and has to maintain HTML cleaning, SSRF protection, encoding detection, redirect handling and size limits. AgentRead does that once and returns predictable, versioned JSON.

x402 lets an agent pay a fraction of a cent per call from its own wallet. There is no sign-up and no stored credentials. Failed extractions are not charged.

That is a hypothesis to validate, not a proven market. The service logs the numbers needed to test it (see [Observability](#observability)).

## Architecture

```text
AI agent ──HTTP (x402 headers)──┐          ┌── POST /v1/inspect ──────────────┐
                                ▼          │                                  │
                      Cloudflare Worker (Hono)                                ▼
AI agent ──MCP Streamable HTTP──► /mcp ────┤   validate input + URL policy + DNS guard
          (x402 in _meta)                  │   (rejects bad input BEFORE any 402)
                                           │                                  │
                                           ├── POST /v1/extract[/structured]  │
                                           │      └─ @x402/hono paymentMiddleware ──► facilitator /verify
                                           │                                  │
                                           └── MCP paid tools                 ▼
                                                  └─ @x402/mcp wrapper    shared operations
                                                                          (inspectUrl / extractUrl /
                                                                           extractUrlStructured)
                                                                              │
                                                       bounded fetch (manual redirects, re-validated
                                                       each hop, timeout, byte cap) → linkedom →
                                                       boilerplate removal → Readability → Turndown
                                                                              │
                                     handler OK (2xx) → facilitator /settle → result + PAYMENT-RESPONSE
                                     handler failed   → settlement cancelled → error (not charged)
```

- **One Worker, no database, no queues, no containers.**
- The HTTP API and MCP tools call the same operation functions and validate with the same zod schemas.
- Payments use the official x402 v2 SDKs: `@x402/hono` for HTTP, `@x402/mcp` for MCP, and `@x402/evm` for the `exact` EVM scheme. No x402 protocol logic is reimplemented here.

More detail: [docs/architecture.md](docs/architecture.md) · [docs/payments.md](docs/payments.md) · [docs/security.md](docs/security.md) · [docs/demo.md](docs/demo.md)

## API

Machine-readable docs: `GET /` (discovery: operations, prices, limits) and `GET /openapi.json` (OpenAPI 3.1, generated from the zod schemas the service validates with).

All errors use one shape:

```json
{ "error": { "code": "blocked_destination", "message": "Internal, reserved, or loopback hostnames are not allowed.", "details": {} } }
```

### `GET /health`

```bash
curl -s http://localhost:8787/health
# {"status":"ok","service":"agentread","version":"0.1.0","environment":"development",
#  "payments":{"enabled":true,"network":"eip155:84532","networkName":"Base Sepolia"}}
```

### `POST /v1/inspect`: free

Checks reachability and extractability before you pay. It downloads at most 64 KB and builds no DOM. Upstream problems (timeouts, 404s, non-HTML) are reported in the 200 body as `reachable: false` or a `limitation`. Only invalid or blocked URLs return 4xx.

```bash
curl -s -X POST http://localhost:8787/v1/inspect \
  -H 'content-type: application/json' \
  -d '{"url":"https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/402"}'
```

```json
{
  "schemaVersion": "1.0", "operation": "inspect_url",
  "requestedUrl": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/402",
  "normalizedUrl": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/402",
  "hostname": "developer.mozilla.org", "reachable": true, "statusCode": 200,
  "finalUrl": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/402", "redirects": 1,
  "contentType": "text/html", "contentLength": 209180, "isHtml": true,
  "title": "402 Payment Required - HTTP | MDN", "mayRequireJavaScript": false,
  "extractionSupported": true, "limitation": null
}
```

### `POST /v1/extract`: paid

Request body (JSON, max 8 KB; unknown fields are rejected):

| Field | Type | Default | Notes |
|---|---|---|---|
| `url` | string | required | Absolute public `http(s)` URL, default port, no credentials, no IP literal, ≤ 2048 chars |
| `maxCharacters` | integer | 20000 | 100 – 100000; Markdown is cut at a paragraph boundary |
| `includeLinks` | boolean | true | `false` keeps link text but drops URLs and images |

Without payment, the response is **HTTP 402**. The `PAYMENT-REQUIRED` header carries the base64 x402 `PaymentRequired` object; the JSON body is a human/agent-readable summary:

```bash
curl -si -X POST http://localhost:8787/v1/extract \
  -H 'content-type: application/json' -d '{"url":"https://example.com/"}'
# HTTP/1.1 402 Payment Required
# payment-required: eyJ4NDAyVmVyc2lvbiI6Miwi...
# {"error":{"code":"payment_required","message":"This operation costs $0.003 (USDC on Base Sepolia). ...",
#   "details":{"operation":"extract_url","price":"$0.003","network":"eip155:84532","x402Version":2}}}
```

Decoded `PAYMENT-REQUIRED` (`accepts[0]`): `{"scheme":"exact","network":"eip155:84532","amount":"3000","asset":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","payTo":"<your address>","maxTimeoutSeconds":120,...}`. `3000` is $0.003 in 6-decimal USDC.

With a valid `PAYMENT-SIGNATURE` header, the response is **200** with a `PAYMENT-RESPONSE` header containing the settlement receipt:

Real output for `https://example.com/` (captured Oct 2026 by running the operation code directly):

```json
{
  "schemaVersion": "1.0", "operation": "extract_url",
  "requestedUrl": "https://example.com/", "finalUrl": "https://example.com/",
  "title": "Example Domain", "description": null,
  "markdown": "This domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes.",
  "headings": [], "truncated": false,
  "extraction": { "method": "readability", "statusCode": 200, "contentType": "text/html", "charset": "utf-8",
    "redirects": 0, "bytesFetched": 577, "characters": 156, "totalCharacters": 156, "words": 25,
    "warnings": [], "durationMs": 854 }
}
```

`extraction.method` is one of `readability`, `main-content-fallback`, `body-fallback`, `plain-text`.

### `POST /v1/extract/structured`: paid

Same request body as `/v1/extract`. Returns metadata, Markdown, headings and links separately:

```json
{
  "schemaVersion": "1.0", "operation": "extract_url_structured",
  "requestedUrl": "...", "finalUrl": "...",
  "metadata": { "title": "...", "description": "...", "canonicalUrl": "...", "language": "en-GB",
                "siteName": "...", "byline": "...", "publishedTime": "2026-03-14T09:00:00Z" },
  "markdown": "...",
  "headings": [{ "level": 2, "text": "Zones of the intertidal" }],
  "headingsTruncated": false,
  "links": [{ "text": "official tide tables", "url": "https://example.org/tide-tables" }],
  "linksTruncated": false,
  "truncated": false,
  "extraction": { "...": "same as extract_url" }
}
```

Missing metadata is `null`; nothing is guessed. `includeLinks` affects only the Markdown; `links` is always returned (max 200, deduplicated, absolute `http(s)` only).

### Status codes (paid endpoints)

| Status | Meaning | Charged? |
|---|---|---|
| 200 | Extraction succeeded and payment settled | yes |
| 400 | Invalid input / blocked destination (returned **before** any 402) | no |
| 402 | `payment_required` (no payment), `payment_invalid` (rejected: `details.reason` gives the facilitator's reason, e.g. `invalid_exact_evm_insufficient_balance`), or `payment_settlement_failed` | no |
| 413 / 415 | Body too large / not JSON | no |
| 422 | `unsupported_content_type`, `content_too_large`, `empty_content`, `javascript_required`, `too_many_redirects`, `host_not_found` | no |
| 429 | Rate limited | no |
| 502 / 504 | Upstream page error/unreachable, DNS failure, facilitator error / upstream timeout | no |
| 503 | Payments not configured on this deployment | no |

## Paying with an x402 client (HTTP)

The official `@x402/fetch` wrapper handles the 402 → sign → retry loop. This is [scripts/testnet-smoke.mjs](scripts/testnet-smoke.mjs), trimmed:

```js
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY); // TESTNET-ONLY wallet
const client = new x402Client().register("eip155:84532", new ExactEvmScheme(toClientEvmSigner(account)));
client.registerPolicy((_v, reqs) => reqs.filter((r) => BigInt(r.amount) <= 10_000n)); // never pay > $0.01

const payFetch = wrapFetchWithPayment(fetch, client);
const res = await payFetch("http://localhost:8787/v1/extract", { // `npm run dev` (Base Sepolia)
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "https://example.com/" }),
});
const result = await res.json();
const receipt = new x402HTTPClient(client).getPaymentSettleResponse((n) => res.headers.get(n));
console.log(result.markdown, receipt.transaction);
```

## MCP

Endpoint: `POST /mcp`, MCP **Streamable HTTP**, stateless (no sessions, JSON responses). `GET`/`DELETE` return 405, as the transport spec allows for servers without a server-initiated stream.

Payment over MCP follows the `@x402/mcp` transport convention, not HTTP headers:

1. Calling a paid tool without payment returns a tool result with `isError: true`. Its `structuredContent` is the x402 `PaymentRequired` object, also JSON-encoded in `content[0].text`.
2. The client signs and retries with the payment in `params._meta["x402/payment"]`.
3. The server verifies, runs the tool, then settles. The receipt is in `_meta["x402/payment-response"]`.

Invalid input and blocked URLs are rejected **before** a payment challenge. Tool results that fail (`isError`) are not settled.

Compatibility note: paid tools intentionally do **not** declare an `outputSchema`. MCP SDK clients validate `structuredContent` against `outputSchema` even on error results. That would reject the x402 payment challenge, which we observed with the official TypeScript client. Their output shape is described in the tool description and in `/openapi.json`. `inspect_url` does declare an `outputSchema`.

Connect and pay with the official client ([scripts/mcp-client-example.mjs](scripts/mcp-client-example.mjs)):

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { wrapMCPClientWithPayment } from "@x402/mcp";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);
const payments = new x402Client().register("eip155:84532", new ExactEvmScheme(toClientEvmSigner(account)));
const mcp = wrapMCPClientWithPayment(new Client({ name: "my-agent", version: "1.0.0" }), payments, {
  autoPayment: true,
  onPaymentRequested: async ({ paymentRequired }) => BigInt(paymentRequired.accepts[0].amount) <= 10_000n,
});
await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp")));

console.log((await mcp.listTools()).tools.map((t) => t.name));      // inspect_url, extract_url, extract_url_structured
const r = await mcp.callTool("extract_url", { url: "https://example.com/" });
console.log(r.paymentMade, r.paymentResponse?.transaction, r.content[0].text);
```

Paid MCP tools also carry x402 **Bazaar** discovery metadata (input and output schemas) in their payment challenge, so Bazaar-enabled facilitators can catalogue them. HTTP routes do not: `@x402/hono` 2.28 validates Bazaar route metadata with ajv, which compiles code at runtime. Workers forbids that, so it would log errors on every request. HTTP discovery is `GET /` + `/openapi.json`.

Generic MCP clients (IDEs, desktop apps) can connect to `/mcp` and use `inspect_url`. Paid tools work only with clients that implement the x402 MCP payment flow, such as `@x402/mcp`. Other clients see the payment challenge as a tool error. Universal agent-framework compatibility is **not** claimed.

## Local development

Requirements: Node.js ≥ 20 and npm.

```bash
npm install                    # see Troubleshooting if npm 10 fails with "edgesOut"
cp .dev.vars.example .dev.vars # set X402_PAY_TO to your testnet receiving address
npm run dev                    # wrangler dev on http://localhost:8787 (Base Sepolia, x402.org facilitator)
npm run smoke:local            # health, inspect, 402, SSRF rejection, MCP discovery (no payment)
```

| Script | What it does |
|---|---|
| `npm run dev` | Local Worker via `wrangler dev` (real workerd, real outbound network) |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm test` | Full Vitest suite inside workerd via `@cloudflare/vitest-plugin` |
| `npm run build` | Production bundle via `wrangler deploy --dry-run --outdir dist` |
| `npm run check` | typecheck + test + build |
| `npm run smoke:local` | Unpaid smoke test against `AGENTREAD_URL`, incl. a zero-cost live facilitator check (signed payment from an empty wallet must be rejected for insufficient balance) |
| `npm run smoke:testnet` | **Live** paid testnet test (needs `EVM_PRIVATE_KEY`) |
| `npm run smoke:mcp` | MCP discovery + free tool; paid call if `EVM_PRIVATE_KEY` is set |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc` |

## Configuration

Non-secret configuration lives in `wrangler.jsonc` (`vars`, per environment). Secrets go in `wrangler secret put` (deployed) or `.dev.vars` (local). Client-script settings are documented in `.env.example`.

| Variable | Required | Example / default | Notes |
|---|---|---|---|
| `ENVIRONMENT` | yes | `development` / `testnet` / `production` | Mainnet networks are only accepted when `production`; `production` only accepts mainnet |
| `X402_NETWORK` | yes | `eip155:84532` (Base Sepolia) / `eip155:8453` (Base) | CAIP-2 |
| `X402_PAY_TO` | yes | `0x…` | Public receiving address. The zero-address placeholder is rejected |
| `X402_FACILITATOR_URL` | yes | `https://x402.org/facilitator` (testnet) / `https://api.cdp.coinbase.com/platform/v2/x402` | `x402.org` is rejected for mainnet |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | secret, prod | | Required when using the CDP facilitator |
| `PRICE_EXTRACT_USD` | yes | `0.003` | Decimal USD, ≤ 6 decimals, 0 < price ≤ 1 |
| `PRICE_EXTRACT_STRUCTURED_USD` | yes | `0.005` | |
| `DNS_CHECK` | no | `doh` | `doh` = DNS-over-HTTPS pre-check of every hop; `off` disables it |
| `EXTRACTION_ENGINE` | no | `lite` in `wrangler.jsonc` (code default `readability`) | `lite` = Workers AI `toMarkdown` (fits the Free plan); `readability` = linkedom + Readability (best quality, needs Workers Paid). Needs the `AI` binding; without it the service falls back to `readability` and logs `config.lite_engine_without_ai`. `GET /health` reports the active engine |
| `DOH_URL` | no | `https://cloudflare-dns.com/dns-query` | |
| `FETCH_TIMEOUT_MS` | no | `10000` | Overall deadline incl. redirects and body |
| `MAX_RESPONSE_BYTES` | no | `3000000` | Download cap for extraction |
| `INSPECT_MAX_BYTES` | no | `65536` | Download cap for inspection |
| `MAX_REDIRECTS` | no | `5` | |
| `MAX_URL_LENGTH` | no | `2048` | |
| `MAX_REQUEST_BODY_BYTES` | no | `8192` | `/mcp` allows 8× this |
| `DEFAULT_MAX_CHARACTERS` / `MAX_CHARACTERS_LIMIT` | no | `20000` / `100000` | |
| `MAX_LINKS` / `MAX_HEADINGS` | no | `200` / `100` | |

Invalid payment configuration fails closed. Paid endpoints return 503, the reason is logged (`payments.misconfigured`), and free endpoints keep working. Rate limits use Workers Rate Limiting bindings (`INSPECT_RATE_LIMITER` 30/min and `PAID_RATE_LIMITER` 120/min per client IP per Cloudflare location). Adjust them in `wrangler.jsonc`.

## Testing

```bash
npm test
```

All tests run inside **workerd** (the Workers runtime) via `@cloudflare/vitest-plugin`. They never touch the internet, a blockchain, or a real facilitator.

| Suite | Covers |
|---|---|
| `tests/unit/security.test.ts` | URL validation/normalisation, ~50 SSRF rejection cases (loopback, private, link-local, metadata, IPv6, mapped IPv4, decimal/hex/octal IPs, wildcard-DNS hosts, ports, credentials, schemes), IP classification, DoH guard |
| `tests/unit/fetch.test.ts` | Manual redirects, re-validation of every hop, DNS guard per hop, redirect limits, timeouts, Content-Length and streaming size caps, header hygiene |
| `tests/unit/extraction.test.ts` | Readability extraction, boilerplate removal, Markdown (lists, tables, code, links), metadata, headings/links, truncation, malformed HTML, SPA detection, charsets, real-world structure regressions |
| `tests/unit/config.test.ts` | Price/network/recipient/facilitator validation, schemas, error normalisation |
| `tests/integration/payments.test.ts` | 402 shape (amount, asset, network, payTo), validation before 402, forged/garbage/tampered/underpaid/misdirected/replayed payments, full `@x402/fetch` flow, no settlement on failed extraction, settlement failure withholds content, facilitator outage |
| `tests/integration/http.test.ts` | Health, discovery, OpenAPI, inspect variants, body/content-type limits, rate limiting, every extraction failure mode, truncation, redirects, plain text, legacy charsets |
| `tests/integration/mcp.test.ts` | Initialization, tool discovery, free tool, payment challenge, pre-payment validation, forged `_meta`, automatic payment with `@x402/mcp`, no settlement on failure, settlement failure |

**What is mocked, and what is real.** Payment tests use the real x402 SDKs end to end:
- Clients are `@x402/fetch` and `@x402/mcp` with genuine EIP-712 signatures from throwaway wallets.
- The server uses `@x402/hono` and `@x402/mcp`.
- The facilitator is the real `x402Facilitator` with the `@x402/evm` exact scheme, so signature, amount, recipient, expiry and nonce checks are SDK code.

Only the blockchain is simulated (`tests/helpers/facilitator.ts`), along with upstream web pages (`tests/helpers/upstream.ts`). **Live settlement on a real network is not covered by `npm test`.** Use `npm run smoke:testnet` for that.

## Deploying to Cloudflare

Prerequisites:
- A Cloudflare account. **The Free plan works** with `EXTRACTION_ENGINE=lite`, the configured default. Switch to `readability` only on Workers Paid ($5/month); see [Extraction engines](#extraction-engines).
- Workers AI enabled on the account (it is by default). HTML→Markdown conversion is documented as free; image descriptions, which are paid, are explicitly disabled.
- `npx wrangler login`.

### Production (Base mainnet, real USDC)

```bash
# 1. Create a CDP API key: https://portal.cdp.coinbase.com  (needed for the CDP facilitator)
npx wrangler secret put CDP_API_KEY_ID --env production
npx wrangler secret put CDP_API_KEY_SECRET --env production
# 2. Set your mainnet receiving address in wrangler.jsonc → env.production.vars.X402_PAY_TO
#    (an address you control on Base; consider a dedicated wallet)
# 3. Deploy
npm run deploy:production       # → https://agentread.<your-subdomain>.workers.dev
# 4. Verify health shows {"network":"eip155:8453"} and an unpaid request returns 402 with amount "3000"
```

Logs: `npx wrangler tail --env production` or Workers Observability in the dashboard (enabled in `wrangler.jsonc`).

### Custom domain (later)

Add the domain to your Cloudflare account, then add `"routes": [{ "pattern": "read.example.com", "custom_domain": true }]` under `env.production` and redeploy. Payment requirements use the request URL as the x402 `resource`, so no other change is needed.

## Testnet payment demo

Testnet runs locally with `npm run dev` (Base Sepolia, x402.org facilitator). Two testnet wallets were generated: the receiver `0xDE20133E787A3cc64565b7AF1cF2bE3bEA3298Ea` and a **payer** `0x7816FC23017c86aa917AdbD44367312696421322` was generated too. Both private keys are in `.secrets/testnet-wallets.json`, which is gitignored and owner-only. **Testnet only: never send mainnet funds to these addresses.**

1. Fund the payer with Base Sepolia USDC at https://faucet.circle.com (choose Base Sepolia). No ETH is needed.
2. Run the paid flow locally:
   ```bash
   echo "X402_PAY_TO=0xDE20133E787A3cc64565b7AF1cF2bE3bEA3298Ea" > .dev.vars
   npm run dev   # in one terminal
   export EVM_PRIVATE_KEY=$(node -p 'require("./.secrets/testnet-wallets.json").payer.privateKey')
   npm run smoke:testnet && npm run smoke:mcp   # in another (AGENTREAD_URL defaults to localhost:8787)
   ```
3. Check the transfers on https://sepolia.basescan.org/address/0xDE20133E787A3cc64565b7AF1cF2bE3bEA3298Ea

## Observability

Structured JSON logs (`console.log`), with no secrets, payment payloads, signatures or page content:

| Event | Fields |
|---|---|
| `http.request` | method, route, status, durationMs, `paid` (settled) |
| `extract.success` / `extract.failure` | op, host (hostname only), method or error code, ms, chars |
| `mcp.extract.success` / `mcp.extract.failure` | tool, host, method / code |
| `payment.settled` / `payment.settle_rejected` | network, amount, public tx hash, `payer` (salted SHA-256 prefix, not the address) |
| `payment.verify_rejected`, `payment.verify_error`, `payment.settle_error` | reason / error class |
| `payments.misconfigured`, `config.invalid`, `http.internal_error` | reason |

These answer: request volume, success rate, failure reasons, latency, unique and repeat payers (`payer` hash), and verify/settle failures. Query them in Workers Observability.

## Extraction engines

The same API, schemas and payment flow run on either engine (`EXTRACTION_ENGINE`):

| | `lite` (default) | `readability` |
|---|---|---|
| How | Picks a content root (`#mw-content-text`, `.markdown-body`, single `<article>`, `<main>`, `[role=main]`) with substring checks. Hands the page to **Workers AI `toMarkdown`** (conversion runs outside our JS). Reads metadata from `<head>` with a few regexes. Removes known noise line by line | linkedom DOM, boilerplate removal, Mozilla Readability, Turndown (GFM tables) |
| Edge CPU per request (measured, real pages) | p50 ≈ 10–13 ms, p90 ≈ 35–47 ms | p50 ≈ 70–80 ms, p75 ≈ 120–285 ms |
| On the Workers Free plan | **0 CPU-limit kills in ~180 requests** (5 benchmark runs) | Killed in 33–84% of requests (error 1102) |
| Quality | Good on docs, articles, Wikipedia and GitHub READMEs. Weaker on pages without a clear content root, some GitHub code blocks lose their fences, and index pages are noisy | Best overall; content scoring handles arbitrary layouts |
| Extra dependency | Workers AI `toMarkdown` (documented as free for HTML) | none |

The measurements come from the temporary `src/bench.ts` Worker driven by `.github/workflows/bench.yml`, with CPU percentiles from Cloudflare's GraphQL analytics (Oct 2026). Free-plan CPU enforcement isn't a simple per-request 10 ms cutoff: lite's measured CPU exceeds 10 ms but it was never killed. Enforcement is opaque and could change, so re-run the benchmark if you see `1102` errors. Once revenue justifies $5/month, switch to Workers Paid and `EXTRACTION_ENGINE=readability`.

## Pricing and cost notes

Default prices: $0.003 (extract) and $0.005 (structured). Before changing them, account for these costs (Oct 2026, verify current prices):
- **Cloudflare Workers:**
  - **Free** with the `lite` engine: 100k requests/day, $0.
  - **Paid** ($5/month minimum, needed for `readability`) includes 10M requests and 30M CPU-ms, then $0.30 per million requests and $0.02 per million CPU-ms. At about 80 CPU-ms per Readability extraction, compute is about $0.000002 per request after the allowance.
- **Workers AI `toMarkdown`:** documented as free for HTML. AgentRead never enables image conversion, which would use paid AI models.
- **CDP facilitator (mainnet):** the first 1,000 settlements per month are free, then **$0.001 per settlement**. At $0.003 that is **33% of revenue**; at $0.005 it is 20%. This is the dominant marginal cost. Batch settlement, which the SDK supports, would reduce it (see next steps).
- **Gas:** in the `exact` EIP-3009 flow the payer only signs an authorization. The facilitator submits the settlement transaction, so the payer needs no ETH. CDP states that gas is paid on-chain separately from its fee. Check the facilitator's current terms for whether it passes gas costs on.
- **Browser rendering** (deferred) would add roughly per-second browser costs and should be priced separately if added.

## Limitations

- **Lite engine quality** (Free-plan default) is below Readability on pages without a clear content root. Some GitHub code blocks lose their fences. It depends on Workers AI `toMarkdown` staying free for HTML.
- **No JavaScript execution.** Client-rendered pages return `javascript_required` (422, not charged). `inspect_url` flags likely cases with `mayRequireJavaScript`.
- **Supported content:** HTML/XHTML, `text/plain` and `text/markdown` only. PDFs, images and JSON are rejected with `unsupported_content_type`.
- Access controls are respected: no cookies, auth headers or client credentials are ever forwarded, and paywalls and CAPTCHAs are not bypassed.
- **SSRF:** strong application-level controls plus Workers' network isolation, but DNS rebinding cannot be fully eliminated at the application layer. See [docs/security.md](docs/security.md). This has **not** been independently security-reviewed or penetration-tested.
- **Payments:**
  - There are no refunds and no exactly-once guarantee beyond what the facilitator and the EIP-3009 nonce provide.
  - If settlement fails after extraction, the content is withheld (402).
  - In the rare case a facilitator times out after broadcasting, a transfer could still land on-chain without content being delivered. This is documented in [docs/payments.md](docs/payments.md).
- **Rate limits** are per Cloudflare location and approximate (Workers Rate Limiting API).
- **Only Base and Base Sepolia** with USDC via the `exact` scheme are configured.
- **A funded live payment has not yet been made.** The live facilitator path is verified up to the balance check. Fund the generated payer wallet and run `npm run smoke:testnet` (see above).
- **Bazaar discovery** is declared for MCP tools only, not HTTP routes (SDK validation uses runtime code generation, which Workers forbids).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `npm install` fails with `Cannot read properties of null (reading 'edgesOut')` | Known npm 10.9 arborist bug with vitest's peer deps. Use npm 11: `npx -y npm@11 install` |
| npm 11 warns `install-scripts … workerd` | The workerd binary ships via optional platform packages and works without the script. If `npx wrangler --version` fails, run `npx npm@11 install-scripts approve workerd` |
| Paid endpoints return 503 `payments_unavailable` | Payment config is invalid. Check logs for `payments.misconfigured` (e.g. zero-address `X402_PAY_TO`, missing CDP secrets, testnet network in production) |
| `workers.dev` URL times out but `npx wrangler deploy` succeeded | Some networks and ISPs block Cloudflare's `workers.dev` range (`188.114.96.0/20`). Try another network, use a custom domain, or run the CI smoke job (`gh workflow run CI -f agentread_url=…`) |
| 402 even after paying | The payer may lack USDC on the right network, the authorization may have expired (`maxTimeoutSeconds: 120`), the amount may have been for the other endpoint, or the payload was replayed. `payment.verify_rejected` logs the reason |
| `javascript_required` | The page renders client-side. AgentRead does not run JavaScript |
| `blocked_destination` for a public site | The site resolves to a non-public IP, uses a non-default port, or is an IP-literal URL |
| Extractions fail with `1102` / CPU-limit errors | On the Free plan, make sure `EXTRACTION_ENGINE=lite` **and** the `AI` binding exist in that environment (`GET /health` → `"extractionEngine":"lite"`). Wrangler does not inherit bindings into `env.*` blocks |
| `wrangler dev` complains about the compatibility date | Keep `compatibility_date` no newer than the bundled workerd (`npx wrangler --version`) |

## Project layout

```text
src/
  index.ts                 Worker entry
  api/                     Hono app, per-request context, discovery, OpenAPI
  mcp/server.ts            Stateless MCP server + x402 payment wrapper
  payments/x402.ts         Facilitator client, resource server, route pricing, logging hooks
  extraction/              Bounded fetch, HTML cleaning, Readability, Markdown, operations
  security/                URL policy, IP classification, DoH guard
  schemas/                 Versioned zod schemas (shared by HTTP, MCP, OpenAPI, tests)
  config/env.ts            Config loading/validation (fails closed)
  utils/                   Errors, structured logging
tests/{unit,integration,helpers,fixtures}
scripts/                   Smoke tests and example clients (Node)
docs/                      Architecture, payments, security, demo script
```
