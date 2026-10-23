import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd (the Workers runtime) via Miniflare. They never touch the
// public internet, a blockchain, or a real facilitator: network edges are injected.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The AI binding would otherwise open a remote proxy session to Cloudflare (needs
      // credentials, slows every run). Tests inject a fake Markdown converter instead.
      remoteBindings: false,
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
