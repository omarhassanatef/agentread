import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Limits } from "../config/env.js";
import { extractInputSchema, extractResultSchema, structuredResultSchema } from "../schemas/index.js";
import type { PaidOperation } from "./x402.js";

export const DISCOVERY_TAGS = ["web", "extraction", "markdown", "scraping", "llm"];

const EXAMPLE_INPUT = { url: "https://example.com/", maxCharacters: 20000, includeLinks: true };

function jsonSchema(schema: Parameters<typeof zodToJsonSchema>[0]): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
  return rest;
}

const outputSchemaFor = (op: PaidOperation) => jsonSchema(op === "extract_url" ? extractResultSchema : structuredResultSchema);

/**
 * x402 Bazaar discovery metadata for a paid HTTP route (CDP Bazaar / agentic.market).
 * Indexed by the CDP facilitator after the route's first successful settled payment.
 */
export function httpDiscovery(op: PaidOperation, limits: Limits): Record<string, unknown> {
  return declareDiscoveryExtension({
    bodyType: "json",
    input: EXAMPLE_INPUT,
    inputSchema: jsonSchema(extractInputSchema(limits)),
    output: { schema: outputSchemaFor(op) },
  });
}

/**
 * Attach Bazaar declarations to route configs *after* @x402/hono's middleware was created.
 *
 * Why: when routes declare `extensions.bazaar` at creation time, @x402/hono 2.28 validates
 * them with ajv, which compiles code at runtime — forbidden on Workers, so it logs a large
 * error (and we build the middleware per request). The validation is advisory only, and the
 * compiled routes keep references to these config objects, so declaring afterwards yields the
 * same 402 output without the failing validation. The declarations come from the SDK's own
 * declareDiscoveryExtension, and tests assert both the 402 metadata and the absence of warnings.
 */
export function attachHttpDiscovery(routes: Record<string, { extensions?: Record<string, unknown> }>, ops: Record<string, PaidOperation>, limits: Limits): void {
  for (const [key, op] of Object.entries(ops)) {
    const route = routes[key];
    if (route) route.extensions = { ...(route.extensions ?? {}), ...httpDiscovery(op, limits) };
  }
}

/**
 * x402 Bazaar discovery metadata for MCP tools, so facilitators that run a Bazaar
 * catalogue can list AgentRead's paid tools with input and output schemas.
 */
export function mcpDiscovery(op: PaidOperation, description: string, limits: Limits): Record<string, unknown> {
  return declareDiscoveryExtension({
    toolName: op,
    description,
    transport: "streamable-http",
    inputSchema: jsonSchema(extractInputSchema(limits)),
    example: EXAMPLE_INPUT,
    output: { schema: outputSchemaFor(op) },
  });
}
