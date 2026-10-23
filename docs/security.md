# Security

AgentRead fetches URLs chosen by untrusted callers, so server-side request forgery (SSRF) is the main threat. The approach is deny by default, with checks at several independent layers.

## Controls (implemented and tested)

**URL policy** (`src/security/url.ts`), applied to the initial URL **and every redirect target**:
- Only `http:`/`https:`. Rejects `file:`, `ftp:`, `gopher:`, `data:`, `javascript:` and so on.
- No embedded credentials (`user:pass@`).
- Default ports only. Any explicit non-default port is rejected; the URL parser drops `:80`/`:443`.
- **No IP-literal hosts at all**, IPv4 or IPv6. This covers decimal, hex and octal forms, which the WHATWG parser normalises (`2130706433`, `0x7f000001`, `017700000001`, `127.1`). Workers cannot fetch IP literals anyway, and banning them removes a whole class of bypasses.
- Single-label hosts (`metadata`, `intranet`) are rejected.
- Blocked suffixes: `localhost`, `local`, `internal`, `home.arpa`, `lan`, `corp`, `in-addr.arpa`, `ip6.arpa`, `onion`, `test`, `example`, `invalid` and similar.
- Known metadata hosts are blocked (`metadata.google.internal`, …), as are wildcard-DNS rebinding helpers (`nip.io`, `sslip.io`, `xip.io`, `localtest.me`, `lvh.me`, …).
- Malformed labels, numeric TLDs, control characters, whitespace and backslashes are rejected. Maximum length is 2048.

**DNS guard** (`src/security/dns.ts`, `DNS_CHECK=doh`): before every hop, A and AAAA records are resolved via DNS-over-HTTPS. The request is rejected unless **all** addresses are public unicast. Non-public ranges include:
- IPv4: RFC 1918, loopback, link-local/metadata, CGNAT, TEST-NETs, benchmarking, multicast, reserved.
- IPv6: loopback, ULA, link-local, site-local, multicast, documentation, NAT64, 6to4, Teredo, IPv4-mapped and IPv4-compatible forms evaluated by their embedded IPv4, and anything outside `2000::/3`.

The guard fails closed if the resolver errors. Resolved addresses are never echoed back to the client.

**Fetch hygiene** (`src/extraction/fetch.ts`):
- `redirect: "manual"`, at most 5 redirects, each re-validated by the URL policy and the DNS guard.
- A fixed header set (`user-agent`, `accept`, `accept-language`). Client cookies, `Authorization`, payment headers and other request headers are **never forwarded**.
- An overall deadline (10 s) covers connect, redirects and body.
- Response size is capped: `Content-Length` is pre-checked, and the body is streamed with a hard byte cap, then the stream is cancelled. Inspection reads at most 64 KB.
- **No secondary fetches.** Extracted links and images are only rewritten to absolute URLs; they are never fetched.

**Request limits:** an 8 KB JSON body (64 KB for `/mcp`), strict schemas that reject unknown fields, bounded `maxCharacters`, link and heading caps, and per-IP rate limits.

**Output hygiene:**
- Internal errors are normalised to `internal_error` with no stack, message, IP or secret.
- Upstream response headers are never returned.
- Logs contain hostnames, never full URLs, query strings, page content or payment payloads.
- Payer addresses are logged only as a salted hash prefix.

**Secrets:** the only secrets are the CDP API key ID and secret, stored as Worker secrets. The Worker holds **no private key**: it receives funds and never signs transactions. The receiving address is public configuration.

## Residual risks and runtime constraints

- **DNS rebinding / TOCTOU.** Workers' `fetch()` resolves DNS itself, so the DoH pre-check can be raced by an attacker who changes records between check and fetch. This cannot be closed at the application layer, because Workers offers no "connect to this IP with this SNI" primitive. Mitigation: Workers subrequests egress from Cloudflare's network and cannot reach your private networks unless you add bindings such as Workers VPC, Tunnel or service bindings. **Do not add such bindings to this Worker.**
- **Cloudflare-hosted targets.** Requests to other sites on Cloudflare go through Cloudflare's edge like any public client. Avoid deploying this Worker in a zone whose WAF trusts Worker subrequests.
- **Non-standard port behaviour in production** is undocumented by Cloudflare (reports say custom ports are ignored). The policy rejects them regardless.
- **Parsing untrusted HTML.** linkedom and Readability parse attacker-controlled markup. No scripts are executed: linkedom does not run JS, and `<script>` is removed. Pathological documents are bounded by the 3 MB cap and the Workers CPU limit.
- **Abuse.** Rate limits are approximate and per-location. A paying attacker can still drive load, but every paid request costs them money. The free `inspect` endpoint is the cheapest abuse vector: it is capped at 64 KB and 30 requests/min per IP per location.
- **Not reviewed.** These controls are covered by about 120 security-relevant tests, but the service has **not** had an independent security review or penetration test. Do not describe it as production-secure until it has.
