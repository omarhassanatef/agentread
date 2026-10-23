# Demo script

The ✅/⚠️ marks show what has been verified (as of 2026-10-23) and what has not.

## Prerequisites

- `npm install`.
- A Base Sepolia receiving address (`X402_PAY_TO`).
- For steps 4–6: a **testnet-only** wallet private key with Base Sepolia USDC from https://faucet.circle.com. Gas is not needed; the facilitator submits the transaction.

```bash
cp .dev.vars.example .dev.vars    # set X402_PAY_TO
npm run dev                       # http://localhost:8787
export AGENTREAD_URL=http://localhost:8787
```

## 1. Health ✅ verified locally (wrangler dev)

```bash
curl -s $AGENTREAD_URL/health
```

## 2. Free inspection ✅ verified locally against example.com and MDN

```bash
curl -s -X POST $AGENTREAD_URL/v1/inspect -H 'content-type: application/json' -d '{"url":"https://example.com/"}'
```

## 3. Unpaid extraction → 402 ✅ verified locally (real x402.org facilitator `/supported`)

```bash
curl -si -X POST $AGENTREAD_URL/v1/extract -H 'content-type: application/json' -d '{"url":"https://example.com/"}' | head -20
# HTTP/1.1 402 … payment-required: <base64>
node -e 'import("@x402/core/http").then(m=>console.log(JSON.stringify(m.decodePaymentRequiredHeader(process.argv[1]),null,2)))' "<paste header>"
```

Or run all unpaid checks at once: `npm run smoke:local` ✅ (9/9 passed locally). The checks include a zero-cost **live facilitator** check: a genuinely signed payment from an empty wallet is rejected by x402.org with `invalid_exact_evm_insufficient_balance`.

## 4–5. Testnet payment + paid extraction ⚠️ NOT yet verified live

```bash
EVM_PRIVATE_KEY=0x<testnet-only key> npm run smoke:testnet
```

Expected output:
- `PASS /v1/extract … settled=true tx=0x…` with a Basescan link;
- the same for `/v1/extract/structured`;
- a Markdown preview of each result.

Check the transfer on https://sepolia.basescan.org: 0.003 and 0.005 USDC to `X402_PAY_TO`.

The same flow has passed in automated tests with real SDK signing and verification against a simulated chain. It has not yet run against the live facilitator and chain.

## 6. MCP discovery and paid tool call ✅ discovery + free tool verified locally / ⚠️ paid call not verified live

```bash
npm run smoke:mcp                                    # lists tools, calls inspect_url
EVM_PRIVATE_KEY=0x<testnet-only key> npm run smoke:mcp  # also pays for extract_url
```

## Against the deployed testnet Worker

✅ Deployed: `https://agentread-testnet.omar-cv.workers.dev` (receiver `0xDE20133E787A3cc64565b7AF1cF2bE3bEA3298Ea`; a payer wallet (unfunded) key is in `.secrets/testnet-wallets.json`, see the README).
✅ `smoke:local` 9/9 against the deployment from GitHub Actions: `gh workflow run CI -f agentread_url=https://agentread-testnet.omar-cv.workers.dev`. It is not reachable from the development machine's network, where the `workers.dev` range is blocked.

## Deploying your own testnet Worker

```bash
npm run deploy:testnet   # after setting env.testnet.vars.X402_PAY_TO in wrangler.jsonc
export AGENTREAD_URL=https://agentread-testnet.<subdomain>.workers.dev
npm run smoke:local && EVM_PRIVATE_KEY=0x… npm run smoke:testnet
npx wrangler tail --env testnet   # watch payment.settled / extract.success events
```

The bundle is ~424 KiB gzip.
