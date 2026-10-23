/**
 * IP address classification for SSRF defence. Deny-by-default: anything that is not
 * clearly globally-routable unicast is treated as non-public.
 */

export function parseIPv4(input: string): number[] | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Parses an IPv6 address (no brackets, optional embedded IPv4) into 8 16-bit groups. */
export function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(":")) return null;

  // Embedded IPv4 tail, e.g. ::ffff:127.0.0.1
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIPv4(maybeV4);
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    s = s.slice(0, lastColon + 1) + "0:0";
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0]!);
  const rest = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (!head || !rest) return null;

  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tail.length) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  return groups;
}

function inV4(ip: number[], base: [number, number, number, number], prefix: number): boolean {
  const toInt = (a: number[]) => ((a[0]! << 24) | (a[1]! << 16) | (a[2]! << 8) | a[3]!) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

/** Non-public IPv4 ranges (IANA special-purpose registry + common internal/metadata ranges). */
const V4_BLOCKED: Array<[[number, number, number, number], number]> = [
  [[0, 0, 0, 0], 8], // "this network"
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // CGNAT (also Alibaba metadata 100.100.100.200)
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local (cloud metadata 169.254.169.254)
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // TEST-NET-1
  [[192, 88, 99, 0], 24], // 6to4 relay anycast
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // TEST-NET-2
  [[203, 0, 113, 0], 24], // TEST-NET-3
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved + broadcast
];

export function isPublicIPv4(ip: number[]): boolean {
  return !V4_BLOCKED.some(([base, prefix]) => inV4(ip, base, prefix));
}

export function isPublicIPv6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const embeddedV4 = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];

  if (g.every((x) => x === 0)) return false; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return false; // ::1
  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96 (deprecated) → judge the embedded IPv4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return isPublicIPv4(embeddedV4);
  }
  // IPv4-translated ::ffff:0:0:0/96
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return false;
  // NAT64 64:ff9b::/96 and local-use 64:ff9b:1::/48 → treat as non-public (deny by default).
  if (g0 === 0x64 && g1 === 0xff9b) return false;
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return false; // discard-only 100::/64
  if (g0 === 0x2001 && g1 < 0x200) return false; // 2001::/23 IETF protocol assignments (incl. Teredo 2001::/32)
  if (g0 === 0x2001 && g1 === 0xdb8) return false; // documentation
  if (g0 === 0x2002) return false; // 6to4 (can encapsulate private IPv4)
  if (g0 === 0x3fff && g1 < 0x1000) return false; // documentation 3fff::/20
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return false; // site-local (deprecated) fec0::/10
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  // Only 2000::/3 is allocated global unicast.
  return (g0 & 0xe000) === 0x2000;
}

/** True only when `ip` parses as an IPv4/IPv6 address in public unicast space. */
export function isPublicIp(ip: string): boolean {
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const v4 = parseIPv4(bare);
  if (v4) return isPublicIPv4(v4);
  const v6 = parseIPv6(bare);
  if (v6) return isPublicIPv6(v6);
  return false;
}

export function isIpLiteral(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return parseIPv4(bare) !== null || parseIPv6(bare) !== null;
}
