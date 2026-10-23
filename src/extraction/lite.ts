import type { Heading, Link, PageMetadata } from "../schemas/index.js";
import { AppError } from "../utils/errors.js";
import type { ContentOptions, ExtractedContent } from "./extract.js";
import { detectJavaScriptSignals, normalizeWhitespace } from "./html.js";

/**
 * "Lite" extraction engine, built for the Workers Free plan (10 ms CPU per request).
 *
 * Measured on Cloudflare's edge (Oct 2026, real pages, CPU per request):
 *   Readability (linkedom DOM)          p50 69 ms  p75 285 ms  → killed on Free
 *   HTMLRewriter cleanup + toMarkdown    p50 25 ms  p75  37 ms  → over budget
 *   page bytes → toMarkdown (this file)  p50  8 ms  p90  16 ms  → mostly within budget
 *
 * So this engine does almost no parsing in JavaScript: it picks a content-root CSS
 * selector with indexOf(), hands the page to Workers AI `toMarkdown` (free for HTML;
 * the conversion runs outside the Worker), reads metadata from the converter's front
 * matter plus a few regexes over <head>, and removes known noise line by line.
 * Quality is below the Readability engine on pages without a clear content root.
 */

/** Converts HTML to Markdown. Production: Workers AI toMarkdown. Tests: injected fake. */
export type MarkdownConverter = (html: string, options: { cssSelector?: string; pageUrl: string }) => Promise<string>;

export function workersAiConverter(ai: Ai): MarkdownConverter {
  return async (html, { cssSelector, pageUrl }) => {
    let res;
    try {
      res = await ai.toMarkdown(
        { name: "page.html", blob: new Blob([html], { type: "text/html; charset=utf-8" }) },
        {
          conversionOptions: {
            html: {
              hostname: new URL(pageUrl).origin,
              ...(cssSelector ? { cssSelector } : {}),
              // Image descriptions run AI models (not free); never enable them here.
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

/**
 * Content-root hints, most specific first. Each is detected with a plain substring
 * search (no DOM, no regex over the whole page). Order matters: a page with a single
 * <article> inside <main> is better served by the article.
 */
const ROOT_HINTS: Array<{ needle: string; selector: string }> = [
  { needle: 'id="mw-content-text"', selector: "#mw-content-text" }, // MediaWiki / Wikipedia
  { needle: 'class="markdown-body', selector: ".markdown-body" }, // GitHub READMEs and docs
  { needle: 'class="vp-doc', selector: ".vp-doc" }, // VitePress docs
  { needle: 'class="theme-doc-markdown', selector: ".theme-doc-markdown" }, // Docusaurus
];

export function chooseRootSelector(html: string): string | undefined {
  for (const h of ROOT_HINTS) if (html.includes(h.needle)) return h.selector;
  // Tags are almost always lower-case in served HTML; avoid copying the page to lower-case it.
  const firstArticle = html.indexOf("<article");
  if (firstArticle !== -1 && html.indexOf("<article", firstArticle + 8) === -1) return "article";
  if (html.includes("<main") || html.includes("<MAIN")) return "main";
  if (html.includes('role="main"') || html.includes("role='main'")) return '[role="main"]';
  return undefined; // whole document; the converter drops <head>, <header>, <footer>, scripts, styles
}

function headSection(html: string): string {
  const end = html.search(/<\/head\s*>/i);
  return html.slice(0, end === -1 ? Math.min(html.length, 65_536) : Math.min(end, 262_144));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
}

function metaFromHead(head: string, name: string): string | null {
  // Attribute order varies: <meta property="x" content="y"> or <meta content="y" property="x">.
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const a = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${esc}["'][^>]*content\\s*=\\s*["']([^"']*)["']`, "i").exec(head);
  const b = a ?? new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${esc}["']`, "i").exec(head);
  const v = normalizeWhitespace(decodeEntities(b?.[1] ?? ""));
  return v || null;
}

function absolute(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(decodeEntities(raw.trim()), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Parse and remove the converter's YAML front matter (title/description/image). */
function splitFrontMatter(md: string): { fm: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n*/.exec(md);
  if (!m) return { fm: {}, body: md };
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]!.toLowerCase()] = decodeEntities(kv[2]!.replace(/^["']|["']$/g, "").trim());
  }
  return { fm, body: md.slice(m[0].length) };
}

const NOISE_LINE = new RegExp(
  "^(?:" +
    [
      "<!doctype[^>]*>", // leaked doctype
      "<\\?>", // leaked processing instruction placeholder
      "(?:[*-]\\s+)?\\[(?:skip|jump) to [^\\]]{1,40}\\]\\(#[^)]*\\)", // skip links
      "toggle the table of contents",
      "\\d+ languages", // Wikipedia language switcher label
      "(?:http|https|js|javascript|ts|typescript|json|bash|sh|shell|html|css|python|go|rust|sql|text|plain)", // code-language labels
    ].join("|") +
    ")\\s*$",
  "i",
);

/** Cheap, line-based cleanup of converter output. Linear in the Markdown size. */
export function cleanMarkdown(md: string, pageUrl: string): string {
  const protocol = new URL(pageUrl).protocol;
  const lines = (md.includes("\r") ? md.replace(/\r\n?/g, "\n") : md).split("\n");
  const out: string[] = [];
  let inFence = false;
  for (let line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence) {
      if (line.length < 120 && NOISE_LINE.test(line.trim())) continue;
      // Anchor-only links (heading permalinks, TOC entries) → plain text.
      if (line.includes("](#")) line = line.replace(/\[([^\]]*)\]\(#[^)]*\)/g, "$1");
      // Protocol-relative image/link URLs → absolute.
      if (line.includes("](//")) line = line.replace(/\]\(\/\/([^)\s]+)/g, (_m, rest: string) => `](${protocol}//${rest}`);
    }
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n```(?:json)?\n\s*\{[\s\S]*?"@context"[\s\S]*?```\s*$/i, "") // appended JSON-LD dump
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripLinks(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Upper bound on Markdown scanned for headings/links, to keep CPU bounded on huge pages. */
const ANALYSIS_LIMIT = 100_000;
/** Converter output beyond this is never returned (MAX_CHARACTERS_LIMIT ≤ 100k), so it is not processed. */
const OUTPUT_LIMIT = 120_000;

function headingsAndLinks(md: string, opts: ContentOptions) {
  const scan = md.length > ANALYSIS_LIMIT ? md.slice(0, ANALYSIS_LIMIT) : md;
  const headings: Heading[] = [];
  let headingsTruncated = false;
  let inFence = false;
  for (const line of scan.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence || line.charCodeAt(0) !== 35 /* # */) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = normalizeWhitespace(m[2]!.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "")).slice(0, 300);
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
  for (const m of scan.matchAll(/(?<!!)\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const url = m[2]!;
    if (seen.has(url)) continue;
    if (links.length >= opts.maxLinks) {
      linksTruncated = true;
      break;
    }
    seen.add(url);
    links.push({ text: normalizeWhitespace(m[1]!.replace(/[*_`]/g, "")).slice(0, 300), url });
  }
  return { headings, headingsTruncated, links, linksTruncated };
}

export async function extractLite(html: string, pageUrl: string, opts: ContentOptions, convert: MarkdownConverter): Promise<ExtractedContent> {
  const js = detectJavaScriptSignals(html);
  const head = headSection(html);
  const cssSelector = chooseRootSelector(html);

  // Converter output can be far larger than anything we return (240k+ chars on long
  // Wikipedia pages). Clean and analyse a bounded prefix only: the API never returns more
  // than MAX_CHARACTERS_LIMIT, so this caps CPU without changing what clients receive.
  const bounded = (s: string) => (s.length > OUTPUT_LIMIT ? s.slice(0, OUTPUT_LIMIT) : s);
  let raw = await convert(html, { pageUrl, ...(cssSelector ? { cssSelector } : {}) });
  let { fm, body } = splitFrontMatter(raw);
  let markdown = cleanMarkdown(bounded(body), pageUrl);
  if (cssSelector && markdown.length < 40) {
    // The selector matched nothing useful: convert the whole document instead.
    raw = await convert(html, { pageUrl });
    ({ fm, body } = splitFrontMatter(raw));
    markdown = cleanMarkdown(bounded(body), pageUrl);
  }

  const titleTag = /<title[^>]*>([\s\S]{0,1000}?)<\/title>/i.exec(head)?.[1];
  // The page's own <head> is authoritative; the converter's front matter is a fallback.
  const title = metaFromHead(head, "og:title") ?? (normalizeWhitespace(decodeEntities(titleTag ?? "")) || normalizeWhitespace(fm.title) || null);
  const description = metaFromHead(head, "description") ?? metaFromHead(head, "og:description") ?? (normalizeWhitespace(fm.description) || null);
  const canonicalTag = /<link[^>]+rel\s*=\s*["']canonical["'][^>]*>/i.exec(head)?.[0];
  const lang = normalizeWhitespace(/<html[^>]*\blang\s*=\s*["']?([a-zA-Z0-9_-]+)/i.exec(html.slice(0, 4096))?.[1]);

  const metadata: PageMetadata = {
    title: title?.slice(0, 500) ?? null,
    description: description?.slice(0, 1000) ?? null,
    canonicalUrl: absolute(canonicalTag ? /href\s*=\s*["']([^"']+)["']/i.exec(canonicalTag)?.[1] : null, pageUrl),
    language: lang && /^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]{2,8})*$/.test(lang) ? lang : null,
    siteName: metaFromHead(head, "og:site_name") ?? metaFromHead(head, "application-name"),
    byline: metaFromHead(head, "author") ?? metaFromHead(head, "article:author"),
    publishedTime: metaFromHead(head, "article:published_time") ?? metaFromHead(head, "date"),
  };

  const links = headingsAndLinks(markdown, opts);
  if (!opts.includeLinks) markdown = stripLinks(markdown);
  return {
    method: "lite",
    metadata,
    markdown,
    ...links,
    // Only needs to distinguish "empty" from "has content": a bounded prefix is enough.
    textLength: normalizeWhitespace(stripLinks(markdown.slice(0, 4000))).length,
    mayRequireJavaScript: js.mayRequireJavaScript,
  };
}
