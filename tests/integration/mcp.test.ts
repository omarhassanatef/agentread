import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { wrapMCPClientWithPayment } from "@x402/mcp";
import { ARTICLE_HTML } from "../fixtures/pages.js";
import { BASE_SEPOLIA_USDC, PAY_TO, harness, payingClient, type Harness } from "../helpers/app.js";
import { html } from "../helpers/upstream.js";
import { extractResultSchema, inspectResultSchema, structuredResultSchema } from "../../src/schemas/index.js";

const PAGE = "https://ocean.example.com/guides/tide-pools";

async function connect(h: Harness): Promise<Client> {
  const client = new Client({ name: "agentread-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://agentread.test/mcp"), { fetch: h.appFetch });
  await client.connect(transport);
  return client;
}

const text = (r: unknown) => (((r as { content?: Array<{ type: string; text: string }> }).content ?? [])[0]?.text ?? "");

describe("MCP server — discovery", () => {
  it("initializes over Streamable HTTP and lists the three tools with schemas", async () => {
    const client = await connect(harness());
    expect(client.getServerVersion()).toMatchObject({ name: "agentread" });
    expect(client.getInstructions()).toContain("x402");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["extract_url", "extract_url_structured", "inspect_url"]);
    const extract = tools.find((t) => t.name === "extract_url")!;
    expect(extract.description).toContain("$0.003");
    expect(extract.inputSchema.required).toEqual(["url"]);
    expect(Object.keys(extract.inputSchema.properties ?? {})).toEqual(["url", "maxCharacters", "includeLinks"]);
    // No outputSchema on paid tools (see src/mcp/server.ts); inspect_url keeps one.
    expect(extract.outputSchema).toBeUndefined();
    expect(extract.description).toContain("markdown");
    expect(tools.find((t) => t.name === "inspect_url")!.outputSchema).toBeDefined();
    expect(extract.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it("rejects unsupported HTTP methods on /mcp in stateless mode", async () => {
    const res = await harness().fetch("/mcp", { method: "GET", headers: { accept: "text/event-stream" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("MCP server — tools", () => {
  it("inspect_url is free and returns structured content", async () => {
    const client = await connect(harness({ [PAGE]: html(ARTICLE_HTML) }));
    const r = await client.callTool({ name: "inspect_url", arguments: { url: PAGE } });
    expect(r.isError).toBeFalsy();
    const parsed = inspectResultSchema.parse(r.structuredContent);
    expect(parsed).toMatchObject({ reachable: true, isHtml: true, extractionSupported: true });
  });

  it("paid tool without payment returns an x402 PaymentRequired tool result", async () => {
    const h = harness({ [PAGE]: html(ARTICLE_HTML) });
    const client = await connect(h);
    const r = await client.callTool({ name: "extract_url", arguments: { url: PAGE } });
    expect(r.isError).toBe(true);
    const required = r.structuredContent as { x402Version: number; accepts: Array<Record<string, unknown>> };
    expect(required.x402Version).toBe(2);
    expect(required.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: "3000", asset: BASE_SEPOLIA_USDC, payTo: PAY_TO });
    expect(JSON.parse(text(r))).toEqual(required);
    expect((required as { extensions?: { bazaar?: { info: { input: Record<string, unknown> } } } }).extensions?.bazaar?.info.input).toMatchObject({
      toolName: "extract_url",
    });
    expect(h.upstream.calls).toHaveLength(0);
  });

  it("a standard client that cached tool schemas (listTools) accepts the payment challenge", async () => {
    // Regression: SDK clients validate structuredContent against outputSchema even when isError=true.
    const client = await connect(harness({ [PAGE]: html(ARTICLE_HTML) }));
    await client.listTools();
    const r = await client.callTool({ name: "extract_url", arguments: { url: PAGE } });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { x402Version: number }).x402Version).toBe(2);
    const i = await client.callTool({ name: "inspect_url", arguments: { url: PAGE } });
    expect(i.isError).toBeFalsy();
  });

  it("validates input before asking for payment", async () => {
    const h = harness();
    const client = await connect(h);
    const blocked = await client.callTool({ name: "extract_url", arguments: { url: "http://localhost:3000/admin" } });
    expect(blocked.isError).toBe(true);
    expect(blocked.structuredContent).toBeUndefined();
    expect(JSON.parse(text(blocked)).error.code).toBe("blocked_destination");

    const badArgs = await client.callTool({ name: "extract_url", arguments: { url: PAGE, maxCharacters: 5 } });
    expect(badArgs.isError).toBe(true);
    expect(text(badArgs)).toMatch(/maxCharacters/);
    expect(h.upstream.calls).toHaveLength(0);
  });

  it("rejects forged payment metadata", async () => {
    const h = harness({ [PAGE]: html(ARTICLE_HTML) });
    const client = await connect(h);
    const r = await client.callTool({
      name: "extract_url",
      arguments: { url: PAGE },
      _meta: { "x402/payment": { x402Version: 2, paymentVerified: true } },
    });
    expect(r.isError).toBe(true);
    expect(h.upstream.calls).toHaveLength(0);
    expect(h.facilitator.chain.settlements).toHaveLength(0);
  });

  it("an x402 MCP client pays automatically and receives the extraction + receipt", async () => {
    const h = harness({ [PAGE]: html(ARTICLE_HTML) });
    const { client: payer, account } = payingClient();
    const mcp = wrapMCPClientWithPayment(new Client({ name: "agent", version: "1.0.0" }), payer, { autoPayment: true });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("https://agentread.test/mcp"), { fetch: h.appFetch }));
    await mcp.listTools(); // agents normally discover first; exercises client-side schema validation

    const r = await mcp.callTool("extract_url", { url: PAGE, maxCharacters: 4000 });
    expect(r.isError).toBeFalsy();
    expect(r.paymentMade).toBe(true);
    expect(r.paymentResponse?.success).toBe(true);
    const result = extractResultSchema.parse(JSON.parse(text(r)));
    expect(result.markdown).toContain("Tide pools are shallow basins");
    expect(h.facilitator.chain.settlements).toHaveLength(1);
    expect(h.facilitator.chain.settlements[0]).toMatchObject({ value: 3000n });
    expect(h.facilitator.chain.settlements[0]!.from.toLowerCase()).toBe(account.address.toLowerCase());

    const s = await mcp.callTool("extract_url_structured", { url: PAGE });
    expect(s.paymentMade).toBe(true);
    structuredResultSchema.parse(JSON.parse(text(s)));
    expect(h.facilitator.chain.settlements.map((x) => x.value)).toEqual([3000n, 5000n]);
  });

  it("failed extraction after payment is not settled", async () => {
    const h = harness({ [PAGE]: { status: 500, body: "boom", headers: { "content-type": "text/html" } } });
    const mcp = wrapMCPClientWithPayment(new Client({ name: "agent", version: "1.0.0" }), payingClient().client, { autoPayment: true });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("https://agentread.test/mcp"), { fetch: h.appFetch }));
    const r = await mcp.callTool("extract_url", { url: PAGE });
    expect(r.isError).toBe(true);
    expect(JSON.parse(text(r)).error.code).toBe("upstream_http_error");
    expect(h.facilitator.calls.verify).toBe(1);
    expect(h.facilitator.calls.settle).toBe(0);
    expect(h.facilitator.chain.settlements).toHaveLength(0);
  });

  it("settlement failure withholds the extraction", async () => {
    const h = harness({ [PAGE]: html(ARTICLE_HTML) });
    h.facilitator.chain.settleMode = "revert";
    const mcp = wrapMCPClientWithPayment(new Client({ name: "agent", version: "1.0.0" }), payingClient().client, { autoPayment: true });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("https://agentread.test/mcp"), { fetch: h.appFetch }));
    const r = await mcp.callTool("extract_url", { url: PAGE }).catch((e: unknown) => ({ thrown: e }));
    const serialized = JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(serialized).not.toContain("Tide pools are shallow");
    expect(h.facilitator.chain.settlements).toHaveLength(0);
  });
});

describe("MCP free daily allowance", () => {
  it("paid tools are served free without payment metadata while the allowance lasts", async () => {
    const { memoryFreeTier } = await import("../../src/payments/free-tier.js");
    const h = harness({ [PAGE]: html(ARTICLE_HTML) }, {}, undefined, undefined, memoryFreeTier(1));
    const client = await connect(h);
    const first = await client.callTool({ name: "extract_url", arguments: { url: PAGE } });
    expect(first.isError).toBeFalsy();
    expect(extractResultSchema.parse(first.structuredContent).markdown).toContain("Tide pools are shallow basins");
    expect(first._meta).toMatchObject({ "agentread/free-tier": { limit: 1, remaining: 0 } });
    const second = await client.callTool({ name: "extract_url", arguments: { url: PAGE } });
    expect(second.isError).toBe(true);
    expect((second.structuredContent as { x402Version: number }).x402Version).toBe(2);
    expect(h.facilitator.chain.settlements).toHaveLength(0);
  });
});
