#!/usr/bin/env node
// LIVE testnet payment smoke test. Spends real Base Sepolia test USDC (no monetary value).
//
// Prerequisites:
//   - AgentRead running against Base Sepolia (local `npm run dev` or the testnet deployment)
//   - EVM_PRIVATE_KEY: a TESTNET-ONLY wallet funded with Base Sepolia USDC (https://faucet.circle.com)
//
//   AGENTREAD_URL=https://agentread-testnet.<you>.workers.dev EVM_PRIVATE_KEY=0x... npm run smoke:testnet
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const BASE = (process.env.AGENTREAD_URL ?? "http://localhost:8787").replace(/\/$/, "");
const TARGET = process.env.SMOKE_TARGET_URL ?? "https://example.com/";
const KEY = process.env.EVM_PRIVATE_KEY;
if (!KEY || !/^0x[0-9a-fA-F]{64}$/.test(KEY)) {
  console.error("Set EVM_PRIVATE_KEY to a 0x-prefixed private key of a TESTNET-ONLY wallet.");
  process.exit(2);
}

const health = await (await fetch(`${BASE}/health`)).json();
if (health.payments?.network !== "eip155:84532") {
  console.error(`Refusing to run: ${BASE} is not configured for Base Sepolia (got ${JSON.stringify(health.payments)}).`);
  process.exit(2);
}

const account = privateKeyToAccount(KEY);
const client = new x402Client().register("eip155:84532", new ExactEvmScheme(toClientEvmSigner(account)));
// Refuse to pay more than 1 cent per request, whatever the server asks for.
client.registerPolicy((_version, reqs) => reqs.filter((r) => BigInt(r.amount) <= 10_000n));
const payFetch = wrapFetchWithPayment(fetch, client);
const http = new x402HTTPClient(client);

console.log(`Payer ${account.address} → ${BASE}`);
for (const path of ["/v1/extract", "/v1/extract/structured"]) {
  const started = Date.now();
  const res = await payFetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: TARGET, maxCharacters: 2000 }),
  });
  const body = await res.json();
  if (res.status !== 200) {
    console.error(`FAIL ${path}: HTTP ${res.status}`, JSON.stringify(body));
    process.exit(1);
  }
  const receipt = http.getPaymentSettleResponse((n) => res.headers.get(n));
  console.log(`PASS ${path} in ${Date.now() - started} ms — settled=${receipt.success} tx=${receipt.transaction}`);
  console.log(`     https://sepolia.basescan.org/tx/${receipt.transaction}`);
  console.log(`     title=${JSON.stringify(body.title ?? body.metadata?.title)} chars=${body.extraction.characters}`);
  console.log(body.markdown.slice(0, 300).replace(/^/gm, "     | "));
}
