// Ranked matchmaking: the third part of the Signal Durable Object (with PeerJS signaling and friends presence), for the
// same reason presence lives there: one global instance bounds the Durable Object duration to one object's day, and idle
// sockets cost nothing (the shared HEARTBEAT auto-response never wakes the object).
//
// Socket: GET /api/ranked/ws?a=<account id>. The id in the URL is the public half of the account code (it only names the
// socket, so a second tab replaces the first); the socket counts for nothing until its first message
// {t:'auth', auth:'ID.SECRET', mode} is checked against D1 (one batch: secret hash, this and last season's rating,
// callsign, battalion). The queue itself is the sockets' attachments (survives hibernation): no D1 writes while waiting.
//
// client -> server  {t:'auth', auth, mode}       join the queue for 'solo' | 'duos'
//                   {t:'q', mode}                 (re)join the queue (after a cancelled match)
//                   {t:'leave'}                   leave the queue (or just close the socket)
//                   {t:'open', mid}               host: my room is open (the guests are sent its code)
//                   {t:'fail', mid}               host: could not open the room / not enough players came
// server -> client  {t:'q', mode, r, rd, n}       queued (n: players in this queue)
//                   {t:'qs', n, w}                queue status every few seconds (w: seconds waited)
//                   {t:'host', mid, code, mode, me, diff, pl:[{sid,n,r,t}]}   you host this match: open room `code`
//                   {t:'match', mid, mode, me, diff, pl, host}               matched; wait for the host's room
//                   {t:'join', mid, code}         the host's room is open: join it
//                   {t:'cancel', why}             the match did not happen (back in the queue on the client's {t:'q'})
//                   {t:'err', e}                  'auth' | 'mode' | 'busy'
// Matching (every join and every 3 s while anyone waits): the longest-waiting player's window is 150 rating points,
// +25 per second waited (max 800); a lobby forms when it is full, or when at least two fit and the oldest waited
// RANKED_WAIT seconds (default 10). The longest-waiting player hosts. The match row is written to D1 before anyone is told.

import { parseAuth, sha256hex, randB32, ROOM_ABC, ID_LEN, B32 } from './lib.js';
import { RANK_MODES, HUMANS, seasonOf, rdNow, softReset, diffFor } from './rlib.js';

export const Q_TAG = 'Q';
const qTag = id => 'q:' + id;
const RE_ID = new RegExp('^[' + B32 + ']{' + ID_LEN + '}$');
const MAX_Q = 3000, MSG_MAX = 512, MSG_LIMIT = 30, MSG_WINDOW = 60000;
const AUTH_WAIT = 20000, OPEN_WAIT = 45000, LINGER = 15 * 60000, TICK = 3000;

export class Queue {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.rate = new WeakMap(); }

  accept(request) {
    const a = new URL(request.url).searchParams.get('a') || '';
    const [client, server] = Object.values(new WebSocketPair());
    const refuse = e => { server.accept(); server.send(JSON.stringify({ t: 'err', e })); server.close(4000, e); return new Response(null, { status: 101, webSocket: client }); };
    if (!RE_ID.test(a)) return refuse('auth');
    if (this.ctx.getWebSockets(Q_TAG).length >= MAX_Q) return refuse('busy');
    for (const w of this.ctx.getWebSockets(qTag(a))) { const at = w.deserializeAttachment() || {}; this.leaveGroup(w, at, 'replaced'); try { w.close(4003, 'Replaced'); } catch (_) {} }
    this.ctx.acceptWebSocket(server, [Q_TAG, qTag(a)]);
    server.serializeAttachment({ k: 'q', a, t0: Date.now(), ok: 0 });
    this.ctx.waitUntil(this.schedule(AUTH_WAIT + 1000));
    return new Response(null, { status: 101, webSocket: client });
  }

  send(w, o) { try { w.send(JSON.stringify(o)); } catch (_) {} }
  all() { const out = []; for (const w of this.ctx.getWebSockets(Q_TAG)) { if (w.readyState !== 1) continue; const a = w.deserializeAttachment(); if (a && a.k === 'q') out.push([w, a]); } return out; }
  group(mid) { return this.all().filter(([, a]) => a.mid === mid); }

  /** wake up in `ms` unless an earlier alarm is set (the presence sweep shares the object's one alarm) */
  async schedule(ms) {
    try { const cur = await this.ctx.storage.getAlarm(), at = Date.now() + ms; if (!cur || cur > at) await this.ctx.storage.setAlarm(at); } catch (_) {}
  }

  async message(ws, raw, att) {
    if (typeof raw !== 'string' || raw.length > MSG_MAX) return;
    const now = Date.now();
    let r = this.rate.get(ws);
    if (!r || now - r.t > MSG_WINDOW) { r = { t: now, n: 0 }; this.rate.set(ws, r); }
    if (++r.n > MSG_LIMIT) { try { ws.close(4008, 'Too many messages'); } catch (_) {} return; }
    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'auth') return this.auth(ws, att, m);
    if (!att.ok) return;
    if (m.t === 'q') {
      if (att.mid && att.st !== 'x') return; // matched: the client must finish (or the server cancel) that match first
      if (!RANK_MODES.includes(m.mode)) { this.send(ws, { t: 'err', e: 'mode' }); return; }
      Object.assign(att, { st: 'q', mode: m.mode, tq: now, mid: '', sid: '', host: 0, code: '' }); ws.serializeAttachment(att);
      this.send(ws, { t: 'q', mode: att.mode, r: Math.round(att.r), rd: Math.round(att.rd), n: this.waiting(att.mode).length });
      await this.match(att.mode); await this.schedule(TICK); return;
    }
    if (m.t === 'leave') { this.leaveGroup(ws, att, 'left'); att.st = ''; att.mid = ''; ws.serializeAttachment(att); return; }
    if (m.t === 'open' && att.host && att.mid && m.mid === att.mid && att.st === 'm') {
      for (const [w, a] of this.group(att.mid)) { a.st = 'o'; w.serializeAttachment(a); if (!a.host) this.send(w, { t: 'join', mid: a.mid, code: att.code }); }
      return;
    }
    if (m.t === 'fail' && att.host && att.mid && m.mid === att.mid) this.cancel(att.mid, 'host');
  }

  async auth(ws, att, m) {
    if (att.ok) return;
    const fail = e => { this.send(ws, { t: 'err', e }); try { ws.close(4001, e); } catch (_) {} };
    const a = parseAuth(m.auth), DB = this.env.DB, now = Date.now(), s = seasonOf(now);
    if (!a || a.id !== att.a || !DB) return fail('auth');
    if (!RANK_MODES.includes(m.mode)) return fail('mode');
    let res, sh;
    try {
      [sh, res] = await Promise.all([sha256hex(a.secret), DB.batch([
        DB.prepare('SELECT a.sh, p.name, p.fcode, m.bat, b.tag FROM accounts a LEFT JOIN profiles p ON p.acct = a.id LEFT JOIN bat_mem m ON m.acct = a.id LEFT JOIN bat b ON b.id = m.bat WHERE a.id = ?').bind(a.id),
        DB.prepare('SELECT season, r, rd, at FROM ratings WHERE acct = ? AND mode = ? AND season IN (?, ?)').bind(a.id, m.mode, s, s - 1),
      ])]);
    } catch (e) { this.send(ws, { t: 'err', e: 'busy' }); try { ws.close(1013, 'Try again'); } catch (_) {} return; }
    const acc = res[0].results[0];
    if (!acc || acc.sh !== sh) return fail('auth');
    if (ws.readyState !== 1) return;
    const cur = res[1].results.find(x => x.season === s), prev = res[1].results.find(x => x.season === s - 1);
    const base = cur ? { r: cur.r, rd: rdNow(cur.rd, cur.at, now) } : softReset(prev && { r: prev.r, rd: rdNow(prev.rd, prev.at, now) });
    Object.assign(att, { ok: 1, mode: m.mode, r: base.r, rd: base.rd, n: String(acc.name || m.name || 'OPERATIVE').slice(0, 12), t: acc.tag || '', b: acc.bat || '', c: acc.fcode || '', st: 'q', tq: now, mid: '' });
    ws.serializeAttachment(att);
    this.send(ws, { t: 'q', mode: att.mode, r: Math.round(att.r), rd: Math.round(att.rd), n: this.waiting(att.mode).length });
    await this.match(att.mode);
    await this.schedule(TICK);
  }

  waiting(mode) { return this.all().filter(([, a]) => a.ok && a.st === 'q' && a.mode === mode); }

  async match(mode, now = Date.now()) {
    const minWait = Math.max(0, +(this.env.RANKED_WAIT ?? 10)) * 1000, max = HUMANS[mode] || 2;
    let q = this.waiting(mode).sort((x, y) => x[1].tq - y[1].tq);
    const win = a => Math.min(800, 150 + 25 * (now - a.tq) / 1000);
    while (q.length >= 2) {
      const [, P] = q[0];
      const c = q.filter(([, a]) => Math.abs(a.r - P.r) <= Math.max(win(P), win(a))).sort((x, y) => Math.abs(x[1].r - P.r) - Math.abs(y[1].r - P.r)).slice(0, max);
      if (c.length >= max || (c.length >= 2 && now - P.tq >= minWait)) {
        const grp = [q[0]].concat(c.filter(x => x !== q[0])).slice(0, max);
        q = q.filter(x => !grp.includes(x));
        await this.form(mode, grp, now);
      } else q.shift();
    }
  }

  async form(mode, grp, now) {
    const mid = randB32(10), sids = new Set();
    while (sids.size < grp.length) sids.add(randB32(6));
    const S = [...sids], seats = {}, pl = [];
    let code = ''; for (let i = 0; i < 5; i++) code += ROOM_ABC[Math.floor(Math.random() * ROOM_ABC.length)];
    grp.forEach(([, a], i) => { seats[S[i]] = { a: a.a, r: a.r, rd: a.rd, n: a.n, t: a.t, b: a.b }; pl.push({ sid: S[i], n: a.n, r: Math.round(a.r), t: a.t }); });
    const diff = diffFor(grp.reduce((s, [, a]) => s + a.r, 0) / grp.length);
    try {
      await this.env.DB.prepare('INSERT INTO rmatch (id, mode, season, host, created, st, seats) VALUES (?,?,?,?,?,?,?)')
        .bind(mid, mode, seasonOf(now), S[0], now, 'p', JSON.stringify(seats)).run();
    } catch (e) { return; } // D1 hiccup: they stay queued and the next tick tries again
    grp.forEach(([w, a], i) => {
      Object.assign(a, { st: 'm', mid, sid: S[i], host: i === 0 ? 1 : 0, code: i === 0 ? code : '', tm: now });
      try { w.serializeAttachment(a); } catch (_) {}
      if (i === 0) this.send(w, { t: 'host', mid, code, mode, me: S[i], diff, pl });
      else this.send(w, { t: 'match', mid, mode, me: S[i], diff, pl, host: grp[0][1].n });
    });
  }

  /** a match that will not happen: everyone in it is told (their clients re-queue); the D1 row expires via the cron */
  cancel(mid, why) {
    for (const [w, a] of this.group(mid)) { Object.assign(a, { st: 'x', host: 0 }); w.serializeAttachment(a); this.send(w, { t: 'cancel', why }); }
  }
  leaveGroup(ws, att, why) { if (att && att.mid && att.st === 'm' && att.host) this.cancel(att.mid, why); }

  closed(ws) {
    const att = ws.deserializeAttachment();
    try { ws.close(1000, 'Bye'); } catch (_) {}
    if (att && att.k === 'q') this.leaveGroup(ws, att, 'host left');
  }

  /** alarm: match, cancel matches whose host never opened a room, drop unauthenticated / lingering sockets, status */
  async tick() {
    const now = Date.now();
    for (const mode of RANK_MODES) await this.match(mode, now);
    let busy = false;
    for (const [w, a] of this.all()) {
      if (!a.ok) { if (now - a.t0 > AUTH_WAIT) { try { w.close(4001, 'No auth'); } catch (_) {} } else busy = true; continue; }
      if (a.st === 'q') { busy = true; this.send(w, { t: 'qs', n: this.waiting(a.mode).length, w: Math.round((now - a.tq) / 1000) }); continue; }
      if (a.st === 'm') { if (a.host && now - a.tm > OPEN_WAIT) this.cancel(a.mid, 'timeout'); else busy = true; continue; }
      if (now - (a.tm || a.t0) > LINGER) { try { w.close(1000, 'Done'); } catch (_) {} }
    }
    if (busy) await this.schedule(TICK);
  }
}

