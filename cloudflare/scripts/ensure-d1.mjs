// CI helper: makes sure the D1 database exists and writes its id into wrangler.jsonc (so nobody edits ids by hand).
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment. usage: node scripts/ensure-d1.mjs [name]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..'), cfg = join(dir, 'wrangler.jsonc');
const name = process.argv[2] || 'stormfall';
const wr = (...a) => execFileSync('npx', ['wrangler', ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
// wrangler prints a banner/warnings before the JSON on some versions: take the outermost JSON array
const parse = t => JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
const find = () => parse(wr('d1', 'list', '--json')).find(d => d.name === name);

let db = find();
if (!db) {
  console.log(`D1 database "${name}" not found: creating it`);
  wr('d1', 'create', name);
  db = find();
}
const id = db && (db.uuid || db.id || db.database_id);
if (!id || !/^[0-9a-f-]{36}$/i.test(id)) { console.error('could not find the D1 database id'); process.exit(1); }
const src = readFileSync(cfg, 'utf8');
const next = src.replace(/("database_name":\s*"[^"]*",\s*"database_id":\s*")[^"]*(")/g, `$1${id}$2`);
writeFileSync(cfg, next);
console.log(`D1 "${name}" id ${id} written to wrangler.jsonc`);
