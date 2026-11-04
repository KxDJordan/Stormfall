// Builds cloudflare/public (the static assets the Worker serves) from the game files at the repo root:
// index.html, manifest.json, vendor/, assets/. The game stays one index.html; the only change is the API base meta:
//   <meta name="sf-api" content="...">   ""  = same origin (the default on Cloudflare), "off" = no backend, or a URL.
// usage: node scripts/build-public.mjs [--api <base>]     (or SF_API_BASE=<base>)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '..', '..'), out = join(here, '..', 'public');
const ai = process.argv.indexOf('--api');
const api = ai > 0 ? process.argv[ai + 1] || '' : process.env.SF_API_BASE || '';
if (!/^(|off|https?:\/\/[^\s"<>]+)$/.test(api)) { console.error('bad --api value'); process.exit(1); }

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let html = readFileSync(join(root, 'index.html'), 'utf8');
const re = /<meta name="sf-api" content="[^"]*">/;
if (!re.test(html)) { console.error('index.html has no <meta name="sf-api"> tag'); process.exit(1); }
html = html.replace(re, `<meta name="sf-api" content="${api}">`);
writeFileSync(join(out, 'index.html'), html);
for (const f of ['manifest.json']) cpSync(join(root, f), join(out, f));
for (const d of ['vendor', 'assets']) if (existsSync(join(root, d))) cpSync(join(root, d), join(out, d), { recursive: true });
// index.html changes on every deploy: make browsers revalidate it (cheap 304s from the assets layer, no Worker)
writeFileSync(join(out, '_headers'), '/\n  Cache-Control: no-cache\n/index.html\n  Cache-Control: no-cache\n');
console.log(`public/ built (api base: ${api || 'same origin'})`);
