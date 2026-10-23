import { SERVICE_NAME, SERVICE_VERSION, SUPPORTED_NETWORKS, type AppConfig } from "../config/env.js";
import { PAID_OPERATIONS, priceFor } from "../payments/x402.js";
import { SCHEMA_VERSION } from "../schemas/index.js";

/** Machine-readable service index served at GET / so agents can discover capabilities and prices. */
export function discoveryDocument(cfg: AppConfig, origin: string) {
  const p = cfg.payment;
  const price = (op: keyof typeof PAID_OPERATIONS) => (p ? priceFor(p, op) : null);
  return {
    name: SERVICE_NAME,
    tagline: "Clean web content for AI agents, paid per request.",
    version: SERVICE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    environment: cfg.environment,
    payments: p
      ? {
          protocol: "x402",
          x402Version: 2,
          scheme: "exact",
          network: p.network,
          networkName: SUPPORTED_NETWORKS[p.network].name,
          asset: "USDC",
          payTo: p.payTo,
          chargedOnlyOnSuccess: true,
        }
      : { enabled: false },
    operations: [
      { name: "inspect_url", http: { method: "POST", path: "/v1/inspect" }, mcpTool: "inspect_url", price: "free" },
      { name: "extract_url", http: { method: "POST", path: PAID_OPERATIONS.extract_url.path }, mcpTool: "extract_url", price: price("extract_url") },
      {
        name: "extract_url_structured",
        http: { method: "POST", path: PAID_OPERATIONS.extract_url_structured.path },
        mcpTool: "extract_url_structured",
        price: price("extract_url_structured"),
      },
    ],
    endpoints: {
      health: `${origin}/health`,
      openapi: `${origin}/openapi.json`,
      mcp: `${origin}/mcp`,
    },
    limits: {
      maxUrlLength: cfg.limits.maxUrlLength,
      maxDownloadBytes: cfg.limits.maxResponseBytes,
      fetchTimeoutMs: cfg.limits.fetchTimeoutMs,
      maxRedirects: cfg.limits.maxRedirects,
      defaultMaxCharacters: cfg.limits.defaultMaxCharacters,
      maxCharacters: cfg.limits.maxCharactersLimit,
      maxLinks: cfg.limits.maxLinks,
      maxHeadings: cfg.limits.maxHeadings,
    },
    limitations: [
      "JavaScript is not executed; client-rendered pages may return javascript_required.",
      "Only public http(s) URLs on default ports; IP-literal, internal and reserved hosts are rejected.",
      "Only HTML, XHTML and plain text/Markdown are extracted.",
      "Authentication, paywalls and CAPTCHAs are not bypassed.",
    ],
  };
}
