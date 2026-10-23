#!/usr/bin/env node
// Asks the CDP facilitator whether AgentRead's paid endpoints qualify for x402 Bazaar
// indexing (no payment, no API key). Region-restricted: run from CI if blocked locally.
//   AGENTREAD_URL=https://agentread.<sub>.workers.dev node scripts/validate-bazaar.mjs
const BASE = (process.env.AGENTREAD_URL ?? "").replace(/\/$/, "");
let failed = 0;
for (const path of ["/v1/extract", "/v1/extract/structured"]) {
  const res = await fetch("https://api.cdp.coinbase.com/platform/v2/x402/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resource: `${BASE}${path}`, method: "POST" }),
  });
  const body = await res.json().catch(() => ({}));
  const ok = body.valid === true && body.simulation?.outcome === "accepted";
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  Bazaar validation ${path}  — HTTP ${res.status} valid=${body.valid} outcome=${body.simulation?.outcome}`);
  console.log(JSON.stringify(body, null, 2).slice(0, 4000));
}
process.exit(failed ? 1 : 0);
