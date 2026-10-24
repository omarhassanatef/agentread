import { createApp } from "./api/app.js";

export { FreeQuota } from "./payments/free-tier.js";

const app = createApp();

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Cloudflare.Env>;
