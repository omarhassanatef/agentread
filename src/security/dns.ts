import { AppError } from "../utils/errors.js";
import { isPublicIp } from "./ip.js";

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Resolves a hostname and throws unless every address it resolves to is public. */
export type HostGuard = (hostname: string, signal?: AbortSignal) => Promise<void>;

interface DohAnswer {
  type: number;
  data: string;
}
interface DohResponse {
  Status: number;
  Answer?: DohAnswer[];
}

const TYPE_A = 1;
const TYPE_AAAA = 28;

/**
 * DNS-over-HTTPS pre-resolution check. Defence in depth only: Workers' fetch()
 * resolves DNS again on its own, so a rebinding attacker can still race this check
 * (TOCTOU). The primary protection is that Workers egress cannot reach private networks.
 */
export function createDohHostGuard(fetcher: Fetcher, dohUrl: string): HostGuard {
  const query = async (hostname: string, type: "A" | "AAAA", signal?: AbortSignal): Promise<DohResponse> => {
    const url = `${dohUrl}?name=${encodeURIComponent(hostname)}&type=${type}`;
    let res: Response;
    try {
      res = await fetcher(url, { headers: { accept: "application/dns-json" }, ...(signal ? { signal } : {}) });
    } catch {
      throw new AppError("dns_resolution_failed", "Could not resolve the hostname. Try again later.");
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new AppError("dns_resolution_failed", "Could not resolve the hostname. Try again later.");
    }
    try {
      return (await res.json()) as DohResponse;
    } catch {
      throw new AppError("dns_resolution_failed", "Could not resolve the hostname. Try again later.");
    }
  };

  return async (hostname, signal) => {
    const [a, aaaa] = await Promise.all([query(hostname, "A", signal), query(hostname, "AAAA", signal)]);
    if (a.Status === 3 && aaaa.Status === 3) {
      throw new AppError("host_not_found", "The hostname does not exist (NXDOMAIN).");
    }
    if (a.Status !== 0 && aaaa.Status !== 0) {
      throw new AppError("dns_resolution_failed", "Could not resolve the hostname.");
    }
    const addrs = [...(a.Answer ?? []), ...(aaaa.Answer ?? [])]
      .filter((r) => r.type === TYPE_A || r.type === TYPE_AAAA)
      .map((r) => r.data.trim());
    if (addrs.length === 0) throw new AppError("host_not_found", "The hostname has no A or AAAA records.");
    if (addrs.some((ip) => !isPublicIp(ip))) {
      // Do not echo the resolved address back: it may reveal internal topology.
      throw new AppError("blocked_destination", "The hostname resolves to a non-public address.");
    }
  };
}

export const noopHostGuard: HostGuard = async () => {};
