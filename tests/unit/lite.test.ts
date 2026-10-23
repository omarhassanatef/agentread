import { describe, expect, it } from "vitest";
import { chooseRootSelector, cleanMarkdown, extractLite, type MarkdownConverter } from "../../src/extraction/lite.js";
import { absolutizeUrls, parseDocument } from "../../src/extraction/html.js";
import { toMarkdown } from "../../src/extraction/markdown.js";
import { ARTICLE_HTML, CARD_LINKS_HTML, DOCS_HTML, NO_META_HTML, SPA_HTML } from "../fixtures/pages.js";

/**
 * Stand-in for Workers AI toMarkdown (which needs Cloudflare's network). It mimics the
 * output observed on the edge: YAML front matter (title/description), then Markdown of
 * the selected element (or the body minus header/footer/nav-less noise), including the
 * noise patterns seen in real output (leaked doctype, skip links, anchor headings).
 */
const calls: Array<{ cssSelector?: string }> = [];
const fakeConverter: MarkdownConverter = async (html, { cssSelector, pageUrl }) => {
  calls.push(cssSelector ? { cssSelector } : {});
  const doc = parseDocument(html);
  absolutizeUrls(doc, pageUrl); // toMarkdown resolves relative links via its hostname option
  const root = (cssSelector ? doc.querySelector(cssSelector) : doc.body) ?? doc.body!;
  for (const el of Array.from(root.querySelectorAll("script, style, header, footer"))) el.remove();
  const title = doc.querySelector("title")?.textContent?.trim();
  const desc = doc.querySelector('meta[name="description"]')?.getAttribute("content");
  const fm = title || desc ? `---\n${desc ? `description: ${desc}\n` : ""}${title ? `title: ${title}\n` : ""}---\n\n` : "";
  return `${fm}<!doctype html> \n\n* [Skip to main content](#content)\n\n${toMarkdown(root, true)}`;
};

const opts = { includeLinks: true, maxLinks: 200, maxHeadings: 100 };

describe("chooseRootSelector", () => {
  it("prefers known content roots, then a single article, main, role=main", () => {
    expect(chooseRootSelector('<main><div id="mw-content-text">x</div></main>')).toBe("#mw-content-text");
    expect(chooseRootSelector('<main><article class="markdown-body entry">x</article></main>')).toBe(".markdown-body");
    expect(chooseRootSelector("<main><article>x</article></main>")).toBe("article");
    expect(chooseRootSelector("<main><article>a</article><article>b</article></main>")).toBe("main");
    expect(chooseRootSelector('<div role="main">x</div>')).toBe('[role="main"]');
    expect(chooseRootSelector("<body><p>x</p></body>")).toBeUndefined();
  });
});

describe("cleanMarkdown", () => {
  it("removes converter and page-chrome noise observed on real pages", () => {
    const md = [
      "<!doctype html> ",
      "* [Skip to main content](#content)",
      "[Jump to content](#bodyContent) ",
      "Toggle the table of contents",
      "25 languages",
      "## [Status](#status)",
      "http",
      "```",
      "http",
      "402 Payment Required",
      "```",
      "<?>",
      "![](//upload.example.org/a.png)",
      "Real paragraph.",
    ].join("\n\n");
    expect(cleanMarkdown(md, "https://site.example.com/x")).toBe(
      ["## Status", "```\n\nhttp\n\n402 Payment Required\n\n```", "![](https://upload.example.org/a.png)", "Real paragraph."].join("\n\n"),
    );
  });

  it("drops an appended JSON-LD dump", () => {
    expect(cleanMarkdown('Body.\n\n```json\n{"@context":"https://schema.org"}\n```', "https://a.example.com/")).toBe("Body.");
  });
});

describe("extractLite", () => {
  it("sends the page with a content-root selector and cleans the result", async () => {
    calls.length = 0;
    const r = await extractLite(ARTICLE_HTML, "https://ocean.example.com/guides/tide-pools", opts, fakeConverter);
    expect(r.method).toBe("lite");
    expect(calls[0]).toEqual({ cssSelector: "article" }); // single <article> inside <main>
    expect(r.markdown).toContain("Tide pools are shallow basins");
    expect(r.markdown).toContain("## Zones of the intertidal");
    expect(r.markdown).not.toContain("<!doctype");
    expect(r.markdown).not.toContain("Skip to main content");
    expect(r.markdown).not.toContain("© 2026 Ocean Notes"); // outside <main>
  });

  it("reads metadata from <head> and front matter without a DOM", async () => {
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
    expect(r.metadata).toMatchObject({ title: null, description: null, canonicalUrl: null, siteName: null });
    expect(r.markdown).toContain("no title element");
  });

  it("selects [role=main] on docs pages", async () => {
    calls.length = 0;
    const r = await extractLite(DOCS_HTML, "https://docs.example.com/docs/config", opts, fakeConverter);
    expect(calls[0]).toEqual({ cssSelector: '[role="main"]' });
    expect(r.markdown).toContain("widget.config.json");
    expect(r.markdown).not.toContain("Changelog");
  });

  it("falls back to the whole document when the selector yields nothing", async () => {
    calls.length = 0;
    const html = '<html><head><title>T</title></head><body><main></main><div><p>The real content lives outside main on this odd page, long enough to count.</p></div></body></html>';
    const r = await extractLite(html, "https://odd.example.com/", opts, fakeConverter);
    expect(calls).toEqual([{ cssSelector: "main" }, {}]);
    expect(r.markdown).toContain("real content lives outside main");
  });

  it("derives headings/links from Markdown and honours limits", async () => {
    const r = await extractLite(ARTICLE_HTML, "https://ocean.example.com/", { includeLinks: true, maxLinks: 1, maxHeadings: 1 }, fakeConverter);
    expect(r.headings).toHaveLength(1);
    expect(r.headingsTruncated).toBe(true);
    expect(r.links).toHaveLength(1);
    expect(r.linksTruncated).toBe(true);
  });

  it("includeLinks=false keeps link text only; structured links still reported", async () => {
    const r = await extractLite(CARD_LINKS_HTML, "https://blog.example.com/", { ...opts, includeLinks: false }, fakeConverter);
    expect(r.markdown).toContain("First post title");
    expect(r.markdown).not.toContain("](");
    expect(r.links.length).toBeGreaterThan(0);
  });

  it("flags JS-rendered shells", async () => {
    const r = await extractLite(SPA_HTML, "https://app.example.com/", opts, fakeConverter);
    expect(r.mayRequireJavaScript).toBe(true);
    expect(r.textLength).toBeLessThan(40);
  });

  it("surfaces converter failures as errors (not charged upstream)", async () => {
    const failing: MarkdownConverter = async () => {
      throw new Error("boom");
    };
    await expect(extractLite(ARTICLE_HTML, "https://a.example.com/", opts, failing)).rejects.toThrow();
  });
});
