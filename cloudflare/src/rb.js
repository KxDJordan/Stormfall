// Ranked & battalions: the Worker's HTTP routes (the matchmaking queue is in queue.js, inside the Signal Durable Object).
// Same conventions as index.js: CORS "simple" requests, auth "ID.SECRET" in the JSON body, one indexed seek per query,
// public read-only lists cached (Cache API + isolate memory). See README -> Cloudflare backend -> Ranked & battalions.
//
// Ranked result reporting (threat model in the README):
//   1. the matchmaker writes rmatch(id, seats) before anyone hears about the match      (st 'p')
//   2. the host registers the seat ids that actually joined (/api/ranked/start)          (st 'r')
//   3. every human reports {h: final simHash, pl: {sid: team place}, left: [sid]} once (/api/ranked/report)
//   4. a strict majority of all registered humans agreeing rates the match at once; else after GRACE the majority of
//      the reports decides; otherwise the match is void. Leavers are rated last. Ratings change by a relative update.

import { parseAuth, sha256hex, randB32, normFriendCode } from './lib.js';
import {
  RANK_MODES, seasonOf, seasonEnd, tierOf, rdNow, softReset, rateMatch, cleanReport, consensus, humanPlaces, batPoints,
  weekKey, validSid, validMid, PLACEMENTS, GRACE, TOP_RANKED,
  BAT_CAP, BAT_ID_LEN, cleanBatName, cleanTag, cleanDesc, cleanEmblem, cleanBanner, cleanChat, CHAT_KEEP, INVITE_DAYS,
  REPORT_KINDS, cleanReportWhy,
} from './rlib.js';

export function rbRoutes(H) {
  const { json, HttpError, allow, tooMany, memAcct, MemLimiter } = H;
  const memSay = new MemLimiter(1, 1500), memMin = new MemLimiter(15, 60000), memBat = new MemLimiter(5, 60000);
  const cacheMem = new Map(); // key -> {t, body}
  const DO = env => env.SIGNAL.get(env.SIGNAL.idFromName('global'));
  const later = (ctx, p) => ctx.waitUntil(Promise.resolve(p).catch(e => console.log('rb bg', e && e.message)));

  /** auth + profile + battalion membership in one read */
  async function who(env, auth, rl = true) {
    const a = parseAuth(auth);
    if (!a) throw new HttpError(401, 'Unknown account');
    const [row, sh] = await Promise.all([
      env.DB.prepare('SELECT a.sh, p.fcode, p.name, m.bat, m.role FROM accounts a LEFT JOIN profiles p ON p.acct = a.id LEFT JOIN bat_mem m ON m.acct = a.id WHERE a.id = ?').bind(a.id).first(),
      sha256hex(a.secret),
    ]);
    if (!row || row.sh !== sh) throw new HttpError(401, 'Unknown account');
    if (rl && !await allow(env.RL_ACCT, memAcct, 'acct:' + a.id)) throw tooMany();
    return { id: a.id, code: row.fcode || null, name: row.name || 'OPERATIVE', bat: row.bat || '', role: row.role || '' };
  }

  /** a cached public GET: isolate memory for `mem` s, then the Cache API, else build() */
  async function cached(ctx, url, key, ttl, build) {
    const now = Date.now(), m = cacheMem.get(key), headers = { 'Cache-Control': 'public, max-age=' + ttl };
    if (m && now - m.t < ttl * 1000) return json(200, m.body, Object.assign(headers, { 'X-Cache': 'MEM' }));
    const req = new Request(url.origin + '/__c/' + encodeURIComponent(key));
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    if (cache) { const hit = await cache.match(req); if (hit) { const bd = await hit.json(); cacheMem.set(key, { t: now, body: bd }); return json(200, bd, Object.assign(headers, { 'X-Cache': 'HIT' })); } }
    const bd = await build();
    if (cacheMem.size > 200) cacheMem.clear();
    cacheMem.set(key, { t: now, body: bd });
    if (cache) ctx.waitUntil(cache.put(req, json(200, bd, headers)).catch(() => {}));
    return json(200, bd, Object.assign(headers, { 'X-Cache': 'MISS' }));
  }
  async function uncache(url, key) {
    cacheMem.delete(key);
    if (typeof caches !== 'undefined') await caches.default.delete(new Request(url.origin + '/__c/' + encodeURIComponent(key))).catch(() => {});
  }

  /* ---------------- ranked ---------------- */

  const rkRow = (x, now) => {
    if (!x) return null;
    const t = tierOf(x.r);
    return { r: Math.round(x.r), rd: Math.round(rdNow(x.rd, x.at, now)), n: x.n, w: x.w, peak: Math.round(x.peak || 0), tier: t.k, div: t.div, prov: x.n < PLACEMENTS ? PLACEMENTS - x.n : 0 };
  };

  // {auth} -> {season, start, ends, modes:{solo, duos}, prev:{season, solo:{peak,tier}, duos}}
  async function rankedMe(env, b) {
    const me = await who(env, b.auth), now = Date.now(), s = seasonOf(now);
    const { results } = await env.DB.prepare('SELECT season, mode, r, rd, n, w, peak, at FROM ratings WHERE acct = ? AND season IN (?, ?)').bind(me.id, s, s - 1).all();
    const modes = {}, prev = { season: s - 1 };
    for (const mode of RANK_MODES) {
      const cur = results.find(x => x.season === s && x.mode === mode), old = results.find(x => x.season === s - 1 && x.mode === mode);
      if (cur) modes[mode] = rkRow(cur, now);
      else { const sr = softReset(old && { r: old.r, rd: old.rd }); modes[mode] = rkRow({ r: sr.r, rd: sr.rd, n: 0, w: 0, peak: 0, at: now }, now); modes[mode].fresh = 1; }
      if (old && old.peak > 0) prev[mode] = { peak: Math.round(old.peak), tier: tierOf(old.peak).k };
    }
    return json(200, { season: s, ends: seasonEnd(s), modes, prev, code: me.code });
  }

  // GET ?mode=solo[&s=season] -> {season, mode, at, top:[{c, n, t, r, tier, div, w, m}]}
  async function rankedTop(env, ctx, url) {
    const mode = url.searchParams.get('mode') || 'solo', now = Date.now(), cur = seasonOf(now);
    const s = +url.searchParams.get('s') || cur;
    if (!RANK_MODES.includes(mode) || !Number.isInteger(s) || s < 1 || s > cur) throw new HttpError(400, 'Bad request');
    return cached(ctx, url, 'rtop:' + s + ':' + mode, s < cur ? 3600 : 60, async () => {
      const { results } = await env.DB.prepare('SELECT r.acct, r.r, r.n, r.w, r.name, r.tag, p.fcode FROM ratings r LEFT JOIN profiles p ON p.acct = r.acct WHERE r.season = ? AND r.mode = ? ORDER BY r.r DESC LIMIT ?').bind(s, mode, TOP_RANKED).all();
      return { season: s, mode, at: now, top: results.map(x => { const t = tierOf(x.r); return { k: x.acct.slice(0, 6), c: x.fcode || '', n: x.name, t: x.tag, r: Math.round(x.r), tier: t.k, div: t.div, m: x.n, w: x.w }; }) };
    });
  }

  // {auth, mode} -> {rank, total, r} (only asked for when you are not in the top 100)
  async function rankedRank(env, b) {
    const me = await who(env, b.auth), s = seasonOf(Date.now());
    if (!RANK_MODES.includes(b.mode)) throw new HttpError(400, 'Bad mode');
    const row = await env.DB.prepare('SELECT r FROM ratings WHERE acct = ? AND season = ? AND mode = ?').bind(me.id, s, b.mode).first();
    if (!row) return json(200, { none: true });
    const [a, c] = await env.DB.batch([
      env.DB.prepare('SELECT COUNT(*) AS n FROM ratings WHERE season = ? AND mode = ? AND r > ?').bind(s, b.mode, row.r),
      env.DB.prepare('SELECT COUNT(*) AS n FROM ratings WHERE season = ? AND mode = ?').bind(s, b.mode),
    ]);
    return json(200, { rank: a.results[0].n + 1, total: c.results[0].n, r: Math.round(row.r) });
  }

  const loadMatch = async (env, mid) => {
    if (!validMid(mid)) throw new HttpError(400, 'Bad match');
    const m = await env.DB.prepare('SELECT id, mode, season, host, created, st, seats, parts, teams, reps, rep0, res FROM rmatch WHERE id = ?').bind(mid).first();
    if (!m) throw new HttpError(404, 'No such match');
    m.seats = JSON.parse(m.seats); m.parts = m.parts ? JSON.parse(m.parts) : null; m.reps = JSON.parse(m.reps || '{}'); m.res = m.res ? JSON.parse(m.res) : null;
    return m;
  };
  const sidOf = (m, acct) => Object.keys(m.seats).find(s => m.seats[s].a === acct) || '';

  // {auth, mid, sids:[seat ids in roster order], teams} -> {ok}: the host registers who actually joined
  async function rankedStart(env, b) {
    const me = await who(env, b.auth), m = await loadMatch(env, b.mid);
    if (m.seats[m.host].a !== me.id) throw new HttpError(403, 'Only the host registers the match');
    if (m.st !== 'p') throw new HttpError(409, 'Already registered');
    if (Date.now() - m.created > 10 * 60000) throw new HttpError(409, 'Too late');
    const sids = Array.isArray(b.sids) ? b.sids : [];
    if (sids.length < 2 || new Set(sids).size !== sids.length || !sids.every(s => validSid(s) && m.seats[s]) || !sids.includes(m.host)) throw new HttpError(400, 'Bad participants');
    const teams = Number.isInteger(b.teams) && b.teams >= 2 && b.teams <= 8 ? b.teams : sids.length;
    const r = await env.DB.prepare("UPDATE rmatch SET st = 'r', parts = ?, teams = ? WHERE id = ? AND st = 'p'").bind(JSON.stringify(sids), teams, m.id).run();
    if (r.meta.changes !== 1) throw new HttpError(409, 'Already registered');
    return json(200, { ok: true, parts: sids });
  }

  /** rate a match whose reports agree (once: the st guard makes a second caller a no-op) */
  async function finalize(env, ctx, m, c) {
    const now = Date.now(), places = humanPlaces(m.parts, c), wk = weekKey(now);
    const rated = rateMatch(m.parts.map(sid => {
      const S = m.seats[sid];
      return { id: sid, r: S.r, rd: S.rd, place: places[sid] };
    }));
    const res = {};
    for (const x of rated) res[x.id] = { p: places[x.id], d: x.d, r: x.r };
    const g = await env.DB.prepare("UPDATE rmatch SET st = 'd', res = ? WHERE id = ? AND st = 'r'").bind(JSON.stringify(res), m.id).run();
    if (g.meta.changes !== 1) return res;
    const st = [], batPts = {};
    for (const x of rated) {
      const S = m.seats[x.id], win = places[x.id] === 1 ? 1 : 0;
      st.push(env.DB.prepare(`INSERT INTO ratings (acct, season, mode, r, rd, n, w, peak, at, name, tag) VALUES (?,?,?,?,?,1,?,?,?,?,?)
        ON CONFLICT(acct, season, mode) DO UPDATE SET r = r + ?, rd = excluded.rd, n = n + 1, w = w + excluded.w,
        peak = CASE WHEN n + 1 >= ? THEN max(peak, r + ?) ELSE peak END, at = excluded.at, name = excluded.name, tag = excluded.tag`)
        .bind(S.a, m.season, m.mode, x.r, x.rd, win, PLACEMENTS <= 1 ? x.r : 0, now, S.n, S.t || '', x.d, PLACEMENTS, x.d));
      const pts = batPoints(c.left.includes(x.id) ? 99 : c.pl[x.id], m.teams || m.parts.length, c.left.includes(x.id));
      if (S.b && pts) {
        batPts[S.b] = (batPts[S.b] || 0) + pts;
        st.push(env.DB.prepare('UPDATE bat_mem SET pts = CASE WHEN wk = ? THEN pts + ? ELSE ? END, wk = ?, tot = tot + ? WHERE acct = ? AND bat = ?').bind(wk, pts, pts, wk, pts, S.a, S.b));
      }
    }
    for (const bat in batPts) st.push(env.DB.prepare('INSERT INTO bat_wk (wk, bat, pts) VALUES (?,?,?) ON CONFLICT(wk, bat) DO UPDATE SET pts = pts + excluded.pts').bind(wk, bat, batPts[bat]));
    await env.DB.batch(st);
    return res;
  }

  const outcome = (m, sid) => {
    if (m.st === 'd') { const r = m.res && m.res[sid]; return { st: 'done', d: r ? r.d : 0, r: r ? Math.round(r.r) : 0, p: r ? r.p : 0, tier: r ? tierOf(r.r).k : '', res: m.res }; }
    if (m.st === 'v') return { st: 'void' };
    return { st: 'wait', got: Object.keys(m.reps).length, of: m.parts ? m.parts.length : 0 };
  };

  async function settle(env, ctx, m) {
    if (m.st !== 'r') return m;
    const gms = Math.max(0, +(env.RANKED_GRACE ?? GRACE / 1000)) * 1000; // RANKED_GRACE (s): tests shorten it
    const grace = !!m.rep0 && Date.now() - m.rep0 > gms || Date.now() - m.created > 90 * 60000;
    const c = consensus(m.parts, m.reps, grace);
    if (c.st === 'ok') { m.res = await finalize(env, ctx, m, c); m.st = 'd'; }
    else if (c.st === 'void') { await env.DB.prepare("UPDATE rmatch SET st = 'v' WHERE id = ? AND st = 'r'").bind(m.id).run(); m.st = 'v'; }
    return m;
  }

  // {auth, mid, h, pl:{sid:place}, left:[sid], bad} -> {st:'wait'|'done'|'void', d?, r?}
  async function rankedReport(env, ctx, b) {
    const me = await who(env, b.auth);
    let m = await loadMatch(env, b.mid);
    const sid = sidOf(m, me.id);
    if (!sid || !m.parts || !m.parts.includes(sid)) throw new HttpError(403, 'You are not in that match');
    if (m.st !== 'r') return json(200, outcome(m, sid));
    if (m.reps[sid]) return json(200, outcome(await settle(env, ctx, m), sid));
    const rep = cleanReport(b, m.parts);
    if (!rep) throw new HttpError(400, 'Bad report');
    // one write: the report lands only if this seat has not reported yet and the match is still open
    const now = Date.now();
    const row = await env.DB.prepare("UPDATE rmatch SET reps = json_set(reps, '$.' || ?, json(?)), rep0 = COALESCE(rep0, ?) WHERE id = ? AND st = 'r' AND json_extract(reps, '$.' || ?) IS NULL RETURNING reps, rep0, st")
      .bind(sid, JSON.stringify(rep), now, m.id, sid).first();
    if (row) { m.reps = JSON.parse(row.reps); m.rep0 = row.rep0; }
    else m = await loadMatch(env, b.mid);
    return json(200, outcome(await settle(env, ctx, m), sid));
  }

  // {auth, mid} -> the match outcome for me (settles it when the grace period is over)
  async function rankedResult(env, ctx, b) {
    const me = await who(env, b.auth), m = await loadMatch(env, b.mid), sid = sidOf(m, me.id);
    if (!sid) throw new HttpError(403, 'You are not in that match');
    return json(200, outcome(await settle(env, ctx, m), sid));
  }

  /* ---------------- battalions ---------------- */

  const batPublic = x => ({ id: x.id, name: x.name, tag: x.tag, bn: x.bn, em: x.em, desc: x.descr, open: x.open, n: x.n, created: x.created });
  const memRow = x => ({ c: x.fcode, n: x.name, lv: x.lv, cls: x.cls, role: x.role, pts: x.pts, tot: x.tot, seen: x.seen, tier: x.r != null ? tierOf(x.r).k : '', rn: x.rn || 0 });
  const needBat = me => { if (!me.bat) throw new HttpError(409, 'You are not in a battalion'); };
  const needCode = me => { if (!me.code) throw new HttpError(409, 'Open Friends once to get your friend code'); };
  const officer = me => me.role === 'l' || me.role === 'o';
  const notifyBat = (env, ctx, code, bat, notify) => { if (code) later(ctx, DO(env).batSet(code, bat || '', !!notify)); };

  async function members(env, bat) {
    const wk = weekKey(Date.now()), s = seasonOf(Date.now());
    const { results } = await env.DB.prepare(`SELECT m.role, CASE WHEN m.wk = ? THEN m.pts ELSE 0 END AS pts, m.tot, p.fcode, p.name, p.lv, p.cls, p.seen, r.r, r.n AS rn
      FROM bat_mem m JOIN profiles p ON p.acct = m.acct LEFT JOIN ratings r ON r.acct = m.acct AND r.season = ? AND r.mode = 'solo'
      WHERE m.bat = ? LIMIT ?`).bind(wk, s, bat, BAT_CAP + 5).all();
    const ord = { l: 0, o: 1, m: 2 };
    return results.map(memRow).sort((a, b) => ord[a.role] - ord[b.role] || b.pts - a.pts || a.n.localeCompare(b.n));
  }
  async function batWeek(env, bat) {
    const r = await env.DB.prepare('SELECT pts FROM bat_wk WHERE wk = ? AND bat = ?').bind(weekKey(Date.now()), bat).first();
    return r ? r.pts : 0;
  }

  // {auth, name, tag, bn, em, desc, open} -> {bat}
  async function batCreate(env, ctx, url, b) {
    const me = await who(env, b.auth); needCode(me);
    if (me.bat) throw new HttpError(409, 'Leave your battalion first');
    const name = cleanBatName(b.name), tag = cleanTag(b.tag), em = cleanEmblem(b.em) || 'bolt', bn = cleanBanner(b.bn);
    if (!name) throw new HttpError(400, 'Names are 3-20 letters, digits or spaces, and must be clean');
    if (!tag) throw new HttpError(400, 'Tags are 3-4 letters or digits, and must be clean');
    if (!await allow(env.RL_NEW, memBat, 'bat:' + me.id)) throw tooMany(); // after the checks: typos do not count
    const id = randB32(BAT_ID_LEN), now = Date.now();
    const ins = await env.DB.prepare('INSERT INTO bat (id, name, name_k, tag, bn, em, descr, open, n, created) VALUES (?,?,?,?,?,?,?,?,1,?) ON CONFLICT DO NOTHING')
      .bind(id, name, name.toLowerCase(), tag, bn, em, cleanDesc(b.desc), b.open === false || b.open === 0 ? 0 : 1, now).run();
    if (ins.meta.changes !== 1) {
      const t = await env.DB.prepare('SELECT tag FROM bat WHERE tag = ?').bind(tag).first();
      throw new HttpError(409, t ? 'That tag is taken' : 'That name is taken');
    }
    const mem = await env.DB.prepare("INSERT INTO bat_mem (acct, bat, role, joined) VALUES (?, ?, 'l', ?) ON CONFLICT(acct) DO NOTHING").bind(me.id, id, now).run();
    if (mem.meta.changes !== 1) { await env.DB.prepare('DELETE FROM bat WHERE id = ?').bind(id).run(); throw new HttpError(409, 'Leave your battalion first'); }
    await env.DB.prepare('DELETE FROM bat_inv WHERE acct = ?').bind(me.id).run();
    notifyBat(env, ctx, me.code, id, false);
    later(ctx, uncache(url, 'btop:' + weekKey(now)));
    return json(200, { bat: { id, name, tag, bn, em, desc: cleanDesc(b.desc), open: b.open === false || b.open === 0 ? 0 : 1, n: 1 }, role: 'l' });
  }

  // {auth} -> {bat, role, members, wk} | {bat:null, inv:[{id,name,tag,bn,em,n,by}]}
  async function batMe(env, b) {
    const me = await who(env, b.auth);
    if (!me.bat) {
      const { results } = await env.DB.prepare('SELECT b.id, b.name, b.tag, b.bn, b.em, b.n, b.open, b.descr, b.created, i.by_name FROM bat_inv i JOIN bat b ON b.id = i.bat WHERE i.acct = ? AND i.exp > ? LIMIT 20').bind(me.id, Date.now()).all();
      return json(200, { bat: null, code: me.code, inv: results.map(x => Object.assign(batPublic(x), { by: x.by_name })) });
    }
    const [bt, mem, wk] = await Promise.all([
      env.DB.prepare('SELECT * FROM bat WHERE id = ?').bind(me.bat).first(), members(env, me.bat), batWeek(env, me.bat),
    ]);
    if (!bt) return json(200, { bat: null, code: me.code, inv: [] });
    return json(200, { bat: Object.assign(batPublic(bt), { wk }), role: me.role, code: me.code, members: mem });
  }

  // GET ?id=ID | ?tag=TAG -> public battalion profile (cached 60 s)
  async function batGet(env, ctx, url) {
    const id = url.searchParams.get('id'), tag = cleanTag(url.searchParams.get('tag'));
    if (!(id && /^[0-9A-Z]{8}$/.test(id)) && !tag) throw new HttpError(400, 'Bad request');
    const bt = id ? await env.DB.prepare('SELECT * FROM bat WHERE id = ?').bind(id).first() : await env.DB.prepare('SELECT * FROM bat WHERE tag = ?').bind(tag).first();
    if (!bt) throw new HttpError(404, 'No battalion with that tag');
    return cached(ctx, url, 'bat:' + bt.id, 60, async () => {
      const [mem, wk] = await Promise.all([members(env, bt.id), batWeek(env, bt.id)]);
      for (const x of mem) delete x.seen; // last seen is for members only
      return { bat: Object.assign(batPublic(bt), { wk }), members: mem };
    });
  }

  // {auth, id} -> {bat, role}: join an open battalion, or one that invited you
  async function batJoin(env, ctx, url, b) {
    const me = await who(env, b.auth); needCode(me);
    if (me.bat) throw new HttpError(409, 'Leave your battalion first');
    if (typeof b.id !== 'string' || !/^[0-9A-Z]{8}$/.test(b.id)) throw new HttpError(400, 'Bad battalion');
    const [bt, inv] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM bat WHERE id = ?').bind(b.id),
      env.DB.prepare('SELECT exp FROM bat_inv WHERE acct = ? AND bat = ?').bind(me.id, b.id),
    ]);
    const x = bt.results[0], invited = inv.results[0] && inv.results[0].exp > Date.now();
    if (!x) throw new HttpError(404, 'That battalion is gone');
    if (!x.open && !invited) throw new HttpError(403, 'That battalion is invite only');
    const g = await env.DB.prepare('UPDATE bat SET n = n + 1 WHERE id = ? AND n < ?').bind(b.id, BAT_CAP).run();
    if (g.meta.changes !== 1) throw new HttpError(409, 'That battalion is full (' + BAT_CAP + ')');
    const ins = await env.DB.prepare("INSERT INTO bat_mem (acct, bat, role, joined) VALUES (?, ?, 'm', ?) ON CONFLICT(acct) DO NOTHING").bind(me.id, b.id, Date.now()).run();
    if (ins.meta.changes !== 1) { await env.DB.prepare('UPDATE bat SET n = n - 1 WHERE id = ?').bind(b.id).run(); throw new HttpError(409, 'Leave your battalion first'); }
    await env.DB.prepare('DELETE FROM bat_inv WHERE acct = ?').bind(me.id).run();
    notifyBat(env, ctx, me.code, b.id, false);
    later(ctx, uncache(url, 'bat:' + b.id));
    return json(200, { bat: Object.assign(batPublic(x), { n: x.n + 1 }), role: 'm' });
  }

  /** remove account `acct` (friend code `code`) from battalion `bat`; the leader's role passes on, the last one disbands */
  async function removeMember(env, ctx, url, bat, acct, code, wasLeader) {
    const st = [env.DB.prepare('DELETE FROM bat_mem WHERE acct = ? AND bat = ?').bind(acct, bat)];
    const left = await env.DB.prepare('SELECT acct, role FROM bat_mem WHERE bat = ? AND acct <> ? ORDER BY (role = \'o\') DESC, joined ASC LIMIT 1').bind(bat, acct).first();
    if (!left) st.push(env.DB.prepare('DELETE FROM bat WHERE id = ?').bind(bat), env.DB.prepare('DELETE FROM bat_inv WHERE bat = ?').bind(bat));
    else {
      st.push(env.DB.prepare('UPDATE bat SET n = n - 1 WHERE id = ?').bind(bat));
      if (wasLeader) st.push(env.DB.prepare("UPDATE bat_mem SET role = 'l' WHERE acct = ?").bind(left.acct));
    }
    await env.DB.batch(st);
    notifyBat(env, ctx, code, '', true);
    later(ctx, uncache(url, 'bat:' + bat));
    return !left;
  }

  // {auth} -> {ok, disbanded}
  async function batLeave(env, ctx, url, b) {
    const me = await who(env, b.auth); needBat(me);
    const gone = await removeMember(env, ctx, url, me.bat, me.id, me.code, me.role === 'l');
    return json(200, { ok: true, disbanded: gone });
  }

  /** a member of my battalion by friend code */
  async function memberByCode(env, me, codeIn) {
    const c = normFriendCode(codeIn);
    if (!c) throw new HttpError(400, 'Friend codes are 8 characters');
    const t = await env.DB.prepare('SELECT p.acct, p.fcode, p.name, m.bat, m.role FROM profiles p LEFT JOIN bat_mem m ON m.acct = p.acct WHERE p.fcode = ?').bind(c).first();
    if (!t) throw new HttpError(404, 'No player with that friend code');
    return t;
  }

  // {auth, code} -> {ok}: officers and the leader invite by friend code (7 days)
  async function batInvite(env, ctx, b) {
    const me = await who(env, b.auth); needBat(me);
    if (!officer(me)) throw new HttpError(403, 'Only officers and the leader can invite');
    if (!await allow(env.RL_NEW, memBat, 'binv:' + me.id)) throw tooMany();
    const t = await memberByCode(env, me, b.code);
    if (t.acct === me.id) throw new HttpError(400, 'That is you');
    if (t.bat === me.bat) throw new HttpError(409, 'Already in your battalion');
    if (t.bat) throw new HttpError(409, 'That player is in another battalion');
    const blocked = await env.DB.prepare("SELECT 1 AS x FROM links WHERE a = ? AND b = ? AND st = 'b'").bind(t.acct, me.id).first();
    if (blocked) throw new HttpError(404, 'No player with that friend code');
    await env.DB.prepare('INSERT INTO bat_inv (acct, bat, by_name, exp) VALUES (?,?,?,?) ON CONFLICT(acct, bat) DO UPDATE SET by_name = excluded.by_name, exp = excluded.exp')
      .bind(t.acct, me.bat, me.name, Date.now() + INVITE_DAYS * 86400000).run();
    notifyBat(env, ctx, t.fcode, '', true); // their battalion is unchanged ('' = none); they just refetch and see the invite
    return json(200, { ok: true, n: t.name });
  }

  // {auth, code, a: kick|promote|demote|lead} or {auth, id, a: decline}
  async function batAct(env, ctx, url, b) {
    const me = await who(env, b.auth), a = b.a;
    if (a === 'decline') {
      if (typeof b.id !== 'string') throw new HttpError(400, 'Bad battalion');
      await env.DB.prepare('DELETE FROM bat_inv WHERE acct = ? AND bat = ?').bind(me.id, b.id).run();
      return json(200, { ok: true });
    }
    if (!['kick', 'promote', 'demote', 'lead'].includes(a)) throw new HttpError(400, 'Bad action');
    needBat(me);
    const t = await memberByCode(env, me, b.code);
    if (t.bat !== me.bat) throw new HttpError(404, 'Not in your battalion');
    if (t.acct === me.id) throw new HttpError(400, 'That is you');
    if (a === 'kick') {
      if (!(me.role === 'l' || (me.role === 'o' && t.role === 'm'))) throw new HttpError(403, 'You cannot remove that member');
      await removeMember(env, ctx, url, me.bat, t.acct, t.fcode, false);
      return json(200, { ok: true });
    }
    if (me.role !== 'l') throw new HttpError(403, 'Only the leader can change roles');
    if (a === 'promote' && t.role !== 'm') throw new HttpError(409, 'Already an officer');
    if (a === 'demote' && t.role !== 'o') throw new HttpError(409, 'Not an officer');
    const st = a === 'lead'
      ? [env.DB.prepare("UPDATE bat_mem SET role = 'l' WHERE acct = ? AND bat = ?").bind(t.acct, me.bat), env.DB.prepare("UPDATE bat_mem SET role = 'o' WHERE acct = ? AND bat = ?").bind(me.id, me.bat)]
      : [env.DB.prepare('UPDATE bat_mem SET role = ? WHERE acct = ? AND bat = ?').bind(a === 'promote' ? 'o' : 'm', t.acct, me.bat)];
    await env.DB.batch(st);
    notifyBat(env, ctx, t.fcode, me.bat, true);
    later(ctx, uncache(url, 'bat:' + me.bat));
    return json(200, { ok: true });
  }

  // {auth, desc?, bn?, em?, open?} -> {ok}: leader and officers
  async function batEdit(env, ctx, url, b) {
    const me = await who(env, b.auth); needBat(me);
    if (!officer(me)) throw new HttpError(403, 'Only officers and the leader can edit the battalion');
    const set = [], v = [];
    if (typeof b.desc === 'string') { set.push('descr = ?'); v.push(cleanDesc(b.desc)); }
    if (typeof b.bn === 'string') { set.push('bn = ?'); v.push(cleanBanner(b.bn)); }
    if (cleanEmblem(b.em)) { set.push('em = ?'); v.push(b.em); }
    if (b.open != null) { set.push('open = ?'); v.push(b.open ? 1 : 0); }
    if (!set.length) throw new HttpError(400, 'Nothing to change');
    await env.DB.prepare('UPDATE bat SET ' + set.join(', ') + ' WHERE id = ?').bind(...v, me.bat).run();
    later(ctx, uncache(url, 'bat:' + me.bat));
    return json(200, { ok: true });
  }

  // {auth, msg} -> {at, m}: one chat line (1 write), pushed live to connected members through the presence object
  async function batSay(env, ctx, b) {
    const me = await who(env, b.auth, false); needBat(me); needCode(me);
    const msg = cleanChat(b.msg);
    if (!msg) throw new HttpError(400, 'Empty message');
    if (!memSay.hit('s:' + me.id) || !memMin.hit('m:' + me.id) || !await allow(env.RL_ACCT, memAcct, 'acct:' + me.id)) throw tooMany();
    let at = Date.now();
    for (let i = 0; i < 3; i++, at++) {
      const r = await env.DB.prepare('INSERT INTO bat_chat (bat, at, code, name, msg) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING').bind(me.bat, at, me.code, me.name, msg).run();
      if (r.meta.changes === 1) break;
    }
    const line = { at, c: me.code, n: me.name, m: msg };
    later(ctx, DO(env).batMsg(me.bat, line));
    return json(200, line);
  }

  // {auth, since} -> {msgs:[{at,c,n,m}]} (the last CHAT_KEEP lines after `since`)
  async function batChat(env, b) {
    const me = await who(env, b.auth); needBat(me);
    const since = Number.isFinite(b.since) ? b.since : 0;
    const { results } = await env.DB.prepare('SELECT at, code, name, msg FROM bat_chat WHERE bat = ? AND at > ? ORDER BY at DESC LIMIT ?').bind(me.bat, since, CHAT_KEEP).all();
    return json(200, { msgs: results.reverse().map(x => ({ at: x.at, c: x.code, n: x.name, m: x.msg })) });
  }

  // GET [?wk=YYYY-MM-DD] -> {wk, top:[{id,name,tag,bn,em,n,pts}]} weekly battalion points (cached 60 s)
  async function batTop(env, ctx, url) {
    const cur = weekKey(Date.now()), wk = url.searchParams.get('wk') || cur;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(wk) || weekKey(Date.parse(wk + 'T00:00:00Z')) !== wk) throw new HttpError(400, 'Bad week');
    return cached(ctx, url, 'btop:' + wk, wk === cur ? 60 : 3600, async () => {
      const { results } = await env.DB.prepare('SELECT w.pts, b.id, b.name, b.tag, b.bn, b.em, b.n FROM bat_wk w JOIN bat b ON b.id = w.bat WHERE w.wk = ? ORDER BY w.pts DESC LIMIT 50').bind(wk).all();
      return { wk, at: Date.now(), top: results };
    });
  }

  // {auth, kind, target, why, ctx} -> {ok}: the report hook (stored for a human to read)
  async function report(env, b) {
    const me = await who(env, b.auth, false);
    if (!await allow(env.RL_NEW, memBat, 'rep:' + me.id)) throw tooMany();
    if (!REPORT_KINDS.includes(b.kind) || typeof b.target !== 'string' || !/^[0-9A-Z]{6,10}$/.test(b.target)) throw new HttpError(400, 'Bad report');
    await env.DB.prepare('INSERT INTO reports (at, by_acct, kind, target, why, ctx) VALUES (?,?,?,?,?,?)').bind(Date.now(), me.id, b.kind, b.target, cleanReportWhy(b.why), cleanReportWhy(b.ctx)).run();
    return json(200, { ok: true });
  }

  /** daily challenge hook: +3 battalion points for the first daily of the day (called after the insert) */
  async function dailyPoints(env, acct) {
    const m = await env.DB.prepare('SELECT bat FROM bat_mem WHERE acct = ?').bind(acct).first();
    if (!m) return;
    const wk = weekKey(Date.now());
    await env.DB.batch([
      env.DB.prepare('UPDATE bat_mem SET pts = CASE WHEN wk = ? THEN pts + 3 ELSE 3 END, wk = ?, tot = tot + 3 WHERE acct = ?').bind(wk, wk, acct),
      env.DB.prepare('INSERT INTO bat_wk (wk, bat, pts) VALUES (?,?,3) ON CONFLICT(wk, bat) DO UPDATE SET pts = pts + 3').bind(wk, m.bat),
    ]);
  }

  async function route(req, env, ctx, url, ip, body) {
    const p = url.pathname, M = req.method;
    if (p === '/api/ranked/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') throw new HttpError(426, 'Expected a WebSocket');
      if (!await allow(env.RL_ACCT, memAcct, 'rq:' + ip)) throw tooMany();
      return DO(env).fetch(req);
    }
    if (M === 'GET') {
      if (p === '/api/ranked/top') return rankedTop(env, ctx, url);
      if (p === '/api/bat/get') return batGet(env, ctx, url);
      if (p === '/api/bat/top') return batTop(env, ctx, url);
      return null;
    }
    if (M !== 'POST' || !/^\/api\/(ranked|bat|report)\b/.test(p)) return null;
    const b = await body(req);
    switch (p) {
      case '/api/ranked/me': return rankedMe(env, b);
      case '/api/ranked/rank': return rankedRank(env, b);
      case '/api/ranked/start': return rankedStart(env, b);
      case '/api/ranked/report': return rankedReport(env, ctx, b);
      case '/api/ranked/result': return rankedResult(env, ctx, b);
      case '/api/bat/create': return batCreate(env, ctx, url, b);
      case '/api/bat/me': return batMe(env, b);
      case '/api/bat/join': return batJoin(env, ctx, url, b);
      case '/api/bat/leave': return batLeave(env, ctx, url, b);
      case '/api/bat/invite': return batInvite(env, ctx, b);
      case '/api/bat/act': return batAct(env, ctx, url, b);
      case '/api/bat/edit': return batEdit(env, ctx, url, b);
      case '/api/bat/say': return batSay(env, ctx, b);
      case '/api/bat/chat': return batChat(env, b);
      case '/api/report': return report(env, b);
    }
    return null;
  }

  /** daily cron: expired invites, old chat, matches nobody finished */
  function cron(env, now) {
    return [
      env.DB.prepare('DELETE FROM bat_inv WHERE exp < ?').bind(now),
      env.DB.prepare('DELETE FROM bat_chat WHERE at < ?').bind(now - 7 * 86400000),
      env.DB.prepare("UPDATE rmatch SET st = 'v' WHERE st IN ('p', 'r') AND created < ?").bind(now - 86400000),
      env.DB.prepare('DELETE FROM rmatch WHERE created < ?').bind(now - 30 * 86400000),
      env.DB.prepare('DELETE FROM bat_wk WHERE wk < ?').bind(weekKey(now - 120 * 86400000)),
    ];
  }

  return { route, cron, dailyPoints };
}

