import { DurableObject } from "cloudflare:workers";
import { logError } from "../utils/log.js";

/**
 * Free daily allowance for the paid operations: N successful extractions per client per
 * UTC day, plus a global daily cap that protects the Workers Free plan quotas.
 *
 * - A slot is reserved before extraction and released if extraction fails, so only
 *   successful extractions count (mirroring "settle only on success" for payments).
 * - Requests that carry an x402 payment never touch the allowance.
 * - Clients are identified by a salted SHA-256 of their IP; raw IPs are never stored.
 *   Clients behind a shared proxy (e.g. an MCP gateway) share one allowance.
 * - Counters live in a Durable Object per (scope, day) and delete themselves after 2 days.
 */

export interface FreeGrant {
  limit: number;
  /** Free calls left today for this client after this one. */
  remaining: number;
  /** Give the slot back (extraction failed). Safe to call once. */
  release(): Promise<void>;
}

export interface FreeTier {
  readonly perClientLimit: number;
  /** Reserve one free call, or null when the allowance (client or global) is used up. */
  reserve(clientIp: string): Promise<FreeGrant | null>;
}

/** Durable Object holding one counter. Storage ops inside a method are atomic (input/output gates). */
export class FreeQuota extends DurableObject {
  async reserve(limit: number): Promise<{ ok: boolean; used: number }> {
    const used = (await this.ctx.storage.get<number>("used")) ?? 0;
    if (used >= limit) return { ok: false, used };
    await this.ctx.storage.put("used", used + 1);
    if (used === 0) await this.ctx.storage.setAlarm(Date.now() + 2 * 24 * 60 * 60 * 1000);
    return { ok: true, used: used + 1 };
  }

  async release(): Promise<void> {
    const used = (await this.ctx.storage.get<number>("used")) ?? 0;
    if (used > 0) await this.ctx.storage.put("used", used - 1);
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

async function clientId(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`agentread-free:${ip}`));
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Production free tier backed by the FREE_QUOTA Durable Object namespace. */
export function durableFreeTier(ns: DurableObjectNamespace<FreeQuota>, perClientLimit: number, globalLimit: number): FreeTier {
  const stub = (name: string) => ns.get(ns.idFromName(name));
  return {
    perClientLimit,
    async reserve(clientIp) {
      if (perClientLimit <= 0 || globalLimit <= 0) return null;
      const day = utcDay();
      const client = stub(`client:${await clientId(clientIp)}:${day}`);
      const global = stub(`global:${day}`);
      try {
        const c = await client.reserve(perClientLimit);
        if (!c.ok) return null;
        const g = await global.reserve(globalLimit);
        if (!g.ok) {
          await client.release();
          return null;
        }
        let released = false;
        return {
          limit: perClientLimit,
          remaining: perClientLimit - c.used,
          async release() {
            if (released) return;
            released = true;
            await Promise.all([client.release(), global.release()]);
          },
        };
      } catch (err) {
        // Never block paid usage because the allowance store is unavailable.
        logError("free_tier.unavailable", { error: err instanceof Error ? err.name : "unknown" });
        return null;
      }
    },
  };
}

/** In-memory free tier (tests). */
export function memoryFreeTier(perClientLimit: number, globalLimit = Number.POSITIVE_INFINITY): FreeTier & { used: Map<string, number> } {
  const used = new Map<string, number>();
  let global = 0;
  return {
    perClientLimit,
    used,
    async reserve(clientIp) {
      const n = used.get(clientIp) ?? 0;
      if (perClientLimit <= 0 || n >= perClientLimit || global >= globalLimit) return null;
      used.set(clientIp, n + 1);
      global++;
      let released = false;
      return {
        limit: perClientLimit,
        remaining: perClientLimit - (n + 1),
        async release() {
          if (released) return;
          released = true;
          used.set(clientIp, (used.get(clientIp) ?? 1) - 1);
          global--;
        },
      };
    },
  };
}
