import { describe, expect, it } from "vitest";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ARTICLE_HTML, DOCS_HTML, EMPTY_BODY_HTML, SPA_HTML, longArticle } from "../fixtures/pages.js";
import { harness, payingClient, postJson, type Harness } from "../helpers/app.js";
import { html, redirect } from "../helpers/upstream.js";
import { extractResultSchema, inspectResultSchema, structuredResultSchema } from "../../src/schemas/index.js";

const A = "https://site.example.com/article";

type ErrorJson = { error: { code: string; message: string; details?: Record<string, unknown> } };

async function paid(h: Harness, path: string, body: unknown): Promise<Response> {
  return wrapFetchWithPayment(h.appFetch, payingClient().client)(`https://agentread.test${path}`, postJson(body));
}

describe("service endpoints", () => {
  it("GET /health", async () => {
    const res = await harness().fetch("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "ok",
      service: "agentread",
      extractionEngine: "readability",
      payments: { enabled: true, network: "eip155:84532", networkName: "Base Sepolia" },
    });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("GET / is a discovery document with prices", async () => {
    const body = (await (await harness().fetch("/")).json()) as { operations: Array<{ name: string; price: string }>; endpoints: { mcp: string } };
    expect(body.operations.map((o) => [o.name, o.price])).toEqual([
      ["inspect_url", "free"],
      ["extract_url", "$0.003"],
      ["extract_url_structured", "$0.005"],
    ]);
    expect(body.endpoints.mcp).toBe("https://agentread.test/mcp");
  });

  it("GET /openapi.json describes every endpoint", async () => {
    const doc = (await (await harness().fetch("/openapi.json")).json()) as { openapi: string; paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/health", "/v1/inspect", "/v1/extract", "/v1/extract/structured", "/mcp"]));
    expect(Object.keys(doc.components.schemas)).toEqual(expect.arrayContaining(["ExtractInput", "ExtractResult", "StructuredResult", "InspectResult", "Error"]));
  });

  it("unknown routes return a JSON 404", async () => {
    const res = await harness().fetch("/v2/nope");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorJson).error.code).toBe("not_found");
  });

  it("CORS exposes x402 headers", async () => {
    const res = await harness().fetch("/v1/extract", { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const exposed = await harness().fetch("/health", { headers: { origin: "https://app.example" } });
    expect(exposed.headers.get("access-control-expose-headers")).toContain("payment-required");
  });
});

describe("POST /v1/inspect (free)", () => {
  it("inspects an HTML page without building a DOM or downloading everything", async () => {
    const h = harness({ "https://site.example.com/old": redirect(A), [A]: html(ARTICLE_HTML, { "content-length": String(ARTICLE_HTML.length) }) });
    const res = await h.fetch("/v1/inspect", postJson({ url: "https://site.example.com/old#frag" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("payment-required")).toBeNull();
    const r = inspectResultSchema.parse(await res.json());
    expect(r).toMatchObject({
      normalizedUrl: "https://site.example.com/old",
      hostname: "site.example.com",
      reachable: true,
      statusCode: 200,
      finalUrl: A,
      redirects: 1,
      contentType: "text/html",
      isHtml: true,
      title: "How Tide Pools Work | Ocean Notes",
      mayRequireJavaScript: false,
      extractionSupported: true,
      limitation: null,
    });
  });

  it("reports HTTP errors as limitations rather than claiming support", async () => {
    const h = harness({ [A]: { status: 404, body: "<title>Not Found</title>", headers: { "content-type": "text/html" } } });
    const r = inspectResultSchema.parse(await (await h.fetch("/v1/inspect", postJson({ url: A }))).json());
    expect(r.reachable).toBe(true);
    expect(r.statusCode).toBe(404);
    expect(r.extractionSupported).toBe(false);
    expect(r.limitation).toContain("404");
  });

  it("flags non-HTML, oversized and JS-rendered pages", async () => {
    const h = harness({
      "https://site.example.com/a.pdf": { body: "%PDF-1.7", headers: { "content-type": "application/pdf" } },
      "https://site.example.com/big": { body: "<html>", headers: { "content-type": "text/html", "content-length": "50000000" } },
      "https://site.example.com/spa": html(SPA_HTML),
    });
    const pdf = inspectResultSchema.parse(await (await h.fetch("/v1/inspect", postJson({ url: "https://site.example.com/a.pdf" }))).json());
    expect(pdf).toMatchObject({ isHtml: false, extractionSupported: false, contentType: "application/pdf" });
    const big = inspectResultSchema.parse(await (await h.fetch("/v1/inspect", postJson({ url: "https://site.example.com/big" }))).json());
    expect(big.extractionSupported).toBe(false);
    expect(big.limitation).toMatch(/exceeds/);
    const spa = inspectResultSchema.parse(await (await h.fetch("/v1/inspect", postJson({ url: "https://site.example.com/spa" }))).json());
    expect(spa.mayRequireJavaScript).toBe(true);
    expect(spa.limitation).toMatch(/JavaScript/);
  });

  it("reports unreachable and slow hosts", async () => {
    const h = harness({ "https://slow.example.com/": { hang: true } });
    const down = inspectResultSchema.parse(await (await h.fetch("/v1/inspect", postJson({ url: "https://down.example.com/" }))).json());
    expect(down).toMatchObject({ reachable: false, extractionSupported: false });
    expect(down.limitation).toBeTruthy();
    const slow = inspectResultSchema.parse(await (await h.fetch("/v1/inspect", postJson({ url: "https://slow.example.com/" }))).json());
    expect(slow.limitation).toMatch(/did not respond/);
  });

  it("rejects invalid and blocked URLs with 400", async () => {
    const h = harness();
    for (const url of ["ftp://x.example.com/", "http://localhost/", "http://192.168.0.1/", "https://user:pw@site.example.com/"]) {
      const res = await h.fetch("/v1/inspect", postJson({ url }));
      expect(res.status).toBe(400);
    }
    expect(h.upstream.calls).toHaveLength(0);
  });

  it("blocks redirects to internal destinations", async () => {
    const h = harness({ [A]: redirect("http://169.254.169.254/latest/meta-data/") });
    const res = await h.fetch("/v1/inspect", postJson({ url: A }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorJson).error.code).toBe("blocked_destination");
    expect(h.upstream.calls).toHaveLength(1);
  });

  it("enforces request body limits and JSON content type", async () => {
    const h = harness();
    const big = await h.fetch("/v1/inspect", postJson({ url: `https://site.example.com/${"a".repeat(20_000)}` }));
    expect(big.status).toBe(413);
    const form = await h.fetch("/v1/inspect", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "url=x" });
    expect(form.status).toBe(415);
  });

  it("applies the rate limiter when bound", async () => {
    const h = harness();
    const env = { ...h.env, INSPECT_RATE_LIMITER: { limit: async () => ({ success: false }) } as unknown as RateLimit };
    const { createApp } = await import("../../src/api/app.js");
    const res = await createApp({ fetcher: h.upstream.fetcher, hostGuard: async () => {} }).fetch(
      new Request("https://agentread.test/v1/inspect", postJson({ url: A })),
      env,
    );
    expect(res.status).toBe(429);
  });
});

describe("paid extraction behaviour", () => {
  it("documentation page → structured Markdown", async () => {
    const h = harness({ "https://docs.example.com/docs/config": html(DOCS_HTML) });
    const res = await paid(h, "/v1/extract", { url: "https://docs.example.com/docs/config" });
    expect(res.status).toBe(200);
    const r = extractResultSchema.parse(await res.json());
    expect(r.markdown).toMatch(/\| apiKey \| string \|/);
    expect(r.description).toBe("Configure the Widget SDK.");
    expect(r.headings[0]).toEqual({ level: 2, text: "Options" });
  });

  it("truncates to maxCharacters and reports it", async () => {
    const h = harness({ [A]: html(longArticle(200)) });
    const r = extractResultSchema.parse(await (await paid(h, "/v1/extract", { url: A, maxCharacters: 1000 })).json());
    expect(r.truncated).toBe(true);
    expect(r.markdown.length).toBeLessThanOrEqual(1000);
    expect(r.extraction.characters).toBe(r.markdown.length);
    expect(r.extraction.totalCharacters).toBeGreaterThan(1000);
  });

  it("applies the default character limit", async () => {
    const h = harness({ [A]: html(longArticle(400)) });
    const r = extractResultSchema.parse(await (await paid(h, "/v1/extract", { url: A })).json());
    expect(r.truncated).toBe(true);
    expect(r.markdown.length).toBeLessThanOrEqual(20_000);
  });

  it("includeLinks=false removes URLs from Markdown but structured links remain", async () => {
    const h = harness({ [A]: html(ARTICLE_HTML) });
    const r = structuredResultSchema.parse(await (await paid(h, "/v1/extract/structured", { url: A, includeLinks: false })).json());
    expect(r.markdown).not.toContain("](");
    expect(r.links.length).toBeGreaterThan(0);
  });

  it("follows redirects and reports the final URL", async () => {
    const h = harness({ "https://site.example.com/old": redirect(A, 308), [A]: html(ARTICLE_HTML) });
    const r = extractResultSchema.parse(await (await paid(h, "/v1/extract", { url: "https://site.example.com/old" })).json());
    expect(r.requestedUrl).toBe("https://site.example.com/old");
    expect(r.finalUrl).toBe(A);
    expect(r.extraction.redirects).toBe(1);
  });

  it("extracts plain text", async () => {
    const h = harness({ [A]: { body: "Just some plain text content that is long enough to count as readable content.", headers: { "content-type": "text/plain" } } });
    const r = extractResultSchema.parse(await (await paid(h, "/v1/extract", { url: A })).json());
    expect(r.extraction.method).toBe("plain-text");
    expect(r.title).toBeNull();
  });

  it("decodes legacy charsets", async () => {
    const enc = new TextEncoder();
    const body = new Uint8Array([
      ...enc.encode("<html><head><title>Caf"),
      0xe9,
      ...enc.encode("</title></head><body><article><p>"),
      ...enc.encode("Le caf".repeat(1)),
      0xe9,
      ...enc.encode(" est ouvert. ".repeat(30)),
      ...enc.encode("</p></article></body></html>"),
    ]);
    const h = harness({ [A]: { body, headers: { "content-type": "text/html; charset=ISO-8859-1" } } });
    const r = extractResultSchema.parse(await (await paid(h, "/v1/extract", { url: A })).json());
    expect(r.title).toBe("Café");
    expect(r.markdown).toContain("Le café est ouvert.");
    expect(r.extraction.charset).toBe("iso-8859-1");
  });

  const failures: Array<[string, Parameters<typeof harness>[0], number, string]> = [
    ["404", { [A]: { status: 404, body: "nope", headers: { "content-type": "text/html" } } }, 502, "upstream_http_error"],
    ["500", { [A]: { status: 500, body: "boom", headers: { "content-type": "text/html" } } }, 502, "upstream_http_error"],
    ["non-HTML", { [A]: { body: "{}", headers: { "content-type": "application/json" } } }, 422, "unsupported_content_type"],
    ["empty body", { [A]: { body: "", headers: { "content-type": "text/html" } } }, 422, "empty_content"],
    ["empty page", { [A]: html(EMPTY_BODY_HTML) }, 422, "empty_content"],
    ["oversized", { [A]: { streamBytes: 4_000_000 } }, 422, "content_too_large"],
    ["JS-rendered", { [A]: html(SPA_HTML) }, 422, "javascript_required"],
    ["unreachable", {}, 502, "upstream_unreachable"],
    ["redirect loop", { [A]: redirect(A) }, 422, "too_many_redirects"],
  ];
  for (const [name, routes, status, code] of failures) {
    it(`${name} → ${status} ${code}, not charged`, async () => {
      const h = harness(routes);
      const res = await paid(h, "/v1/extract", { url: A });
      expect(res.status).toBe(status);
      expect(((await res.json()) as ErrorJson).error.code).toBe(code);
      expect(h.facilitator.chain.settlements).toHaveLength(0);
    });
  }
});
