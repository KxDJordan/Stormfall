// Battalions against a real local Worker: create / join / invite / roles / kick / leave, chat (stored + pushed live through
// the presence socket), battalion mates on the presence socket (presence, room invites without being friends),
// moderation (name and tag filter, chat masking and rate limit, the report hook) and the public profile / leaderboard.
//   node --test test/battalion.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, sleep, get, j, P, mkUser, sock } from './rb-util.mjs';

setup();
const U = {};
let BAT;
const bme = async u => (await P('/api/bat/me', { auth: u.auth })).b;
async function online(u, st = { s: 'menu' }) {
  const s = sock('/api/social/ws?c=' + u.code); await s.opened;
  s.send(Object.assign({ t: 'auth', auth: u.auth }, st));
  s.hi = await s.next(m => m.t === 'hi');
  return s;
}

test('create: name and tag rules, profanity filter, unique names and tags', async () => {
  for (const n of ['lead', 'offi', 'memb', 'solo']) U[n.toUpperCase()] = await mkUser(n);
  const mk = b => P('/api/bat/create', Object.assign({ auth: U.LEAD.auth, bn: 'bn_signal', em: 'wolf', desc: 'We hold the line' }, b));
  assert.equal((await mk({ name: 'ab', tag: 'ABC' })).s, 400);
  assert.equal((await mk({ name: 'Iron Wolves', tag: 'AB' })).s, 400);
  assert.equal((await mk({ name: 'Iron Wolves', tag: 'ABCDE' })).s, 400);
  assert.equal((await mk({ name: 'Sh1t Squad', tag: 'OKAY' })).s, 400, 'profane name (leetspeak) refused');
  assert.equal((await mk({ name: 'Nice Name', tag: 'FUK' })).s, 400, 'profane tag refused');
  assert.equal((await mk({ name: 'Iron <b>Wolves', tag: 'IRW' })).s, 400);
  const r = await mk({ name: 'Iron Wolves', tag: 'irw', desc: 'We hold the line. No shit.' });
  assert.equal(r.s, 200);
  BAT = r.b.bat;
  assert.deepEqual([BAT.name, BAT.tag, BAT.em, BAT.bn, BAT.n, r.b.role], ['Iron Wolves', 'IRW', 'wolf', 'bn_signal', 1, 'l']);
  assert.equal(BAT.desc, 'We hold the line. No s***.', 'profanity in the description is masked');
  assert.equal((await mk({ name: 'Other', tag: 'OTH' })).s, 409, 'one battalion per player');
  const dupName = await P('/api/bat/create', { auth: U.SOLO.auth, name: 'iron wolves', tag: 'XYZ', bn: 'bn_std', em: 'bolt' });
  assert.deepEqual([dupName.s, dupName.b.error], [409, 'That name is taken']);
  const dupTag = await P('/api/bat/create', { auth: U.SOLO.auth, name: 'Steel', tag: 'IRW', bn: 'bn_std', em: 'bolt' });
  assert.deepEqual([dupTag.s, dupTag.b.error], [409, 'That tag is taken']);
});

test('profile page: public by id or tag, cached; my battalion with roles', async () => {
  const g = await j(await get('/api/bat/get?tag=irw'));
  assert.equal(g.s, 200);
  assert.deepEqual([g.b.bat.id, g.b.bat.tag, g.b.members.length, g.b.members[0].role, g.b.members[0].n], [BAT.id, 'IRW', 1, 'l', 'LEAD']);
  assert.equal(g.b.members[0].seen, undefined, 'last seen is for members only');
  assert.match(g.h.get('cache-control'), /max-age=60/);
  assert.equal((await get('/api/bat/get?id=' + BAT.id)).status, 200);
  assert.equal((await get('/api/bat/get?tag=NONE')).status, 404);
  assert.equal((await get('/api/bat/get')).status, 400);
  const m = await bme(U.LEAD);
  assert.deepEqual([m.bat.id, m.role, m.members.length, m.bat.wk], [BAT.id, 'l', 1, 0]);
  assert.equal((await bme(U.SOLO)).bat, null);
});

test('join: open battalions by id; invite-only needs an invite; invites arrive live', async () => {
  let r = await P('/api/bat/join', { auth: U.OFFI.auth, id: BAT.id });
  assert.deepEqual([r.s, r.b.role, r.b.bat.n], [200, 'm', 2]);
  assert.equal((await P('/api/bat/join', { auth: U.OFFI.auth, id: BAT.id })).s, 409);
  // invite only from now on
  assert.equal((await P('/api/bat/edit', { auth: U.OFFI.auth, open: false })).s, 403, 'members cannot edit');
  assert.equal((await P('/api/bat/edit', { auth: U.LEAD.auth, open: false, desc: 'Invite only' })).s, 200);
  assert.equal((await P('/api/bat/join', { auth: U.MEMB.auth, id: BAT.id })).s, 403);
  assert.equal((await P('/api/bat/invite', { auth: U.OFFI.auth, code: U.MEMB.code })).s, 403, 'members cannot invite');
  const ms = await online(U.MEMB);
  r = await P('/api/bat/invite', { auth: U.LEAD.auth, code: U.MEMB.code.toLowerCase() });
  assert.deepEqual([r.s, r.b.n], [200, 'MEMB']);
  await ms.next(m => m.t === 'bx');
  const inv = (await bme(U.MEMB)).inv;
  assert.deepEqual(inv.map(x => [x.tag, x.by]), [['IRW', 'LEAD']]);
  assert.equal((await P('/api/bat/invite', { auth: U.LEAD.auth, code: U.OFFI.code })).s, 409, 'already a member');
  r = await P('/api/bat/join', { auth: U.MEMB.auth, id: BAT.id });
  assert.equal(r.s, 200);
  assert.equal((await bme(U.MEMB)).members.length, 3);
  ms.ws.close();
  // decline an invite
  await P('/api/bat/invite', { auth: U.LEAD.auth, code: U.SOLO.code });
  assert.equal((await bme(U.SOLO)).inv.length, 1);
  assert.equal((await P('/api/bat/act', { auth: U.SOLO.auth, id: BAT.id, a: 'decline' })).s, 200);
  assert.equal((await bme(U.SOLO)).inv.length, 0);
});

test('roles: the leader promotes and demotes; officers kick members but not officers; leadership passes', async () => {
  assert.equal((await P('/api/bat/act', { auth: U.OFFI.auth, code: U.MEMB.code, a: 'kick' })).s, 403, 'members cannot kick');
  assert.equal((await P('/api/bat/act', { auth: U.LEAD.auth, code: U.OFFI.code, a: 'promote' })).s, 200);
  assert.equal((await P('/api/bat/act', { auth: U.LEAD.auth, code: U.OFFI.code, a: 'promote' })).s, 409);
  let m = await bme(U.LEAD);
  assert.deepEqual(m.members.map(x => [x.n, x.role]), [['LEAD', 'l'], ['OFFI', 'o'], ['MEMB', 'm']]);
  assert.equal((await P('/api/bat/act', { auth: U.OFFI.auth, code: U.LEAD.code, a: 'kick' })).s, 403, 'officers cannot kick the leader');
  assert.equal((await P('/api/bat/act', { auth: U.OFFI.auth, code: U.MEMB.code, a: 'promote' })).s, 403, 'only the leader changes roles');
  assert.equal((await P('/api/bat/act', { auth: U.LEAD.auth, code: U.SOLO.code, a: 'kick' })).s, 404, 'not a member');
  assert.equal((await P('/api/bat/act', { auth: U.OFFI.auth, code: U.MEMB.code, a: 'kick' })).s, 200, 'an officer kicks a member');
  assert.equal((await bme(U.MEMB)).bat, null);
  assert.equal((await bme(U.LEAD)).bat.n, 2);
  // MEMB comes back by invite; the leader hands over leadership, then demotes nobody (now an officer)
  await P('/api/bat/invite', { auth: U.OFFI.auth, code: U.MEMB.code });
  assert.equal((await P('/api/bat/join', { auth: U.MEMB.auth, id: BAT.id })).s, 200);
  assert.equal((await P('/api/bat/act', { auth: U.LEAD.auth, code: U.OFFI.code, a: 'lead' })).s, 200);
  m = await bme(U.OFFI);
  assert.deepEqual(m.members.map(x => [x.n, x.role]), [['OFFI', 'l'], ['LEAD', 'o'], ['MEMB', 'm']]);
  assert.equal((await P('/api/bat/act', { auth: U.OFFI.auth, code: U.LEAD.code, a: 'demote' })).s, 200);
  assert.equal((await P('/api/bat/act', { auth: U.OFFI.auth, code: U.LEAD.code, a: 'lead' })).s, 200, 'and back');
});

test('chat: stored, fetched since a point, pushed live to connected members, masked, rate limited', async () => {
  const L = await online(U.LEAD), M = await online(U.MEMB);
  let r = await P('/api/bat/say', { auth: U.LEAD.auth, msg: '  Drop at the docks,\n then push the fuckin hill  ' });
  assert.equal(r.s, 200);
  assert.equal(r.b.m, 'Drop at the docks, then push the f***** hill');
  const live = await M.next(m => m.t === 'bm');
  assert.deepEqual([live.c, live.n, live.m, live.at], [U.LEAD.code, 'LEAD', r.b.m, r.b.at]);
  await L.next(m => m.t === 'bm'); // the sender's own socket gets it too
  assert.equal((await P('/api/bat/say', { auth: U.LEAD.auth, msg: 'too fast' })).s, 429, 'one line per 1.5 s');
  await sleep(1600);
  assert.equal((await P('/api/bat/say', { auth: U.MEMB.auth, msg: '' })).s, 400);
  assert.equal((await P('/api/bat/say', { auth: U.MEMB.auth, msg: 'x'.repeat(400) })).b.m.length, 160);
  assert.equal((await P('/api/bat/say', { auth: U.SOLO.auth, msg: 'hi' })).s, 409, 'outsiders cannot post');
  const c = await P('/api/bat/chat', { auth: U.OFFI.auth, since: 0 });
  assert.deepEqual(c.b.msgs.map(x => x.n), ['LEAD', 'MEMB']);
  const c2 = await P('/api/bat/chat', { auth: U.OFFI.auth, since: c.b.msgs[0].at });
  assert.equal(c2.b.msgs.length, 1);
  assert.equal((await P('/api/bat/chat', { auth: U.SOLO.auth, since: 0 })).s, 409);
  L.ws.close(); M.ws.close();
});

test('presence: battalion mates (not friends) see each other and can invite each other to a room', async () => {
  const L = await online(U.LEAD), M = await online(U.MEMB, { s: 'lobby', r: 'ABCDE', m: 'duos', o: 1 });
  assert.deepEqual(M.hi.bon[U.LEAD.code], { s: 'menu' });
  assert.equal((await L.next(m => m.t === 'p' && m.c === U.MEMB.code)).s, 'lobby');
  M.send({ t: 'inv', to: U.LEAD.code, r: 'ABCDE', m: 'duos' });
  const inv = await L.next(m => m.t === 'inv');
  assert.deepEqual([inv.c, inv.n, inv.r, inv.m], [U.MEMB.code, 'MEMB', 'ABCDE', 'duos']);
  assert.equal((await M.next(m => m.t === 'invd')).live, 1);
  M.send({ t: 'inv', to: U.SOLO.code, r: 'ABCDE', m: 'duos' }); // not a mate, not a friend
  assert.equal((await M.next(m => m.t === 'err')).e, 'offline');
  // kicked: the member's socket learns it (bx) and mates stop seeing them
  assert.equal((await P('/api/bat/act', { auth: U.LEAD.auth, code: U.MEMB.code, a: 'kick' })).s, 200);
  await M.next(m => m.t === 'bx');
  assert.equal((await L.next(m => m.t === 'p' && m.c === U.MEMB.code)).s, 'off');
  M.send({ t: 'inv', to: U.LEAD.code, r: 'ABCDE', m: 'duos' });
  assert.equal((await M.next(m => m.t === 'err')).e, 'notfriend');
  L.ws.close(); M.ws.close();
});

test('leave: the leader leaving passes the lead; the last member disbands; weekly board and report hook', async () => {
  assert.equal((await P('/api/bat/leave', { auth: U.LEAD.auth })).s, 200);
  const m = await bme(U.OFFI);
  assert.deepEqual(m.members.map(x => [x.n, x.role]), [['OFFI', 'l']]);
  const r = await P('/api/bat/leave', { auth: U.OFFI.auth });
  assert.deepEqual([r.s, r.b.disbanded], [200, true]);
  await sleep(100);
  assert.equal((await get('/api/bat/get?id=' + BAT.id)).status, 404);
  assert.equal((await P('/api/bat/leave', { auth: U.OFFI.auth })).s, 409);
  // the tag is free again
  assert.equal((await P('/api/bat/create', { auth: U.SOLO.auth, name: 'Iron Wolves', tag: 'IRW', bn: 'bn_grid', em: 'storm' })).s, 200);
  const top = await j(await get('/api/bat/top'));
  assert.equal(top.s, 200); assert.ok(Array.isArray(top.b.top));
  assert.equal((await get('/api/bat/top?wk=2026-11-03')).status, 400, 'weeks start on Monday');
  // report hook
  assert.equal((await P('/api/report', { auth: U.LEAD.auth, kind: 'chat', target: U.MEMB.code, why: 'spam', ctx: 'buy gold' })).s, 200);
  assert.equal((await P('/api/report', { auth: U.LEAD.auth, kind: 'nope', target: U.MEMB.code })).s, 400);
  // the report hook is rate limited (5 per minute)
  let last = 200;
  for (let i = 0; i < 6 && last === 200; i++) last = (await P('/api/report', { auth: U.LEAD.auth, kind: 'bat', target: BAT.id, why: 'x' })).s;
  assert.equal(last, 429);
});
