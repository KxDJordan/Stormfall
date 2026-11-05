// Shared setup for the ranked & battalion API tests: a local Worker (wrangler dev) with a fresh state directory and short
// ranked timers (RANKED_WAIT=1 s queue wait, RANKED_GRACE=3 s report grace), unless SF_API points at a running one
// (start it with --var RANKED_WAIT:1 --var RANKED_GRACE:3).
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const env = { API: process.env.SF_API || '' };
let proc = null, state = null;
const socks = [];

export function setup() {
  before(async () => {
    if (env.API) return;
    const port = 22000 + Math.floor(Math.random() * 2000);
    state = mkdtempSync(join(tmpdir(), 'sf-wr-'));
    execFileSync('node', ['scripts/build-public.mjs'], { cwd: dir, stdio: 'ignore' });
    execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'stormfall', '--local', '--persist-to', state], { cwd: dir, stdio: 'ignore' });
    proc = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', state, '--test-scheduled',
      '--var', 'ALLOW_LOCALHOST:1', '--var', 'RANKED_WAIT:1', '--var', 'RANKED_GRACE:3'], { cwd: dir, stdio: 'ignore', detached: true });
    env.API = 'http://127.0.0.1:' + port;
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(env.API + '/api/health')).ok) return; } catch (_) {}
      await sleep(500);
    }
    throw new Error('wrangler dev did not start');
  });
  after(() => {
    for (const s of socks) { try { s.ws.close(); } catch (_) {} }
    if (proc) { try { process.kill(-proc.pid, 'SIGTERM'); } catch (_) {} }
    if (state) setTimeout(() => rmSync(state, { recursive: true, force: true }), 1500);
  });
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const post = (p, b) => fetch(env.API + p, { method: 'POST', body: JSON.stringify(b) });
export const get = p => fetch(env.API + p);
export const j = async r => ({ s: r.status, b: await r.json(), h: r.headers });
export const P = async (p, b) => j(await post(p, b));

/** a new account with a public profile (friend code); waits out the 5-per-minute account limit when it hits it */
export async function mkUser(name, lv = 5) {
  let a;
  for (let i = 0; i < 4; i++) {
    const r = await post('/api/account', {});
    if (r.status === 429) { await sleep(61000); continue; }
    a = await r.json(); break;
  }
  assert.ok(a && a.auth, 'account created');
  const r = await P('/api/social/me', { auth: a.auth, name, lv, cls: 'ranger', title: '', banner: 'bn_std' });
  assert.equal(r.s, 200);
  return Object.assign(a, { code: r.b.code, name: name.toUpperCase() });
}

/** a WebSocket with a message queue: next(pred) waits for (and removes) the first matching message */
export function sock(path) {
  const ws = new WebSocket(env.API.replace(/^http/, 'ws') + path), msgs = [], waiters = [];
  ws.onmessage = e => { msgs.push(JSON.parse(e.data)); for (const w of waiters.splice(0)) w(); };
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const closed = new Promise(r => { ws.onclose = e => r(e); });
  const next = (pred, ms = 8000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout; got ' + JSON.stringify(msgs))), ms);
    const check = () => { const i = msgs.findIndex(pred); if (i >= 0) { clearTimeout(t); res(msgs.splice(i, 1)[0]); } else waiters.push(check); };
    check();
  });
  const s = { ws, msgs, next, opened, closed, send: o => ws.send(typeof o === 'string' ? o : JSON.stringify(o)) };
  socks.push(s);
  return s;
}
