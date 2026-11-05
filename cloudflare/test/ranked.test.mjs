// Ranked against a real local Worker: the matchmaking queue (Signal Durable Object), match registration by the host,
// result reports that must agree, ratings, leavers, the leaderboard and battalion points from ranked results.
//   node --test test/ranked.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, env, sleep, get, j, P, mkUser, sock } from './rb-util.mjs';

setup();
const U = {};

/** queue `users` for `mode`; resolves when the host's room is open and every guest got the join code */
async function matchUp(users, mode = 'solo') {
  const S = [];
  for (const u of users) {
    const s = sock('/api/ranked/ws?a=' + u.id); await s.opened;
    s.send({ t: 'auth', auth: u.auth, mode });
    const q = await s.next(m => m.t === 'q' || m.t === 'err');
    assert.equal(q.t, 'q', JSON.stringify(q));
    S.push(s);
  }
  const got = await Promise.all(S.map(s => s.next(m => m.t === 'host' || m.t === 'match', 12000)));
  const hi = got.findIndex(m => m.t === 'host');
  assert.ok(hi >= 0, 'one player hosts');
  const host = got[hi];
  for (const m of got) { assert.equal(m.mid, host.mid); assert.equal(m.mode, mode); assert.equal(m.pl.length, users.length); }
  assert.match(host.code, /^[A-HJKMNP-Z2-9]{5}$/);
  S[hi].send({ t: 'open', mid: host.mid });
  for (let i = 0; i < S.length; i++) if (i !== hi) assert.equal((await S[i].next(m => m.t === 'join')).code, host.code);
  for (const s of S) s.ws.close();
  const sid = {}; users.forEach((u, i) => { sid[u.name] = got[i].me; });
  return { mid: host.mid, host: users[hi], sid, diff: host.diff, pl: host.pl };
}
const rep = (u, m, extra) => P('/api/ranked/report', Object.assign({ auth: u.auth, mid: m.mid }, extra));
const me = async u => (await P('/api/ranked/me', { auth: u.auth })).b;

test('setup: accounts with profiles; a fresh account starts at 1000 in placements', async () => {
  for (const n of ['ada', 'bix', 'cyd']) U[n.toUpperCase()] = await mkUser(n);
  const m = await me(U.ADA);
  assert.equal(m.modes.solo.r, 1000);
  assert.equal(m.modes.solo.tier, 'bronze');
  assert.equal(m.modes.solo.prov, 5);
  assert.ok(m.modes.solo.fresh);
  assert.ok(m.season >= 1 && m.ends > Date.now());
  assert.equal((await P('/api/ranked/me', { auth: 'nope' })).s, 401);
});

test('queue: auth by the first message, wrong account or mode refused, heartbeat answered', async () => {
  const bad = sock('/api/ranked/ws?a=' + U.ADA.id); await bad.opened;
  bad.send({ t: 'auth', auth: U.BIX.auth, mode: 'solo' }); // B's secret on A's socket
  assert.equal((await bad.next(m => m.t === 'err')).e, 'auth');
  assert.equal((await bad.closed).code, 4001);
  const bm = sock('/api/ranked/ws?a=' + U.ADA.id); await bm.opened;
  bm.send({ t: 'auth', auth: U.ADA.auth, mode: 'quads' });
  assert.equal((await bm.next(m => m.t === 'err')).e, 'mode');
  const hb = sock('/api/ranked/ws?a=' + U.ADA.id); await hb.opened;
  hb.send('{"type":"HEARTBEAT"}');
  assert.equal((await hb.next(m => m.type === 'HEARTBEAT')).type, 'HEARTBEAT');
  hb.ws.close();
  assert.equal((await get('/api/ranked/ws?a=' + U.ADA.id)).status, 426);
  const nope = sock('/api/ranked/ws?a=short'); await nope.opened;
  assert.equal((await nope.next(m => m.t === 'err')).e, 'auth');
});

test('queue: two players are matched, the host opens a room, the guest gets its code; host leaving cancels', async () => {
  // a lone player waits (no match with nobody)
  const a = sock('/api/ranked/ws?a=' + U.ADA.id); await a.opened;
  a.send({ t: 'auth', auth: U.ADA.auth, mode: 'duos' });
  const q = await a.next(m => m.t === 'q');
  assert.deepEqual([q.mode, q.r, q.n], ['duos', 1000, 1]);
  await a.next(m => m.t === 'qs', 6000);
  const b = sock('/api/ranked/ws?a=' + U.BIX.id); await b.opened;
  b.send({ t: 'auth', auth: U.BIX.auth, mode: 'duos' });
  const ha = await a.next(m => m.t === 'host' || m.t === 'match', 12000), hb = await b.next(m => m.t === 'host' || m.t === 'match', 12000);
  assert.equal(ha.t, 'host', 'the longest-waiting player hosts');
  assert.equal(hb.t, 'match');
  assert.equal(hb.host, 'ADA');
  assert.equal(ha.diff, 'recruit', 'AI difficulty follows the lobby rating (1000: Recruit)');
  // the host leaves before opening the room: the guest is told and re-queues
  a.ws.close();
  assert.equal((await b.next(m => m.t === 'cancel')).t, 'cancel');
  b.send({ t: 'q', mode: 'duos' });
  assert.equal((await b.next(m => m.t === 'q')).mode, 'duos');
  b.send({ t: 'leave' }); b.ws.close();
});

let M1;
test('register: only the host, only matched seats, once', async () => {
  M1 = await matchUp([U.ADA, U.BIX]);
  const guest = M1.host === U.ADA ? U.BIX : U.ADA, sids = [M1.sid.ADA, M1.sid.BIX];
  assert.equal((await P('/api/ranked/start', { auth: guest.auth, mid: M1.mid, sids })).s, 403);
  assert.equal((await P('/api/ranked/start', { auth: M1.host.auth, mid: M1.mid, sids: [M1.sid.ADA, 'ZZZZZZ'] })).s, 400);
  assert.equal((await P('/api/ranked/start', { auth: M1.host.auth, mid: M1.mid, sids: [M1.sid.ADA] })).s, 400);
  assert.equal((await P('/api/ranked/start', { auth: M1.host.auth, mid: 'ZZZZZZZZZZ', sids })).s, 404);
  const r = await P('/api/ranked/start', { auth: M1.host.auth, mid: M1.mid, sids, teams: 8 });
  assert.deepEqual([r.s, r.b.parts], [200, sids]);
  assert.equal((await P('/api/ranked/start', { auth: M1.host.auth, mid: M1.mid, sids })).s, 409);
});

test('report: agreeing reports rate the match (winner up, loser down); outsiders and junk refused; once per seat', async () => {
  const pl = { [M1.sid.ADA]: 1, [M1.sid.BIX]: 4 };
  assert.equal((await rep(U.CYD, M1, { h: 123, pl })).s, 403);
  assert.equal((await rep(U.ADA, M1, { h: 'x', pl })).s, 400);
  assert.equal((await rep(U.ADA, M1, { h: 123, pl: { [M1.sid.ADA]: 1 } })).s, 400);
  let r = await rep(U.ADA, M1, { h: 123456, pl, left: [] });
  assert.deepEqual([r.s, r.b.st, r.b.got, r.b.of], [200, 'wait', 1, 2]);
  r = await rep(U.ADA, M1, { h: 999, pl }); // a second report from the same seat changes nothing
  assert.equal(r.b.st, 'wait');
  r = await rep(U.BIX, M1, { h: 123456, pl, left: [] });
  assert.equal(r.b.st, 'done');
  assert.ok(r.b.d < 0, 'the loser loses rating: ' + r.b.d);
  const a = await P('/api/ranked/result', { auth: U.ADA.auth, mid: M1.mid });
  assert.equal(a.b.st, 'done'); assert.ok(a.b.d > 0, 'the winner gains: ' + a.b.d);
  assert.equal(Math.round(a.b.d), -Math.round(r.b.d), 'equal ratings and deviations: symmetric change');
  const ma = await me(U.ADA), mb = await me(U.BIX);
  assert.deepEqual([ma.modes.solo.n, ma.modes.solo.w, mb.modes.solo.n, mb.modes.solo.w], [1, 1, 1, 0]);
  assert.ok(ma.modes.solo.r > 1000 && mb.modes.solo.r < 1000);
  assert.ok(ma.modes.solo.rd < 300, 'deviation shrinks after a match');
  assert.equal(ma.modes.solo.prov, 4);
  assert.equal(ma.modes.duos.r, 1000, 'modes are rated separately');
  assert.equal((await rep(U.ADA, M1, { h: 1, pl })).b.st, 'done', 'reports after the result just return it');
});

test('report: disagreeing reports void the match (no rating change)', async () => {
  const before = [(await me(U.ADA)).modes.solo.r, (await me(U.BIX)).modes.solo.r];
  const m = await matchUp([U.ADA, U.BIX]);
  assert.equal((await P('/api/ranked/start', { auth: m.host.auth, mid: m.mid, sids: [m.sid.ADA, m.sid.BIX] })).s, 200);
  assert.equal((await rep(U.ADA, m, { h: 1, pl: { [m.sid.ADA]: 1, [m.sid.BIX]: 2 } })).b.st, 'wait');
  assert.equal((await rep(U.BIX, m, { h: 2, pl: { [m.sid.ADA]: 2, [m.sid.BIX]: 1 } })).b.st, 'void');
  assert.deepEqual([(await me(U.ADA)).modes.solo.r, (await me(U.BIX)).modes.solo.r], before);
});

test('report: a broken ruleset (bad) from one player voids a two-player match', async () => {
  const m = await matchUp([U.ADA, U.BIX]);
  assert.equal((await P('/api/ranked/start', { auth: m.host.auth, mid: m.mid, sids: [m.sid.ADA, m.sid.BIX] })).s, 200);
  assert.equal((await rep(U.ADA, m, { h: 5, pl: { [m.sid.ADA]: 1, [m.sid.BIX]: 2 } })).b.st, 'wait');
  assert.equal((await rep(U.BIX, m, { bad: 1 })).b.st, 'void');
});

test('leaver: the one who stays reports alone; after the grace period the leaver takes the loss', async () => {
  const b0 = (await me(U.BIX)).modes.solo.r;
  const m = await matchUp([U.ADA, U.BIX]);
  assert.equal((await P('/api/ranked/start', { auth: m.host.auth, mid: m.mid, sids: [m.sid.ADA, m.sid.BIX] })).s, 200);
  // BIX disconnected mid-match: their operative was played by AI and even placed 1st, but leavers are rated last
  const r = await rep(U.ADA, m, { h: 77, pl: { [m.sid.ADA]: 3, [m.sid.BIX]: 1 }, left: [m.sid.BIX] });
  assert.equal(r.b.st, 'wait');
  await sleep(3500);
  const x = await P('/api/ranked/result', { auth: U.BIX.auth, mid: m.mid });
  assert.equal(x.b.st, 'done');
  assert.ok(x.b.d < 0 && (await me(U.BIX)).modes.solo.r < b0, 'the leaver lost rating');
  assert.ok((await P('/api/ranked/result', { auth: U.ADA.auth, mid: m.mid })).b.d > 0);
});

test('leaderboard: top 100 (cached) and your position', async () => {
  const t = await j(await get('/api/ranked/top?mode=solo'));
  assert.equal(t.s, 200);
  assert.deepEqual(t.b.top.map(x => x.n), ['ADA', 'BIX']);
  assert.equal(t.b.top[0].c, U.ADA.code);
  assert.ok(t.b.top[0].r > t.b.top[1].r && t.b.top[0].tier && t.b.top[0].m === 2);
  assert.ok(!JSON.stringify(t.b).includes(U.ADA.id), 'never the account id');
  assert.match(t.h.get('cache-control'), /max-age=60/);
  assert.equal((await j(await get('/api/ranked/top?mode=solo'))).h.get('x-cache'), 'MEM');
  assert.equal((await get('/api/ranked/top?mode=quads')).status, 400);
  const rk = await P('/api/ranked/rank', { auth: U.BIX.auth, mode: 'solo' });
  assert.deepEqual([rk.b.rank, rk.b.total], [2, 2]);
  assert.ok((await P('/api/ranked/rank', { auth: U.CYD.auth, mode: 'solo' })).b.none);
});

test('battalion points: a ranked result adds weekly points to the members\' battalions', async () => {
  const c = await P('/api/bat/create', { auth: U.ADA.auth, name: 'Ranked Crew', tag: 'RKC', bn: 'bn_std', em: 'bolt' });
  assert.equal(c.s, 200);
  const m = await matchUp([U.ADA, U.CYD]);
  assert.equal(m.pl.find(p => p.n === 'ADA').t, 'RKC', 'the matchmaker knows the battalion tag');
  assert.equal((await P('/api/ranked/start', { auth: m.host.auth, mid: m.mid, sids: [m.sid.ADA, m.sid.CYD], teams: 8 })).s, 200);
  const pl = { [m.sid.ADA]: 1, [m.sid.CYD]: 2 };
  await rep(U.ADA, m, { h: 9, pl }); assert.equal((await rep(U.CYD, m, { h: 9, pl })).b.st, 'done');
  const top = await j(await get('/api/bat/top'));
  assert.deepEqual(top.b.top.map(x => [x.tag, x.pts]), [['RKC', 10]]);
  const bm = await P('/api/bat/me', { auth: U.ADA.auth });
  assert.equal(bm.b.bat.wk, 10);
  assert.equal(bm.b.members[0].pts, 10);
  assert.ok(bm.b.members[0].tier, 'members show their ranked tier');
  const t = await j(await get('/api/ranked/top?mode=solo&s=' + (await me(U.ADA)).season));
  assert.ok(t.b.top.length >= 2);
});
