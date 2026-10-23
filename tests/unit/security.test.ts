import { describe, expect, it } from "vitest";
import { isPublicIp, parseIPv6 } from "../../src/security/ip.js";
import { validateTargetUrl } from "../../src/security/url.js";
import { createDohHostGuard } from "../../src/security/dns.js";
import { AppError } from "../../src/utils/errors.js";

const MAX = 2048;

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AppError ? e.code : "non-app-error";
  }
}

describe("validateTargetUrl — accepts and normalises", () => {
  it("accepts public http(s) URLs and strips the fragment", () => {
    const v = validateTargetUrl("https://Example.COM/a/b?q=1#frag", MAX);
    expect(v.href).toBe("https://example.com/a/b?q=1");
    expect(v.hostname).toBe("example.com");
  });
  it("normalises explicit default ports away", () => {
    expect(validateTargetUrl("https://example.com:443/x", MAX).href).toBe("https://example.com/x");
    expect(validateTargetUrl("http://example.com:80/", MAX).href).toBe("http://example.com/");
  });
  it("accepts IDN hostnames via punycode", () => {
    expect(validateTargetUrl("https://bücher.de/x", MAX).hostname).toBe("xn--bcher-kva.de");
  });
  it("tolerates a trailing dot", () => {
    expect(validateTargetUrl("https://example.com./", MAX).hostname).toBe("example.com");
  });
});

describe("validateTargetUrl — rejects", () => {
  const cases: Array<[string, string]> = [
    ["", "invalid_url"],
    ["not a url", "invalid_url"],
    ["/relative/path", "invalid_url"],
    ["ftp://example.com/file", "invalid_url"],
    ["file:///etc/passwd", "invalid_url"],
    ["gopher://example.com/", "invalid_url"],
    ["javascript:alert(1)", "invalid_url"],
    ["data:text/html,hi", "invalid_url"],
    ["https://user:pass@example.com/", "invalid_url"],
    ["https://user@example.com/", "invalid_url"],
    ["https://example.com:8080/", "blocked_destination"],
    ["http://example.com:22/", "blocked_destination"],
    ["http://localhost/", "blocked_destination"],
    ["http://LOCALHOST./", "blocked_destination"],
    ["http://app.localhost/", "blocked_destination"],
    ["http://127.0.0.1/", "blocked_destination"],
    ["http://127.1/", "blocked_destination"],
    ["http://2130706433/", "blocked_destination"],
    ["http://0x7f000001/", "blocked_destination"],
    ["http://017700000001/", "blocked_destination"],
    ["http://0.0.0.0/", "blocked_destination"],
    ["http://10.0.0.1/", "blocked_destination"],
    ["http://192.168.1.1/", "blocked_destination"],
    ["http://172.16.0.1/", "blocked_destination"],
    ["http://169.254.169.254/latest/meta-data/", "blocked_destination"],
    ["http://100.100.100.200/", "blocked_destination"],
    ["http://[::1]/", "blocked_destination"],
    ["http://[::ffff:127.0.0.1]/", "blocked_destination"],
    ["http://[fd00::1]/", "blocked_destination"],
    ["http://[fe80::1]/", "blocked_destination"],
    ["http://8.8.8.8/", "blocked_destination"], // public, but IP literals are not supported at all
    ["http://metadata.google.internal/computeMetadata/v1/", "blocked_destination"],
    ["http://metadata/", "blocked_destination"],
    ["http://intranet/", "blocked_destination"],
    ["http://printer.local/", "blocked_destination"],
    ["http://db.internal/", "blocked_destination"],
    ["http://router.home.arpa/", "blocked_destination"],
    ["http://127.0.0.1.nip.io/", "blocked_destination"],
    ["http://10-0-0-1.sslip.io/", "blocked_destination"],
    ["http://localtest.me/", "blocked_destination"],
    ["http://foo.lvh.me/", "blocked_destination"],
    ["http://1.1.1.1.in-addr.arpa/", "blocked_destination"],
    ["http://abc.onion/", "blocked_destination"],
    ["http://-bad-.example.com/", "invalid_url"],
    ["http://exa mple.com/", "invalid_url"],
    ["http://example.com/\u0000", "invalid_url"],
    ["http://example.123/", "invalid_url"],
    ["http:\\\\example.com\\", "invalid_url"],
  ];
  for (const [url, code] of cases) {
    it(`${JSON.stringify(url)} → ${code}`, () => {
      expect(codeOf(() => validateTargetUrl(url, MAX))).toBe(code);
    });
  }
  it("rejects over-long URLs", () => {
    expect(codeOf(() => validateTargetUrl(`https://example.com/${"a".repeat(3000)}`, MAX))).toBe("invalid_url");
  });
  it("rejects non-string input", () => {
    expect(codeOf(() => validateTargetUrl(undefined as unknown as string, MAX))).toBe("invalid_url");
  });
});

describe("isPublicIp", () => {
  const nonPublic = [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.31.255.255", "192.0.0.1", "192.0.2.5",
    "192.168.0.1", "198.18.0.1", "198.51.100.1", "203.0.113.9", "224.0.0.1", "239.1.1.1", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::127.0.0.1", "64:ff9b::7f00:1", "100::1", "2001::1", "2001:db8::1",
    "2002:7f00:1::1", "fc00::1", "fd12:3456::1", "fe80::1%eth0", "fec0::1", "ff02::1", "[::1]", "not-an-ip", "1.2.3", "1.2.3.256",
  ];
  const publicIps = ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"];
  for (const ip of nonPublic) it(`${ip} is not public`, () => expect(isPublicIp(ip)).toBe(false));
  for (const ip of publicIps) it(`${ip} is public`, () => expect(isPublicIp(ip)).toBe(true));

  it("parses compressed and embedded IPv6 forms", () => {
    expect(parseIPv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6("1::")).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIPv6("1::2::3")).toBeNull();
  });
});

describe("DoH host guard", () => {
  const doh = (answers: Record<string, { Status: number; Answer?: Array<{ type: number; data: string }> }>) =>
    createDohHostGuard(async (input) => {
      const u = new URL(String(input));
      const key = `${u.searchParams.get("name")}/${u.searchParams.get("type")}`;
      const body = answers[key] ?? { Status: 0, Answer: [] };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/dns-json" } });
    }, "https://doh.test/dns-query");

  it("allows hostnames that resolve only to public addresses", async () => {
    const guard = doh({
      "ok.example.com/A": { Status: 0, Answer: [{ type: 5, data: "cdn.example.net." }, { type: 1, data: "93.184.216.34" }] },
      "ok.example.com/AAAA": { Status: 0, Answer: [{ type: 28, data: "2606:2800:220:1::1" }] },
    });
    await expect(guard("ok.example.com")).resolves.toBeUndefined();
  });

  it("blocks DNS names pointing at private addresses (rebinding-style)", async () => {
    const guard = doh({
      "evil.example.com/A": { Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }, { type: 1, data: "10.0.0.5" }] },
    });
    await expect(guard("evil.example.com")).rejects.toMatchObject({ code: "blocked_destination" });
  });

  it("blocks AAAA loopback", async () => {
    const guard = doh({ "v6.example.com/AAAA": { Status: 0, Answer: [{ type: 28, data: "::1" }] } });
    await expect(guard("v6.example.com")).rejects.toMatchObject({ code: "blocked_destination" });
  });

  it("does not echo resolved internal addresses in the error", async () => {
    const guard = doh({ "evil.example.com/A": { Status: 0, Answer: [{ type: 1, data: "169.254.169.254" }] } });
    const err = await guard("evil.example.com").catch((e: AppError) => e);
    expect(String((err as AppError).message)).not.toContain("169.254");
  });

  it("reports NXDOMAIN as host_not_found", async () => {
    const guard = doh({ "nope.example.com/A": { Status: 3 }, "nope.example.com/AAAA": { Status: 3 } });
    await expect(guard("nope.example.com")).rejects.toMatchObject({ code: "host_not_found" });
  });

  it("fails closed when the resolver is down", async () => {
    const guard = createDohHostGuard(async () => new Response("oops", { status: 503 }), "https://doh.test/dns-query");
    await expect(guard("x.example.com")).rejects.toMatchObject({ code: "dns_resolution_failed" });
  });
});
