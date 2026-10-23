#!/usr/bin/env node
// Registers AgentRead's origin on x402scan.com (discovery via /openapi.json).
// Auth is Sign-In-With-X: a wallet signs a message — no transaction, no payment.
// No payment client is used, so this script cannot spend funds. A throwaway wallet is
// generated unless SIWX_PRIVATE_KEY is set.
//   AGENTREAD_URL=https://agentread.<sub>.workers.dev node scripts/register-x402scan.mjs
import { createSIWxPayload, encodeSIWxHeader, SIGN_IN_WITH_X } from "@x402/extensions/sign-in-with-x";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ORIGIN = (process.env.AGENTREAD_URL ?? "https://agentread.omar-cv.workers.dev").replace(/\/$/, "");
const ENDPOINT = "https://www.x402scan.com/api/x402/registry/register-origin";
const account = privateKeyToAccount(process.env.SIWX_PRIVATE_KEY ?? generatePrivateKey());
const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: ORIGIN }) };

const challenge = await fetch(ENDPOINT, init);
if (challenge.status !== 402) {
  console.log(`Unexpected HTTP ${challenge.status}: ${(await challenge.text()).slice(0, 500)}`);
  process.exit(1);
}
const header = challenge.headers.get("payment-required");
const required = header ? decodePaymentRequiredHeader(header) : await challenge.json();
if ((required.accepts ?? []).length > 0) {
  console.log("Refusing: the challenge asks for payment, and this script never pays.");
  process.exit(1);
}
const siwx = required.extensions?.[SIGN_IN_WITH_X];
const chain = siwx?.supportedChains?.find((c) => c.chainId.startsWith("eip155:"));
if (!chain) {
  console.log("No EVM sign-in option offered:", JSON.stringify(siwx).slice(0, 500));
  process.exit(1);
}
const payload = await createSIWxPayload({ ...siwx.info, chainId: chain.chainId, type: chain.type }, account, ENDPOINT);
const res = await fetch(ENDPOINT, { ...init, headers: { ...init.headers, [SIGN_IN_WITH_X]: encodeSIWxHeader(payload) } });
const text = await res.text();
console.log(`HTTP ${res.status} (signed in as ${account.address})`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2).slice(0, 5000));
} catch {
  console.log(text.slice(0, 2000));
}
process.exit(res.ok ? 0 : 1);
