import { Readability } from "@mozilla/readability";
import type { ExtractionMethod, Heading, Link, PageMetadata } from "../schemas/index.js";
import {
  absolutizeUrls,
  detectJavaScriptSignals,
  extractMetadata,
  normalizeForReadability,
  normalizeWhitespace,
  parseDocument,
  removeBoilerplate,
  removePageChrome,
  type DomElement,
} from "./html.js";
import { toMarkdown } from "./markdown.js";

export interface ContentOptions {
  includeLinks: boolean;
  maxLinks: number;
  maxHeadings: number;
}

export interface ExtractedContent {
  method: ExtractionMethod;
  metadata: PageMetadata;
  markdown: string;
  headings: Heading[];
  headingsTruncated: boolean;
  links: Link[];
  linksTruncated: boolean;
  /** Plain-text length of the main content, used for empty/JS-only detection. */
  textLength: number;
  mayRequireJavaScript: boolean;
}

/** Readability results shorter than this fall back to main/body extraction. */
const MIN_READABLE_CHARS = 140;

function collectHeadings(root: DomElement, max: number): { headings: Heading[]; truncated: boolean } {
  const headings: Heading[] = [];
  let truncated = false;
  for (const h of Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    const text = normalizeWhitespace(h.textContent).slice(0, 300);
    if (!text) continue;
    if (headings.length >= max) {
      truncated = true;
      break;
    }
    headings.push({ level: Number(h.tagName.slice(1)), text });
  }
  return { headings, truncated };
}

function collectLinks(root: DomElement, max: number): { links: Link[]; truncated: boolean } {
  const links: Link[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const a of Array.from(root.querySelectorAll("a[href]"))) {
    const url = a.getAttribute("href");
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    const text = normalizeWhitespace(a.textContent) || normalizeWhitespace(a.getAttribute("title")) || "";
    if (links.length >= max) {
      truncated = true;
      break;
    }
    seen.add(url);
    links.push({ text: text.slice(0, 300), url });
  }
  return { links, truncated };
}

function contentRootFromHtml(html: string): DomElement {
  const doc = parseDocument(`<!doctype html><html><head></head><body><div id="agentread-root">${html}</div></body></html>`);
  return doc.getElementById("agentread-root") ?? (doc.body as DomElement);
}

/**
 * Deterministic main-content extraction:
 * 1. parse once, read metadata, absolutise URLs, strip boilerplate;
 * 2. try Mozilla Readability;
 * 3. fall back to <main>/<article>/[role=main], then <body>, with page chrome removed.
 */
export function extractFromHtml(html: string, pageUrl: string, opts: ContentOptions): ExtractedContent {
  const js = detectJavaScriptSignals(html);
  const doc = parseDocument(html);
  const metadata = extractMetadata(doc, pageUrl);
  absolutizeUrls(doc, pageUrl);
  removeBoilerplate(doc);
  normalizeForReadability(doc);

  // Snapshot the fallback candidate before Readability mutates the document.
  const mainCandidate = doc.querySelector('main, [role="main"], article');
  const fallbackHtml = mainCandidate?.innerHTML ?? doc.body?.innerHTML ?? "";
  const fallbackMethod: ExtractionMethod = mainCandidate ? "main-content-fallback" : "body-fallback";

  let method: ExtractionMethod = "readability";
  let root: DomElement | null = null;
  let readabilityByline: string | null = null;
  let readabilityLang: string | null = null;
  try {
    const article = new Readability(doc as never, { charThreshold: 200, keepClasses: false }).parse();
    if (article?.content && normalizeWhitespace(article.textContent).length >= MIN_READABLE_CHARS) {
      root = contentRootFromHtml(article.content);
      readabilityByline = normalizeWhitespace(article.byline) || null;
      readabilityLang = normalizeWhitespace(article.lang) || null;
    }
  } catch {
    // Malformed documents can make Readability throw; the fallback still produces output.
  }

  if (!root) {
    method = fallbackMethod;
    root = contentRootFromHtml(fallbackHtml);
    removePageChrome(root);
  }

  const textLength = normalizeWhitespace(root.textContent).length;
  const markdown = toMarkdown(root, opts.includeLinks);
  const { headings, truncated: headingsTruncated } = collectHeadings(root, opts.maxHeadings);
  const { links, truncated: linksTruncated } = collectLinks(root, opts.maxLinks);

  return {
    method,
    metadata: {
      ...metadata,
      byline: metadata.byline ?? readabilityByline,
      language: metadata.language ?? readabilityLang,
    },
    markdown,
    headings,
    headingsTruncated,
    links,
    linksTruncated,
    textLength,
    mayRequireJavaScript: js.mayRequireJavaScript,
  };
}

/** text/plain and text/markdown are returned as-is (normalised line endings). */
export function extractFromText(text: string, isMarkdown: boolean, opts: ContentOptions): ExtractedContent {
  const markdown = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const headings: Heading[] = [];
  let headingsTruncated = false;
  const links: Link[] = [];
  let linksTruncated = false;
  if (isMarkdown) {
    for (const m of markdown.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)) {
      if (headings.length >= opts.maxHeadings) {
        headingsTruncated = true;
        break;
      }
      headings.push({ level: m[1]!.length, text: m[2]!.slice(0, 300) });
    }
    const seen = new Set<string>();
    for (const m of markdown.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)) {
      if (seen.has(m[2]!)) continue;
      if (links.length >= opts.maxLinks) {
        linksTruncated = true;
        break;
      }
      seen.add(m[2]!);
      links.push({ text: m[1]!.slice(0, 300), url: m[2]! });
    }
  }
  return {
    method: "plain-text",
    metadata: { title: null, description: null, canonicalUrl: null, language: null, siteName: null, byline: null, publishedTime: null },
    markdown,
    headings,
    headingsTruncated,
    links,
    linksTruncated,
    textLength: markdown.length,
    mayRequireJavaScript: false,
  };
}
