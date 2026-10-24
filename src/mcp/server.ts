import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createPaymentWrapper } from "@x402/mcp";
import type { FacilitatorClient } from "@x402/core/server";
import { SERVICE_NAME, SERVICE_VERSION, type AppConfig } from "../config/env.js";
import { extractUrl, extractUrlStructured, inspectUrl, prevalidateUrl, type Services } from "../extraction/operations.js";
import { createResourceServer, priceFor, type PaidOperation } from "../payments/x402.js";
import type { FreeTier } from "../payments/free-tier.js";
import { DISCOVERY_TAGS, mcpDiscovery } from "../payments/discovery.js";
import { extractInputShape, inspectInputShape, inspectResultSchema, type ExtractInput } from "../schemas/index.js";
import { AppError, errorBody, toAppError } from "../utils/errors.js";
import { logEvent } from "../utils/log.js";
import { checkRateLimit, paymentsUnavailable } from "../api/context.js";

export interface McpContext {
  cfg: AppConfig;
  svc: Services;
  /** Lazily resolved so tools/list works even if the facilitator is unreachable. */
  facilitator: () => FacilitatorClient;
  inspectLimiter?: RateLimit;
  paidLimiter?: RateLimit;
  clientKey: string;
  /** Free daily allowance for paid tools (null/absent → every call needs payment). */
  freeTier?: FreeTier | null;
}

/** Text-only tool result: the shape both the MCP SDK and @x402/mcp accept. */
type TextToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(data: Record<string, unknown>): TextToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

function fail(err: unknown): TextToolResult {
  const e = toAppError(err);
  return { content: [{ type: "text", text: JSON.stringify(errorBody(e)) }], isError: true };
}

const PAID_TOOL_DOCS: Record<PaidOperation, { title: string; description: string; output: string }> = {
  extract_url: {
    title: "Extract URL (clean Markdown)",
    description:
      "Fetch a public web page and return its main content as clean Markdown with title, description, headings and extraction metadata. " +
      "Removes navigation, ads, cookie banners and scripts. Does not execute JavaScript. Paid via x402",
    output:
      "Returns JSON (structuredContent + text) with schemaVersion, operation, requestedUrl, finalUrl, title, description, markdown, headings[{level,text}], truncated, extraction{method,statusCode,contentType,charset,redirects,bytesFetched,characters,totalCharacters,words,warnings,durationMs}.",
  },
  extract_url_structured: {
    title: "Extract URL (structured)",
    description:
      "Fetch a public web page and return structured data: page metadata (title, description, canonical URL, language, site name, byline), " +
      "main content Markdown, ordered headings with levels, and links (text + URL). Deterministic HTML processing, no LLM. Paid via x402",
    output:
      "Returns JSON with schemaVersion, operation, requestedUrl, finalUrl, metadata{title,description,canonicalUrl,language,siteName,byline,publishedTime}, markdown, headings, headingsTruncated, links[{text,url}], linksTruncated, truncated, extraction{...}.",
  },
};

/** Build a stateless MCP server for one request. Tools share operations/schemas with the HTTP API. */
export function buildMcpServer(ctx: McpContext): McpServer {
  const { cfg, svc } = ctx;
  const server = new McpServer(
    { name: "agentread", title: SERVICE_NAME, version: SERVICE_VERSION },
    {
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      instructions:
        "AgentRead turns public web pages into clean, agent-friendly content. Call inspect_url (free) first to check a URL; " +
        "extract_url and extract_url_structured are paid per successful call via x402 (USDC). Failed extractions are not charged.",
    },
  );

  server.registerTool(
    "inspect_url",
    {
      title: "Inspect URL (free)",
      description:
        "Free, lightweight check of a public URL: reachability, HTTP status, final URL after redirects, content type, page title, " +
        "and whether extraction is likely to work. Downloads at most a small prefix of the page.",
      inputSchema: inspectInputShape(cfg.limits),
      outputSchema: inspectResultSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async (args) => {
      try {
        await checkRateLimit(ctx.inspectLimiter, ctx.clientKey);
        return ok(await inspectUrl(args, svc));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // Paid tools deliberately declare no outputSchema: the x402 PaymentRequired tool result
  // carries its own object in structuredContent (isError=true), and MCP SDK clients validate
  // structuredContent against outputSchema even on error results, which would reject the
  // payment challenge. The success shape is documented in the description and /openapi.json.
  const registerPaid = (op: PaidOperation) => {
    const docs = PAID_TOOL_DOCS[op];
    const price = cfg.payment ? priceFor(cfg.payment, op) : "unavailable";
    server.registerTool(
      op,
      {
        title: docs.title,
        description: `${docs.description} (${price} per successful call${cfg.freeTier.perClient > 0 ? `; the first ${cfg.freeTier.perClient} successful calls per day are free` : ""}). ${docs.output}`,
        inputSchema: extractInputShape(cfg.limits),
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (args, extra) => {
        // Reject bad input *before* asking for payment.
        let target;
        try {
          if (!cfg.payment) throw paymentsUnavailable();
          target = await prevalidateUrl(args.url, svc);
          await checkRateLimit(ctx.paidLimiter, ctx.clientKey);
        } catch (err) {
          return fail(err);
        }
        const run = op === "extract_url" ? extractUrl : extractUrlStructured;

        // Free daily allowance: calls without x402 payment metadata are served free while it lasts.
        const meta = (extra as { _meta?: Record<string, unknown> })._meta;
        if (!meta?.["x402/payment"] && ctx.freeTier) {
          const grant = await ctx.freeTier.reserve(ctx.clientKey);
          if (grant) {
            try {
              const result = await run(args, svc, target);
              logEvent("mcp.extract.success", { tool: op, host: target.hostname, method: result.extraction.method, free: true });
              return { ...ok(result), _meta: { "agentread/free-tier": { limit: grant.limit, remaining: grant.remaining } } };
            } catch (err) {
              await grant.release();
              const e = toAppError(err);
              logEvent("mcp.extract.failure", { tool: op, host: target.hostname, code: e.code, free: true });
              return fail(e);
            }
          }
        }

        const payment = cfg.payment;
        let paid;
        try {
          const resourceServer = createResourceServer(payment, ctx.facilitator());
          await resourceServer.initialize();
          const accepts = await resourceServer.buildPaymentRequirements({
            scheme: "exact",
            network: payment.network,
            payTo: payment.payTo,
            price: priceFor(payment, op),
            maxTimeoutSeconds: 120,
          });
          paid = createPaymentWrapper(resourceServer, {
            accepts,
            resource: { url: `mcp://tool/${op}`, description: docs.description, mimeType: "application/json", serviceName: SERVICE_NAME, tags: DISCOVERY_TAGS },
            extensions: mcpDiscovery(op, docs.description, cfg.limits),
          });
        } catch {
          return fail(new AppError("payments_unavailable", "The payment facilitator is unavailable. Try again later."));
        }

        const handler = paid(async (a: ExtractInput) => {
          try {
            const result = await run(a, svc, target);
            logEvent("mcp.extract.success", { tool: op, host: target.hostname, method: result.extraction.method });
            return ok(result);
          } catch (err) {
            const e = toAppError(err);
            logEvent("mcp.extract.failure", { tool: op, host: target.hostname, code: e.code });
            return fail(e); // isError → @x402/mcp skips settlement
          }
        });
        return handler(args, extra as never) as Promise<CallToolResult>;
      },
    );
  };

  registerPaid("extract_url");
  registerPaid("extract_url_structured");
  return server;
}

/** Handle one Streamable HTTP request statelessly (JSON responses, no sessions). */
export async function handleMcpRequest(request: Request, ctx: McpContext): Promise<Response> {
  const server = buildMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close().catch(() => {});
  }
}
