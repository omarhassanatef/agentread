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
