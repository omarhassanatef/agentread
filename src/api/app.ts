import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { paymentMiddleware } from "@x402/hono";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { SERVICE_VERSION, SUPPORTED_NETWORKS, type AppConfig, type Bindings } from "../config/env.js";
import { extractUrl, extractUrlStructured, inspectUrl, prevalidateUrl, type Services } from "../extraction/operations.js";
import { handleMcpRequest } from "../mcp/server.js";
import { PAID_OPERATIONS, createResourceServer, paidRoutes, type PaidOperation } from "../payments/x402.js";
import { attachHttpDiscovery } from "../payments/discovery.js";

const PAID_ROUTE_KEYS = Object.fromEntries(
  (Object.keys(PAID_OPERATIONS) as PaidOperation[]).map((op) => [`${PAID_OPERATIONS[op].method} ${PAID_OPERATIONS[op].path}`, op]),
) as Record<string, PaidOperation>;
import { extractInputSchema, inspectInputSchema, type ExtractInput, type InspectInput } from "../schemas/index.js";
import type { ValidatedUrl } from "../security/url.js";
import { AppError, errorBody, toAppError } from "../utils/errors.js";
import { logError, logEvent } from "../utils/log.js";
import { checkRateLimit, clientKey, createServices, getConfig, getFacilitator, paymentsUnavailable, type AppDeps } from "./context.js";
import { discoveryDocument } from "./discovery.js";
import { openApiDocument } from "./openapi.js";

type Vars = {
  cfg: AppConfig;
  svc: Services;
  input: ExtractInput;
  target: ValidatedUrl;
};
export type AppEnv = { Bindings: Bindings; Variables: Vars };

function sendError(c: Context<AppEnv>, err: unknown) {
  const e = toAppError(err);
  if (e.code === "internal_error") logError("http.internal_error", { path: c.req.path, error: err instanceof Error ? err.name : "unknown" });
  return c.json(errorBody(e), e.status as never);
}

async function readJson(c: Context<AppEnv>): Promise<unknown> {
  const type = c.req.header("content-type");
  if (type && !/json/i.test(type)) throw new AppError("unsupported_media_type", "Request body must be JSON (Content-Type: application/json).");
  try {
    return await c.req.json();
  } catch {
    throw new AppError("invalid_request", "Request body must be valid JSON.");
  }
}

function zodMessage(issues: { path: (string | number)[]; message: string }[]): string {
  return issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}

export function createApp(deps: AppDeps = {}) {
  const app = new Hono<AppEnv>();

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["content-type", "payment-signature", "x-payment", "mcp-session-id", "mcp-protocol-version", "accept"],
      exposeHeaders: ["payment-required", "payment-response", "x-payment-response", "mcp-session-id"],
      maxAge: 600,
    }),
  );

  // Config + per-request services, request logging.
  app.use("*", async (c, next) => {
    const started = Date.now();
    let cfg: AppConfig;
    try {
      cfg = getConfig(c.env ?? {});
    } catch (err) {
      logError("config.invalid", { error: err instanceof Error ? err.message : "unknown" });
      return c.json(errorBody(new AppError("internal_error", "Service is misconfigured.")), 500);
    }
    c.set("cfg", cfg);
    c.set("svc", createServices(cfg, deps, c.env ?? {}));
    await next();
    c.header("x-content-type-options", "nosniff");
    logEvent("http.request", {
      method: c.req.method,
      route: c.req.routePath,
      status: c.res.status,
      durationMs: Date.now() - started,
      paid: c.res.headers.has("payment-response"),
    });
  });

  app.onError((err, c) => sendError(c, err));
  app.notFound((c) => sendError(c, new AppError("not_found", `No route for ${c.req.method} ${c.req.path}. See GET / for the API index.`)));

  const limitBody = (factor = 1): MiddlewareHandler<AppEnv> => async (c, next) =>
    bodyLimit({
      maxSize: c.get("cfg").limits.maxRequestBodyBytes * factor,
      onError: (cc) => cc.json(errorBody(new AppError("request_too_large", "Request body is too large.")), 413),
    })(c, next);

  app.get("/", (c) => c.json(discoveryDocument(c.get("cfg"), new URL(c.req.url).origin)));
  app.get("/health", (c) => {
    const cfg = c.get("cfg");
    return c.json({
      status: "ok",
      service: "agentread",
      version: SERVICE_VERSION,
      environment: cfg.environment,
      // Active engine: "lite" only when the Workers AI binding is actually present.
      extractionEngine: c.get("svc").markdownConverter ? "lite" : "readability",
      payments: cfg.payment
        ? { enabled: true, network: cfg.payment.network, networkName: SUPPORTED_NETWORKS[cfg.payment.network].name }
        : { enabled: false },
    });
  });
  app.get("/openapi.json", (c) => c.json(openApiDocument(c.get("cfg"), new URL(c.req.url).origin)));

  // ---- Free: inspect -------------------------------------------------------
  app.post("/v1/inspect", limitBody(), async (c) => {
    try {
      const parsed = inspectInputSchema(c.get("cfg").limits).safeParse(await readJson(c));
      if (!parsed.success) throw new AppError("invalid_request", zodMessage(parsed.error.issues));
      await checkRateLimit(c.env?.INSPECT_RATE_LIMITER, clientKey(c.req.raw));
      return c.json(await inspectUrl(parsed.data as InspectInput, c.get("svc")));
    } catch (err) {
      return sendError(c, err);
    }
  });

  // ---- Paid: validate → rate limit → x402 → handler -------------------------
  /** Runs before the payment middleware so invalid requests never receive a 402. */
  const prevalidate: MiddlewareHandler<AppEnv> = async (c, next) => {
    try {
      const cfg = c.get("cfg");
      const parsed = extractInputSchema(cfg.limits).safeParse(await readJson(c));
      if (!parsed.success) throw new AppError("invalid_request", zodMessage(parsed.error.issues));
      c.set("target", await prevalidateUrl(parsed.data.url, c.get("svc")));
      c.set("input", parsed.data);
      await checkRateLimit(c.env?.PAID_RATE_LIMITER, clientKey(c.req.raw));
      if (!cfg.payment) {
        // Operator-facing reason goes to logs only; clients get a generic 503.
        logError("payments.misconfigured", { reason: cfg.paymentConfigError });
        throw paymentsUnavailable();
      }
    } catch (err) {
      return sendError(c, err);
    }
    await next();
  };

  /**
   * @x402/hono payment gate, constructed per request (Workers cannot share in-flight I/O
   * across requests; the facilitator's /supported data is cached separately).
   */
  const paymentGate: MiddlewareHandler<AppEnv> = async (c, next) => {
    const cfg = c.get("cfg");
    const facilitator = getFacilitator(cfg, deps);
    const server = createResourceServer(cfg.payment!, facilitator);
    const routes = paidRoutes(cfg.payment!);
    const middleware = paymentMiddleware(routes, server);
    attachHttpDiscovery(routes as Record<string, { extensions?: Record<string, unknown> }>, PAID_ROUTE_KEYS, cfg.limits); // after creation: see discovery.ts
    const returned = await middleware(c, next);
    const res = returned ?? c.res;
    // The SDK answers rejected payments (invalid signature, insufficient balance, expired…)
    // with an empty `{}` body and puts the reason only in the base64 PAYMENT-REQUIRED header.
    // Give agents the same readable error shape as every other response.
    if (res.status === 402 && res.headers.get("content-type")?.includes("json")) {
      const text = await res.clone().text();
      const header = res.headers.get("payment-required");
      if (text.trim() === "{}" && header) {
        let reason: string | undefined;
        try {
          reason = decodePaymentRequiredHeader(header).error;
        } catch {
          reason = undefined;
        }
        const body = errorBody(
          new AppError("payment_invalid", "The payment was rejected. Sign a new payment for the requirements in the PAYMENT-REQUIRED header and retry.", {
            reason: reason ?? "unknown",
          }),
        );
        c.res = new Response(JSON.stringify(body), { status: 402, headers: res.headers });
        return c.res;
      }
    }
    return returned;
  };

  const paidHandler = (op: PaidOperation) => async (c: Context<AppEnv>) => {
    const input = c.get("input");
    const target = c.get("target");
    try {
      const result = op === "extract_url" ? await extractUrl(input, c.get("svc"), target) : await extractUrlStructured(input, c.get("svc"), target);
      logEvent("extract.success", { op, host: target.hostname, method: result.extraction.method, ms: result.extraction.durationMs, chars: result.extraction.characters });
      return c.json(result);
    } catch (err) {
      const e = toAppError(err);
      logEvent("extract.failure", { op, host: target.hostname, code: e.code });
      // Status >= 400 makes @x402/hono cancel settlement: failed extractions are not charged.
      return sendError(c, e);
    }
  };

  app.post("/v1/extract", limitBody(), prevalidate, paymentGate, paidHandler("extract_url"));
  app.post("/v1/extract/structured", limitBody(), prevalidate, paymentGate, paidHandler("extract_url_structured"));

  // ---- MCP (Streamable HTTP, stateless). Payment happens per tool call via @x402/mcp.
  // Stateless JSON mode has no server-initiated stream and no sessions, so GET/DELETE are
  // answered with 405 as the transport spec allows (avoids idle SSE connections).
  app.on(["GET", "DELETE"], "/mcp", (c) => {
    c.header("allow", "POST, OPTIONS");
    return sendError(c, new AppError("method_not_allowed", "This MCP endpoint is stateless: send JSON-RPC requests with POST."));
  });
  app.post("/mcp", limitBody(8), async (c) => {
    const cfg = c.get("cfg");
    return handleMcpRequest(c.req.raw, {
      cfg,
      svc: c.get("svc"),
      facilitator: () => getFacilitator(cfg, deps),
      inspectLimiter: c.env?.INSPECT_RATE_LIMITER,
      paidLimiter: c.env?.PAID_RATE_LIMITER,
      clientKey: clientKey(c.req.raw),
    });
  });

  return app;
}
