import { describe, expect, it } from "vitest";
import { extractLite, type MarkdownConverter } from "../../src/extraction/lite.js";
import { parseDocument } from "../../src/extraction/html.js";
import { toMarkdown } from "../../src/extraction/markdown.js";
import { ARTICLE_HTML, CARD_LINKS_HTML, DOCS_HTML, NO_META_HTML, SPA_HTML, WIKI_STYLE_HTML } from "../fixtures/pages.js";

/**
 * Stand-in for Workers AI toMarkdown (which needs Cloudflare's network): converts the
 * cleaned HTML with Turndown, honouring cssSelector and dropping <header>/<footer>
 * like toMarkdown does. HTMLRewriter — the part under test — is the real runtime API.
 */
const calls: Array<{ cssSelector?: string; html: string }> = [];
const fakeConverter: MarkdownConverter = async (html, { cssSelector }) => {
  calls.push({ html, ...(cssSelector ? { cssSelector } : {}) });
  const doc = parseDocument(html);
  const root = (cssSelector ? doc.querySelector(cssSelector) : doc.body) ?? doc.body!;
  if (!cssSelector) for (const el of Array.from(root.querySelectorAll("header, footer"))) el.remove();
  return toMarkdown(root, true);
};

const opts = { includeLinks: true, maxLinks: 200, maxHeadings: 100 };

describe("lite engine (HTMLRewriter + converter)", () => {
  it("removes boilerplate with HTMLRewriter before conversion", async () => {
    calls.length = 0;
    const r = await extractLite(ARTICLE_HTML, "https://ocean.example.com/guides/tide-pools", opts, fakeConverter);
    expect(r.method).toBe("lite");
    const sent = calls[0]!.html;
    for (const junk of ["We use cookies", "BUY OCEAN SNACKS", "Subscribe to our newsletter", "© 2026 Ocean Notes", "window.analytics", "<nav", "<script", "<style"]) {
      expect(sent).not.toContain(junk);
    }
    expect(calls[0]!.cssSelector).toBe("main");
    expect(r.markdown).toContain("Tide pools are shallow basins");
    expect(r.markdown).toContain("## Zones of the intertidal");
    expect(r.markdown).not.toContain("javascript:");
  });

  it("absolutises links and images in the HTML it sends", async () => {
    const r = await extractLite(ARTICLE_HTML, "https://ocean.example.com/guides/tide-pools", opts, fakeConverter);
    expect(r.markdown).toContain("[splash zone](https://ocean.example.com/glossary#splash-zone)");
    expect(r.markdown).toContain("![Green anemone](https://ocean.example.com/img/anemone.jpg)");
    expect(r.links).toEqual(expect.arrayContaining([{ text: "official tide tables", url: "https://example.org/tide-tables" }]));
  });

  it("reads metadata in the same streaming pass", async () => {
    const r = await extractLite(ARTICLE_HTML, "https://ocean.example.com/guides/tide-pools", opts, fakeConverter);
    expect(r.metadata).toEqual({
      title: "How Tide Pools Work | Ocean Notes",
      description: "A field guide to the ecology of rocky tide pools.",
      canonicalUrl: "https://ocean.example.com/guides/tide-pools",
      language: "en-GB",
      siteName: "Ocean Notes",
      byline: "Sam Rivera",
      publishedTime: "2026-03-14T09:00:00Z",
    });
  });

  it("missing metadata stays null", async () => {
    const r = await extractLite(NO_META_HTML, "https://plain.example.com/", opts, fakeConverter);
    expect(r.metadata.title).toBeNull();
    expect(r.metadata.description).toBeNull();
    expect(r.markdown).toContain("no title element");
  });

  it("selects [role=main] and strips doc sidebars", async () => {
    calls.length = 0;
    const r = await extractLite(DOCS_HTML, "https://docs.example.com/docs/config", opts, fakeConverter);
    expect(calls[0]!.cssSelector).toBe('[role="main"]');
    expect(r.markdown).toContain("widget.config.json");
    expect(r.markdown).not.toContain("Changelog");
    expect(r.markdown).toContain("[API reference](https://docs.example.com/api#client)");
  });

  it("drops Wikipedia-style [edit] links and keeps headings", async () => {
    const r = await extractLite(WIKI_STYLE_HTML, "https://wiki.example.com/Kelp", opts, fakeConverter);
    expect(r.markdown).not.toContain("[edit]");
    expect(r.headings.map((h) => h.text)).toEqual(["Growth", "Light"]);
  });

  it("derives headings and links from Markdown and honours limits", async () => {
    const r = await extractLite(ARTICLE_HTML, "https://ocean.example.com/", { includeLinks: true, maxLinks: 1, maxHeadings: 1 }, fakeConverter);
    expect(r.headings).toHaveLength(1);
    expect(r.headingsTruncated).toBe(true);
    expect(r.links).toHaveLength(1);
    expect(r.linksTruncated).toBe(true);
  });

  it("includeLinks=false keeps link text only", async () => {
    const r = await extractLite(CARD_LINKS_HTML, "https://blog.example.com/", { ...opts, includeLinks: false }, fakeConverter);
    expect(r.markdown).toContain("First post title");
    expect(r.markdown).not.toContain("](");
    expect(r.links.length).toBeGreaterThan(0); // structured links still reported
  });

  it("flags JS-rendered shells", async () => {
    const r = await extractLite(SPA_HTML, "https://app.example.com/", opts, fakeConverter);
    expect(r.mayRequireJavaScript).toBe(true);
    expect(r.textLength).toBeLessThan(40);
  });

  it("strips converter artefacts (front matter, JSON-LD, duplicate title)", async () => {
    const conv: MarkdownConverter = async () =>
      '---\ntitle: X\n---\n\n# How Tide Pools Work | Ocean Notes\n\nBody text here.\n\n```json\n{"@context":"https://schema.org","@type":"Article"}\n```';
    const r = await extractLite(ARTICLE_HTML, "https://ocean.example.com/", opts, conv);
    expect(r.markdown).toBe("Body text here.");
  });

  it("does not crash on garbage input", async () => {
    for (const junk of ["", "<<<>>>", "<html", "\u0000", "<table><tr><td>x"]) {
      await expect(extractLite(junk, "https://x.example.com/", opts, fakeConverter)).resolves.toBeDefined();
    }
  });
});
