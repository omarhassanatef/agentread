#!/usr/bin/env node
// Checks AgentRead's directory listings and prints a Markdown report. Free; read-only.
// Writes `found=<comma list>` to $GITHUB_OUTPUT when something actionable appears.
//   node scripts/listing-status.mjs
import { appendFileSync } from "node:fs";

const ORIGIN = "https://agentread.omar-cv.workers.dev";
const HOST = "agentread.omar-cv.workers.dev";
const lines = [];
const found = [];
const get = async (url, init) => {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    return { status: 0, text: String(e) };
  }
};

// 1. Official MCP Registry
{
  const r = await get("https://registry.modelcontextprotocol.io/v0/servers?search=io.github.omarhassanatef/agentread");
  let status = "not found";
  try {
    const s = JSON.parse(r.text).servers?.[0];
    if (s) status = `${s._meta?.["io.modelcontextprotocol.registry/official"]?.status ?? "listed"} (v${s.server.version})`;
  } catch {}
  lines.push(`- **MCP Registry:** ${status}`);
}

// 2. Glama connector: find connector IDs mentioning agentread and confirm one points at our host.
{
  const ids = new Set(["io.github.omarhassanatef/agentread"]);
  for (const q of ["agentread", "AgentRead", HOST]) {
    const r = await get(`https://glama.ai/mcp/connectors?query=${encodeURIComponent(q)}`);
    for (const m of r.text.matchAll(/\/mcp\/connectors\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/g)) {
      if (!m[1].startsWith("_index") && /agentread/i.test(m[1])) ids.add(m[1]);
    }
  }
  let match = null;
  for (const id of ids) {
    const r = await get(`https://glama.ai/mcp/connectors/${id}`);
    if (r.status === 200 && (r.text.includes(HOST) || r.text.includes("omarhassanatef"))) {
      match = id;
      break;
    }
  }
  if (match) {
    found.push("glama");
    lines.push(`- **Glama:** ✅ listed as \`${match}\`: https://glama.ai/mcp/connectors/${match}`);
    lines.push(`  - Next: submit the awesome-remote-mcp-servers entry from docs/listings.md, with badge ID \`${match}\`.`);
  } else {
    lines.push(`- **Glama:** not listed yet (checked ${ids.size} candidate IDs)`);
  }
}

// 3. CDP Bazaar: the validator reports `index` once the resource is indexed.
for (const path of ["/v1/extract", "/v1/extract/structured"]) {
  const r = await get("https://api.cdp.coinbase.com/platform/v2/x402/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resource: `${ORIGIN}${path}`, method: "POST" }),
  });
  let msg = `HTTP ${r.status}`;
  try {
    const b = JSON.parse(r.text);
    msg = `valid=${b.valid} index=${JSON.stringify(b.index)}`;
    if (b.index) found.push(`bazaar${path}`);
  } catch {}
  lines.push(`- **CDP Bazaar ${path}:** ${msg}`);
}

// 4. awesome-x402 PR
{
  const r = await get("https://api.github.com/repos/xpaysh/awesome-x402/pulls/1974", { headers: { "user-agent": "agentread-listing-status" } });
  try {
    const pr = JSON.parse(r.text);
    const state = pr.merged ? "merged ✅" : pr.state;
    if (pr.merged) found.push("awesome-x402");
    lines.push(`- **awesome-x402 PR #1974:** ${state}`);
  } catch {
    lines.push(`- **awesome-x402 PR #1974:** HTTP ${r.status}`);
  }
}

const report = `### AgentRead listing status (${new Date().toISOString().slice(0, 10)})\n\n${lines.join("\n")}\n`;
console.log(report);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `found=${found.join(",")}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `report<<EOF\n${report}\nEOF\n`);
}
