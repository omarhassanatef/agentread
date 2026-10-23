# Payments (x402)

## What is used

- Protocol: **x402 v2**, scheme **`exact`**, EVM, USDC via EIP-3009 `transferWithAuthorization`.
- SDKs (pinned): `@x402/core`, `@x402/hono`, `@x402/mcp`, `@x402/evm` **2.28.0**, plus `@coinbase/x402` **2.1.0** for CDP facilitator auth.
- Networks: **Base Sepolia `eip155:84532`** (testnet) and **Base `eip155:8453`** (production).
- Facilitators: `https://x402.org/facilitator` (free, testnet only, no key) and `https://api.cdp.coinbase.com/platform/v2/x402` (mainnet, CDP API key via JWT).
- Prices: `$0.003` and `$0.005`, passed to the SDK as dollar strings. The SDK converts them using the network's default USDC (6 decimals) to `amount: "3000"` and `"5000"`. The asset on Base Sepolia is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`; tests assert this.

## Responsibilities

| AgentRead | Facilitator | Client |
|---|---|---|
| Publishes requirements (price, asset, network, `payTo`, timeout) | `/verify`: signature, amount, recipient, validity window, balance, nonce unused, simulation | Chooses a requirement, signs an EIP-3009 authorization (`PAYMENT-SIGNATURE` or `_meta["x402/payment"]`) |
| Matches the payload to its own requirements (rejects other amounts and recipients) | `/settle`: submits the transfer on-chain and waits for the receipt | Retries the request with the payment |
| Runs the work only after a successful verify; settles only if the work succeeded | Replay protection via the on-chain EIP-3009 nonce | Should cap spend (`registerPolicy`, `onPaymentRequested`) |
| Withholds content if settlement fails | Pays gas / submits tx | |

AgentRead never trusts a client claim of payment. Every paid request goes through SDK verification against AgentRead's own requirements. A forged `{"paymentVerified": true}` is rejected, and tests cover this for both HTTP and MCP.

## Flow (HTTP)

1. `POST /v1/extract` without payment → `402`, with a `PAYMENT-REQUIRED` header (base64 `PaymentRequired`) and a JSON summary body.
2. The client signs and retries with `PAYMENT-SIGNATURE`.
3. `@x402/hono` verifies with the facilitator. If the result is invalid, the response is a 402 with `{"error":{"code":"payment_invalid","details":{"reason":"<facilitator reason>"}}}`. AgentRead rewrites the SDK's empty `{}` body; the reason is also in the `PAYMENT-REQUIRED` header.
4. The handler runs the extraction.
5. If the handler returns ≥ 400, settlement is **cancelled**: the client gets the error and is not charged.
6. If the handler succeeds, the middleware settles. On success: `200` + body + `PAYMENT-RESPONSE` (base64 `SettleResponse` with tx hash) and `Cache-Control: private`. On failure: `402` with `payment_settlement_failed`; the body is withheld.

## Flow (MCP)

Same semantics via `@x402/mcp`'s `createPaymentWrapper`:
- The challenge is a tool result with `isError: true` and `structuredContent = PaymentRequired`.
- The payment arrives in `params._meta["x402/payment"]`.
- The receipt goes in `_meta["x402/payment-response"]`.
- Tool results with `isError` are not settled.

## Failure handling and limitations

- **Invalid, expired or mismatched payment:** facilitator verify fails → 402. Signatures valid for a different amount or recipient do not match AgentRead's requirements → 402.
- **Replay:** the second use of an authorization fails verification because the on-chain nonce is already used → 402, no content (tested). Two identical payloads in flight at the same moment can both pass verify. Both extractions then run, but only one settlement can succeed on-chain, so the other request gets 402 and no content. Cost: one wasted extraction, no free content.
- **Settlement failure** (revert, RPC error, facilitator error): content withheld. AgentRead offers **no refunds and no exactly-once guarantee**. If the facilitator broadcasts the transfer but times out before confirming, the transfer may still land on-chain while the client got a 402. The response tells clients to contact the operator in that case. Tx hashes appear in logs (`payment.settled`) for reconciliation.
- **Facilitator unavailable:** paid endpoints fail closed (5xx) before doing any work. Free endpoints are unaffected.
- **Misconfiguration** (zero/invalid `payTo`, testnet network in production, mainnet with the `x402.org` facilitator, CDP without keys, absurd prices): payments are disabled and paid endpoints return 503 instead of serving free content.

## Testing payments

- **Automated (`npm test`, mocked chain):** real SDK clients sign real EIP-712 authorizations. The real `x402Facilitator` with the `@x402/evm` exact scheme verifies and settles them against `MockChain`, which stands in only for chain reads and writes. Covered cases:
  - unpaid 402 shape;
  - garbage, forged, tampered, underpaid, misdirected and replayed payments;
  - successful HTTP and MCP flows with settlement amounts asserted;
  - no settlement on 404, 500, timeout, JS-required, oversized and other failures;
  - reverted and erroring settlement;
  - facilitator outage.
- **Live, zero cost (verified):** `npm run smoke:local` signs a real payment with an empty wallet and sends it through AgentRead to the live x402.org facilitator. The facilitator accepts the signature and requirements, then rejects on balance (`invalid_exact_evm_insufficient_balance`).
- **Live funded (not yet run):** `npm run smoke:testnet` against a Base Sepolia deployment with a funded testnet wallet. See [demo.md](demo.md).

## Switching networks

`ENVIRONMENT` gates it explicitly: `production` ⇒ mainnet only, anything else ⇒ testnet only. Changing network means changing `X402_NETWORK`, `X402_FACILITATOR_URL`, `X402_PAY_TO`, and (for CDP) the secrets in the relevant `env` block. Other networks would need an entry in `SUPPORTED_NETWORKS` (`src/config/env.ts`) and a facilitator that lists them in `/supported`.
