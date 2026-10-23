import TurndownService from "turndown";
import { tables, strikethrough } from "@joplin/turndown-plugin-gfm";
import type { DomElement } from "./html.js";

function createService(includeLinks: boolean): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  td.use([tables, strikethrough]);
  td.remove(["script", "style", "noscript", "iframe", "form", "button", "select", "input", "textarea"] as never);

  td.addRule("links", {
    filter: (node) => node.nodeName === "A",
    replacement: (content, node) => {
      const text = content.trim();
      const href = (node as unknown as DomElement).getAttribute("href");
      if (!text) return "";
      if (!includeLinks || !href) return content;
      const title = (node as unknown as DomElement).getAttribute("title");
      const safeHref = href.replace(/[()\s]/g, (c) => encodeURIComponent(c));
      const link = (label: string) => (title ? `[${label}](${safeHref} "${title.replace(/"/g, '\\"')}")` : `[${label}](${safeHref})`);
      // Block content inside <a> (card links wrapping headings/paragraphs) cannot live in
      // inline link syntax: link the heading text, or append the link after the block.
      if (/\n/.test(text) || /^#{1,6} /.test(text)) {
        const heading = /^(#{1,6}) (.+)$/m.exec(text);
        if (heading && text.split("\n").filter(Boolean).length === 1) return `\n\n${heading[1]} ${link(heading[2]!)}\n\n`;
        return `${content}\n\n${link("Link")}\n\n`;
      }
      return link(text);
    },
  });

  td.addRule("images", {
    filter: (node) => node.nodeName === "IMG",
    replacement: (_content, node) => {
      if (!includeLinks) return "";
      const el = node as unknown as DomElement;
      const src = el.getAttribute("src");
      if (!src || !/^https?:\/\//i.test(src)) return "";
      const alt = (el.getAttribute("alt") ?? "").replace(/[\[\]\n]/g, " ").trim();
      return `![${alt}](${src.replace(/[()\s]/g, (c) => encodeURIComponent(c))})`;
    },
  });

  // Compact list items ("- item" instead of Turndown's default "-   item").
  td.addRule("listItem", {
    filter: "li",
    replacement: (content, node, options) => {
      const el = node as unknown as DomElement;
      const parent = el.parentNode;
      let prefix = `${options.bulletListMarker} `;
      if (parent?.nodeName === "OL") {
        const start = Number(parent.getAttribute("start") ?? "1") || 1;
        const index = Array.prototype.indexOf.call(parent.children, el);
        prefix = `${start + index}. `;
      }
      const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, `\n${" ".repeat(prefix.length)}`);
      const next = (el as unknown as { nextSibling: unknown }).nextSibling;
      return prefix + body + (next && !/\n$/.test(body) ? "\n" : "");
    },
  });

  // Figures/pictures: keep inner content (img + caption) without wrapper noise.
  td.addRule("figcaption", {
    filter: (node) => node.nodeName === "FIGCAPTION",
    replacement: (content) => (content.trim() ? `\n\n_${content.trim()}_\n\n` : ""),
  });

  return td;
}

const services = new Map<boolean, TurndownService>();

/**
 * linkedom does not implement HTMLTableElement.rows, which the GFM table plugin relies
 * on. Add a spec-shaped getter (direct rows + rows of thead/tbody/tfoot) to linkedom's
 * table prototype once; a prototype patch survives Turndown's cloneNode().
 */
function ensureTableRows(root: DomElement): void {
  const table = root.querySelector("table");
  if (!table) return;
  const proto = Object.getPrototypeOf(table) as object;
  if ("rows" in proto) return;
  Object.defineProperty(proto, "rows", {
    configurable: true,
    get(this: DomElement) {
      const rows: DomElement[] = [];
      for (const child of Array.from(this.children)) {
        if (child.tagName === "TR") rows.push(child);
        else if (child.tagName === "THEAD" || child.tagName === "TBODY" || child.tagName === "TFOOT") {
          for (const tr of Array.from(child.children)) if (tr.tagName === "TR") rows.push(tr);
        }
      }
      return rows;
    },
  });
}

/** Convert a cleaned content element to Markdown. */
export function toMarkdown(root: DomElement, includeLinks: boolean): string {
  ensureTableRows(root);
  let td = services.get(includeLinks);
  if (!td) {
    td = createService(includeLinks);
    services.set(includeLinks, td);
  }
  const md = td.turndown(root as unknown as TurndownService.Node);
  return md
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Truncate Markdown to at most `max` characters, preferring a paragraph or line
 * boundary, and never splitting a surrogate pair.
 */
export function truncateMarkdown(md: string, max: number): { text: string; truncated: boolean } {
  if (md.length <= max) return { text: md, truncated: false };
  let cut = md.lastIndexOf("\n\n", max);
  if (cut < max * 0.6) cut = md.lastIndexOf("\n", max);
  if (cut < max * 0.6) cut = md.lastIndexOf(" ", max);
  if (cut < max * 0.6) cut = max;
  const code = md.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return { text: md.slice(0, cut).trimEnd(), truncated: true };
}

export function countWords(md: string): number {
  const plain = md.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#*_>`|~-]/g, " ");
  const m = plain.match(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu);
  return m ? m.length : 0;
}
