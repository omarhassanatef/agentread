import type { Limits } from "../config/env.js";
import type { Fetcher, HostGuard } from "../security/dns.js";
import { validateTargetUrl, type ValidatedUrl } from "../security/url.js";
import {
  SCHEMA_VERSION,
  type ExtractInput,
  type ExtractResult,
  type ExtractionInfo,
  type InspectInput,
  type InspectResult,
  type StructuredResult,
} from "../schemas/index.js";
import { AppError } from "../utils/errors.js";
import { extractFromHtml, extractFromText, type ExtractedContent } from "./extract.js";
import { extractLite, type MarkdownConverter } from "./lite.js";
import { decodeBody, safeFetch, type FetchedDocument } from "./fetch.js";
import { detectJavaScriptSignals, sniffTitle } from "./html.js";
import { countWords, truncateMarkdown } from "./markdown.js";

/** Everything an operation needs from the outside world. Injected so tests run offline. */
export interface Services {
  fetcher: Fetcher;
  hostGuard: HostGuard;
  limits: Limits;
  /** Set when the lite engine is active (see extraction/lite.ts); otherwise Readability is used. */
  markdownConverter?: MarkdownConverter;
}

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/x-markdown"]);

/** Content that is "close enough" to HTML when the server sends no/odd Content-Type. */
function looksLikeHtml(body: Uint8Array): boolean {
  const head = new TextDecoder("utf-8").decode(body.subarray(0, 1024)).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || /<(head|body|title)[\s>]/.test(head);
}

type Kind = "html" | "text" | "markdown" | "unsupported";

function classify(doc: FetchedDocument): Kind {
  if (doc.mimeType && HTML_TYPES.has(doc.mimeType)) return "html";
  if (doc.mimeType === "text/markdown" || doc.mimeType === "text/x-markdown") return "markdown";
  if (doc.mimeType && TEXT_TYPES.has(doc.mimeType)) return "text";
  if ((!doc.mimeType || doc.mimeType === "application/octet-stream") && looksLikeHtml(doc.body)) return "html";
  return "unsupported";
}

/**
 * Validation that must pass before a client is asked to pay: URL policy + DNS guard.
 * Returns the validated URL so callers do not re-parse.
 */
export async function prevalidateUrl(raw: string, svc: Services): Promise<ValidatedUrl> {
  const target = validateTargetUrl(raw, svc.limits.maxUrlLength);
  await svc.hostGuard(target.hostname);
  return target;
}

/** Free, bounded inspection: at most `inspectMaxBytes` are downloaded and no DOM is built. */
export async function inspectUrl(input: InspectInput, svc: Services): Promise<InspectResult> {
  const target = validateTargetUrl(input.url, svc.limits.maxUrlLength);
  const base: InspectResult = {
    schemaVersion: SCHEMA_VERSION,
    operation: "inspect_url",
    requestedUrl: input.url,
    normalizedUrl: target.href,
    hostname: target.hostname,
    reachable: false,
    statusCode: null,
    finalUrl: null,
    redirects: 0,
    contentType: null,
    contentLength: null,
    isHtml: false,
    title: null,
    mayRequireJavaScript: false,
    extractionSupported: false,
    limitation: null,
  };

  let doc: FetchedDocument;
  try {
    doc = await safeFetch(target, svc, { maxBytes: svc.limits.inspectMaxBytes, allowPartial: true });
  } catch (err) {
    // Policy violations are request errors; network/upstream problems are inspection results.
    if (err instanceof AppError && (err.code === "invalid_url" || err.code === "blocked_destination")) throw err;
    const e = err instanceof AppError ? err : new AppError("upstream_unreachable", "The page could not be reached.");
    return { ...base, limitation: e.message };
  }

  const kind = classify(doc);
  const text = kind === "html" ? decodeBody(doc.body, doc.headerCharset).text : "";
  const js = kind === "html" ? detectJavaScriptSignals(text) : { mayRequireJavaScript: false };
  const result: InspectResult = {
    ...base,
    reachable: true,
    statusCode: doc.status,
    finalUrl: doc.finalUrl,
    redirects: doc.redirects,
    contentType: doc.mimeType,
    contentLength: doc.contentLength,
    isHtml: kind === "html",
    title: kind === "html" ? sniffTitle(text) : null,
    mayRequireJavaScript: js.mayRequireJavaScript,
  };

  let limitation: string | null = null;
  if (doc.status < 200 || doc.status >= 300) limitation = `The page returned HTTP ${doc.status}.`;
  else if (kind === "unsupported") limitation = `Content type ${doc.mimeType ?? "(none)"} is not supported; only HTML and plain text can be extracted.`;
  else if (doc.contentLength !== null && doc.contentLength > svc.limits.maxResponseBytes)
    limitation = `The page (${doc.contentLength} bytes) exceeds the ${svc.limits.maxResponseBytes}-byte extraction limit.`;
  else if (doc.body.length === 0) limitation = "The page returned an empty body.";
  else if (js.mayRequireJavaScript)
    limitation = "The page appears to render its content with JavaScript; extraction may return little or no content.";

  // JS-heavy pages are still "supported" (we will try), but flagged via mayRequireJavaScript.
  result.extractionSupported = limitation === null || (js.mayRequireJavaScript && doc.status >= 200 && doc.status < 300);
  result.limitation = limitation;
  return result;
}

interface FullExtraction {
  doc: FetchedDocument;
  content: ExtractedContent;
  charset: string;
  warnings: string[];
}

async function fetchAndExtract(input: ExtractInput, svc: Services, target?: ValidatedUrl): Promise<FullExtraction> {
  const validated = target ?? validateTargetUrl(input.url, svc.limits.maxUrlLength);
  const doc = await safeFetch(validated, svc, { maxBytes: svc.limits.maxResponseBytes, allowPartial: false });

  if (doc.status < 200 || doc.status >= 300) {
    throw new AppError("upstream_http_error", `The page returned HTTP ${doc.status}.`, { status: doc.status });
  }
  const kind = classify(doc);
  if (kind === "unsupported") {
    throw new AppError(
      "unsupported_content_type",
      `Content type ${doc.mimeType ?? "(none)"} is not supported. Only HTML and plain text pages can be extracted.`,
      { contentType: doc.mimeType },
    );
  }
  if (doc.body.length === 0) throw new AppError("empty_content", "The page returned an empty body.");

  const { text, charset, fallback } = decodeBody(doc.body, doc.headerCharset);
  const warnings: string[] = [];
  if (fallback) warnings.push(`charset_unsupported_decoded_as_utf8`);

  const opts = { includeLinks: input.includeLinks ?? true, maxLinks: svc.limits.maxLinks, maxHeadings: svc.limits.maxHeadings };
  const content =
    kind !== "html"
      ? extractFromText(text, kind === "markdown", opts)
      : svc.markdownConverter
        ? await extractLite(text, doc.finalUrl, opts, svc.markdownConverter)
        : extractFromHtml(text, doc.finalUrl, opts);

  if (content.textLength < 40 || content.markdown.length === 0) {
    if (content.mayRequireJavaScript) {
      throw new AppError(
        "javascript_required",
        "The page renders its content with JavaScript, which AgentRead does not execute. No readable content was found in the HTML.",
      );
    }
    throw new AppError("empty_content", "No readable content was found on the page.");
  }
  if (content.mayRequireJavaScript) warnings.push("page_may_require_javascript");
  if (content.headingsTruncated) warnings.push("headings_truncated");
  if (content.linksTruncated) warnings.push("links_truncated");
  return { doc, content, charset, warnings };
}

function extractionInfo(full: FullExtraction, returned: string, startedAt: number): ExtractionInfo {
  const characters = returned.length;
  return {
    method: full.content.method,
    statusCode: full.doc.status,
    contentType: full.doc.mimeType,
    charset: full.charset,
    redirects: full.doc.redirects,
    bytesFetched: full.doc.body.length,
    characters,
    totalCharacters: full.content.markdown.length,
    words: countWords(returned), // of the returned Markdown: bounded CPU on huge pages
    warnings: full.warnings,
    durationMs: Date.now() - startedAt,
  };
}

export async function extractUrl(input: ExtractInput, svc: Services, target?: ValidatedUrl): Promise<ExtractResult> {
  const startedAt = Date.now();
  const full = await fetchAndExtract(input, svc, target);
  const { text, truncated } = truncateMarkdown(full.content.markdown, input.maxCharacters ?? svc.limits.defaultMaxCharacters);
  return {
    schemaVersion: SCHEMA_VERSION,
    operation: "extract_url",
    requestedUrl: input.url,
    finalUrl: full.doc.finalUrl,
    title: full.content.metadata.title,
    description: full.content.metadata.description,
    markdown: text,
    headings: full.content.headings,
    truncated,
    extraction: extractionInfo(full, text, startedAt),
  };
}

export async function extractUrlStructured(input: ExtractInput, svc: Services, target?: ValidatedUrl): Promise<StructuredResult> {
  const startedAt = Date.now();
  const full = await fetchAndExtract(input, svc, target);
  const { text, truncated } = truncateMarkdown(full.content.markdown, input.maxCharacters ?? svc.limits.defaultMaxCharacters);
  return {
    schemaVersion: SCHEMA_VERSION,
    operation: "extract_url_structured",
    requestedUrl: input.url,
    finalUrl: full.doc.finalUrl,
    metadata: full.content.metadata,
    markdown: text,
    headings: full.content.headings,
    headingsTruncated: full.content.headingsTruncated,
    links: full.content.links,
    linksTruncated: full.content.linksTruncated,
    truncated,
    extraction: extractionInfo(full, text, startedAt),
  };
}
