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
import { toAppError, errorBody } from "./utils/errors.js";

interface BenchEnv extends Bindings {
  BENCH_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: BenchEnv): Promise<Response> {
    const token = env.BENCH_TOKEN;
    if (!token || request.headers.get("x-bench-token") !== token) return new Response("forbidden", { status: 403 });
    const params = new URL(request.url).searchParams;
    const url = params.get("url") ?? "";
    const engine = params.get("engine") === "readability" ? "readability" : "lite";
    const cfg = { ...loadConfig({ ...env, EXTRACTION_ENGINE: engine }) };
    const svc = createServices(cfg, {}, env);
    try {
      const r = await extractUrl({ url, maxCharacters: 100_000 }, svc);
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
