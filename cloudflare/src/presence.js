// Friends presence and room invites: the social half of the Signal Durable Object (same instance as PeerJS signaling).
//
// Why inside Signal and not a separate object: a Durable Object bills duration only while awake; one global instance
// awake 24 h at 128 MB is ~11,000 GB-s, under the free 13,000 GB-s/day, so a single object can never exceed the free
// duration however busy it gets (two always-awake objects could). It also shares the one WebSocket auto-response pair
// ('{"type":"HEARTBEAT"}'), so idle presence sockets cost nothing: heartbeats never wake the object.
//
// Socket: GET /api/social/ws?c=<friend code>. The code in the URL is public; the socket counts for nothing until its
// first message {t:'auth', auth:'ID.SECRET', s, r, m, o} is checked against D1 (the account's secret hash and that the
// code is the account's). The secret never appears in a URL or header. Unauthenticated sockets are closed after 20 s.
//
// client -> server  {t:'auth', auth, s, r, m, o}   s: 'menu' | 'lobby' | 'match'; r/m: room code and mode in a lobby;
//                                                 o: 1 = friends may join the room (only then do they see r)
//                   {t:'st', s, r, m, o}          presence changed (the client sends only transitions)
//                   {t:'inv', to, r, m}           invite a friend to the room you are in
//                   {t:'dec', c, r}               decline an invite from c
//                   '{"type":"HEARTBEAT"}'        answered by the runtime (auto-response), never reaches this code
// server -> client  {t:'hi', c, on:{code:{s,r?,m?}}, inv:[{c,n,r,m,exp}]}   after auth: online friends + pending invites
//                   {t:'p', c, s, r?, m?}         a friend's presence changed (s:'off' = went offline)
//                   {t:'fx'}                      your friends/requests changed: refetch /api/social/list
//                   {t:'inv', c, n, r, m, exp}    a friend invites you
//                   {t:'invd', c, live, exp}      your invite was delivered now (live) or stored for when they open the app
//                   {t:'invn', c, r}              a friend declined your invite
//                   {t:'err', e}                  'auth' | 'rate' | 'notfriend' | 'room'
// Battalions (see rb.js): a socket also knows its battalion (att.bat, from D1 at auth, updated by the Worker's batSet RPC).
// Battalion mates see each other's presence like friends do ('hi' carries bon:{code:{s,...}}, then 'p' updates), may
// invite each other to a room (live only: a mate who is not connected gets {t:'err', e:'offline'}), and get
//                   {t:'bm', at, c, n, m}            a battalion chat line (stored in D1 by /api/bat/say)
//                   {t:'bx'}                         your battalion changed (joined, kicked, invited...): refetch /api/bat/me
// Each socket's state lives in its attachment (survives hibernation): {k:'s', c, t0, ok, fr:'CODE,CODE', n, s, r, m, o, at, off}
// (off = this socket stored offline invites: they are deleted when its lobby closes).

import { parseAuth, sha256hex, normFriendCode, cleanPresence, publicPresence, samePresence, cleanRoom, cleanMode,
  MAX_LINKS, INVITE_TTL } from './lib.js';

export const S_TAG = 'S';                        // every presence socket carries this tag (separate from PeerJS peers)
const tagOf = c => 's:' + c;                     // and its friend code ('s:' cannot appear in a PeerJS id)
const MAX_SOCIAL = 5000, PER_CODE = 4;           // sockets in total / per account (tabs, devices)
const MSG_MAX = 1024, MSG_WINDOW = 60000, MSG_LIMIT = 40, INV_LIMIT = 12;
const AUTH_WAIT = 20000, STALE = 150000, SWEEP = 180000; // client heartbeat is every 50 s

export class Presence {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.rate = new WeakMap(); // ws -> {t, n, inv}: in memory (resets when the object hibernates, which is fine)
    this.alarmOn = false;
  }

  accept(request) {
    const u = new URL(request.url), c = normFriendCode(u.searchParams.get('c'));
    const [client, server] = Object.values(new WebSocketPair());
    const refuse = (e) => { server.accept(); server.send(JSON.stringify({ t: 'err', e })); server.close(4000, e); return new Response(null, { status: 101, webSocket: client }); };
    if (!c) return refuse('code');
    if (this.ctx.getWebSockets(S_TAG).length >= MAX_SOCIAL) return refuse('busy');
    const same = this.ctx.getWebSockets(tagOf(c)).filter(w => w.readyState === 1);
    if (same.length >= PER_CODE) { // drop an unauthenticated one first (someone else using a public code), else the oldest
      const L = same.map(w => [w, w.deserializeAttachment() || {}]).sort((x, y) => (x[1].ok | 0) - (y[1].ok | 0) || x[1].t0 - y[1].t0);
      this.drop(L[0][0], L[0][1], 4003, 'Too many connections');
    }
    this.ctx.acceptWebSocket(server, [S_TAG, tagOf(c)]);
    server.serializeAttachment({ k: 's', c, t0: Date.now(), ok: 0 });
    this.ctx.waitUntil(this.ensureAlarm());
    return new Response(null, { status: 101, webSocket: client });
  }

  async ensureAlarm() {
    if (this.alarmOn) return;
    try { if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + SWEEP); this.alarmOn = true; } catch (_) {}
  }

  /** authenticated, open sockets of a code (optionally leaving one out: the one that is closing) */
  live(c, except) {
    const out = [];
    for (const w of this.ctx.getWebSockets(tagOf(c))) {
      if (w === except || w.readyState !== 1) continue;
      const a = w.deserializeAttachment();
      if (a && a.ok && !a.gone) out.push([w, a]);
    }
    return out;
  }
  /** the account's presence: the most recently updated of its sockets, or null when none is connected */
  state(L) {
    let best = null;
    for (const [, a] of L) if (!best || a.at > best.at) best = a;
    return best && { s: best.s, r: best.r, m: best.m, o: best.o };
  }
  /** sockets of friend `fc` that also list `me` as a friend (both sides must agree) */
  peers(fc, me) {
    return this.live(fc).filter(([, a]) => frList(a).includes(me));
  }
  send(w, o) { try { w.send(typeof o === 'string' ? o : JSON.stringify(o)); } catch (_) {} }
  /** tell c's friends and battalion mates (only those connected) about c's new presence */
  broadcast(c, fr, st, bat) {
    const msg = JSON.stringify(Object.assign({ t: 'p', c }, publicPresence(st)));
    for (const fc of fr) for (const [w] of this.peers(fc, c)) this.send(w, msg);
    if (bat) for (const [w, a] of this.mates(bat, c)) if (!frList(a).includes(c)) this.send(w, msg);
  }
  /** connected, authenticated sockets of battalion `bat` other than account c's */
  mates(bat, c) {
    const out = [];
    if (!bat) return out;
    for (const w of this.ctx.getWebSockets(S_TAG)) {
      if (w.readyState !== 1) continue;
      const a = w.deserializeAttachment();
      if (a && a.ok && !a.gone && a.bat === bat && a.c !== c) out.push([w, a]);
    }
    return out;
  }

  async message(ws, raw, att) {
    if (typeof raw !== 'string' || raw.length > MSG_MAX) return;
    const now = Date.now();
    let r = this.rate.get(ws);
    if (!r || now - r.t > MSG_WINDOW) { r = { t: now, n: 0, inv: 0 }; this.rate.set(ws, r); }
    if (++r.n > MSG_LIMIT) { this.drop(ws, att, 4008, 'Too many messages'); return; }
    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'auth') return this.auth(ws, att, m);
    if (!att.ok) return;
    if (m.t === 'st') return this.status(ws, att, m);
    if (m.t === 'inv') {
      if (++r.inv > INV_LIMIT) { this.send(ws, { t: 'err', e: 'rate' }); return; }
      return this.invite(ws, att, m);
    }
    if (m.t === 'dec') {
      const host = normFriendCode(m.c);
      if (!host || !frList(att).includes(host)) return;
      for (const [w] of this.peers(host, att.c)) this.send(w, { t: 'invn', c: att.c, r: cleanRoom(m.r) });
    }
  }

  async auth(ws, att, m) {
    if (att.ok) return;
    const a = parseAuth(m.auth), DB = this.env.DB, now = Date.now();
    const fail = () => { this.send(ws, { t: 'err', e: 'auth' }); try { ws.close(4001, 'Unknown account'); } catch (_) {} };
    if (!a || !DB) return fail();
    let acc, fr, inv;
    try {
      const [sh, res] = await Promise.all([sha256hex(a.secret), DB.batch([
        DB.prepare('SELECT a.sh, p.fcode, p.name FROM accounts a JOIN profiles p ON p.acct = a.id WHERE a.id = ?').bind(a.id),
        DB.prepare("SELECT p.fcode FROM links l JOIN profiles p ON p.acct = l.b WHERE l.a = ? AND l.st = 'f' LIMIT ?").bind(a.id, MAX_LINKS),
        DB.prepare('SELECT from_code, room, mode, name, exp FROM invites WHERE to_code = ? AND exp > ?').bind(att.c, now),
        DB.prepare('SELECT bat FROM bat_mem WHERE acct = ?').bind(a.id),
      ])]);
      acc = res[0].results[0]; fr = res[1].results.map(x => x.fcode); inv = res[2].results;
      att.bat = res[3].results[0] ? res[3].results[0].bat : '';
      if (!acc || acc.sh !== sh || acc.fcode !== att.c) return fail();
    } catch (e) { this.send(ws, { t: 'err', e: 'busy' }); try { ws.close(1013, 'Try again'); } catch (_) {} return; }
    if (ws.readyState !== 1) return;
    const before = this.state(this.live(att.c));
    const p = cleanPresence(m) || { s: 'menu', r: '', m: '', o: 0 };
    Object.assign(att, { ok: 1, fr: fr.join(','), n: acc.name, at: now }, p);
    ws.serializeAttachment(att);
    // online friends (who list us too) and invites stored while we were away whose room is still open
    const on = {};
    for (const fc of fr) { const L = this.peers(fc, att.c); if (L.length) on[fc] = publicPresence(this.state(L)); }
    const pend = [];
    for (const x of inv) {
      if (!fr.includes(x.from_code)) continue;
      const host = this.state(this.live(x.from_code));
      if (host && host.s === 'lobby' && host.r === x.room) pend.push({ c: x.from_code, n: x.name, r: x.room, m: x.mode, exp: x.exp });
    }
    const bon = {};
    for (const [, a] of this.mates(att.bat, att.c)) if (!on[a.c]) bon[a.c] = publicPresence(this.state(this.live(a.c)));
    this.send(ws, att.bat ? { t: 'hi', c: att.c, on, inv: pend, bon } : { t: 'hi', c: att.c, on, inv: pend });
    if (inv.length) this.ctx.waitUntil(DB.prepare('DELETE FROM invites WHERE to_code = ?').bind(att.c).run().catch(() => {}));
    const after = this.state(this.live(att.c));
    if (!samePresence(before, after)) this.broadcast(att.c, fr, after, att.bat);
  }

  status(ws, att, m) {
    const p = cleanPresence(m);
    if (!p) return;
    const L = this.live(att.c), before = this.state(L);
    Object.assign(att, p, { at: Date.now() });
    ws.serializeAttachment(att);
    const after = this.state(this.live(att.c));
    if (!samePresence(before, after)) this.broadcast(att.c, frList(att), after, att.bat);
    this.roomClosed(ws, att, before, after);
  }

  /** the host left its lobby (match started, room closed): its stored offline invites are void */
  roomClosed(ws, att, before, after) {
    if (!att.off || !before || before.s !== 'lobby' || (after && after.s === 'lobby' && after.r === before.r)) return;
    att.off = 0; try { ws.serializeAttachment(att); } catch (_) {} // only when this socket stored some (att.off)
    if (this.env.DB) this.ctx.waitUntil(this.env.DB.prepare('DELETE FROM invites WHERE from_code = ?').bind(att.c).run().catch(() => {}));
  }

  async invite(ws, att, m) {
    const to = normFriendCode(m.to), room = cleanRoom(m.r), mode = cleanMode(m.m);
    const friend = !!to && frList(att).includes(to), mate = !!to && !friend && !!att.bat && this.live(to).some(([, a]) => a.bat === att.bat);
    if (!friend && !mate) { this.send(ws, { t: 'err', e: to && att.bat ? 'offline' : 'notfriend', c: m.to }); return; }
    if (!room || att.s !== 'lobby' || att.r !== room) { this.send(ws, { t: 'err', e: 'room' }); return; }
    const exp = Date.now() + INVITE_TTL, L = friend ? this.peers(to, att.c) : this.live(to).filter(([, a]) => a.bat === att.bat);
    if (L.length) {
      const msg = JSON.stringify({ t: 'inv', c: att.c, n: att.n, r: room, m: mode, exp });
      for (const [w] of L) this.send(w, msg);
      this.send(ws, { t: 'invd', c: to, live: 1, exp });
      return;
    }
    // not connected: keep it in D1 for 5 minutes; delivered on their next connect if the room is still open
    if (this.env.DB) {
      try {
        await this.env.DB.prepare('INSERT INTO invites (to_code, from_code, room, mode, name, exp) VALUES (?,?,?,?,?,?) ON CONFLICT(to_code, from_code) DO UPDATE SET room = excluded.room, mode = excluded.mode, name = excluded.name, exp = excluded.exp')
          .bind(to, att.c, room, mode, att.n || '', exp).run();
        if (!att.off) { att.off = 1; ws.serializeAttachment(att); }
      } catch (_) {}
    }
    this.send(ws, { t: 'invd', c: to, live: 0, exp });
  }

  /** server-side close: also handles the presence change (webSocketClose only fires for client-side closes) */
  drop(ws, att, code, why) {
    this.gone(ws, att);
    try { ws.close(code, why); } catch (_) {}
  }
  closed(ws) {
    const att = ws.deserializeAttachment();
    try { ws.close(1000, 'Bye'); } catch (_) {}
    if (att && att.k === 's') this.gone(ws, att);
  }
  gone(ws, att) {
    if (!att || !att.ok || att.gone) return;
    att.gone = 1; try { ws.serializeAttachment(att); } catch (_) {}
    const L = this.live(att.c, ws), after = this.state(L);
    const before = this.state(L.concat([[ws, att]]));
    if (!samePresence(before, after)) this.broadcast(att.c, frList(att), after, att.bat);
    this.roomClosed(ws, att, before, after);
    if (!after && this.env.DB) {
      this.ctx.waitUntil(this.env.DB.prepare('UPDATE profiles SET seen = ? WHERE fcode = ?').bind(Date.now(), att.c).run().catch(() => {}));
    }
  }

  /** alarm: close sockets that never authenticated or whose heartbeats stopped (a phone that went to sleep) */
  async sweep() {
    this.alarmOn = false;
    const now = Date.now(), all = this.ctx.getWebSockets(S_TAG);
    for (const w of all) {
      const a = w.deserializeAttachment() || {};
      if (!a.ok) { if (now - (a.t0 || 0) > AUTH_WAIT) { try { w.close(4001, 'No auth'); } catch (_) {} } continue; }
      let hb = 0; try { const d = this.ctx.getWebSocketAutoResponseTimestamp(w); hb = d ? +d : 0; } catch (_) {}
      if (now - Math.max(a.t0 || 0, a.at || 0, hb) > STALE) this.drop(w, a, 4002, 'No heartbeat');
    }
    if (this.ctx.getWebSockets(S_TAG).some(w => w.readyState === 1)) await this.ensureAlarm();
  }

  /** called by the Worker after a friends change: kind 'r' request sent a->b, 'f' now friends, 'x' unlinked */
  link(a, b, kind) {
    a = normFriendCode(a); b = normFriendCode(b);
    if (!a || !b || a === b) return false;
    const fx = '{"t":"fx"}';
    const edit = (c, other, add) => {
      for (const [w, att] of this.live(c)) {
        const L = frList(att).filter(x => x !== other);
        if (add && L.length < MAX_LINKS) L.push(other);
        att.fr = L.join(','); w.serializeAttachment(att);
      }
    };
    if (kind === 'f' || kind === 'x') { edit(a, b, kind === 'f'); edit(b, a, kind === 'f'); }
    for (const c of [a, b]) for (const [w] of this.live(c)) this.send(w, fx);
    if (kind === 'f') { // each sees the other's presence right away
      const sa = this.state(this.live(a)), sb = this.state(this.live(b));
      if (sa) for (const [w] of this.live(b)) this.send(w, Object.assign({ t: 'p', c: a }, publicPresence(sa)));
      if (sb) for (const [w] of this.live(a)) this.send(w, Object.assign({ t: 'p', c: b }, publicPresence(sb)));
    } else if (kind === 'x') {
      for (const [w] of this.live(a)) this.send(w, { t: 'p', c: b, s: 'off' });
      for (const [w] of this.live(b)) this.send(w, { t: 'p', c: a, s: 'off' });
    }
    return true;
  }

  /** called by the Worker after a battalion change: c's sockets now belong to `bat`; notify: send {t:'bx'} to c */
  batSet(c, bat, notify) {
    c = normFriendCode(c);
    if (!c) return false;
    for (const [w, att] of this.live(c)) {
      const old = att.bat || '';
      if (old !== (bat || '')) {
        att.bat = bat || ''; w.serializeAttachment(att);
        const st = this.state(this.live(c));
        if (old) for (const [m, a] of this.mates(old, c)) if (!frList(a).includes(c)) this.send(m, { t: 'p', c, s: 'off' });
        if (bat) for (const [m, a] of this.mates(bat, c)) if (!frList(a).includes(c)) this.send(m, Object.assign({ t: 'p', c }, publicPresence(st)));
      }
      if (notify) this.send(w, '{"t":"bx"}');
    }
    return true;
  }
  /** a battalion chat line to every connected member */
  batMsg(bat, msg) {
    if (!bat || !msg) return 0;
    const s = JSON.stringify(Object.assign({ t: 'bm' }, msg));
    let n = 0;
    for (const w of this.ctx.getWebSockets(S_TAG)) {
      if (w.readyState !== 1) continue;
      const a = w.deserializeAttachment();
      if (a && a.ok && !a.gone && a.bat === bat) { this.send(w, s); n++; }
    }
    return n;
  }
}

function frList(att) { return att && att.fr ? att.fr.split(',') : []; }
