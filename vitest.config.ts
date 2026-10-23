import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd (the Workers runtime) via Miniflare. They never touch the
// public internet, a blockchain, or a real facilitator: network edges are injected.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { ENVIRONMENT: "test", DNS_CHECK: "off" },
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
