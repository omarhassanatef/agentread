import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/config/env.js";
import { safeFetch } from "../../src/extraction/fetch.js";
import { validateTargetUrl } from "../../src/security/url.js";
import { AppError } from "../../src/utils/errors.js";
import { mockUpstream, redirect, html } from "../helpers/upstream.js";
import type { HostGuard } from "../../src/security/dns.js";

const limits = { ...DEFAULT_LIMITS, fetchTimeoutMs: 1000, maxRedirects: 3 };
const allowAll: HostGuard = async () => {};
const target = (u: string) => validateTargetUrl(u, limits.maxUrlLength);
const full = { maxBytes: limits.maxResponseBytes, allowPartial: false };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof AppError ? e.code : `non-app:${String(e)}`;
  }
}

describe("safeFetch", () => {
  it("follows permitted redirects manually and reports the final URL", async () => {
    const up = mockUpstream({
      "https://a.example.com/": redirect("/next"),
      "https://a.example.com/next": redirect("https://b.example.com/final", 302),
      "https://b.example.com/final": html("<p>ok</p>"),
    });
    const doc = await safeFetch(target("https://a.example.com/"), { fetcher: up.fetcher, hostGuard: allowAll, limits }, full);
    expect(doc.finalUrl).toBe("https://b.example.com/final");
    expect(doc.redirects).toBe(2);
    expect(up.calls.every((c) => c.redirect === "manual")).toBe(true);
  });

  it("re-validates redirect targets (redirect to internal address is blocked)", async () => {
    for (const loc of ["http://169.254.169.254/latest/meta-data", "http://localhost:8080/admin", "http://[::1]/", "file:///etc/passwd", "http://10.0.0.1/"]) {
      const up = mockUpstream({ "https://a.example.com/": redirect(loc) });
      expect(await code(safeFetch(target("https://a.example.com/"), { fetcher: up.fetcher, hostGuard: allowAll, limits }, full))).toBe(
        "blocked_destination",
      );
      expect(up.calls).toHaveLength(1); // never fetched the internal target
    }
  });

  it("runs the DNS guard on every hop", async () => {
    const seen: string[] = [];
    const guard: HostGuard = async (h) => {
      seen.push(h);
      if (h === "rebind.example.com") throw new AppError("blocked_destination", "private");
    };
    const up = mockUpstream({ "https://a.example.com/": redirect("https://rebind.example.com/") });
    expect(await code(safeFetch(target("https://a.example.com/"), { fetcher: up.fetcher, hostGuard: guard, limits }, full))).toBe("blocked_destination");
    expect(seen).toEqual(["a.example.com", "rebind.example.com"]);
  });

  it("limits the number of redirects", async () => {
    const up = mockUpstream({
      "https://a.example.com/1": redirect("/2"),
      "https://a.example.com/2": redirect("/3"),
      "https://a.example.com/3": redirect("/4"),
      "https://a.example.com/4": redirect("/5"),
    });
    expect(await code(safeFetch(target("https://a.example.com/1"), { fetcher: up.fetcher, hostGuard: allowAll, limits }, full))).toBe("too_many_redirects");
  });

  it("times out slow hosts", async () => {
    const up = mockUpstream({ "https://slow.example.com/": { hang: true } });
    const started = Date.now();
    expect(await code(safeFetch(target("https://slow.example.com/"), { fetcher: up.fetcher, hostGuard: allowAll, limits }, full))).toBe("upstream_timeout");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("maps network failures to upstream_unreachable", async () => {
    const up = mockUpstream({});
    expect(await code(safeFetch(target("https://down.example.com/"), { fetcher: up.fetcher, hostGuard: allowAll, limits }, full))).toBe("upstream_unreachable");
  });

  it("rejects oversized bodies by Content-Length without reading them", async () => {
    const up = mockUpstream({ "https://big.example.com/": { headers: { "content-type": "text/html", "content-length": "99999999" }, body: "x" } });
    expect(await code(safeFetch(target("https://big.example.com/"), { fetcher: up.fetcher, hostGuard: allowAll, limits }, full))).toBe("content_too_large");
  });

  it("stops streaming bodies that exceed the limit (no Content-Length)", async () => {
    const up = mockUpstream({ "https://big.example.com/": { streamBytes: 5_000_000 } });
    const small = { ...limits, maxResponseBytes: 100_000 };
    expect(
      await code(safeFetch(target("https://big.example.com/"), { fetcher: up.fetcher, hostGuard: allowAll, limits: small }, { maxBytes: 100_000, allowPartial: false })),
    ).toBe("content_too_large");
  });

  it("returns a bounded prefix in partial mode", async () => {
    const up = mockUpstream({ "https://big.example.com/": { streamBytes: 500_000 } });
    const doc = await safeFetch(target("https://big.example.com/"), { fetcher: up.fetcher, hostGuard: allowAll, limits }, { maxBytes: 1000, allowPartial: true });
    expect(doc.body.length).toBe(1000);
    expect(doc.partial).toBe(true);
  });

  it("sends only a fixed, minimal header set (no client credentials/cookies)", async () => {
    const up = mockUpstream({ "https://a.example.com/": html("<p>x</p>") });
    await safeFetch(target("https://a.example.com/"), { fetcher: up.fetcher, hostGuard: allowAll, limits }, full);
    expect(Object.keys(up.calls[0]!.headers).sort()).toEqual(["accept", "accept-language", "user-agent"]);
  });
});
