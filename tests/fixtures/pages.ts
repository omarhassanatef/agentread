/** Controlled HTML fixtures. Tests never fetch real websites. */

export const ARTICLE_HTML = `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <title>How Tide Pools Work | Ocean Notes</title>
  <meta name="description" content="A field guide to the ecology of rocky tide pools.">
  <meta property="og:site_name" content="Ocean Notes">
  <meta name="author" content="Sam Rivera">
  <meta property="article:published_time" content="2026-03-14T09:00:00Z">
  <link rel="canonical" href="/guides/tide-pools">
  <style>body { font-family: serif; }</style>
  <script>window.analytics = { track() {} };</script>
</head>
<body>
  <div id="cookie-banner" class="cookie-consent">We use cookies to improve your experience. <button>Accept all</button></div>
  <header class="site-header">
    <a href="/">Ocean Notes</a>
    <nav><ul><li><a href="/about">About</a></li><li><a href="/guides">Guides</a></li><li><a href="/shop">Shop</a></li></ul></nav>
  </header>
  <div class="ad-slot">BUY OCEAN SNACKS NOW — 50% OFF</div>
  <main>
    <article>
      <h1>How Tide Pools Work</h1>
      <p class="byline">By Sam Rivera</p>
      <p>Tide pools are shallow basins of seawater that remain on rocky shores when the tide goes out. They are among the most
      accessible marine habitats, yet they host a remarkable diversity of life adapted to dramatic daily changes in temperature,
      salinity and oxygen.</p>
      <h2>Zones of the intertidal</h2>
      <p>Ecologists divide the shore into zones based on how long each area is exposed to air. Organisms in the
      <a href="/glossary#splash-zone">splash zone</a> tolerate long dry periods, while those in the low zone are submerged most of the day.</p>
      <ul>
        <li>Splash zone: barnacles and periwinkle snails</li>
        <li>High zone: limpets and rockweed</li>
        <li>Low zone: sea stars, anemones and kelp</li>
      </ul>
      <h2>Measured conditions</h2>
      <table>
        <thead><tr><th>Zone</th><th>Exposure (h/day)</th><th>Max temp (°C)</th></tr></thead>
        <tbody>
          <tr><td>High</td><td>18</td><td>32</td></tr>
          <tr><td>Low</td><td>3</td><td>19</td></tr>
        </tbody>
      </table>
      <h3>Field tips</h3>
      <p>Visit at low tide, step only on bare rock, and never remove animals. Read the
      <a href="https://example.org/tide-tables">official tide tables</a> before you go. Avoid <a href="javascript:alert(1)">this fake link</a>.</p>
      <p><img src="/img/anemone.jpg" alt="Green anemone"></p>
      <pre><code>low_tide = min(heights)</code></pre>
    </article>
  </main>
  <aside class="sidebar"><h4>Related</h4><a href="/guides/kelp">Kelp forests</a></aside>
  <div class="newsletter-signup"><h3>Subscribe to our newsletter</h3><input type="email"></div>
  <footer class="site-footer">© 2026 Ocean Notes · <a href="/privacy">Privacy</a></footer>
  <script src="/app.js"></script>
</body>
</html>`;

export const DOCS_HTML = `<!doctype html>
<html lang="en">
<head><title>Configuration — Widget SDK Docs</title><meta name="description" content="Configure the Widget SDK."></head>
<body>
  <nav class="docs-sidebar">
    <a href="/docs/intro">Introduction</a><a href="/docs/install">Install</a><a href="/docs/config">Configuration</a>
    <a href="/docs/api">API</a><a href="/docs/faq">FAQ</a><a href="/docs/changelog">Changelog</a>
  </nav>
  <div role="main" class="content">
    <h1>Configuration</h1>
    <p>The Widget SDK reads its configuration from a <code>widget.config.json</code> file in your project root. Every option
    has a sensible default, so most projects only need to set an API key and a region.</p>
    <h2>Options</h2>
    <table>
      <tr><th>Option</th><th>Type</th><th>Default</th></tr>
      <tr><td>apiKey</td><td>string</td><td>—</td></tr>
      <tr><td>region</td><td>string</td><td>us</td></tr>
      <tr><td>retries</td><td>number</td><td>3</td></tr>
    </table>
    <h2>Example</h2>
    <pre><code class="language-json">{ "apiKey": "abc", "region": "eu" }</code></pre>
    <h3>Environment variables</h3>
    <p>Options can also be supplied through environment variables prefixed with <code>WIDGET_</code>. Environment variables
    override values from the configuration file, which makes them useful for CI pipelines and containers.</p>
    <p>See the <a href="../api#client">API reference</a> for the full list.</p>
  </div>
  <footer>Docs footer · <a href="/docs/edit">Edit this page</a></footer>
</body>
</html>`;

export const NO_META_HTML = `<html><body>
  <div><div>
    <p>This page has no title element and no meta description at all. It still contains enough plain paragraph text that an
    extractor should be able to return it as readable Markdown without inventing a title or a description for it.</p>
    <p>A second paragraph adds a little more substance so the content clears the minimum length threshold comfortably.</p>
  </div></div>
</body></html>`;

export const MALFORMED_HTML = `<html><head><title>Broken & <b>Bold</title>
<body><div><p>First paragraph with an <b>unclosed bold tag and <i>nested italics
<p>Second paragraph begins without closing the first one, which browsers and parsers have to recover from gracefully.
<div><span>Stray span</div></span>
<ul><li>item one<li>item two<li>item three</ul>
<p>Final paragraph of the malformed document, long enough to be considered content by the extraction pipeline overall.
</body>`;

export const SPA_HTML = `<!doctype html>
<html><head><title>Dashboard</title>
<script src="/static/runtime.js"></script><script src="/static/vendor.js"></script><script src="/static/main.js"></script>
</head>
<body>
  <noscript>You need to enable JavaScript to run this app.</noscript>
  <div id="root"></div>
</body></html>`;

export const EMPTY_BODY_HTML = `<!doctype html><html><head><title>Nothing here</title></head><body>   </body></html>`;

/** A long article used for truncation tests. */
export function longArticle(paragraphs: number): string {
  const ps = Array.from(
    { length: paragraphs },
    (_, i) => `<p>Paragraph ${i + 1}. ${"The quick brown fox jumps over the lazy dog. ".repeat(6)}</p>`,
  ).join("\n");
  return `<!doctype html><html><head><title>Long read</title></head><body><article><h1>Long read</h1>${ps}</article></body></html>`;
}

/** Patterns seen on real sites that Readability mishandles without normalisation. */
export const WIKI_STYLE_HTML = `<!doctype html><html lang="en"><head><title>Kelp - Encyclopedia</title></head><body>
<main><div id="content"><div class="mw-body-content">
<p>Kelps are large brown algae that live in cool, relatively shallow waters close to the shore. They grow in dense collections
called kelp forests, which are among the most productive ecosystems on Earth and provide habitat for many species.</p>
<div class="mw-heading mw-heading2"><h2 id="Growth">Growth</h2><span class="mw-editsection">[<a href="/edit?section=1">edit</a>]</span></div>
<p>Kelp can grow up to half a metre a day under ideal conditions, anchored to the seabed by a root-like holdfast. Gas-filled
bladders keep the blades near the surface where light is plentiful, allowing photosynthesis to proceed rapidly.</p>
<div class="mw-heading mw-heading3"><h3 id="Light">Light&#8203;</h3><span class="mw-editsection">[<a href="/edit?section=2">edit</a>]</span></div>
<p>Light availability limits the depth at which kelp can grow, typically to about twenty metres in clear water, and less in
turbid coastal waters where suspended sediment absorbs and scatters sunlight before it reaches the blades.</p>
</div></div></main></body></html>`;

export const HEADER_INTRO_HTML = `<!doctype html><html lang="en"><head><title>418 I'm a teapot - Ref</title></head><body>
<main id="content">
  <div class="layout__header page-header"><h1>418 I'm a teapot</h1>
    <section><p>The HTTP 418 status code indicates that the server refuses to brew coffee because it is, permanently, a teapot.
    This introductory paragraph is the most important part of the page and must survive extraction.</p></section>
  </div>
  <aside class="toc"><a href="#status">Status</a></aside>
  <div class="layout__body">
    <section><h2 id="status">Status</h2><pre><code>418 I'm a teapot</code></pre>
    <p>Some websites use this response for requests they do not wish to handle, such as automated queries, which is a
    lighthearted and non-standard use of an otherwise joke status code defined in an April Fools' RFC.</p></section>
    <section><h2>Specifications</h2><p>The status code is defined in RFC 2324 section 2.3.2 and was later reserved by RFC 9110
    so that it cannot be assigned to another meaning by future specifications.</p></section>
  </div>
</main></body></html>`;

export const CARD_LINKS_HTML = `<!doctype html><html><head><title>Blog</title></head><body><main>
<article><a href="/posts/one"><h2>First post title</h2></a><p>Summary of the first post with enough words to be counted as real
content by the extraction pipeline, describing what the article covers in detail.</p></article>
<article><a href="/posts/two"><h2>Second post title</h2></a><p>Summary of the second post with enough words to be counted as
real content by the extraction pipeline, describing what the article covers in detail.</p></article>
</main></body></html>`;
