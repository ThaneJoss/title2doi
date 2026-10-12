import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist');
const read = name => readFile(resolve(output, name), 'utf8');
const names = await readdir(output);
const expected = ['index.html', '404.html', 'styles.css', 'app.mjs', 'core.mjs', 'favicon.svg', 'robots.txt', 'sitemap.xml', '_headers'];
assert.deepEqual([...names].sort(), [...expected].sort(), 'Only the website asset allowlist should be published');
const [html, app, headers, missing, sitemap, robots] = await Promise.all(['index.html', 'app.mjs', '_headers', '404.html', 'sitemap.xml', 'robots.txt'].map(read));
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(ids.length, new Set(ids).size, 'HTML IDs must be unique');
for (const [, id] of app.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(id), `Missing UI element: ${id}`);
for (const [, icon] of html.matchAll(/<use href="#([^"]+)"/g)) assert.ok(ids.includes(icon), `Missing SVG symbol: ${icon}`);
for (const page of [html, missing]) {
  assert.ok(!/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(page), 'Inline scripts are not permitted');
  assert.ok(!/\s(?:style|on\w+)\s*=/i.test(page), 'Inline styles and event handlers violate CSP');
}
assert.match(html, /<script type="module" data-cfasync="false" src="app\.mjs"><\/script>/, 'Cloudflare module entry must be protected from Rocket Loader');
assert.match(html, /rel="canonical" href="https:\/\/title2doi\.thanejoss\.com\/"/);
assert.match(headers, /connect-src[^;]*https:\/\/api\.crossref\.org/);
assert.match(headers, /Content-Type: text\/javascript/);
assert.match(headers, /frame-ancestors 'none'/);
assert.ok(!headers.includes("'unsafe-inline'") && !headers.includes("'unsafe-eval'"));
assert.match(missing, /name="robots" content="noindex"/);
assert.match(missing, /href="\/"/);
assert.match(sitemap, /<loc>https:\/\/title2doi\.thanejoss\.com\/<\/loc>/);
assert.match(robots, /Sitemap: https:\/\/title2doi\.thanejoss\.com\/sitemap\.xml/);
const config = JSON.parse(await readFile(resolve(root, 'wrangler.worker.jsonc'), 'utf8'));
assert.equal(config.assets.directory, './dist');
assert.equal(config.assets.not_found_handling, '404-page');
assert.deepEqual(config.routes, [{ pattern: 'title2doi.thanejoss.com', custom_domain: true }]);
console.log('Verified static assets, UI bindings, canonical domain, CSP, module entry, and 404 configuration.');
