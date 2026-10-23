# Architecture

## Shape

One Cloudflare Worker, written in TypeScript (strict), routed with Hono. There is no database, queue, Durable Object or external service other than the x402 facilitator and the DNS-over-HTTPS resolver.

```text
src/index.ts ── createApp() ── src/api/app.ts
                                 │
     ┌───────────────────────────┼────────────────────────────┐
     │ GET /, /health,           │ POST /v1/inspect           │ POST /v1/extract[/structured]
     │ /openapi.json             │  bodyLimit → zod →         │  bodyLimit → prevalidate (zod + URL
     │                           │  rate limit → inspectUrl   │  policy + DNS guard + rate limit)
     │                           │                            │  → paymentGate (@x402/hono)
     │                           │                            │  → paidHandler → extractUrl*
     │                                                        │
     │ POST /mcp ── src/mcp/server.ts (stateless McpServer per request)
     │               inspect_url → inspectUrl
     │               extract_url* → prevalidate → @x402/mcp createPaymentWrapper → extractUrl*
     ▼
src/extraction/operations.ts   inspectUrl · extractUrl · extractUrlStructured · prevalidateUrl
src/extraction/fetch.ts        safeFetch (manual redirects, per-hop validation, deadline, byte cap), decodeBody
src/extraction/html.ts         linkedom parse, metadata, URL absolutisation, boilerplate removal, structure fixes
src/extraction/extract.ts      Readability → fallbacks → headings/links
src/extraction/markdown.ts     Turndown (+ GFM tables), truncation
src/security/*                 URL policy, IP ranges, DoH guard
src/payments/x402.ts           facilitator client (+ /supported cache), resource server + hooks, routes/prices
src/schemas/index.ts           versioned zod schemas (input, results)
src/config/env.ts              config parsing/validation
```

## Key decisions

| Decision | Why |
|---|---|
| **x402 v2 official SDKs** (`@x402/hono`, `@x402/mcp`, `@x402/evm`, `@x402/core` 2.28) | Current maintained line; source was read to confirm the behaviour relied on: settle-after-handler, skip settlement on status ≥ 400 / `isError`. No hand-rolled protocol code |
| **Resource server rebuilt per request** | Workers forbids sharing in-flight I/O promises across requests. Only the facilitator's resolved `/supported` JSON is cached per isolate (10 min) |
| **Validation middleware before the payment middleware** | Requests that fail basic validation (schema, URL policy, DNS) never get a 402, so clients are not asked to pay for requests that cannot succeed |
| **Stateless MCP** (`WebStandardStreamableHTTPServerTransport`, `sessionIdGenerator: undefined`, `enableJsonResponse: true`) | No Durable Objects or session storage. Each request builds a fresh server. `GET`/`DELETE /mcp` → 405 |
| **cfworker JSON-schema validator for MCP** | The SDK's default (ajv) compiles code with `new Function`, which Workers forbids |
| **No `outputSchema` on paid MCP tools** | SDK clients validate `structuredContent` against `outputSchema` even on error results, which rejects x402 payment challenges. Observed against the real TS client |
| **linkedom + @mozilla/readability + turndown (+ @joplin/turndown-plugin-gfm)** | Pure-JS DOM that runs in workerd (verified by the test suite running in workerd). Two small adaptations: a `rows` getter for linkedom tables (GFM plugin), and structure normalisation for common Readability failure modes |
| **Deterministic extraction only** | No LLM calls. Output depends only on the page bytes |
| **Workers Rate Limiting bindings** | Free and built in, no storage. Approximate and per-location |
| **zod 3.25** | Same major as `@x402/*` (deduplicated); the MCP SDK accepts v3 or v4 |
| **`nodejs_compat`** | `@x402/hono` uses `Buffer` |

## Request lifecycle (paid HTTP)

1. `bodyLimit` (8 KB) → JSON parse → zod (`.strict()`, so unknown fields are rejected).
2. `validateTargetUrl` checks scheme, credentials, port, IP literal, hostname policy. The DNS guard (DoH) requires all A/AAAA records to be public.
3. Rate limit (`PAID_RATE_LIMITER`, keyed by `cf-connecting-ip`).
4. `@x402/hono` `paymentMiddleware`:
   - no `PAYMENT-SIGNATURE` → 402 with `PAYMENT-REQUIRED`;
   - otherwise decode, match requirements, then facilitator `/verify`.
5. Handler: `safeFetch` → decode → extract → truncate → JSON.
6. Middleware: if the handler status is ≥ 400, settlement is cancelled. Otherwise it calls facilitator `/settle`. On success the original body goes out with `PAYMENT-RESPONSE`; on failure the body is replaced with a 402 and the content is withheld.

## Extensibility

`Services` (fetcher, hostGuard, limits) is injected into every operation. A browser-rendering fallback (for example Cloudflare Browser Rendering) would be another fetcher or extractor chosen when `javascript_required` is detected. It would likely be a separately priced operation, so that cheap requests do not subsidise expensive ones.
