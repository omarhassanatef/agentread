/**
 * Benchmark Worker (NOT the product). Runs the production fetch + SSRF guard + extraction
 * code for either engine, so engine quality and CPU behaviour can be measured on
 * Cloudflare's edge without paying. Deployed temporarily as `agentread-bench`
 * (wrangler.bench.jsonc), gated by the BENCH_TOKEN secret, and deleted after use.
 *
 *   GET /?url=https://…&engine=lite|readability   (header x-bench-token: <BENCH_TOKEN>)
 */
import { createServices } from "./api/context.js";
import { loadConfig, type Bindings } from "./config/env.js";
import { extractUrl } from "./extraction/operations.js";
import { safeFetch } from "./extraction/fetch.js";
import { validateTargetUrl } from "./security/url.js";
import { toAppError, errorBody } from "./utils/errors.js";

interface BenchEnv extends Bindings {
  BENCH_TOKEN?: string;
  /** Pins the mode so per-script analytics (CPU quantiles) separate the variants. */
  BENCH_MODE?: string;
}

export default {
  async fetch(request: Request, env: BenchEnv): Promise<Response> {
    const token = env.BENCH_TOKEN;
    if (!token || request.headers.get("x-bench-token") !== token) return new Response("forbidden", { status: 403 });
    const params = new URL(request.url).searchParams;
    const url = params.get("url") ?? "";
    const mode = env.BENCH_MODE ?? params.get("engine") ?? "lite";
    if (mode === "raw") {
      // Minimal-CPU variant: raw bytes straight to toMarkdown, no parsing in our JS.
      const cfg = loadConfig(env);
      const svc = createServices(cfg, {}, env);
      try {
        const doc = await safeFetch(validateTargetUrl(url, cfg.limits.maxUrlLength), svc, { maxBytes: cfg.limits.maxResponseBytes, allowPartial: false });
        const selector = params.get("selector") ?? undefined;
        const res = await env.AI!.toMarkdown(
          { name: "page.html", blob: new Blob([doc.body], { type: `text/html; charset=${doc.headerCharset ?? "utf-8"}` }) },
          { conversionOptions: { html: { hostname: new URL(doc.finalUrl).origin, ...(selector ? { cssSelector: selector } : {}), images: { convert: false, convertOGImage: false } } } },
        );
        const markdown = res.format === "error" ? "" : res.data;
        return Response.json({ engine: "raw", method: "raw", bytes: doc.body.length, chars: markdown.length, headings: (markdown.match(/^#{1,6} /gm) ?? []).length, wallMs: 0, markdown, ...(res.format === "error" ? { error: { code: res.error } } : {}) });
      } catch (err) {
        const e = toAppError(err);
        return Response.json({ engine: "raw", ...errorBody(e) }, { status: e.status });
      }
    }
    const engine = mode === "readability" ? "readability" : "lite";
    const cfg = { ...loadConfig({ ...env, EXTRACTION_ENGINE: engine }) };
    const svc = createServices(cfg, {}, env);
    try {
      const r = await extractUrl({ url }, svc); // product defaults (20k chars)
      return Response.json({
        engine,
        method: r.extraction.method,
        title: r.title,
        bytes: r.extraction.bytesFetched,
        chars: r.extraction.characters,
        headings: r.headings.length,
        wallMs: r.extraction.durationMs,
        markdown: r.markdown,
      });
    } catch (err) {
      const e = toAppError(err);
      return Response.json({ engine, ...errorBody(e) }, { status: e.status });
    }
  },
};
