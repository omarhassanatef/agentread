import { createApp } from "./api/app.js";

const app = createApp();

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Cloudflare.Env>;
