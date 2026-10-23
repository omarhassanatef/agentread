import type { Heading, Link, PageMetadata } from "../schemas/index.js";
import { AppError } from "../utils/errors.js";
import type { ContentOptions, ExtractedContent } from "./extract.js";
import { detectJavaScriptSignals, normalizeWhitespace } from "./html.js";

/**
 * "Lite" extraction engine for the Workers Free plan (10 ms CPU per request).
 *
 * The CPU-heavy work is delegated to native/remote code that does not count against
 * the Worker's CPU budget in the same way as JavaScript DOM building:
 *  1. HTMLRewriter (lol-html, native streaming parser) strips boilerplate, reads
 *     metadata and absolutises links in one pass, without building a DOM;
 *  2. a Markdown converter (Workers AI `toMarkdown`, free for HTML) turns the cleaned
 *     HTML into Markdown, restricted to the main content via a CSS selector.
 * Quality is lower than the Readability engine on pages without semantic markup.
 */

/** Converts cleaned HTML to Markdown. Production: Workers AI toMarkdown. Tests: injected fake. */
export type MarkdownConverter = (html: string, options: { cssSelector?: string; pageUrl: string }) => Promise<string>;

export function workersAiConverter(ai: Ai): MarkdownConverter {
  return async (html, { cssSelector, pageUrl }) => {
    let res: Awaited<ReturnType<Ai["toMarkdown"]>> extends infer R ? (R extends Array<infer X> ? X : R) : never;
    try {
      res = await ai.toMarkdown(
        { name: "page.html", blob: new Blob([html], { type: "text/html" }) },
        {
          conversionOptions: {
            html: {
              hostname: new URL(pageUrl).origin,
              ...(cssSelector ? { cssSelector } : {}),
              // Image descriptions use AI models (not free); never enable them here.
              images: { convert: false, convertOGImage: false },
            },
          },
        },
      );
    } catch {
      throw new AppError("internal_error", "The Markdown conversion service is unavailable. Try again later.");
    }
    if (res.format === "error") {
      throw new AppError("internal_error", "The Markdown conversion service could not convert this page.");
    }
    return res.data;
  };
}

/** Elements removed outright. lol-html supports type, attribute (=, ~=, ^=, $=, *=) and descendant selectors. */
const REMOVE = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "frame",
  "object",
  "embed",
  "svg",
  "canvas",
  "link",
  "button",
  "input",
  "select",
  "textarea",
  "form",
  "dialog",
  "nav",
  "aside",
  "footer",
  "[hidden]",
  '[aria-hidden="true"]',
  '[role="navigation"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="search"]',
  '[role="complementary"]',
  '[role="contentinfo"]',
  // Exact class/id tokens (same intent as the Readability engine's BOILERPLATE_TOKEN).
  ...[
    "cookie",
    "cookies",
    "cookie-banner",
    "cookie-consent",
    "cookie-notice",
    "consent",
    "gdpr",
    "modal",
    "popup",
    "overlay",
    "newsletter",
    "newsletter-signup",
    "subscribe",
    "ad",
    "ads",
    "advert",
    "advertisement",
    "ad-slot",
    "adsbygoogle",
    "sponsored",
    "social-share",
    "share-buttons",
    "breadcrumb",
    "breadcrumbs",
    "skip-link",
    "sr-only",
    "visually-hidden",
    "language-name",
    "copy-button",
    "mw-editsection",
    "mw-jump-link",
    "navbox",
  ].flatMap((t) => [`[class~="${t}"]`, `[id="${t}"]`]),
  // Vendor consent managers use prefixed ids/classes.
  '[id^="onetrust"]',
  '[class^="onetrust"]',
  '[id^="CybotCookiebot"]',
  '[id^="didomi"]',
  '[class^="osano"]',
  '[id^="sp_message"]',
  '[style*="display:none"]',
  '[style*="display: none"]',
];

interface Collected {
  title: string;
  ogTitle: string | null;
  description: string | null;
  canonical: string | null;
  lang: string | null;
  siteName: string | null;
  byline: string | null;
  published: string | null;
  base: string;
}

function absolute(raw: string | null, base: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim(), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** One streaming pass: metadata + boilerplate removal + link/image absolutisation. */
async function rewrite(html: string, pageUrl: string): Promise<{ cleaned: string; meta: Collected }> {
  const meta: Collected = {
    title: "",
    ogTitle: null,
    description: null,
    canonical: null,
    lang: null,
    siteName: null,
    byline: null,
    published: null,
    base: pageUrl,
  };
  const metaMap: Record<string, (v: string) => void> = {
    "og:title": (v) => (meta.ogTitle ??= v),
    "twitter:title": (v) => (meta.ogTitle ??= v),
    description: (v) => (meta.description ??= v),
    "og:description": (v) => (meta.description ??= v),
    "twitter:description": (v) => (meta.description ??= v),
    "og:site_name": (v) => (meta.siteName ??= v),
    "application-name": (v) => (meta.siteName ??= v),
    author: (v) => (meta.byline ??= v),
    "article:author": (v) => (meta.byline ??= v),
    "article:published_time": (v) => (meta.published ??= v),
    date: (v) => (meta.published ??= v),
  };
  let inTitle = false;

  const rewriter = new HTMLRewriter()
    .on("html", { element: (el) => void (meta.lang = el.getAttribute("lang")) })
    .on("base[href]", { element: (el) => void (meta.base = absolute(el.getAttribute("href"), pageUrl) ?? pageUrl) })
    .on("title", {
      element: (el) => {
        inTitle = true;
        el.onEndTag(() => void (inTitle = false));
      },
      text: (t) => {
        if (inTitle && meta.title.length < 1000) meta.title += t.text;
      },
    })
    .on("meta", {
      element: (el) => {
        const key = (el.getAttribute("property") ?? el.getAttribute("name") ?? "").toLowerCase();
        const content = normalizeWhitespace(el.getAttribute("content"));
        if (content && metaMap[key]) metaMap[key](content);
        if (el.getAttribute("charset") !== null || (el.getAttribute("http-equiv") ?? "").toLowerCase() === "content-type") el.remove();
      },
    })
    .on('link[rel="canonical"]', { element: (el) => void (meta.canonical ??= absolute(el.getAttribute("href"), pageUrl)) })
    .on(REMOVE.join(","), { element: (el) => void el.remove() })
    .on("a[href]", {
      element: (el) => {
        const href = el.getAttribute("href") ?? "";
        const abs = href.startsWith("#") ? null : absolute(href, meta.base);
        if (abs) el.setAttribute("href", abs);
        else el.removeAttribute("href");
      },
    })
    .on("img", {
      element: (el) => {
        const abs = absolute(el.getAttribute("src") ?? el.getAttribute("data-src"), meta.base);
        if (abs) el.setAttribute("src", abs);
        else el.remove();
      },
    });

  const cleaned = await rewriter.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })).text();
  return { cleaned, meta };
}

/** Pick the main-content container with cheap string checks on the cleaned HTML. */
function mainSelector(cleaned: string): string | undefined {
  if (/<main[\s>]/i.test(cleaned)) return "main";
  if (/role\s*=\s*["']?main["'\s>]/i.test(cleaned)) return '[role="main"]';
  const articles = cleaned.match(/<article[\s>]/gi)?.length ?? 0;
  if (articles === 1) return "article";
  return undefined; // whole body; toMarkdown drops <header>/<footer> itself
}

/** Strip artefacts the converter adds that are not page content (front matter, JSON-LD dumps). */
function tidy(md: string): string {
  let out = md.replace(/\r\n?/g, "\n");
  out = out.replace(/^---\n[\s\S]*?\n---\n+/, ""); // YAML front matter
  out = out.replace(/\n```(?:json|ld\+json)?\n\s*\{[\s\S]*?"@context"[\s\S]*?```\s*$/i, ""); // appended JSON-LD
  return out
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripLinks(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function headingsAndLinks(md: string, opts: ContentOptions) {
  const headings: Heading[] = [];
  let headingsTruncated = false;
  let inFence = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = normalizeWhitespace(m[2]!.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")).slice(0, 300);
    if (!text) continue;
    if (headings.length >= opts.maxHeadings) {
      headingsTruncated = true;
      break;
    }
    headings.push({ level: m[1]!.length, text });
  }
  const links: Link[] = [];
  let linksTruncated = false;
  const seen = new Set<string>();
  for (const m of md.matchAll(/(?<!!)\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const url = m[2]!;
    if (seen.has(url)) continue;
    if (links.length >= opts.maxLinks) {
      linksTruncated = true;
      break;
    }
    seen.add(url);
    links.push({ text: normalizeWhitespace(m[1]).slice(0, 300), url });
  }
  return { headings, headingsTruncated, links, linksTruncated };
}

export async function extractLite(html: string, pageUrl: string, opts: ContentOptions, convert: MarkdownConverter): Promise<ExtractedContent> {
  const js = detectJavaScriptSignals(html);
  const { cleaned, meta } = await rewrite(html, pageUrl);
  const cssSelector = mainSelector(cleaned);
  let markdown = tidy(await convert(cleaned, { pageUrl, ...(cssSelector ? { cssSelector } : {}) }));
  // A selector that matched nothing useful: retry on the whole document.
  if (cssSelector && markdown.length < 40) markdown = tidy(await convert(cleaned, { pageUrl }));
  // The converter may prepend the <title> as an H1; drop it so content starts with the page body.
  const title = normalizeWhitespace(meta.title) || null;
  if (title) markdown = markdown.replace(new RegExp(`^#\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n+`), "");

  const links = headingsAndLinks(markdown, opts);
  if (!opts.includeLinks) markdown = stripLinks(markdown);
  const lang = normalizeWhitespace(meta.lang);
  const metadata: PageMetadata = {
    title: (meta.ogTitle ?? title)?.slice(0, 500) ?? null,
    description: meta.description?.slice(0, 1000) ?? null,
    canonicalUrl: meta.canonical,
    language: lang && /^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]{2,8})*$/.test(lang) ? lang : null,
    siteName: meta.siteName,
    byline: meta.byline,
    publishedTime: meta.published,
  };
  const plain = stripLinks(markdown).replace(/[#*_>`|~-]/g, " ");
  return {
    method: "lite",
    metadata,
    markdown,
    ...links,
    textLength: normalizeWhitespace(plain).length,
    mayRequireJavaScript: js.mayRequireJavaScript,
  };
}
