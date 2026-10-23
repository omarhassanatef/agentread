#!/usr/bin/env node
// Unpaid smoke test against a running AgentRead (default: `npm run dev` on :8787).
// Verifies health, free inspection, 402 payment requirements, input validation and
// MCP tool discovery. Needs network access for the target page and the facilitator.
//
//   AGENTREAD_URL=http://localhost:8787 SMOKE_TARGET_URL=https://example.com/ npm run smoke:local
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = (process.env.AGENTREAD_URL ?? "http://localhost:8787").replace(/\/$/, "");
const TARGET = process.env.SMOKE_TARGET_URL ?? "https://example.com/";
let failed = 0;

function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!cond) failed++;
}

const post = (path, body, headers = {}) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const health = await fetch(`${BASE}/health`);
const h = await health.json();
check("GET /health", health.status === 200 && h.status === "ok", `${JSON.stringify(h.payments)} engine=${h.extractionEngine}`);
if (process.env.EXPECT_ENGINE) check(`Extraction engine is ${process.env.EXPECT_ENGINE}`, h.extractionEngine === process.env.EXPECT_ENGINE, h.extractionEngine);

const inspect = await post("/v1/inspect", { url: TARGET });
const i = await inspect.json();
check("POST /v1/inspect (free)", inspect.status === 200 && i.reachable === true, `status=${i.statusCode} title=${JSON.stringify(i.title)} supported=${i.extractionSupported}`);

const unpaid = await post("/v1/extract", { url: TARGET });
const header = unpaid.headers.get("payment-required");
let req;
try {
  req = header ? decodePaymentRequiredHeader(header) : null;
} catch {
  req = null;
}
const a = req?.accepts?.[0];
check("POST /v1/extract unpaid → 402", unpaid.status === 402 && !!a, a ? `${a.amount} of ${a.asset} on ${a.network} → ${a.payTo}` : `status=${unpaid.status}`);

const bad = await post("/v1/extract", { url: "http://169.254.169.254/latest/meta-data/" });
check("SSRF target rejected before payment (400)", bad.status === 400 && !bad.headers.get("payment-required"));

const forged = await post("/v1/extract", { url: TARGET }, { "payment-signature": btoa(JSON.stringify({ x402Version: 2, paymentVerified: true })) });
check("Forged payment rejected (402)", forged.status === 402);

// Live facilitator check at zero cost: a genuinely signed payment from a fresh, empty wallet
// must pass signature/requirement checks and be rejected by the real facilitator on balance.
if (req) {
  const empty = privateKeyToAccount(generatePrivateKey());
  const payer = new x402Client().register(a.network, new ExactEvmScheme(toClientEvmSigner(empty)));
  const sig = encodePaymentSignatureHeader(await payer.createPaymentPayload(req));
  const r = await post("/v1/extract", { url: TARGET }, { "payment-signature": sig });
  const body = await r.json().catch(() => ({}));
  const reason = body?.error?.details?.reason ?? "";
  // x402.org reports "insufficient_balance"; the CDP facilitator simulates the transfer and
  // reports the revert. Either proves the facilitator authenticated us and verified the payload.
  check("Live facilitator verifies signature, rejects unfunded payer", r.status === 402 && /insufficient|revert/i.test(reason), reason || `status=${r.status}`);
}

const mcp = new Client({ name: "agentread-smoke", version: "1.0.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
const { tools } = await mcp.listTools();
check("MCP tools/list", tools.length === 3, tools.map((t) => t.name).join(", "));
const mi = await mcp.callTool({ name: "inspect_url", arguments: { url: TARGET } });
check("MCP inspect_url", !mi.isError && mi.structuredContent?.reachable === true);
const mp = await mcp.callTool({ name: "extract_url", arguments: { url: TARGET } });
check("MCP extract_url unpaid → PaymentRequired", mp.isError === true && mp.structuredContent?.x402Version === 2);
await mcp.close();

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
