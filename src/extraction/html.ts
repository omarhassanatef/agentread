import { parseHTML } from "linkedom";
import type { PageMetadata } from "../schemas/index.js";

// linkedom implements the DOM but ships its own types; the standard DOM lib is not
// loaded in a Workers project, so we use a minimal structural type.
export type DomElement = {
  tagName: string;
  nodeName: string;
  nodeType: number;
  textContent: string | null;
  innerHTML: string;
  className: string;
  id: string;
  parentNode: DomElement | null;
  children: ArrayLike<DomElement>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  remove(): void;
  querySelector(sel: string): DomElement | null;
  querySelectorAll(sel: string): ArrayLike<DomElement>;
  cloneNode(deep: boolean): DomElement;
  replaceWith(node: DomElement): void;
};
export type DomDocument = {
  documentElement: DomElement;
  head: DomElement | null;
  body: DomElement | null;
  title: string;
  querySelector(sel: string): DomElement | null;
  querySelectorAll(sel: string): ArrayLike<DomElement>;
  getElementById(id: string): DomElement | null;
};

export function parseDocument(html: string): DomDocument {
  // Ensure linkedom always builds html/head/body even for fragments or junk input.
  const source = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head></head><body>${html}</body></html>`;
  const { document } = parseHTML(source);
  return document as unknown as DomDocument;
}

export function normalizeWhitespace(s: string | null | undefined): string {
  return (s ?? "").replace(/[\u200b-\u200d\u2060\ufeff]/g, "").replace(/\s+/g, " ").trim();
}

function metaContent(doc: DomDocument, selectors: string[]): string | null {
  for (const sel of selectors) {
    const v = normalizeWhitespace(doc.querySelector(sel)?.getAttribute("content"));
    if (v) return v;
  }
  return null;
}

function safeHttpUrl(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim(), base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = u.hash.length > 256 ? "" : u.hash;
    return u.href;
  } catch {
    return null;
  }
}

/** Metadata from the full document. Missing values are null — never guessed. */
export function extractMetadata(doc: DomDocument, baseUrl: string): PageMetadata {
  const titleTag = normalizeWhitespace(doc.querySelector("title")?.textContent);
  const title =
    metaContent(doc, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) ??
    (titleTag || null) ??
    (normalizeWhitespace(doc.querySelector("h1")?.textContent) || null);
  const description = metaContent(doc, [
    'meta[name="description"]',
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
  ]);
  const canonicalUrl = safeHttpUrl(doc.querySelector('link[rel="canonical"]')?.getAttribute("href"), baseUrl);
  const langAttr = normalizeWhitespace(doc.documentElement?.getAttribute("lang"));
  const language =
    (langAttr && /^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]{2,8})*$/.test(langAttr) ? langAttr : null) ??
    metaContent(doc, ['meta[http-equiv="content-language" i]', 'meta[property="og:locale"]']);
  return {
    title: title ? title.slice(0, 500) : null,
    description: description ? description.slice(0, 1000) : null,
    canonicalUrl,
    language,
    siteName: metaContent(doc, ['meta[property="og:site_name"]', 'meta[name="application-name"]']),
    byline: metaContent(doc, ['meta[name="author"]', 'meta[property="article:author"]']),
    publishedTime: metaContent(doc, ['meta[property="article:published_time"]', 'meta[name="date"]', 'meta[itemprop="datePublished"]']),
  };
}

/** Resolve relative href/src against the page (honouring a safe <base href>) and drop unsafe schemes. */
export function absolutizeUrls(doc: DomDocument, pageUrl: string): void {
  const baseHref = doc.querySelector("base[href]")?.getAttribute("href");
  const base = safeHttpUrl(baseHref, pageUrl) ?? pageUrl;
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      a.removeAttribute("href");
      continue;
    }
    const abs = safeHttpUrl(href, base);
    if (abs) a.setAttribute("href", abs);
    else a.removeAttribute("href"); // javascript:, data:, mailto: etc. keep only the text
  }
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? img.getAttribute("data-src");
    const abs = safeHttpUrl(src, base);
    if (abs) img.setAttribute("src", abs);
    else img.remove();
  }
}

const REMOVE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "svg",
  "canvas",
  "link",
  "meta",
  "button",
  "input",
  "select",
  "textarea",
  "dialog",
  "nav",
  "[hidden]",
  '[aria-hidden="true"]',
  '[role="navigation"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="search"]',
];

/** Class/id tokens that identify boilerplate widgets. Tested per token to avoid substring false-positives. */
const BOILERPLATE_TOKEN = new RegExp(
  "^(?:" +
    [
      "cookie",
      "cookies",
      "cookie[-_]?(?:banner|bar|notice|consent|policy|popup|modal|wall)",
      "consent(?:[-_].*)?",
      "gdpr(?:[-_].*)?",
      "ccpa",
      "onetrust.*",
      "ot-sdk.*",
      "cookiebot.*",
      "truste.*",
      "osano.*",
      "cmp(?:[-_].*)?",
      "qc-cmp.*",
      "didomi.*",
      "modal(?:[-_]?(?:overlay|backdrop))?",
      "popup",
      "overlay",
      "newsletter(?:[-_]?(?:signup|form|popup|modal))?",
      "subscribe(?:[-_]?(?:box|form|popup|modal))?",
      "ad",
      "ads",
      "advert.*",
      "advertisement",
      "ad[-_]?(?:slot|unit|container|banner|wrapper)",
      "adsbygoogle",
      "sponsored",
      "social[-_]?(?:share|links|buttons)",
      "share[-_]?(?:buttons|bar|links|tools)",
      "skip[-_]?(?:link|to[-_]?content)",
      "breadcrumbs?",
      "sr-only",
      "visually[-_]?hidden",
      "language-name", // code-block language labels ("http", "js") rendered as text
      "copy[-_]?(?:button|code|to[-_]?clipboard)",
    ].join("|") +
    ")$",
  "i",
);

const PROTECTED_TAGS = new Set(["HTML", "HEAD", "BODY", "MAIN", "ARTICLE"]);

function isBoilerplate(el: DomElement): boolean {
  if (PROTECTED_TAGS.has(el.tagName)) return false;
  const tokens = `${el.id ?? ""} ${el.className ?? ""}`.split(/\s+/).filter(Boolean);
  if (tokens.some((t) => BOILERPLATE_TOKEN.test(t))) return true;
  const style = (el.getAttribute("style") ?? "").replace(/\s+/g, "").toLowerCase();
  return style.includes("display:none") || style.includes("visibility:hidden");
}

/** Remove non-content elements before readability scoring. */
export function removeBoilerplate(doc: DomDocument): void {
  for (const el of Array.from(doc.querySelectorAll(REMOVE_SELECTORS.join(",")))) el.remove();
  for (const el of Array.from(doc.querySelectorAll("[class],[id],[style]"))) {
    if (el.parentNode && isBoilerplate(el)) el.remove();
  }
}

const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

/**
 * Structural fixes that keep Readability from discarding real content:
 * - wrapper divs whose only child is a heading (e.g. Wikipedia's div.mw-heading) are
 *   unwrapped, otherwise Readability's div→p conversion drops the heading;
 * - wrappers inside <main>/<article> named like "header" that contain substantial
 *   paragraphs (e.g. MDN's intro) lose the class/id Readability penalises.
 */
export function normalizeForReadability(doc: DomDocument): void {
  for (const div of Array.from(doc.querySelectorAll("div"))) {
    const headings = Array.from(div.children).filter((k) => HEADING_TAGS.has(k.tagName));
    if (headings.length !== 1) continue;
    const heading = headings[0]!;
    // Allow small extras such as Wikipedia's "[edit]" links next to the heading.
    const extra = normalizeWhitespace(div.textContent).length - normalizeWhitespace(heading.textContent).length;
    if (extra <= 30 && div.children.length <= 3) div.replaceWith(heading);
  }
  for (const el of Array.from(doc.querySelectorAll("main [class*=header], main [id*=header], article [class*=header], article [id*=header]"))) {
    if (el.tagName === "HEADER" || !el.parentNode) continue;
    const hasProse = Array.from(el.querySelectorAll("p")).some((p) => normalizeWhitespace(p.textContent).length >= 80);
    if (!hasProse) continue;
    el.removeAttribute("class");
    el.removeAttribute("id");
    // Readability scores sibling containers separately and often drops an intro block
    // that sits beside the body container: move the intro into that container.
    let next = (el as unknown as { nextElementSibling: DomElement | null }).nextElementSibling;
    while (next && ["ASIDE", "NAV", "HEADER", "FOOTER"].includes(next.tagName)) {
      next = (next as unknown as { nextElementSibling: DomElement | null }).nextElementSibling;
    }
    if (next && (next.tagName === "DIV" || next.tagName === "SECTION")) {
      (next as unknown as { prepend(n: DomElement): void }).prepend(el);
    }
  }
}

/** Additional removal for the non-readability fallback path, where page chrome is not scored away. */
export function removePageChrome(root: DomElement): void {
  for (const el of Array.from(root.querySelectorAll('header, footer, aside, form, [role="banner"], [role="contentinfo"], [role="complementary"]'))) {
    el.remove();
  }
}

export interface JsSignals {
  mayRequireJavaScript: boolean;
  scriptCount: number;
}

/** Heuristics for pages that render their content client-side. Run on raw HTML. */
export function detectJavaScriptSignals(html: string): JsSignals {
  // Substring scans + regexes on small windows only: this runs on every extraction,
  // including the CPU-constrained lite engine.
  let scriptCount = 0;
  for (let i = html.indexOf("<script"); i !== -1 && scriptCount < 1000; i = html.indexOf("<script", i + 7)) scriptCount++;
  let noscriptWarning = false;
  for (let i = html.indexOf("<noscript"), n = 0; i !== -1 && n < 20; i = html.indexOf("<noscript", i + 9), n++) {
    if (/(enable|requires?|turn on|need)[\s\S]{0,40}?javascript/i.test(html.slice(i, i + 600))) {
      noscriptWarning = true;
      break;
    }
  }
  let emptyAppRoot = false;
  for (const id of ["root", "app", "__next", "__nuxt", "___gatsby", "svelte", "main-app"]) {
    for (const q of ['"', "'"]) {
      const at = html.indexOf(`id=${q}${id}${q}`);
      if (at === -1) continue;
      const close = html.indexOf(">", at);
      if (close !== -1 && /^\s*<\/div>/.test(html.slice(close + 1, close + 200))) emptyAppRoot = true;
    }
  }
  return { mayRequireJavaScript: noscriptWarning || emptyAppRoot, scriptCount };
}

/** Cheap <title> sniff for inspect_url on a partial document, without building a DOM. */
export function sniffTitle(html: string): string | null {
  const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']{1,500})["']/i.exec(html);
  const t = /<title[^>]*>([\s\S]{0,1000}?)<\/title>/i.exec(html);
  const raw = t?.[1] ?? og?.[1];
  if (!raw) return null;
  const decoded = raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d{1,6});/g, (_, d: string) => {
      const cp = Number(d);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    });
  return normalizeWhitespace(decoded) || null;
}
