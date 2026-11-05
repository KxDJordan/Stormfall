// Stormfall backend: one Worker with Static Assets.
// The game files are served by the assets layer without running this code (free, unlimited); only /api/* reaches it
// (run_worker_first in wrangler.jsonc). Endpoints are listed in the README (Cloudflare backend).
//
// Cost notes: every API call is a "simple" CORS request (GET, or POST with a text/plain JSON body and no custom
// headers), so cross-origin use from GitHub Pages never pays for a preflight. Auth is "ID.SECRET" in the body;
// the server keeps sha256(secret) only. Each handler touches one D1 row (save) or one index range (leaderboard).

import { Signal } from './signal.js';
import {
  randB32, sha256hex, parseAuth, authToCode, dayKey, validDayKey, dayAccepted, cleanDaily, validSave,
  originAllowed, normIce, MemLimiter, ID_LEN, SECRET_LEN, MAX_BODY, TOP_N,
  normFriendCode, cleanProfile, FCODE_LEN, MAX_LINKS, MAX_OUT, MAX_IN, MAX_BLOCKS,
} from './lib.js';
import { rbRoutes } from './rb.js';

export { Signal };

const memIp = new MemLimiter(120, 60000), memNew = new MemLimiter(5, 60000), memAcct = new MemLimiter(30, 60000);
const memAdd = new MemLimiter(5, 60000); // friend-code lookups per account (fallback for the RL_NEW binding)
const topMem = new Map();   // day -> {t, body}: per-isolate leaderboard cache (works on workers.dev, where the Cache API is a no-op)
let turnMem = null;         // {ice, exp}: TURN credentials shared by everyone for a few hours

class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
let RB = null; // ranked & battalions routes (rb.js), built on first use with this file's helpers

function json(status, obj, headers) {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json; charset=utf-8');
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(obj), { status, headers: h });
}

/** Rate limit: the Workers Rate Limiting binding if configured, else a per-isolate fixed window. */
async function allow(binding, mem, key) {
  if (binding && typeof binding.limit === 'function') {
    try { const { success } = await binding.limit({ key }); return success; } catch (_) { /* fall through */ }
  }
  return mem.hit(key);
}
const tooMany = () => new HttpError(429, 'Too many requests. Try again in a minute.', { 'Retry-After': '60' });

async function body(req) {
  const len = +req.headers.get('Content-Length') || 0;
  if (len > MAX_BODY) throw new HttpError(413, 'Too large');
  const t = await req.text();
  if (t.length > MAX_BODY) throw new HttpError(413, 'Too large');
  try { const o = JSON.parse(t); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch (_) {}
  throw new HttpError(400, 'Bad JSON');
}

/** Checks "ID.SECRET" against the stored hash. Returns the account row (with the extra columns asked for). */
async function account(env, auth, cols = 'rev, save_at') {
  const a = parseAuth(auth);
  if (!a) throw new HttpError(401, 'Unknown account');
  const [row, sh] = await Promise.all([
    env.DB.prepare(`SELECT sh, ${cols} FROM accounts WHERE id = ?`).bind(a.id).first(),
    sha256hex(a.secret),
  ]);
  if (!row || row.sh !== sh) throw new HttpError(401, 'Unknown account');
  row.id = a.id;
  return row;
}

/* ---------------- accounts and cloud saves ---------------- */

async function createAccount(env, ip) {
  if (!await allow(env.RL_NEW, memNew, 'new:' + ip)) throw tooMany();
  for (let i = 0; i < 3; i++) {
    const id = randB32(ID_LEN), secret = randB32(SECRET_LEN);
    const r = await env.DB.prepare('INSERT INTO accounts (id, sh, created) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .bind(id, await sha256hex(secret), Date.now()).run();
    if (r.meta.changes === 1) return json(200, { id, auth: id + '.' + secret, code: authToCode(id, secret) });
  }
  throw new HttpError(500, 'Try again');
}

// {auth, have} -> {rev, at, data} (data is null when the client already has this revision: no payload sent)
async function saveGet(env, b) {
  const have = Number.isInteger(b.have) ? b.have : -1;
  const a = parseAuth(b.auth);
  if (!a) throw new HttpError(401, 'Unknown account');
  const [row, sh] = await Promise.all([
    env.DB.prepare('SELECT sh, rev, save_at, CASE WHEN rev = ? THEN NULL ELSE save END AS save FROM accounts WHERE id = ?').bind(have, a.id).first(),
    sha256hex(a.secret),
  ]);
  if (!row || row.sh !== sh) throw new HttpError(401, 'Unknown account');
  return json(200, { rev: row.rev, at: row.save_at || 0, data: row.save || null });
}

// {auth, base, data} -> {rev, at} | 409 {rev, at, data} (someone else pushed since `base`: the client asks the player)
async function savePut(env, b) {
  const a = parseAuth(b.auth);
  if (!a) throw new HttpError(401, 'Unknown account');
  if (!validSave(b.data)) throw new HttpError(400, 'Bad save');
  if (!Number.isInteger(b.base) || b.base < 0) throw new HttpError(400, 'Bad base revision');
  if (!await allow(env.RL_ACCT, memAcct, 'acct:' + a.id)) throw tooMany();
  const sh = await sha256hex(a.secret), now = Date.now();
  // auth + compare-and-swap in one statement: 1 row read, 1 row written
  const row = await env.DB.prepare('UPDATE accounts SET save = ?, rev = rev + 1, save_at = ? WHERE id = ? AND sh = ? AND rev = ? RETURNING rev')
    .bind(b.data, now, a.id, sh, b.base).first();
  if (row) return json(200, { rev: row.rev, at: now });
  const cur = await env.DB.prepare('SELECT sh, rev, save_at, save FROM accounts WHERE id = ?').bind(a.id).first();
  if (!cur || cur.sh !== sh) throw new HttpError(401, 'Unknown account');
  return json(409, { error: 'conflict', rev: cur.rev, at: cur.save_at || 0, data: cur.save || null });
}

/* ---------------- daily leaderboard ---------------- */

async function rankOf(env, day, score, at) {
  const [r, c] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM daily WHERE day = ? AND (score > ? OR (score = ? AND at < ?))').bind(day, score, score, at),
    env.DB.prepare('SELECT n FROM daily_count WHERE day = ?').bind(day),
  ]);
  return { rank: (r.results[0] ? r.results[0].n : 0) + 1, total: c.results[0] ? c.results[0].n : 0 };
}

async function dailySubmit(env, ctx, url, b) {
  const d = cleanDaily(b);
  if (d.error) throw new HttpError(400, d.error);
  const r = d.row, now = Date.now();
  if (!dayAccepted(r.day, now)) throw new HttpError(400, 'That daily challenge is closed');
  const acc = await account(env, b.auth, 'rev');
  if (!await allow(env.RL_ACCT, memAcct, 'acct:' + acc.id)) throw tooMany();
  const ins = await env.DB.prepare('INSERT INTO daily (day, acct, score, at, name, cls, place, kills, dmg, rounds, win) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(day, acct) DO NOTHING')
    .bind(r.day, acc.id, r.score, now, r.name, r.cls, r.place, r.kills, r.dmg, r.rounds, r.win).run();
  const dup = ins.meta.changes !== 1;
  let mine = { score: r.score, at: now };
  if (dup) mine = await env.DB.prepare('SELECT score, at FROM daily WHERE day = ? AND acct = ?').bind(r.day, acc.id).first();
  else {
    await env.DB.prepare('INSERT INTO daily_count (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1').bind(r.day).run();
    ctx.waitUntil(rb().dailyPoints(env, acc.id).catch(() => {})); // battalion points (ranked & battalions)
    // this isolate and this location's Cache API show the new score at once; others within their short TTL
    topMem.delete(r.day);
    if (typeof caches !== 'undefined') await caches.default.delete(topKey(url, r.day)).catch(() => {});
  }
  const rk = await rankOf(env, r.day, mine.score, mine.at);
  return json(200, { ok: true, dup, day: r.day, score: mine.score, rank: rk.rank, total: rk.total });
}

// {auth, day} -> your rank today (only asked for when you are not in the cached top 50)
async function dailyMe(env, b) {
  const a = parseAuth(b.auth);
  if (!a || !validDayKey(b.day)) throw new HttpError(400, 'Bad request');
  const row = await env.DB.prepare('SELECT score, at FROM daily WHERE day = ? AND acct = ?').bind(b.day, a.id).first();
  if (!row) return json(200, { none: true });
  const rk = await rankOf(env, b.day, row.score, row.at);
  return json(200, { score: row.score, rank: rk.rank, total: rk.total });
}

const topKey = (url, day) => new Request(url.origin + '/api/daily/top?day=' + day);

async function dailyTop(env, ctx, url) {
  const day = url.searchParams.get('day') || dayKey(Date.now()), now = Date.now();
  if (!validDayKey(day)) throw new HttpError(400, 'Bad day');
  const age = (Date.parse(dayKey(now) + 'T00:00:00Z') - Date.parse(day + 'T00:00:00Z')) / 86400000;
  if (age < -1 || age > 40) throw new HttpError(404, 'No leaderboard for that day');
  const ttl = age >= 2 ? 3600 : 60; // a closed day never changes
  const headers = { 'Cache-Control': 'public, max-age=' + ttl, 'X-Cache': 'MISS' };
  const m = topMem.get(day);
  if (m && now - m.t < Math.min(ttl, 30) * 1000) return json(200, m.body, Object.assign(headers, { 'X-Cache': 'MEM' }));
  const key = topKey(url, day);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    const hit = await cache.match(key);
    if (hit) { const bd = await hit.json(); topMem.set(day, { t: now, body: bd }); return json(200, bd, Object.assign(headers, { 'X-Cache': 'HIT' })); }
  }
  const [top, cnt] = await env.DB.batch([
    env.DB.prepare('SELECT acct, name, cls, score, place, kills, dmg, rounds, win FROM daily WHERE day = ? ORDER BY score DESC, at ASC LIMIT ?').bind(day, TOP_N),
    env.DB.prepare('SELECT n FROM daily_count WHERE day = ?').bind(day),
  ]);
  const bd = {
    day, total: cnt.results[0] ? cnt.results[0].n : 0, at: now,
    // t: a short public tag of the account (the client finds itself by it); never the full id
    top: top.results.map(x => ({ t: x.acct.slice(0, 6), n: x.name, c: x.cls, s: x.score, p: x.place, k: x.kills, d: x.dmg, r: x.rounds, w: x.win })),
  };
  topMem.set(day, { t: now, body: bd });
  if (cache) ctx.waitUntil(cache.put(key, json(200, bd, { 'Cache-Control': 'public, max-age=' + ttl })).catch(() => {}));
  return json(200, bd, headers);
}

/* ---------------- ICE servers (TURN) ---------------- */

async function turn(env) {
  const id = env.TURN_KEY_ID, tok = env.TURN_KEY_API_TOKEN, now = Date.now();
  if (!id || !tok) return json(200, { iceServers: null, ttl: 86400, turn: false }, { 'Cache-Control': 'public, max-age=3600' });
  const life = Math.max(3600, Math.min(172800, +env.TURN_TTL || 86400)) * 1000;
  if (!turnMem || turnMem.exp - now < life / 2) {
    try {
      const base = env.TURN_API_BASE || 'https://rtc.live.cloudflare.com/v1';
      const r = await fetch(`${base}/turn/keys/${encodeURIComponent(id)}/credentials/generate-ice-servers`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: life / 1000 }),
      });
      const ice = r.ok ? normIce(await r.json()) : null;
      if (ice) turnMem = { ice, exp: now + life };
      else console.log('turn: credential request failed', r.status); // status only, never the token
    } catch (e) { console.log('turn: credential request error'); }
  }
  if (!turnMem) return json(200, { iceServers: null, ttl: 600, turn: false }, { 'Cache-Control': 'private, max-age=600' });
  const left = Math.floor((turnMem.exp - now) / 1000) - 600; // the client stops using them 10 minutes early
  return json(200, { iceServers: turnMem.ice, ttl: left, turn: true }, { 'Cache-Control': 'private, max-age=' + Math.max(60, left) });
}

/* ---------------- socials: profiles, friends, presence socket ----------------
   Friends are addressed by their public friend code everywhere (never by account id). Every change that affects a
   connected player is pushed to the presence object (one Durable Object RPC per change, after the response). */

const socialDO = env => env.SIGNAL.get(env.SIGNAL.idFromName('global'));
function notify(env, ctx, a, b, kind) {
  ctx.waitUntil(socialDO(env).link(a, b, kind).catch(e => console.log('social notify failed', e && e.message)));
}

/** auth + the caller's friend code in one read; rate limited per account */
async function socAuth(env, auth) {
  const a = parseAuth(auth);
  if (!a) throw new HttpError(401, 'Unknown account');
  const [row, sh] = await Promise.all([
    env.DB.prepare('SELECT a.sh, p.fcode FROM accounts a LEFT JOIN profiles p ON p.acct = a.id WHERE a.id = ?').bind(a.id).first(),
    sha256hex(a.secret),
  ]);
  if (!row || row.sh !== sh) throw new HttpError(401, 'Unknown account');
  if (!await allow(env.RL_ACCT, memAcct, 'acct:' + a.id)) throw tooMany();
  return { id: a.id, code: row.fcode || null };
}

// {auth, name, lv, cls, title, banner} -> {code}: publishes the public profile (creates it and the friend code once)
async function socialMe(env, b) {
  const me = await socAuth(env, b.auth), p = cleanProfile(b), now = Date.now();
  if (me.code) {
    await env.DB.prepare('UPDATE profiles SET name = ?, lv = ?, cls = ?, title = ?, banner = ?, updated = ? WHERE acct = ?')
      .bind(p.name, p.lv, p.cls, p.title, p.banner, now, me.id).run();
    return json(200, { code: me.code });
  }
  for (let i = 0; i < 4; i++) {
    const code = randB32(FCODE_LEN);
    const r = await env.DB.prepare('INSERT INTO profiles (acct, fcode, name, lv, cls, title, banner, seen, updated) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .bind(me.id, code, p.name, p.lv, p.cls, p.title, p.banner, now, now).run();
    if (r.meta.changes === 1) return json(200, { code });
    const ex = await env.DB.prepare('SELECT fcode FROM profiles WHERE acct = ?').bind(me.id).first(); // a parallel call won
    if (ex) return json(200, { code: ex.fcode });
  }
  throw new HttpError(500, 'Try again');
}

const linkRow = x => ({ c: x.fcode, n: x.name, lv: x.lv, cls: x.cls, ti: x.title, bn: x.banner, seen: x.seen, at: x.at });

// {auth} -> {code, friends, inc, out, blk}: everything about me (one primary-key range + one profile seek per row)
async function socialList(env, b) {
  const me = await socAuth(env, b.auth);
  if (!me.code) return json(200, { code: null, friends: [], inc: [], out: [], blk: [] });
  const { results } = await env.DB.prepare('SELECT l.st, l.at, p.fcode, p.name, p.lv, p.cls, p.title, p.banner, p.seen FROM links l JOIN profiles p ON p.acct = l.b WHERE l.a = ? LIMIT ?')
    .bind(me.id, MAX_LINKS + MAX_IN + MAX_BLOCKS + 10).all();
  const out = { code: me.code, friends: [], inc: [], out: [], blk: [] }, key = { f: 'friends', i: 'inc', o: 'out', b: 'blk' };
  for (const x of results) if (key[x.st]) out[key[x.st]].push(linkRow(x));
  for (const k of ['inc', 'out', 'blk']) for (const x of out[k]) delete x.seen; // last seen is for friends only
  return json(200, out);
}

/** the target of an add/act by friend code, with both directions of the link between us */
async function socTarget(env, me, codeIn) {
  if (!me.code) throw new HttpError(409, 'Open Friends once to get your friend code');
  const c = normFriendCode(codeIn);
  if (!c) throw new HttpError(400, 'Friend codes are 8 characters');
  if (c === me.code) throw new HttpError(400, 'That is your own friend code');
  const t = await env.DB.prepare('SELECT acct FROM profiles WHERE fcode = ?').bind(c).first();
  if (!t) throw new HttpError(404, 'No player with that friend code');
  const [mine, theirs] = await env.DB.batch([
    env.DB.prepare('SELECT st FROM links WHERE a = ? AND b = ?').bind(me.id, t.acct),
    env.DB.prepare('SELECT st FROM links WHERE a = ? AND b = ?').bind(t.acct, me.id),
  ]);
  return { id: t.acct, code: c, mine: mine.results[0] ? mine.results[0].st : '', theirs: theirs.results[0] ? theirs.results[0].st : '' };
}
async function counts(env, id) {
  const { results } = await env.DB.prepare('SELECT st, COUNT(*) AS n FROM links WHERE a = ? GROUP BY st').bind(id).all();
  const o = { f: 0, i: 0, o: 0, b: 0 };
  for (const x of results) o[x.st] = x.n;
  return o;
}
const UPSERT = 'INSERT INTO links (a, b, st, at) VALUES (?,?,?,?) ON CONFLICT(a, b) DO UPDATE SET st = excluded.st, at = excluded.at';
const setBoth = (env, a, b, stA, stB, now) => [env.DB.prepare(UPSERT).bind(a, b, stA, now), env.DB.prepare(UPSERT).bind(b, a, stB, now)];
const delBoth = (env, a, b) => [
  env.DB.prepare('DELETE FROM links WHERE a = ? AND b = ?').bind(a, b),
  env.DB.prepare('DELETE FROM links WHERE a = ? AND b = ?').bind(b, a),
];

// {auth, code} -> {st, code}: send a friend request (or accept theirs). Lookups are rate limited: friend codes are 40-bit
// random, so finding one by guessing takes ~10^11 tries at 5 per minute per account.
async function socialAdd(env, ctx, b) {
  const me = await socAuth(env, b.auth);
  if (!await allow(env.RL_NEW, memAdd, 'fadd:' + me.id)) throw tooMany();
  const t = await socTarget(env, me, b.code), now = Date.now();
  if (t.theirs === 'b') throw new HttpError(404, 'No player with that friend code'); // blocked: indistinguishable from a wrong code
  if (t.mine === 'b') throw new HttpError(409, 'You blocked this player. Unblock them first.');
  if (t.mine === 'f' || t.mine === 'o') return json(200, { st: t.mine, code: t.code });
  const [cm, ct] = await Promise.all([counts(env, me.id), counts(env, t.id)]);
  if (t.mine === 'i') { // they already asked: this accepts
    if (cm.f >= MAX_LINKS || ct.f >= MAX_LINKS) throw new HttpError(409, 'Friends list is full (' + MAX_LINKS + ')');
    await env.DB.batch(setBoth(env, me.id, t.id, 'f', 'f', now));
    notify(env, ctx, me.code, t.code, 'f');
    return json(200, { st: 'f', code: t.code });
  }
  if (cm.f + cm.o >= MAX_LINKS) throw new HttpError(409, 'Friends list is full (' + MAX_LINKS + ')');
  if (cm.o >= MAX_OUT) throw new HttpError(409, 'Too many requests waiting for an answer. Cancel some first.');
  if (ct.i >= MAX_IN || ct.f >= MAX_LINKS) throw new HttpError(409, 'That player cannot take more friend requests right now');
  await env.DB.batch(setBoth(env, me.id, t.id, 'o', 'i', now));
  notify(env, ctx, me.code, t.code, 'r');
  return json(200, { st: 'o', code: t.code });
}

// {auth, code, a: accept|decline|cancel|remove|block|unblock} -> {st} (the new state from my side; '' = no link)
async function socialAct(env, ctx, b) {
  const me = await socAuth(env, b.auth), a = b.a;
  if (!['accept', 'decline', 'cancel', 'remove', 'block', 'unblock'].includes(a)) throw new HttpError(400, 'Bad action');
  const t = await socTarget(env, me, b.code), now = Date.now();
  const need = { accept: 'i', decline: 'i', cancel: 'o', remove: 'f', unblock: 'b' }[a];
  if (need && t.mine !== need) return json(409, { error: 'Nothing to do', st: t.mine });
  if (a === 'accept') {
    const [cm, ct] = await Promise.all([counts(env, me.id), counts(env, t.id)]);
    if (cm.f >= MAX_LINKS || ct.f >= MAX_LINKS) throw new HttpError(409, 'Friends list is full (' + MAX_LINKS + ')');
    await env.DB.batch(setBoth(env, me.id, t.id, 'f', 'f', now));
    notify(env, ctx, me.code, t.code, 'f');
    return json(200, { st: 'f' });
  }
  if (a === 'unblock') {
    await env.DB.prepare('DELETE FROM links WHERE a = ? AND b = ?').bind(me.id, t.id).run();
    return json(200, { st: '' });
  }
  if (a === 'block') {
    if (t.mine !== 'b' && (await counts(env, me.id)).b >= MAX_BLOCKS) throw new HttpError(409, 'Block list is full');
    await env.DB.batch([
      env.DB.prepare("INSERT INTO links (a, b, st, at) VALUES (?,?,'b',?) ON CONFLICT(a, b) DO UPDATE SET st = 'b', at = excluded.at").bind(me.id, t.id, now),
      env.DB.prepare('DELETE FROM links WHERE a = ? AND b = ?').bind(t.id, me.id),
      env.DB.prepare('DELETE FROM invites WHERE to_code = ? AND from_code = ?').bind(me.code, t.code),
      env.DB.prepare('DELETE FROM invites WHERE to_code = ? AND from_code = ?').bind(t.code, me.code),
    ]);
    if (t.mine || t.theirs) notify(env, ctx, me.code, t.code, 'x');
    return json(200, { st: 'b' });
  }
  await env.DB.batch(delBoth(env, me.id, t.id)); // decline, cancel, remove
  notify(env, ctx, me.code, t.code, 'x');
  return json(200, { st: '' });
}

/* ---------------- router ---------------- */

function rb() { return RB || (RB = rbRoutes({ json, HttpError, allow, tooMany, memAcct, MemLimiter })); }

async function route(req, env, ctx, url, ip) {
  const p = url.pathname, M = req.method;
  if (/^\/api\/(ranked|bat|report)(\/|$)/.test(p)) { // ranked & battalions (rb.js)
    const r = await rb().route(req, env, ctx, url, ip, body);
    if (r) return r;
    throw new HttpError(404, 'Not found');
  }
  if (p === '/api/peerjs') {
    if (req.headers.get('Upgrade') !== 'websocket') throw new HttpError(426, 'Expected a WebSocket');
    return env.SIGNAL.get(env.SIGNAL.idFromName('global')).fetch(req);
  }
  if (p === '/api/peerjs/id' && M === 'GET') {
    return new Response(crypto.randomUUID(), { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
  }
  if (p === '/api/peerjs/peers') throw new HttpError(401, 'Peer listing is disabled');
  if (p === '/api/social/ws') { // presence socket; the account is checked by its first message (see presence.js)
    if (req.headers.get('Upgrade') !== 'websocket') throw new HttpError(426, 'Expected a WebSocket');
    const c = normFriendCode(url.searchParams.get('c'));
    if (!c) throw new HttpError(400, 'Bad friend code');
    if (!await allow(env.RL_ACCT, memAcct, 'ws:' + c)) throw tooMany();
    return socialDO(env).fetch(req);
  }
  if (p === '/api/health' && M === 'GET') return json(200, { ok: true, turn: !!(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN), t: Date.now() });
  if (p === '/api/turn' && M === 'GET') return turn(env);
  if (p === '/api/daily/top' && M === 'GET') return dailyTop(env, ctx, url);
  if (M === 'POST') {
    if (p === '/api/account') return createAccount(env, ip);
    const b = await body(req);
    if (p === '/api/save/get') return saveGet(env, b);
    if (p === '/api/save/put') return savePut(env, b);
    if (p === '/api/daily/submit') return dailySubmit(env, ctx, url, b);
    if (p === '/api/daily/me') return dailyMe(env, b);
    if (p === '/api/social/me') return socialMe(env, b);
    if (p === '/api/social/list') return socialList(env, b);
    if (p === '/api/social/add') return socialAdd(env, ctx, b);
    if (p === '/api/social/act') return socialAct(env, ctx, b);
  }
  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') {
      // only reached for paths that are not static files (assets answer everything else without running the Worker)
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });
    }
    const origin = req.headers.get('Origin'), okOrigin = originAllowed(origin, url.origin, env.ALLOWED_ORIGINS, env.ALLOW_LOCALHOST === '1');
    const withCors = res => {
      if (res.status === 101 || !okOrigin) return res;
      const r = new Response(res.body, res);
      r.headers.set('Access-Control-Allow-Origin', origin);
      r.headers.append('Vary', 'Origin');
      return r;
    };
    if (req.method === 'OPTIONS') {
      if (!okOrigin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' } });
    }
    // browsers always send Origin on cross-origin requests and WebSocket upgrades: other sites cannot use the API
    if (origin && !okOrigin) return json(403, { error: 'Origin not allowed' });
    const ip = req.headers.get('CF-Connecting-IP') || 'local';
    try {
      if (!await allow(env.RL_IP, memIp, 'ip:' + ip)) throw tooMany();
      return withCors(await route(req, env, ctx, url, ip));
    } catch (e) {
      if (e instanceof HttpError) return withCors(json(e.status, { error: e.message }, e.extra));
      console.log('error', req.method, url.pathname, e && e.message); // no bodies, no secrets
      return withCors(json(500, { error: 'Server error' }));
    }
  },

  // daily housekeeping (cron): old leaderboards, accounts that never saved anything (and have no friends profile),
  // expired invites and friend requests nobody answered for 60 days
  async scheduled(evt, env) {
    const now = Date.now(), old = dayKey(now - 40 * 86400000);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM daily WHERE day < ?').bind(old),
      env.DB.prepare('DELETE FROM daily_count WHERE day < ?').bind(old),
      env.DB.prepare('DELETE FROM accounts WHERE rev = 0 AND created < ? AND id NOT IN (SELECT acct FROM profiles)').bind(now - 7 * 86400000),
      env.DB.prepare('DELETE FROM invites WHERE exp < ?').bind(now),
      env.DB.prepare("DELETE FROM links WHERE st IN ('i', 'o') AND at < ?").bind(now - 60 * 86400000),
      ...rb().cron(env, now), // ranked & battalions: expired invites, old chat, unfinished matches
    ]);
  },
};
