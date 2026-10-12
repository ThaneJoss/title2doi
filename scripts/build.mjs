import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist');
// Publish only website assets, never the repository, tests, or deployment config.
const assets = ['index.html', '404.html', 'styles.css', 'app.mjs', 'core.mjs', 'favicon.svg', 'robots.txt', 'sitemap.xml', '_headers'];
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const asset of assets) await cp(resolve(root, asset), resolve(output, asset));
console.log(`Built ${assets.length} static files into dist/`);
