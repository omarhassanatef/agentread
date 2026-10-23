import { SUPPORTED_NETWORKS, type AppConfig } from "../config/env.js";
import { priceFor } from "../payments/x402.js";

/** /llms.txt (llmstxt.org convention): a compact, model-readable description of the service. */
export function llmsTxt(cfg: AppConfig, origin: string): string {
  const p = cfg.payment;
  const price = (op: "extract_url" | "extract_url_structured") => (p ? `${priceFor(p, op)} per successful call` : "unavailable");
  const network = p ? `${SUPPORTED_NETWORKS[p.network].name} (${p.network})` : "not configured";
  return `# AgentRead

> Clean web content for AI agents. Turns a public web page into clean Markdown plus metadata, headings and links. Pay per call with x402 (USDC on ${network}); no accounts or API keys. Failed extractions are not charged.

## Operations

- [inspect_url](${origin}/openapi.json): POST ${origin}/v1/inspect {"url": "..."}. Free. Reachability, status, content type, title, and whether extraction will work.
- [extract_url](${origin}/openapi.json): POST ${origin}/v1/extract {"url": "...", "maxCharacters"?: number, "includeLinks"?: boolean}. ${price("extract_url")}. Clean Markdown, title, description, headings.
- [extract_url_structured](${origin}/openapi.json): POST ${origin}/v1/extract/structured, same input. ${price("extract_url_structured")}. Metadata (canonical URL, language, site name, byline, published time), Markdown, headings, links.

## Paying

- Unpaid paid-endpoint requests return HTTP 402 with an x402 v2 \`PAYMENT-REQUIRED\` header. Retry with a \`PAYMENT-SIGNATURE\` header from an x402 client such as @x402/fetch.
- MCP (Streamable HTTP, stateless): ${origin}/mcp. Tools: inspect_url (free), extract_url, extract_url_structured. Paid tools return an x402 PaymentRequired tool result; pay via _meta["x402/payment"] (e.g. @x402/mcp).

## Limits

- Public http(s) URLs only, default ports, no IP literals or internal hosts. JavaScript is not executed. HTML and plain text only.

## Docs

- [OpenAPI](${origin}/openapi.json)
- [Service index](${origin}/)
- [Source and README](https://github.com/omarhassanatef/agentread)
`;
}
