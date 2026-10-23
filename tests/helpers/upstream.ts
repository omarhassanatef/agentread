import type { Fetcher } from "../../src/security/dns.js";

export interface UpstreamRoute {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Never respond (until the request is aborted). */
  hang?: boolean;
  /** Stream this many bytes of filler without a Content-Length header. */
  streamBytes?: number;
}

export interface MockUpstream {
  fetcher: Fetcher;
  calls: Array<{ url: string; headers: Record<string, string>; redirect: string | undefined }>;
}

/** In-memory upstream web. Unknown URLs behave like unreachable hosts. */
export function mockUpstream(routes: Record<string, UpstreamRoute | ((url: string) => Response)>): MockUpstream {
  const calls: MockUpstream["calls"] = [];
  const fetcher: Fetcher = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url, headers, redirect: init?.redirect });
    const route = routes[url];
    if (!route) throw new TypeError("fetch failed: network unreachable");
    if (typeof route === "function") return route(url);
    if (route.hang) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (route.streamBytes) {
      let sent = 0;
      const total = route.streamBytes;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= total) return controller.close();
          const n = Math.min(16_384, total - sent);
          controller.enqueue(new Uint8Array(n).fill(0x61));
          sent += n;
        },
      });
      return new Response(stream, { status: route.status ?? 200, headers: route.headers ?? { "content-type": "text/html" } });
    }
    return new Response(route.body ?? "", {
      status: route.status ?? 200,
      headers: route.headers ?? { "content-type": "text/html; charset=utf-8" },
    });
  };
  return { fetcher, calls };
}

export const html = (body: string, extra: Record<string, string> = {}): UpstreamRoute => ({
  body,
  headers: { "content-type": "text/html; charset=utf-8", ...extra },
});

export const redirect = (to: string, status = 301): UpstreamRoute => ({ status, headers: { location: to }, body: "" });
