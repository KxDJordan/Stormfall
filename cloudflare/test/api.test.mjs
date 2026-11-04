// Integration tests against a real local Worker (wrangler dev = workerd + Miniflare: local D1, Durable Object, rate limits).
// Starts its own `wrangler dev` with a fresh state directory unless SF_API is set to a running one.
//   node --test test/api.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
let API = process.env.SF_API, proc = null, state = null;
const GH = 'https://kxdjordan.github.io';

before(async () => {
  if (API) return;
  const port = 18000 + Math.floor(Math.random() * 2000);
  state = mkdtempSync(join(tmpdir(), 'sf-wr-'));
  execFileSync('node', ['scripts/build-public.mjs'], { cwd: dir, stdio: 'ignore' });
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'stormfall', '--local', '--persist-to', state], { cwd: dir, stdio: 'ignore' });
  proc = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', state, '--test-scheduled', '--var', 'ALLOW_LOCALHOST:1'], { cwd: dir, stdio: 'ignore', detached: true });
  API = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(API + '/api/health')).ok) return; } catch (_) {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start');
});
after(() => {
  if (proc) { try { process.kill(-proc.pid, 'SIGTERM'); } catch (_) {} }
  if (state) setTimeout(() => rmSync(state, { recursive: true, force: true }), 1500);
});

const post = (p, b, h = {}) => fetch(API + p, { method: 'POST', body: typeof b === 'string' ? b : JSON.stringify(b), headers: h });
const j = async r => ({ s: r.status, b: await r.json(), h: r.headers });
const today = () => new Date().toISOString().slice(0, 10);
const SAVE1 = 'SFS0.' + Buffer.from(JSON.stringify({ sf: 'stormfall-save', v: 1, data: { stormfall_profile: '{"xp":10}' } })).toString('base64');
const SAVE2 = 'SFS0.' + Buffer.from(JSON.stringify({ sf: 'stormfall-save', v: 1, data: { stormfall_profile: '{"xp":99}' } })).toString('base64');
let A, B;

test('static assets are served and the game has the API meta', async () => {
  const r = await fetch(API + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<meta name="sf-api" content="">/);
  assert.equal((await fetch(API + '/vendor/peerjs.min.js')).status, 200);
  assert.equal((await fetch(API + '/nope.txt')).status, 404);
});

test('health + CORS: allowed origins echoed, others refused, preflight cached', async () => {
  let r = await fetch(API + '/api/health', { headers: { Origin: GH } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), GH);
  r = await fetch(API + '/api/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  r = await fetch(API + '/api/save/get', { method: 'OPTIONS', headers: { Origin: GH, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-max-age'), '86400');
  assert.equal((await fetch(API + '/api/nothing')).status, 404);
});

test('create accounts', async () => {
  const a = await j(await post('/api/account', '', { Origin: GH }));
  assert.equal(a.s, 200);
  assert.match(a.b.auth, /^[0-9A-Z]{10}\.[0-9A-Z]{20}$/);
  assert.match(a.b.code, /^([0-9A-Z]{5}-){5}[0-9A-Z]{5}$/);
  assert.equal(a.h.get('access-control-allow-origin'), GH);
  A = a.b;
  B = (await j(await post('/api/account', ''))).b;
  assert.notEqual(A.id, B.id);
});

test('cloud save: empty, push, pull, not-modified, conflict', async () => {
  let r = await j(await post('/api/save/get', { auth: A.auth, have: 0 }));
  assert.deepEqual([r.s, r.b.rev, r.b.data], [200, 0, null]);
  r = await j(await post('/api/save/put', { auth: A.auth, base: 0, data: SAVE1 }));
  assert.equal(r.s, 200); assert.equal(r.b.rev, 1);
  r = await j(await post('/api/save/get', { auth: A.auth, have: 1 }));
  assert.deepEqual([r.b.rev, r.b.data], [1, null], 'no payload when the client is current');
  r = await j(await post('/api/save/get', { auth: A.auth, have: 0 }));
  assert.equal(r.b.data, SAVE1);
  // another device still on rev 0 pushes: conflict, with the cloud copy to compare
  r = await j(await post('/api/save/put', { auth: A.auth, base: 0, data: SAVE2 }));
  assert.equal(r.s, 409); assert.equal(r.b.rev, 1); assert.equal(r.b.data, SAVE1);
  // it chooses to keep its own copy: pushes on top of rev 1
  r = await j(await post('/api/save/put', { auth: A.auth, base: 1, data: SAVE2 }));
  assert.equal(r.s, 200); assert.equal(r.b.rev, 2);
  r = await j(await post('/api/save/get', { auth: A.auth, have: 1 }));
  assert.equal(r.b.data, SAVE2);
});

test('cloud save: bad input is refused', async () => {
  const bad = A.id + '.' + 'X'.repeat(20);
  assert.equal((await post('/api/save/get', { auth: bad, have: 0 })).status, 401);
  assert.equal((await post('/api/save/put', { auth: bad, base: 2, data: SAVE1 })).status, 401);
  assert.equal((await post('/api/save/get', { auth: 'nope' })).status, 401);
  assert.equal((await post('/api/save/put', { auth: A.auth, base: 2, data: '<html>' })).status, 400);
  assert.equal((await post('/api/save/put', { auth: A.auth, base: -1, data: SAVE1 })).status, 400);
  assert.equal((await post('/api/save/put', { auth: A.auth, base: 2, data: 'SFS1.' + 'A'.repeat(80000) })).status, 413);
  assert.equal((await post('/api/save/get', 'not json')).status, 400);
  assert.equal((await post('/api/save/get', '[1,2]')).status, 400);
});

test('daily leaderboard: submit, one per day, rank, top 50, cache', async () => {
  const day = today();
  const res = { day, of: 8, place: 4, win: false, kills: 1, dmg: 80, rounds: 10, name: 'alpha', cls: 'ranger' };
  let r = await j(await post('/api/daily/submit', { ...res, auth: A.auth }));
  assert.equal(r.s, 200);
  const sA = Math.round(4 / 7 * 1000) + 200 + 800 + 250;
  assert.deepEqual([r.b.dup, r.b.score, r.b.rank, r.b.total], [false, sA, 1, 1]);
  // a second (better) submission the same day is ignored: the first attempt counts
  r = await j(await post('/api/daily/submit', { ...res, place: 1, win: true, auth: A.auth }));
  assert.deepEqual([r.b.dup, r.b.score], [true, sA]);
  let top = await j(await fetch(API + '/api/daily/top?day=' + day));
  assert.equal(top.h.get('x-cache'), 'MISS');
  assert.equal(top.b.top.length, 1);
  top = await j(await fetch(API + '/api/daily/top?day=' + day));
  assert.notEqual(top.h.get('x-cache'), 'MISS', 'second read is served from cache');
  assert.match(top.h.get('cache-control'), /max-age=60/);
  // B beats A
  r = await j(await post('/api/daily/submit', { ...res, place: 1, win: true, kills: 5, auth: B.auth, name: 'bravo' }));
  assert.deepEqual([r.b.rank, r.b.total], [1, 2]);
  top = await j(await fetch(API + '/api/daily/top?day=' + day));
  assert.deepEqual(top.b.top.map(x => x.n), ['BRAVO', 'ALPHA'], 'a new score clears this isolate\'s cache');
  assert.equal(top.b.total, 2);
  assert.equal(top.b.top[0].t, B.id.slice(0, 6));
  assert.ok(!JSON.stringify(top.b).includes(B.id), 'full account ids are never published');
  r = await j(await post('/api/daily/me', { auth: A.auth, day }));
  assert.deepEqual([r.b.rank, r.b.total, r.b.score], [2, 2, sA]);
  r = await j(await post('/api/daily/me', { auth: A.auth, day: '2020-01-01' }));
  assert.equal(r.b.none, true);
});

test('daily leaderboard: implausible, closed days and bad auth are refused', async () => {
  const day = today();
  const ok = { day, of: 8, place: 2, kills: 1, dmg: 80, rounds: 10, auth: A.auth };
  assert.equal((await post('/api/daily/submit', { ...ok, kills: 30 })).status, 400);
  assert.equal((await post('/api/daily/submit', { ...ok, dmg: 1e9 })).status, 400);
  assert.equal((await post('/api/daily/submit', { ...ok, day: '2020-01-01' })).status, 400);
  assert.equal((await post('/api/daily/submit', { ...ok, auth: B.id + '.' + 'Z'.repeat(20) })).status, 401);
  assert.equal((await fetch(API + '/api/daily/top?day=2020-01-01')).status, 404);
  assert.equal((await fetch(API + '/api/daily/top?day=x')).status, 400);
});

test('turn: no secrets configured -> library defaults', async () => {
  const r = await j(await fetch(API + '/api/turn'));
  assert.deepEqual([r.s, r.b.iceServers, r.b.turn], [200, null, false]);
});

// ---- PeerJS signaling through the Durable Object ----
const wsUrl = q => API.replace(/^http/, 'ws') + '/api/peerjs?' + new URLSearchParams(q);
function sock(q) {
  const ws = new WebSocket(wsUrl(q)), msgs = [], waiters = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); msgs.push(m); for (const w of waiters.splice(0)) w(); };
  const next = (pred, ms = 5000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting for message, got ' + JSON.stringify(msgs))), ms);
    const check = () => { const i = msgs.findIndex(pred); if (i >= 0) { clearTimeout(t); res(msgs.splice(i, 1)[0]); } else waiters.push(check); };
    check();
  });
  const closed = new Promise(r => { ws.onclose = r; });
  return { ws, next, closed, send: o => ws.send(typeof o === 'string' ? o : JSON.stringify(o)) };
}

test('signaling: ids, OPEN, ID-TAKEN, relay, EXPIRE, heartbeat, bad key', async () => {
  const id = await (await fetch(API + '/api/peerjs/id?ts=1&version=1.5.5')).text();
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal((await fetch(API + '/api/peerjs/peers')).status, 401);

  const host = sock({ key: 'peerjs', id: 'stormfall-tst01', token: 'tokA', version: '1.5.5' });
  assert.equal((await host.next(m => true)).type, 'OPEN');
  // a second host trying the same room code is refused (room codes stay unique)
  const dupe = sock({ key: 'peerjs', id: 'stormfall-tst01', token: 'tokX', version: '1.5.5' });
  assert.equal((await dupe.next(m => true)).type, 'ID-TAKEN');
  await dupe.closed;
  const guest = sock({ key: 'peerjs', id, token: 'tokB', version: '1.5.5' });
  assert.equal((await guest.next(m => true)).type, 'OPEN');

  guest.send({ type: 'OFFER', dst: 'stormfall-tst01', payload: { sdp: 'x', connectionId: 'dc_1', type: 'data' } });
  const off = await host.next(m => m.type === 'OFFER');
  assert.deepEqual([off.src, off.dst, off.payload.sdp], [id, 'stormfall-tst01', 'x']);
  host.send({ type: 'ANSWER', dst: id, payload: { sdp: 'y', connectionId: 'dc_1' } });
  assert.equal((await guest.next(m => m.type === 'ANSWER')).src, 'stormfall-tst01');
  host.send({ type: 'CANDIDATE', dst: id, payload: { candidate: 'c', connectionId: 'dc_1' } });
  assert.equal((await guest.next(m => m.type === 'CANDIDATE')).payload.candidate, 'c');

  // no such room: EXPIRE back to the sender (PeerJS: 'peer-unavailable')
  guest.send({ type: 'OFFER', dst: 'stormfall-zzzzz', payload: { sdp: 'x', connectionId: 'dc_2' } });
  const ex = await guest.next(m => m.type === 'EXPIRE');
  assert.equal(ex.src, 'stormfall-zzzzz');

  // heartbeats are answered by the runtime (auto-response), without waking the object
  guest.send('{"type":"HEARTBEAT"}');
  await guest.next(m => m.type === 'HEARTBEAT');

  // the same peer reconnecting with its token replaces its old socket
  const again = sock({ key: 'peerjs', id: 'stormfall-tst01', token: 'tokA', version: '1.5.5' });
  assert.equal((await again.next(m => true)).type, 'OPEN');
  await host.closed;
  guest.send({ type: 'CANDIDATE', dst: 'stormfall-tst01', payload: { candidate: 'd', connectionId: 'dc_1' } });
  assert.equal((await again.next(m => m.type === 'CANDIDATE')).payload.candidate, 'd');

  const bad = sock({ key: 'other', id: 'abc', token: 't', version: '1.5.5' });
  assert.equal((await bad.next(m => true)).type, 'INVALID-KEY');
  const none = sock({ key: 'peerjs', version: '1.5.5' });
  assert.equal((await none.next(m => true)).type, 'ERROR');
  for (const s of [guest, again]) s.ws.close();
});

test('scheduled housekeeping runs', async () => {
  const r = await fetch(API + '/__scheduled?cron=17+4+*+*+*');
  assert.equal(r.status, 200);
  // A and B have saves or scores; the cleanup only drops never-saved accounts older than 7 days
  assert.equal((await post('/api/save/get', { auth: A.auth, have: 2 })).status, 200);
});

test('rate limit: account creation is limited per IP (429 + Retry-After)', async () => {
  let r;
  for (let i = 0; i < 12; i++) { r = await post('/api/account', ''); if (r.status === 429) break; }
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '60');
});
