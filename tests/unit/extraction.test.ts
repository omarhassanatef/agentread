import { describe, expect, it } from "vitest";
import { extractFromHtml, extractFromText } from "../../src/extraction/extract.js";
import { countWords, truncateMarkdown } from "../../src/extraction/markdown.js";
import { detectJavaScriptSignals, sniffTitle } from "../../src/extraction/html.js";
import { decodeBody } from "../../src/extraction/fetch.js";
import { ARTICLE_HTML, CARD_LINKS_HTML, DOCS_HTML, HEADER_INTRO_HTML, MALFORMED_HTML, NO_META_HTML, SPA_HTML, WIKI_STYLE_HTML } from "../fixtures/pages.js";

const opts = { includeLinks: true, maxLinks: 200, maxHeadings: 100 };

describe("extractFromHtml — article page", () => {
  const r = extractFromHtml(ARTICLE_HTML, "https://ocean.example.com/guides/tide-pools?ref=x", opts);

  it("uses readability and keeps the main content", () => {
    expect(r.method).toBe("readability");
    expect(r.markdown).toContain("Tide pools are shallow basins of seawater");
    expect(r.markdown).toContain("## Zones of the intertidal");
    expect(r.markdown).toContain("### Field tips");
  });

  it("removes navigation, cookie banners, ads, newsletter, footer and scripts", () => {
    for (const junk of ["We use cookies", "Accept all", "BUY OCEAN SNACKS", "Subscribe to our newsletter", "© 2026 Ocean Notes", "window.analytics", "font-family"]) {
      expect(r.markdown).not.toContain(junk);
    }
    expect(r.markdown).not.toMatch(/\[Shop\]/);
  });

  it("converts lists, tables, code and links to Markdown with absolute URLs", () => {
    expect(r.markdown).toMatch(/^- Splash zone: barnacles/m);
    expect(r.markdown).toMatch(/\| Zone \| Exposure \(h\/day\) \| Max temp \(°C\) \|/);
    expect(r.markdown).toContain("```");
    expect(r.markdown).toContain("[splash zone](https://ocean.example.com/glossary#splash-zone)");
    expect(r.markdown).toContain("[official tide tables](https://example.org/tide-tables)");
    expect(r.markdown).toContain("![Green anemone](https://ocean.example.com/img/anemone.jpg)");
  });

  it("drops javascript: links but keeps their text", () => {
    expect(r.markdown).not.toContain("javascript:");
    expect(r.markdown).toContain("this fake link");
  });

  it("extracts metadata without inventing values", () => {
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

  it("returns ordered headings with levels and deduplicated absolute links", () => {
    expect(r.headings.map((h) => [h.level, h.text])).toEqual(
      expect.arrayContaining([
        [2, "Zones of the intertidal"],
        [2, "Measured conditions"],
        [3, "Field tips"],
      ]),
    );
    const zones = r.headings.findIndex((h) => h.text === "Zones of the intertidal");
    const tips = r.headings.findIndex((h) => h.text === "Field tips");
    expect(zones).toBeLessThan(tips);
    expect(r.links).toEqual(
      expect.arrayContaining([
        { text: "splash zone", url: "https://ocean.example.com/glossary#splash-zone" },
        { text: "official tide tables", url: "https://example.org/tide-tables" },
      ]),
    );
    expect(r.links.every((l) => /^https?:\/\//.test(l.url))).toBe(true);
  });

  it("keeps link text but no URLs when includeLinks=false", () => {
    const plain = extractFromHtml(ARTICLE_HTML, "https://ocean.example.com/guides/tide-pools", { ...opts, includeLinks: false });
    expect(plain.markdown).toContain("splash zone");
    expect(plain.markdown).not.toContain("](");
  });

  it("honours link and heading limits", () => {
    const limited = extractFromHtml(ARTICLE_HTML, "https://ocean.example.com/", { includeLinks: true, maxLinks: 1, maxHeadings: 1 });
    expect(limited.links).toHaveLength(1);
    expect(limited.linksTruncated).toBe(true);
    expect(limited.headings).toHaveLength(1);
    expect(limited.headingsTruncated).toBe(true);
  });
});

describe("extractFromHtml — other page shapes", () => {
  it("documentation page: drops sidebar nav and footer, keeps tables and code", () => {
    const r = extractFromHtml(DOCS_HTML, "https://docs.example.com/docs/config", opts);
    expect(r.markdown).toContain("widget.config.json");
    expect(r.markdown).toMatch(/\| apiKey \| string \|/);
    expect(r.markdown).toContain('{ "apiKey": "abc", "region": "eu" }');
    expect(r.markdown).not.toContain("Changelog");
    expect(r.markdown).not.toContain("Edit this page");
    expect(r.markdown).toContain("[API reference](https://docs.example.com/api#client)");
    expect(r.metadata.title).toBe("Configuration — Widget SDK Docs");
  });

  it("missing title and description stay null", () => {
    const r = extractFromHtml(NO_META_HTML, "https://plain.example.com/", opts);
    expect(r.metadata.title).toBeNull();
    expect(r.metadata.description).toBeNull();
    expect(r.metadata.canonicalUrl).toBeNull();
    expect(r.markdown).toContain("no title element and no meta description");
  });

  it("malformed HTML is handled gracefully", () => {
    const r = extractFromHtml(MALFORMED_HTML, "https://broken.example.com/", opts);
    expect(r.markdown).toContain("First paragraph");
    expect(r.markdown).toContain("Final paragraph of the malformed document");
    expect(r.markdown).toMatch(/item two/);
  });

  it("SPA shell yields no content and is flagged as requiring JavaScript", () => {
    const r = extractFromHtml(SPA_HTML, "https://app.example.com/", opts);
    expect(r.mayRequireJavaScript).toBe(true);
    expect(r.textLength).toBeLessThan(40);
  });

  it("does not crash on garbage input", () => {
    for (const junk of ["", "<<<>>>", "<html", "\u0000\u0001", "<table><tr><td>x"]) {
      expect(() => extractFromHtml(junk, "https://x.example.com/", opts)).not.toThrow();
    }
  });
});

describe("real-world structure regressions", () => {
  it("keeps headings wrapped in single-heading divs (Wikipedia-style) and strips zero-width chars", () => {
    const r = extractFromHtml(WIKI_STYLE_HTML, "https://wiki.example.com/Kelp", opts);
    expect(r.headings).toEqual([
      { level: 2, text: "Growth" },
      { level: 3, text: "Light" },
    ]);
    expect(r.markdown).toContain("## Growth");
    expect(r.markdown).not.toContain("[edit]");
  });

  it("keeps an intro paragraph that sits in a header-named wrapper beside the body (MDN-style)", () => {
    const r = extractFromHtml(HEADER_INTRO_HTML, "https://ref.example.com/418", opts);
    expect(r.markdown).toContain("refuses to brew coffee");
    expect(r.markdown).toContain("## Specifications");
    expect(r.markdown.indexOf("refuses to brew")).toBeLessThan(r.markdown.indexOf("## Status"));
  });

  it("renders links wrapping headings as valid Markdown", () => {
    const r = extractFromHtml(CARD_LINKS_HTML, "https://blog.example.com/", opts);
    expect(r.markdown).toContain("## [First post title](https://blog.example.com/posts/one)");
    expect(r.markdown).not.toMatch(/\[\s*#/);
  });
});

describe("plain text and markdown", () => {
  it("passes text through with normalised newlines", () => {
    const r = extractFromText("line one\r\nline two\r\n\r\n\r\n\r\nline three", false, opts);
    expect(r.method).toBe("plain-text");
    expect(r.markdown).toBe("line one\nline two\n\nline three");
  });
  it("reads headings and links from markdown", () => {
    const r = extractFromText("# Title\n\nSee [docs](https://d.example.com/x).\n\n## Part", true, opts);
    expect(r.headings).toEqual([
      { level: 1, text: "Title" },
      { level: 2, text: "Part" },
    ]);
    expect(r.links).toEqual([{ text: "docs", url: "https://d.example.com/x" }]);
  });
});

describe("truncation and counting", () => {
  it("does not truncate short text", () => {
    expect(truncateMarkdown("hello", 100)).toEqual({ text: "hello", truncated: false });
  });
  it("prefers paragraph boundaries and respects the limit", () => {
    const md = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} ${"word ".repeat(20)}`).join("\n\n");
    const { text, truncated } = truncateMarkdown(md, 1000);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(md.startsWith(text)).toBe(true);
    expect(md.slice(text.length).trimStart().startsWith("Paragraph")).toBe(true);
  });
  it("never splits a surrogate pair", () => {
    const md = "a".repeat(99) + "😀" + "b".repeat(50);
    const { text } = truncateMarkdown(md, 100);
    expect(text.endsWith("\ud83d")).toBe(false);
  });
  it("counts words, ignoring link URLs", () => {
    expect(countWords("Hello [big world](https://x.example.com/a/b/c) — it's fine")).toBe(5);
  });
});

describe("html helpers", () => {
  it("sniffs titles cheaply, decoding entities", () => {
    expect(sniffTitle("<html><head><title>  A &amp; B  </title>")).toBe("A & B");
    expect(sniffTitle("<p>no title</p>")).toBeNull();
  });
  it("detects JS-rendered shells", () => {
    expect(detectJavaScriptSignals(SPA_HTML).mayRequireJavaScript).toBe(true);
    expect(detectJavaScriptSignals(ARTICLE_HTML).mayRequireJavaScript).toBe(false);
  });
});

describe("decodeBody", () => {
  it("uses the header charset", () => {
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in latin1
    const r = decodeBody(bytes, "iso-8859-1");
    expect(r.text).toBe("café");
    expect(r.fallback).toBe(false);
  });
  it("sniffs <meta charset> when the header has none", () => {
    const enc = new TextEncoder().encode('<meta charset="windows-1252"><p>');
    const bytes = new Uint8Array([...enc, 0x93, 0x68, 0x69, 0x94]); // “hi” in cp1252
    expect(decodeBody(bytes, null).text).toContain("“hi”");
  });
  it("strips a UTF-8 BOM", () => {
    expect(decodeBody(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]), null).text).toBe("hi");
  });
  it("falls back to UTF-8 for unknown charsets and reports it", () => {
    const r = decodeBody(new TextEncoder().encode("hello"), "x-made-up-charset");
    expect(r).toEqual({ text: "hello", charset: "utf-8", fallback: true });
  });
});
