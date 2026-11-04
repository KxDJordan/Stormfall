// Socials against a real local Worker (wrangler dev: local D1 + the Signal Durable Object with the presence sockets).
// Starts its own `wrangler dev` with a fresh state directory unless SF_API is set to a running one.
//   node --test test/social.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
let API = process.env.SF_API, proc = null, state = null;

before(async () => {
  if (API) return;
  const port = 20000 + Math.floor(Math.random() * 2000);
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
  for (const s of socks) { try { s.ws.close(); } catch (_) {} }
  if (proc) { try { process.kill(-proc.pid, 'SIGTERM'); } catch (_) {} }
  if (state) setTimeout(() => rmSync(state, { recursive: true, force: true }), 1500);
});

const post = (p, b) => fetch(API + p, { method: 'POST', body: JSON.stringify(b) });
const j = async r => ({ s: r.status, b: await r.json() });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const socks = [];
/** a presence socket with a message queue: next(pred) waits for (and removes) the first matching message */
function sock(code) {
  const ws = new WebSocket(API.replace(/^http/, 'ws') + '/api/social/ws?c=' + code), msgs = [], waiters = [];
  ws.onmessage = e => { msgs.push(JSON.parse(e.data)); for (const w of waiters.splice(0)) w(); };
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const closed = new Promise(r => { ws.onclose = e => r(e); });
  const next = (pred, ms = 5000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout; got ' + JSON.stringify(msgs))), ms);
    const check = () => { const i = msgs.findIndex(pred); if (i >= 0) { clearTimeout(t); res(msgs.splice(i, 1)[0]); } else waiters.push(check); };
    check();
  });
  const none = async (pred, ms = 600) => { await sleep(ms); assert.ok(!msgs.some(pred), 'unexpected message: ' + JSON.stringify(msgs.filter(pred))); };
  const s = { ws, msgs, next, none, opened, closed, send: o => ws.send(typeof o === 'string' ? o : JSON.stringify(o)) };
  socks.push(s);
  return s;
}
async function online(acc, st = { s: 'menu' }) {
  const s = sock(acc.code); await s.opened;
  s.send(Object.assign({ t: 'auth', auth: acc.auth }, st));
  s.hi = await s.next(m => m.t === 'hi');
  return s;
}
const U = {};
async function mk(name, lv) {
  const a = (await j(await post('/api/account', {}))).b;
  const r = await j(await post('/api/social/me', { auth: a.auth, name, lv, cls: 'ranger', title: 't_rookie', banner: 'bn_std' }));
  assert.equal(r.s, 200);
  return Object.assign(a, { code: r.b.code, name });
}
const list = async a => (await j(await post('/api/social/list', { auth: a.auth }))).b;
const add = (a, code) => post('/api/social/add', { auth: a.auth, code });
const act = (a, code, x) => post('/api/social/act', { auth: a.auth, code, a: x });

test('profiles: friend codes are 8 chars, stable, distinct, never the account code', async () => {
  for (const [k, lv] of [['ALPHA', 12], ['BRAVO', 7], ['CHARLIE', 3], ['DELTA', 1]]) U[k] = await mk(k.toLowerCase(), lv);
  const codes = Object.values(U).map(u => u.code);
  for (const c of codes) assert.match(c, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(new Set(codes).size, 4);
  for (const u of Object.values(U)) assert.ok(!u.auth.includes(u.code) && !u.id.includes(u.code));
  // publishing again keeps the code and updates the fields; junk is cleaned
  const r = await j(await post('/api/social/me', { auth: U.ALPHA.auth, name: 'alpha<script>', lv: 13, cls: 'Bad Class', title: '../x', banner: 'bn_gold' }));
  assert.deepEqual([r.s, r.b.code], [200, U.ALPHA.code]);
  const l = await list(U.ALPHA);
  assert.deepEqual([l.code, l.friends.length, l.inc.length, l.out.length], [U.ALPHA.code, 0, 0, 0]);
  assert.equal((await post('/api/social/me', { auth: U.ALPHA.id + '.' + 'Z'.repeat(20) })).status, 401);
  assert.equal((await post('/api/social/list', { auth: 'nope' })).status, 401);
});

test('presence socket: auth by first message, wrong account refused, heartbeat auto-response', async () => {
  const bad = sock(U.ALPHA.code); await bad.opened;
  bad.send({ t: 'auth', auth: U.BRAVO.auth }); // B's secret, A's code
  assert.equal((await bad.next(m => m.t === 'err')).e, 'auth');
  assert.equal((await bad.closed).code, 4001);
  const junk = sock(U.ALPHA.code); await junk.opened;
  junk.send({ t: 'st', s: 'lobby', r: 'ABCDE' }); // ignored before auth
  junk.send('{"type":"HEARTBEAT"}');
  assert.equal((await junk.next(m => m.type === 'HEARTBEAT')).type, 'HEARTBEAT');
  junk.ws.close();
  assert.equal((await fetch(API + '/api/social/ws?c=' + U.ALPHA.code)).status, 426);
  const nope = sock('nope'); // bad friend code: refused before the Durable Object (400, no upgrade)
  await assert.rejects(nope.opened);
});

test('requests: add by code (any format), live notice, accept, presence both ways', async () => {
  const A = await online(U.ALPHA), B = await online(U.BRAVO);
  assert.deepEqual(A.hi, { t: 'hi', c: U.ALPHA.code, on: {}, inv: [] });
  const typed = U.BRAVO.code.toLowerCase().replace(/^(.{4})/, '$1-');
  let r = await j(await add(U.ALPHA, typed));
  assert.deepEqual([r.s, r.b.st, r.b.code], [200, 'o', U.BRAVO.code]);
  await B.next(m => m.t === 'fx');
  let lb = await list(U.BRAVO), la = await list(U.ALPHA);
  assert.deepEqual(lb.inc.map(x => [x.c, x.n, x.lv, x.cls]), [[U.ALPHA.code, 'ALPHASCRIPT', 13, '']]);
  assert.equal(lb.inc[0].bn, 'bn_gold');
  assert.equal(lb.inc[0].seen, undefined, 'last seen is only shown to friends');
  assert.deepEqual(la.out.map(x => x.c), [U.BRAVO.code]);
  // not friends yet: no presence leaks
  B.send({ t: 'st', s: 'lobby', r: 'ABCDE', m: 'duos', o: 1 });
  await A.none(m => m.t === 'p');
  r = await j(await act(U.BRAVO, U.ALPHA.code, 'accept'));
  assert.deepEqual([r.s, r.b.st], [200, 'f']);
  await A.next(m => m.t === 'fx');
  assert.deepEqual(await A.next(m => m.t === 'p'), { t: 'p', c: U.BRAVO.code, s: 'lobby', m: 'duos', r: 'ABCDE' });
  assert.deepEqual(await B.next(m => m.t === 'p'), { t: 'p', c: U.ALPHA.code, s: 'menu' });
  la = await list(U.ALPHA);
  assert.deepEqual(la.friends.map(x => x.c), [U.BRAVO.code]);
  assert.equal(la.out.length, 0);
  // transitions only: the room code is shown only while friends may join; a repeated state sends nothing
  B.send({ t: 'st', s: 'lobby', r: 'ABCDE', m: 'duos', o: 0 });
  assert.deepEqual(await A.next(m => m.t === 'p'), { t: 'p', c: U.BRAVO.code, s: 'lobby', m: 'duos' });
  B.send({ t: 'st', s: 'lobby', r: 'ABCDE', m: 'duos', o: 0 });
  await A.none(m => m.t === 'p');
  B.send({ t: 'st', s: 'match' });
  assert.deepEqual(await A.next(m => m.t === 'p'), { t: 'p', c: U.BRAVO.code, s: 'match' });
  // a new socket sees online friends in its hello
  const A2 = await online(U.ALPHA);
  assert.deepEqual(A2.hi.on, { [U.BRAVO.code]: { s: 'match' } });
  A2.ws.close();
  await sleep(300);
  await B.none(m => m.t === 'p' && m.s === 'off'); // A is still online in another tab
  U.A = A; U.B = B;
});

test('invites: live delivery, decline, only friends, only for your own open room', async () => {
  const { A, B } = U;
  B.send({ t: 'st', s: 'lobby', r: 'KQRST', m: 'quick', o: 1 });
  await A.next(m => m.t === 'p' && m.r === 'KQRST');
  B.send({ t: 'inv', to: U.ALPHA.code, r: 'KQRST', m: 'quick' });
  const inv = await A.next(m => m.t === 'inv');
  assert.deepEqual([inv.c, inv.n, inv.r, inv.m], [U.BRAVO.code, 'BRAVO', 'KQRST', 'quick']);
  assert.ok(inv.exp > Date.now() + 4 * 60000 && inv.exp <= Date.now() + 5 * 60000 + 1000);
  assert.equal((await B.next(m => m.t === 'invd')).live, 1);
  A.send({ t: 'dec', c: U.BRAVO.code, r: 'KQRST' });
  assert.deepEqual(await B.next(m => m.t === 'invn'), { t: 'invn', c: U.ALPHA.code, r: 'KQRST' });
  B.send({ t: 'inv', to: U.CHARLIE.code, r: 'KQRST', m: 'quick' });
  assert.equal((await B.next(m => m.t === 'err')).e, 'notfriend');
  B.send({ t: 'inv', to: U.ALPHA.code, r: 'ZZZZZ', m: 'quick' });
  assert.equal((await B.next(m => m.t === 'err')).e, 'room');
});

test('offline invites: stored briefly, delivered on connect while the room is open, void once it closes', async () => {
  const { B } = U;
  // C asks B, B accepts by adding C back (mutual add = accept)
  assert.equal((await j(await add(U.CHARLIE, U.BRAVO.code))).b.st, 'o');
  await B.next(m => m.t === 'fx');
  assert.equal((await j(await add(U.BRAVO, U.CHARLIE.code))).b.st, 'f');
  await B.next(m => m.t === 'fx');
  B.send({ t: 'inv', to: U.CHARLIE.code, r: 'KQRST', m: 'quick' });
  assert.equal((await B.next(m => m.t === 'invd')).live, 0);
  const C = await online(U.CHARLIE);
  assert.deepEqual(C.hi.inv.map(x => [x.c, x.n, x.r, x.m]), [[U.BRAVO.code, 'BRAVO', 'KQRST', 'quick']]);
  assert.deepEqual(C.hi.on[U.BRAVO.code], { s: 'lobby', m: 'quick', r: 'KQRST' });
  C.ws.close(); await C.closed;
  await B.next(m => m.t === 'p' && m.c === U.CHARLIE.code && m.s === 'off');
  // stored again, then the room starts its match: the invite is void
  B.send({ t: 'inv', to: U.CHARLIE.code, r: 'KQRST', m: 'quick' });
  assert.equal((await B.next(m => m.t === 'invd')).live, 0);
  B.send({ t: 'st', s: 'match' });
  await U.A.next(m => m.t === 'p' && m.s === 'match');
  const C2 = await online(U.CHARLIE);
  assert.deepEqual(C2.hi.inv, []);
  C2.ws.close(); await C2.closed;
  await B.next(m => m.t === 'p' && m.c === U.CHARLIE.code && m.s === 'off');
});

test('offline + last seen: closing the last socket tells friends and records last seen', async () => {
  const { A, B } = U;
  const t0 = Date.now();
  B.ws.close(); await B.closed;
  assert.deepEqual(await A.next(m => m.t === 'p' && m.c === U.BRAVO.code), { t: 'p', c: U.BRAVO.code, s: 'off' });
  await sleep(300);
  const f = (await list(U.ALPHA)).friends.find(x => x.c === U.BRAVO.code);
  assert.ok(f.seen >= t0 - 1000, 'last seen recorded');
  U.B = await online(U.BRAVO);
  assert.equal((await A.next(m => m.t === 'p' && m.c === U.BRAVO.code)).s, 'menu');
});

test('remove, cancel, decline, block, unblock', async () => {
  const { A, B } = U;
  assert.equal((await j(await act(U.ALPHA, U.BRAVO.code, 'remove'))).b.st, '');
  await B.next(m => m.t === 'fx');
  assert.deepEqual(await B.next(m => m.t === 'p'), { t: 'p', c: U.ALPHA.code, s: 'off' });
  assert.equal((await list(U.BRAVO)).friends.some(x => x.c === U.ALPHA.code), false);
  await A.next(m => m.t === 'p' && m.c === U.BRAVO.code && m.s === 'off');
  B.send({ t: 'st', s: 'menu' }); B.send({ t: 'st', s: 'lobby', r: 'MNPQR', m: 'solo', o: 1 });
  await A.none(m => m.t === 'p' && m.c === U.BRAVO.code); // no presence after removal
  assert.equal((await act(U.ALPHA, U.BRAVO.code, 'remove')).status, 409);
  // cancel
  assert.equal((await j(await add(U.CHARLIE, U.DELTA.code))).b.st, 'o');
  assert.equal((await j(await act(U.CHARLIE, U.DELTA.code, 'cancel'))).b.st, '');
  assert.equal((await list(U.DELTA)).inc.length, 0);
  // decline
  assert.equal((await j(await add(U.DELTA, U.CHARLIE.code))).b.st, 'o');
  assert.equal((await j(await act(U.CHARLIE, U.DELTA.code, 'decline'))).b.st, '');
  assert.equal((await list(U.DELTA)).out.length, 0);
  // block: the blocked player's request disappears and they cannot find you any more
  assert.equal((await j(await add(U.DELTA, U.ALPHA.code))).b.st, 'o');
  await A.next(m => m.t === 'fx');
  assert.equal((await j(await act(U.ALPHA, U.DELTA.code, 'block'))).b.st, 'b');
  assert.equal((await list(U.DELTA)).out.length, 0);
  assert.deepEqual((await list(U.ALPHA)).blk.map(x => x.c), [U.DELTA.code]);
  let r = await j(await add(U.DELTA, U.ALPHA.code));
  assert.deepEqual([r.s, r.b.error], [404, 'No player with that friend code']);
  assert.equal((await add(U.ALPHA, U.DELTA.code)).status, 409, 'unblock first');
  assert.equal((await j(await act(U.ALPHA, U.DELTA.code, 'unblock'))).b.st, '');
  assert.equal((await list(U.ALPHA)).blk.length, 0);
  assert.equal((await act(U.ALPHA, U.DELTA.code, 'dance')).status, 400);
});

test('bad input and rate limits', async () => {
  let r = await j(await add(U.CHARLIE, U.CHARLIE.code));
  assert.equal(r.s, 400);
  assert.equal((await add(U.CHARLIE, 'short')).status, 400);
  assert.equal((await add(U.CHARLIE, 'ZZZZZZZZ')).status, 404);
  // friend-code lookups: 5 per minute per account (C used 5 above with this one)
  let st = 0;
  for (let i = 0; i < 6 && st !== 429; i++) st = (await add(U.CHARLIE, 'ZZZZZZZ' + i)).status;
  assert.equal(st, 429);
  // presence socket: message flood closes it
  const C = await online(U.CHARLIE);
  for (let i = 0; i < 60; i++) C.send({ t: 'st', s: i % 2 ? 'menu' : 'match' });
  assert.equal((await C.closed).code, 4008);
});

test('scheduled housekeeping keeps profiles and removes expired invites', async () => {
  assert.equal((await fetch(API + '/__scheduled?cron=17+4+*+*+*')).status, 200);
  assert.equal((await list(U.ALPHA)).code, U.ALPHA.code);
});
