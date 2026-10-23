import { AppError } from "../utils/errors.js";
import { isIpLiteral } from "./ip.js";

/**
 * Hostname suffixes that are internal by convention or that exist to map public
 * names onto private addresses (wildcard rebinding helpers). Matched as whole labels.
 */
const BLOCKED_SUFFIXES = [
  "localhost",
  "localdomain",
  "local",
  "internal",
  "intranet",
  "private",
  "corp",
  "home",
  "lan",
  "home.arpa",
  "in-addr.arpa",
  "ip6.arpa",
  "onion",
  "test",
  "example",
  "invalid",
  "alt",
  // Wildcard DNS services that resolve arbitrary names to embedded (often private) IPs.
  "nip.io",
  "sslip.io",
  "xip.io",
  "localtest.me",
  "lvh.me",
  "vcap.me",
  "lacolhost.com",
];

/** Exact hostnames of well-known metadata/internal services. */
const BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata.azure.com",
  "instance-data.ec2.internal",
]);

export interface ValidatedUrl {
  url: URL;
  /** Normalised string form (fragment removed). */
  href: string;
  hostname: string;
}

function blocked(message: string): AppError {
  return new AppError("blocked_destination", message);
}

export function checkHostname(hostname: string): void {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0 || host.length > 253) throw new AppError("invalid_url", "The URL hostname is empty or too long.");
  if (isIpLiteral(hostname) || hostname.startsWith("[")) {
    // Cloudflare Workers cannot fetch IP literals at all, and allowing them would bypass hostname policy.
    throw blocked("IP-address URLs are not supported. Use a public hostname.");
  }
  const labels = host.split(".");
  if (labels.length < 2) throw blocked("Single-label hostnames are not allowed. Use a fully-qualified public hostname.");
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) && !/^xn--[a-z0-9-]{1,59}$/.test(label)) {
      throw new AppError("invalid_url", "The URL hostname is malformed.");
    }
  }
  if (/^\d+$/.test(labels[labels.length - 1]!)) throw new AppError("invalid_url", "The URL hostname is malformed.");
  if (BLOCKED_HOSTS.has(host)) throw blocked("This destination is not allowed.");
  for (const suffix of BLOCKED_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      throw blocked("Internal, reserved, or loopback hostnames are not allowed.");
    }
  }
}

/**
 * Syntactic + policy validation of an untrusted target URL. Applied to the initial
 * URL and again to every redirect target. DNS-level checks live in dns.ts.
 */
export function validateTargetUrl(raw: string, maxUrlLength: number): ValidatedUrl {
  if (typeof raw !== "string" || raw.trim() === "") throw new AppError("invalid_url", "A URL is required.");
  const trimmed = raw.trim();
  if (trimmed.length > maxUrlLength) {
    throw new AppError("invalid_url", `The URL exceeds the maximum length of ${maxUrlLength} characters.`);
  }
  // Reject control characters/whitespace that parsers handle inconsistently.
  if (/[\u0000-\u001f\u007f\s\\]/.test(trimmed)) throw new AppError("invalid_url", "The URL contains invalid characters.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError("invalid_url", "The URL is not a valid absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError("invalid_url", "Only http and https URLs are supported.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new AppError("invalid_url", "URLs containing credentials are not allowed.");
  }
  // The URL parser drops default ports, so any remaining port is non-standard.
  if (url.port !== "") {
    throw blocked("Only the default ports (80 for http, 443 for https) are supported.");
  }
  checkHostname(url.hostname);

  url.hash = "";
  return { url, href: url.href, hostname: url.hostname.replace(/\.$/, "") };
}
