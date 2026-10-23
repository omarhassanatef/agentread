import type { Limits } from "../config/env.js";
import type { Fetcher, HostGuard } from "../security/dns.js";
import { validateTargetUrl, type ValidatedUrl } from "../security/url.js";
import { AppError } from "../utils/errors.js";

export const USER_AGENT = "AgentRead/0.1 (+https://github.com/agentread; web extraction for AI agents)";

export interface FetchDeps {
  fetcher: Fetcher;
  hostGuard: HostGuard;
  limits: Limits;
}

export interface FetchedDocument {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  /** Lower-cased MIME type without parameters, or null when the server sent none. */
  mimeType: string | null;
  headerCharset: string | null;
  contentLength: number | null;
  body: Uint8Array;
  /** True when reading stopped at `maxBytes` (only possible with `allowPartial`). */
  partial: boolean;
  redirects: number;
}

export interface FetchOptions {
  maxBytes: number;
  /** When true, stop reading at maxBytes instead of failing (used by inspect). */
  allowPartial: boolean;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function parseContentType(header: string | null): { mimeType: string | null; charset: string | null } {
  if (!header) return { mimeType: null, charset: null };
  const [type, ...params] = header.split(";");
  const mimeType = type?.trim().toLowerCase() || null;
  let charset: string | null = null;
  for (const p of params) {
    const [k, v] = p.split("=");
    if (k?.trim().toLowerCase() === "charset" && v) charset = v.trim().replace(/^["']|["']$/g, "").toLowerCase();
  }
  return { mimeType, charset };
}

async function readBounded(res: Response, maxBytes: number, allowPartial: boolean): Promise<{ body: Uint8Array; partial: boolean }> {
  if (!res.body) return { body: new Uint8Array(0), partial: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let partial = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        if (!allowPartial) {
          throw new AppError("content_too_large", `The page exceeds the maximum download size of ${maxBytes} bytes.`, { maxBytes });
        }
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        partial = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Stop downloading as soon as we are done or over the limit.
    reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  return { body, partial };
}

/**
 * Fetch a validated public URL with SSRF protections:
 * - redirects are followed manually and every hop is re-validated (URL policy + DNS guard),
 * - no client headers/cookies are forwarded; only a fixed, minimal header set is sent,
 * - an overall deadline covers connection, redirects and body download,
 * - the body is streamed with a hard byte cap.
 */
export async function safeFetch(target: ValidatedUrl, deps: FetchDeps, opts: FetchOptions): Promise<FetchedDocument> {
  const { fetcher, hostGuard, limits } = deps;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.fetchTimeoutMs);
  let current = target;
  let redirects = 0;

  try {
    for (;;) {
      await hostGuard(current.hostname, controller.signal);
      let res: Response;
      try {
        res = await fetcher(current.href, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "user-agent": USER_AGENT,
            accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
            "accept-language": "en;q=0.9,*;q=0.5",
          },
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new AppError("upstream_timeout", `The page did not respond within ${limits.fetchTimeoutMs} ms.`);
        }
        if (err instanceof AppError) throw err;
        throw new AppError("upstream_unreachable", "The page could not be reached.");
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location) throw new AppError("upstream_http_error", "The page returned a redirect without a destination.", { status: res.status });
        if (++redirects > limits.maxRedirects) {
          throw new AppError("too_many_redirects", `The page redirected more than ${limits.maxRedirects} times.`);
        }
        let next: URL;
        try {
          next = new URL(location, current.href);
        } catch {
          throw new AppError("upstream_http_error", "The page redirected to an invalid URL.");
        }
        try {
          current = validateTargetUrl(next.href, limits.maxUrlLength);
        } catch (err) {
          if (err instanceof AppError) {
            throw new AppError("blocked_destination", `The page redirected to a disallowed destination: ${err.message}`);
          }
          throw err;
        }
        continue;
      }

      const { mimeType, charset } = parseContentType(res.headers.get("content-type"));
      const lengthHeader = res.headers.get("content-length");
      const contentLength = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
      if (!opts.allowPartial && contentLength !== null && contentLength > opts.maxBytes) {
        await res.body?.cancel();
        throw new AppError("content_too_large", `The page exceeds the maximum download size of ${opts.maxBytes} bytes.`, {
          maxBytes: opts.maxBytes,
        });
      }

      let read: { body: Uint8Array; partial: boolean };
      try {
        read = await readBounded(res, opts.maxBytes, opts.allowPartial);
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (controller.signal.aborted) {
          throw new AppError("upstream_timeout", `The page did not finish loading within ${limits.fetchTimeoutMs} ms.`);
        }
        throw new AppError("upstream_unreachable", "The connection was interrupted while downloading the page.");
      }

      return {
        requestedUrl: target.href,
        finalUrl: current.href,
        status: res.status,
        mimeType,
        headerCharset: charset,
        contentLength,
        body: read.body,
        partial: read.partial,
        redirects,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Decode bytes using BOM → Content-Type charset → <meta charset> → UTF-8. */
export function decodeBody(body: Uint8Array, headerCharset: string | null): { text: string; charset: string; fallback: boolean } {
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(body.subarray(3)), charset: "utf-8", fallback: false };
  }
  let label = headerCharset;
  if (!label) {
    const head = new TextDecoder("utf-8").decode(body.subarray(0, 2048));
    const m = /<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_\-:.]+)/i.exec(head);
    label = m?.[1]?.toLowerCase() ?? null;
  }
  if (label && label !== "utf-8" && label !== "utf8") {
    try {
      return { text: new TextDecoder(label).decode(body), charset: label, fallback: false };
    } catch {
      // Unsupported by this runtime's TextDecoder: fall back to UTF-8 and say so.
      return { text: new TextDecoder("utf-8").decode(body), charset: "utf-8", fallback: true };
    }
  }
  return { text: new TextDecoder("utf-8").decode(body), charset: "utf-8", fallback: false };
}
