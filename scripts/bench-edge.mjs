#!/usr/bin/env node
// Edge benchmark: calls the temporary agentread-bench Worker (src/bench.ts) for both engines
// on real pages. On the Workers Free plan a CPU-limit kill shows up as HTTP 503 / error 1102.
//   BENCH_URL=https://agentread-bench.<sub>.workers.dev BENCH_TOKEN=… node scripts/bench-edge.mjs
// BENCH_TARGETS="lite=https://…,readability=https://…,raw=https://…" (one Worker per mode), or BENCH_URL for one.
const TARGETS = (process.env.BENCH_TARGETS ?? `lite=${process.env.BENCH_URL},readability=${process.env.BENCH_URL}`)
  .split(",").map((t) => t.split("=")).map(([engine, base]) => ({ engine, base }));
const TOKEN = process.env.BENCH_TOKEN;
const REPEAT = Number(process.env.BENCH_REPEAT ?? 3);
const PAGES = (process.env.BENCH_PAGES ?? [
  "https://example.com/",
  "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/402",
  "https://en.wikipedia.org/wiki/Tide_pool",
  "https://hono.dev/docs/getting-started/cloudflare-workers",
  "https://blog.cloudflare.com/",
  "https://github.com/coinbase/x402",
  "https://news.ycombinator.com/",
  "https://en.wikipedia.org/wiki/Pacific_Ocean",
].join(",")).split(",");

const rows = [];
const previews = {};
for (const page of PAGES) {
  for (const { engine, base } of TARGETS) {
    for (let i = 0; i < REPEAT; i++) {
      const t0 = Date.now();
      let status = 0, body = {}, raw = "";
      try {
        const res = await fetch(`${base}/?engine=${engine}&url=${encodeURIComponent(page)}${process.env.BENCH_SELECTOR ? `&selector=${encodeURIComponent(process.env.BENCH_SELECTOR)}` : ""}`, { headers: { "x-bench-token": TOKEN } });
        status = res.status;
        raw = await res.text();
        try { body = JSON.parse(raw); } catch { body = { error: { code: /1102|exceeded/i.test(raw) ? "CPU_LIMIT_1102" : `non-json(${raw.slice(0, 80).replace(/\s+/g, " ")})` } }; }
      } catch (e) { body = { error: { code: `fetch-failed ${e}` } }; }
      rows.push({ page: page.replace(/^https:\/\//, "").slice(0, 48), engine, try: i + 1, status, ok: status === 200, code: body.error?.code ?? "", bytes: body.bytes ?? "", chars: body.chars ?? "", headings: body.headings ?? "", wallMs: body.wallMs ?? "", rttMs: Date.now() - t0 });
      if (status === 200 && i === 0) previews[`${engine} ${page}`] = body.markdown;
    }
  }
}
console.table(rows);
const summary = {};
for (const r of rows) {
  const k = r.engine;
  summary[k] ??= { ok: 0, fail: 0, failures: {} };
  if (r.ok) summary[k].ok++; else { summary[k].fail++; summary[k].failures[r.code || r.status] = (summary[k].failures[r.code || r.status] ?? 0) + 1; }
}
console.log("SUMMARY", JSON.stringify(summary));
for (const [k, md] of Object.entries(previews)) {
  console.log(`\n===== ${k} (${md.length} chars)\n${md.slice(0, Number(process.env.BENCH_PREVIEW ?? 1200))}`);
}
