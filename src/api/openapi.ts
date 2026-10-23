import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { SERVICE_VERSION, SUPPORTED_NETWORKS, type AppConfig } from "../config/env.js";
import { priceFor } from "../payments/x402.js";
import {
  extractInputSchema,
  extractResultSchema,
  inspectInputSchema,
  inspectResultSchema,
  structuredResultSchema,
} from "../schemas/index.js";
import { ERROR_STATUS } from "../utils/errors.js";

const errorSchema = z.object({
  error: z.object({
    code: z.enum(Object.keys(ERROR_STATUS) as [string, ...string[]]),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});

const paymentRequiredSchema = z.object({
  error: z.object({
    code: z.enum(["payment_required", "payment_settlement_failed"]),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});

function schema(s: z.ZodTypeAny) {
  const { $schema: _ignored, ...rest } = zodToJsonSchema(s, { target: "openApi3", $refStrategy: "none" }) as Record<string, unknown>;
  return rest;
}

const json = (ref: string) => ({ "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } });
const err = (description: string) => ({ description, content: json("Error") });

/** OpenAPI 3.1 document generated from the same zod schemas the service validates with. */
export function openApiDocument(cfg: AppConfig, origin: string) {
  const p = cfg.payment;
  const priceNote = (op: "extract_url" | "extract_url_structured") =>
    p ? `Costs ${priceFor(p, op)} in USDC on ${SUPPORTED_NETWORKS[p.network].name} (${p.network}) via x402 v2 \`exact\` scheme.` : "Payments are not configured on this deployment.";

  const paidResponses = (resultRef: string) => ({
    "200": {
      description: "Extraction succeeded and payment was settled. The `PAYMENT-RESPONSE` header carries the base64 settlement receipt.",
      headers: { "PAYMENT-RESPONSE": { schema: { type: "string" }, description: "Base64-encoded x402 SettleResponse." } },
      content: json(resultRef),
    },
    "400": err("Invalid input or blocked destination (returned before any payment is requested)."),
    "402": {
      description:
        "Payment required, invalid/expired/replayed payment, or settlement failure. The `PAYMENT-REQUIRED` header carries the base64 x402 PaymentRequired object (accepts[], resource).",
      headers: { "PAYMENT-REQUIRED": { schema: { type: "string" }, description: "Base64-encoded x402 PaymentRequired." } },
      content: json("PaymentRequired"),
    },
    "413": err("Request body too large."),
    "415": err("Request body is not JSON."),
    "422": err("Page could not be extracted (unsupported content, too large, empty, requires JavaScript, too many redirects, unknown host). Not charged."),
    "429": err("Rate limited."),
    "502": err("Upstream page or DNS error, or facilitator error. Not charged."),
    "503": err("Payments not configured."),
    "504": err("Upstream page timed out. Not charged."),
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "AgentRead API",
      version: SERVICE_VERSION,
      description:
        "Clean web content for AI agents, paid per request via x402. Paid endpoints return HTTP 402 with x402 v2 payment requirements; " +
        "retry with a `PAYMENT-SIGNATURE` header produced by an x402 client (e.g. @x402/fetch). Only successful extractions are settled.",
    },
    servers: [{ url: origin }],
    paths: {
      "/health": { get: { summary: "Health check", responses: { "200": { description: "Service is up." } } } },
      "/": { get: { summary: "Service discovery document (operations, prices, limits)", responses: { "200": { description: "Discovery JSON." } } } },
      "/v1/inspect": {
        post: {
          summary: "Inspect a URL (free)",
          operationId: "inspect_url",
          requestBody: { required: true, content: json("InspectInput") },
          responses: {
            "200": { description: "Inspection result. Upstream failures are reported in the body (reachable=false, limitation).", content: json("InspectResult") },
            "400": err("Invalid input or blocked destination."),
            "413": err("Request body too large."),
            "429": err("Rate limited."),
          },
        },
      },
      "/v1/extract": {
        post: {
          summary: "Extract clean Markdown (paid)",
          operationId: "extract_url",
          description: priceNote("extract_url"),
          parameters: [{ name: "PAYMENT-SIGNATURE", in: "header", required: false, schema: { type: "string" }, description: "Base64 x402 PaymentPayload." }],
          requestBody: { required: true, content: json("ExtractInput") },
          responses: paidResponses("ExtractResult"),
        },
      },
      "/v1/extract/structured": {
        post: {
          summary: "Structured extraction (paid)",
          operationId: "extract_url_structured",
          description: priceNote("extract_url_structured"),
          parameters: [{ name: "PAYMENT-SIGNATURE", in: "header", required: false, schema: { type: "string" }, description: "Base64 x402 PaymentPayload." }],
          requestBody: { required: true, content: json("ExtractInput") },
          responses: paidResponses("StructuredResult"),
        },
      },
      "/mcp": {
        post: {
          summary: "MCP Streamable HTTP endpoint (stateless, JSON responses)",
          description:
            "JSON-RPC 2.0 per the MCP Streamable HTTP transport. Tools: inspect_url, extract_url, extract_url_structured. " +
            "Paid tools return an x402 PaymentRequired tool result (isError=true, structuredContent) and accept payment in `params._meta[\"x402/payment\"]`.",
          responses: { "200": { description: "JSON-RPC response." } },
        },
      },
    },
    components: {
      schemas: {
        InspectInput: schema(inspectInputSchema(cfg.limits)),
        ExtractInput: schema(extractInputSchema(cfg.limits)),
        InspectResult: schema(inspectResultSchema),
        ExtractResult: schema(extractResultSchema),
        StructuredResult: schema(structuredResultSchema),
        Error: schema(errorSchema),
        PaymentRequired: schema(paymentRequiredSchema),
      },
    },
  };
}
