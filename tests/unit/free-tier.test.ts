import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { durableFreeTier, utcDay } from "../../src/payments/free-tier.js";

const ns = (env as unknown as { FREE_QUOTA: DurableObjectNamespace<import("../../src/payments/free-tier.js").FreeQuota> }).FREE_QUOTA;

describe("FreeQuota Durable Object (real runtime)", () => {
  it("allows the per-client limit, then refuses; release gives a slot back", async () => {
    const tier = durableFreeTier(ns, 2, 100);
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}-${crypto.randomUUID()}`;
    const a = await tier.reserve(ip);
    const b = await tier.reserve(ip);
    expect(a?.remaining).toBe(1);
    expect(b?.remaining).toBe(0);
    expect(await tier.reserve(ip)).toBeNull();
    await b!.release();
    await b!.release(); // idempotent
    const c = await tier.reserve(ip);
    expect(c?.remaining).toBe(0);
    expect(await tier.reserve(ip)).toBeNull();
  });

  it("counts clients separately", async () => {
    const tier = durableFreeTier(ns, 1, 100);
    expect(await tier.reserve(`client-a-${crypto.randomUUID()}`)).not.toBeNull();
    expect(await tier.reserve(`client-b-${crypto.randomUUID()}`)).not.toBeNull();
  });

  it("enforces the global daily cap and rolls back the client slot", async () => {
    // Use a fresh global counter by consuming it to the cap with distinct clients.
    const day = utcDay();
    const global = ns.get(ns.idFromName(`global:${day}`));
    const before = await global.reserve(1_000_000);
    await global.release();
    const cap = before.used; // current usage + 1 → cap so the next reserve is refused
    const tier = durableFreeTier(ns, 5, cap - 1);
    const ip = `cap-${crypto.randomUUID()}`;
    expect(await tier.reserve(ip)).toBeNull();
    // The client counter was released when the global cap refused the call.
    const generous = durableFreeTier(ns, 1, 1_000_000);
    expect(await generous.reserve(ip)).not.toBeNull();
  });

  it("a zero limit disables the free tier", async () => {
    expect(await durableFreeTier(ns, 0, 100).reserve("x")).toBeNull();
  });
});
