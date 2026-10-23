# Listings and discovery

Where AgentRead is listed, how each listing was made, and what is still open. All of these are free.

## Status (2026-10-23)

| Directory | Status | How |
|---|---|---|
| [Official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.omarhassanatef/agentread) | ✅ Published (`io.github.omarhassanatef/agentread`, active) | `server.json` + `.github/workflows/publish-mcp.yml` (GitHub OIDC). Re-publish after bumping `version`: `gh workflow run publish-mcp.yml -f publish=true` |
| [x402scan](https://www.x402scan.com) | ✅ Registered (2 paid + 4 public routes, 0 failed) | `node scripts/register-x402scan.mjs` (Sign-In-With-X signature only, no payment) |
| CDP x402 Bazaar / [agentic.market](https://agentic.market) | ⏳ Eligible, not yet indexed | Validator passes all checks (`node scripts/validate-bazaar.mjs`, run in CI). Indexing happens automatically after the **first successful paid call** through the CDP facilitator. A listing is dropped after 30 days without a settled payment |
| [awesome-x402](https://github.com/xpaysh/awesome-x402) | ⏳ PR open: [#1974](https://github.com/xpaysh/awesome-x402/pull/1974) | Fork + PR |
| [awesome-remote-mcp-servers](https://github.com/punkpeye/awesome-remote-mcp-servers) | ⏳ Waiting for a Glama connector | Requires a [Glama connector](https://glama.ai/mcp/connectors) badge and that the PR author starred the repo. See the entry below |
| [Glama connectors](https://glama.ai/mcp/connectors) | ⏳ Not yet imported | Expected to sync from the MCP Registry; otherwise list it manually (Glama account) |
| [mcpservers.org](https://mcpservers.org/submit) (feeds wong2/awesome-mcp-servers) | 📝 Manual: web form | Free plan: name, category (Web Scraping), short description, link, registry name, "supports remote", contact email |
| PulseMCP and other registry-fed directories | ⏳ Expected via the MCP Registry | No action unless it is missing after a few days |
| mcp.so | ⛔ Skipped | Only a paid ($39) publish option is offered |

## Machine-readable discovery served by the Worker

| URL | For |
|---|---|
| `/openapi.json` | OpenAPI 3.1 with `x-payment-info` (price, x402 protocol), `x-discovery.ownershipProofs`, `info.x-guidance`, `security: []` on free routes |
| `/.well-known/x402` | x402scan fan-out format (`version: 1`, resources, ownership proof) |
| `/llms.txt` | LLM-readable summary (llmstxt.org) |
| `/` | Service index: operations, prices, limits |
| `/icon.png`, `/favicon.png` | 128×128 PNG icon, also the x402 `resource.iconUrl` |
| 402 `PAYMENT-REQUIRED` | x402 v2 requirements + `extensions.bazaar` (input/output schema and examples) |

Audits: `gh workflow run CI -f agentread_url=https://agentread.omar-cv.workers.dev` runs the smoke test, the CDP Bazaar validator and `npx @agentcash/discovery` (x402scan's auditor) from GitHub's network.

## Ready-to-submit entry: awesome-remote-mcp-servers

Once `https://glama.ai/mcp/connectors/io.github.omarhassanatef/agentread` exists, star `punkpeye/awesome-remote-mcp-servers`, then add this under **🔎 Search & Data Extraction** (alphabetical):

```markdown
- [AgentRead](https://agentread.omar-cv.workers.dev) `https://agentread.omar-cv.workers.dev/mcp`
  [![AgentRead MCP connector](https://glama.ai/mcp/connectors/io.github.omarhassanatef/agentread/badges/score.svg)](https://glama.ai/mcp/connectors/io.github.omarhassanatef/agentread)
  🔓 - Web page to clean Markdown, metadata, headings and links; free inspect, paid extraction via x402.
```

## Launch post drafts

**Short (X / Farcaster):**

> AgentRead is live: clean web content for AI agents, paid per call with x402.
> URL → Markdown, metadata, headings and links. $0.003 per extraction in USDC on Base, free URL inspection, and no charge for failed extractions. No signup and no API key.
> HTTP API + remote MCP server. Open source (MIT).
> https://github.com/omarhassanatef/agentread

**x402 community (Slack / Discord):**

> Hi all, I just shipped **AgentRead**, an x402-paid web extraction API and remote MCP server on Cloudflare Workers.
> - `POST /v1/inspect`: free reachability and extractability check
> - `POST /v1/extract`: $0.003, clean Markdown + title, description, headings
> - `POST /v1/extract/structured`: $0.005, adds canonical URL, language, links
> - MCP: `https://agentread.omar-cv.workers.dev/mcp` (`io.github.omarhassanatef/agentread` in the MCP Registry)
>
> x402 v2, exact scheme, USDC on Base via the CDP facilitator. Payment settles only when extraction succeeds. Discovery: `/openapi.json` with `x-payment-info`, `/.well-known/x402`, Bazaar metadata. Feedback welcome: https://github.com/omarhassanatef/agentread
