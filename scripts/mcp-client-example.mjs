#!/usr/bin/env node
// Example MCP client: discovers AgentRead's tools, calls the free tool, and — when
// EVM_PRIVATE_KEY is set — pays for extract_url with @x402/mcp (Base Sepolia testnet).
//
//   AGENTREAD_URL=http://localhost:8787 [EVM_PRIVATE_KEY=0x...] npm run smoke:mcp
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { wrapMCPClientWithPayment } from "@x402/mcp";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const BASE = (process.env.AGENTREAD_URL ?? "http://localhost:8787").replace(/\/$/, "");
const TARGET = process.env.SMOKE_TARGET_URL ?? "https://example.com/";
const transport = () => new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));

// 1. Discovery and the free tool with a plain MCP client.
const plain = new Client({ name: "agentread-example", version: "1.0.0" });
await plain.connect(transport());
const { tools } = await plain.listTools();
console.log("Tools:");
for (const t of tools) console.log(`  - ${t.name}: ${t.description}`);
const inspected = await plain.callTool({ name: "inspect_url", arguments: { url: TARGET } });
console.log("\ninspect_url →", JSON.stringify(inspected.structuredContent, null, 2));
await plain.close();

// 2. A paid call, signed automatically by the x402 MCP client.
const key = process.env.EVM_PRIVATE_KEY;
if (!key) {
  console.log("\nSet EVM_PRIVATE_KEY (testnet-only wallet with Base Sepolia USDC) to make a paid extract_url call.");
  process.exit(0);
}
const account = privateKeyToAccount(key);
const payments = new x402Client().register("eip155:84532", new ExactEvmScheme(toClientEvmSigner(account)));
const mcp = wrapMCPClientWithPayment(new Client({ name: "agentread-example", version: "1.0.0" }), payments, {
  autoPayment: true,
  onPaymentRequested: async ({ paymentRequired }) => {
    const a = paymentRequired.accepts[0];
    console.log(`\nPayment requested: ${a.amount} atomic units of ${a.asset} on ${a.network}`);
    return BigInt(a.amount) <= 10_000n; // approve at most $0.01
  },
});
await mcp.connect(transport());
const result = await mcp.callTool("extract_url", { url: TARGET, maxCharacters: 2000 });
console.log(`paid=${result.paymentMade} tx=${result.paymentResponse?.transaction ?? "-"}`);
console.log(result.content[0]?.text?.slice(0, 600));
await mcp.close();
