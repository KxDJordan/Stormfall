// Unit tests for the pure handlers' helpers: node --test test/unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  randB32, sha256hex, parseAuth, codeToAuth, authToCode, dayKey, validDayKey, dayAccepted, cleanDaily, cleanName,
  validSave, originAllowed, validPeerId, normIce, MemLimiter, B32,
  normFriendCode, fmtFriendCode, cleanProfile, cleanRoom, cleanPresence, publicPresence, samePresence,
} from '../src/lib.js';
import { Presence, S_TAG } from '../src/presence.js';

test('random ids use the Crockford alphabet and the right length', () => {
  const s = randB32(200);
  assert.equal(s.length, 200);
  for (const c of s) assert.ok(B32.includes(c));
  assert.notEqual(randB32(20), randB32(20));
});

test('sha256hex matches a known vector', async () => {
  assert.equal(await sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('auth and account code round trip, typos tolerated, junk rejected', () => {
  const id = randB32(10), sec = randB32(20), code = authToCode(id, sec);
  assert.match(code, /^([0-9A-Z]{5}-){5}[0-9A-Z]{5}$/);
  assert.equal(codeToAuth(code), id + '.' + sec);
  assert.equal(codeToAuth(code.toLowerCase().replace(/-/g, ' ')), id + '.' + sec);
  assert.equal(codeToAuth('O0000-00000-00000-00000-00000-0000I'), '0000000000.00000000000000000001');
  assert.equal(codeToAuth('short'), null);
  assert.deepEqual(parseAuth(id + '.' + sec), { id, secret: sec });
  assert.equal(parseAuth(id + ':' + sec), null);
  assert.equal(parseAuth(id + '.' + sec.slice(1) + 'U'), null); // U is not in the alphabet
  assert.equal(parseAuth(null), null);
  assert.equal(parseAuth({}), null);
});

test('day keys', () => {
  const now = Date.parse('2026-11-04T00:30:00Z');
  assert.equal(dayKey(now), '2026-11-04');
  assert.ok(validDayKey('2026-02-28'));
  assert.ok(!validDayKey('2026-02-30'));
  assert.ok(!validDayKey('2026-2-3'));
  assert.ok(!validDayKey(20261104));
  assert.ok(dayAccepted('2026-11-04', now));
  assert.ok(dayAccepted('2026-11-03', now));
  assert.ok(!dayAccepted('2026-11-02', now));
  assert.ok(!dayAccepted('2026-11-05', now));
});

test('daily results are validated and scored like the game', () => {
  const base = { day: '2026-11-04', of: 8, place: 3, win: false, kills: 2, dmg: 120, rounds: 14, name: 'nomad<script>', cls: 'ranger' };
  const r = cleanDaily(base).row;
  // dailyScore: P = round((8-3)/7*1000) = 714; K = 400; D = 1200; S = 350
  assert.equal(r.score, 714 + 400 + 1200 + 350);
  assert.equal(r.name, 'NOMADSCRIPT');
  assert.equal(cleanDaily({ ...base, place: 1, win: true, kills: 7 }).row.score, 1000 + 500 + 1400 + 1200 + 350);
  assert.ok(cleanDaily({ ...base, place: 1, win: false }).error, 'place 1 is a win');
  assert.ok(cleanDaily({ ...base, win: true }).error, 'a win is place 1');
  assert.ok(cleanDaily({ ...base, kills: 8 }).error, 'at most of-1 kills');
  assert.ok(cleanDaily({ ...base, dmg: 99999 }).error);
  assert.ok(cleanDaily({ ...base, dmg: 1.5 }).error);
  assert.ok(cleanDaily({ ...base, rounds: -1 }).error);
  assert.ok(cleanDaily({ ...base, of: 9 }).error);
  assert.ok(cleanDaily({ ...base, place: 9 }).error);
  assert.ok(cleanDaily({ ...base, day: 'today' }).error);
  assert.ok(cleanDaily(null).error);
  assert.equal(cleanDaily({ ...base, cls: 'Robert"); DROP' }).row.cls, '');
  assert.equal(cleanName(''), 'OPERATIVE');
});

test('save codes', () => {
  assert.ok(validSave('SFS1.' + 'A'.repeat(100)));
  assert.ok(validSave('SFS0.eyJzZiI6InN0b3JtZmFsbC1zYXZlIn0='));
  assert.ok(!validSave('SFS2.AAAA'));
  assert.ok(!validSave('SFS1.<script>'));
  assert.ok(!validSave('SFS1.' + 'A'.repeat(70000)));
  assert.ok(!validSave(42));
});

test('CORS origins', () => {
  const L = 'https://kxdjordan.github.io, https://play.example.com/';
  assert.ok(originAllowed('https://kxdjordan.github.io', 'https://x.workers.dev', L, false));
  assert.ok(originAllowed('https://play.example.com', 'https://x.workers.dev', L, false));
  assert.ok(originAllowed('https://x.workers.dev', 'https://x.workers.dev', L, false));
  assert.ok(!originAllowed('https://evil.example', 'https://x.workers.dev', L, false));
  assert.ok(!originAllowed('https://kxdjordan.github.io.evil.example', 'https://x.workers.dev', L, false));
  assert.ok(!originAllowed('http://localhost:8080', 'https://x.workers.dev', L, false));
  assert.ok(originAllowed('http://localhost:8080', 'https://x.workers.dev', L, true));
  assert.ok(originAllowed('http://127.0.0.1:8766', 'https://x.workers.dev', L, true));
  assert.ok(!originAllowed('http://127.0.0.1.evil:80', 'https://x.workers.dev', L, true));
  assert.ok(!originAllowed(null, 'https://x.workers.dev', L, true));
});

test('peer ids', () => {
  assert.ok(validPeerId('stormfall-abcde'));
  assert.ok(validPeerId('e296494e-3574-4228-8274-1a3ae2ec5e1b'));
  assert.ok(!validPeerId('-x'));
  assert.ok(!validPeerId('a/b'));
  assert.ok(!validPeerId('a'.repeat(65)));
});

test('TURN responses are normalised and :53 urls dropped', () => {
  const n = normIce({ iceServers: { urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' } });
  assert.deepEqual(n, [{ urls: ['stun:stun.cloudflare.com:3478', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }]);
  const m = normIce({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }] });
  assert.equal(m.length, 2);
  assert.equal(normIce({}), null);
  assert.equal(normIce({ iceServers: [{ urls: 'turn:x:53' }] }), null);
});

test('memory limiter: fixed window', () => {
  const l = new MemLimiter(3, 1000);
  assert.ok(l.hit('a', 0) && l.hit('a', 1) && l.hit('a', 2));
  assert.ok(!l.hit('a', 3));
  assert.ok(l.hit('b', 3));
  assert.ok(l.hit('a', 1001));
});

/* ---------------- socials ---------------- */

test('friend codes: normalised, typo tolerant, junk rejected', () => {
  assert.equal(normFriendCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normFriendCode(' o1il 2345 '), '01112345');
  assert.equal(normFriendCode('ABCDEFG'), null);
  assert.equal(normFriendCode('ABCDEFGHJ'), null);
  assert.equal(normFriendCode(null), null);
  assert.equal(fmtFriendCode('ABCDEFGH'), 'ABCD-EFGH');
});

test('public profile and presence are cleaned', () => {
  assert.deepEqual(cleanProfile({ name: 'ab<c>', lv: 7, cls: 'ranger', title: 't_x', banner: 'BAD!' }), { name: 'ABC', lv: 7, cls: 'ranger', title: 't_x', banner: '' });
  assert.deepEqual(cleanProfile({ lv: 1e9 }), { name: 'OPERATIVE', lv: 1, cls: '', title: '', banner: '' });
  assert.equal(cleanRoom('ABCDE'), 'ABCDE');
  assert.equal(cleanRoom('ABCD1'), ''); // 1 is not in the room alphabet
  assert.equal(cleanPresence({ s: 'away' }), null);
  assert.deepEqual(cleanPresence({ s: 'match', r: 'ABCDE', o: 1 }), { s: 'match', r: '', m: '', o: 0 });
  const lob = cleanPresence({ s: 'lobby', r: 'ABCDE', m: 'duos', o: 1 });
  assert.deepEqual(publicPresence(lob), { s: 'lobby', m: 'duos', r: 'ABCDE' });
  assert.deepEqual(publicPresence({ ...lob, o: 0 }), { s: 'lobby', m: 'duos' });
  assert.deepEqual(publicPresence(null), { s: 'off' });
  assert.ok(samePresence({ ...lob, o: 0 }, { ...lob, r: 'ZZZZZ', o: 0 }), 'a hidden room change is not a visible change');
});

// a fake Durable Object context for the presence logic
function fakeCtx() {
  const socks = [], ctx = {
    alarm: null, waits: [],
    getWebSockets: tag => socks.filter(w => !tag || w.tags.includes(tag)),
    getWebSocketAutoResponseTimestamp: w => (w.hb ? new Date(w.hb) : null),
    storage: { getAlarm: async () => ctx.alarm, setAlarm: async t => { ctx.alarm = t; } },
    waitUntil: p => ctx.waits.push(p),
  };
  const mk = (code, att, hb) => {
    const w = { tags: [S_TAG, 's:' + code], readyState: 1, att, hb, out: [], closed: null,
      deserializeAttachment() { return this.att && JSON.parse(JSON.stringify(this.att)); },
      serializeAttachment(a) { this.att = JSON.parse(JSON.stringify(a)); },
      send(m) { this.out.push(JSON.parse(m)); }, close(c) { this.readyState = 3; this.closed = c; } };
    socks.push(w); return w;
  };
  return { ctx, mk };
}

test('presence sweep: unauthenticated and silent sockets are closed, friends told once', async () => {
  const now = Date.now(), { ctx, mk } = fakeCtx(), runs = [];
  const DB = { prepare: sql => ({ bind: (...a) => ({ run: async () => { runs.push([sql, a]); return {}; } }) }) };
  const P = new Presence(ctx, { DB });
  const A = mk('AAAAAAAA', { k: 's', c: 'AAAAAAAA', ok: 1, fr: 'BBBBBBBB', s: 'menu', at: now - 400000, t0: now - 500000 }, now - 200000); // silent 200 s
  const B = mk('BBBBBBBB', { k: 's', c: 'BBBBBBBB', ok: 1, fr: 'AAAAAAAA', s: 'menu', at: now - 400000, t0: now - 500000 }, now - 20000);  // heartbeat 20 s ago
  const X = mk('CCCCCCCC', { k: 's', c: 'CCCCCCCC', ok: 0, t0: now - 60000 });                                                        // never authenticated
  await P.sweep();
  assert.equal(A.closed, 4002);
  assert.equal(X.closed, 4001);
  assert.equal(B.closed, null);
  assert.deepEqual(B.out, [{ t: 'p', c: 'AAAAAAAA', s: 'off' }]);
  assert.ok(runs.some(([sql, a]) => /UPDATE profiles SET seen/.test(sql) && a[1] === 'AAAAAAAA'), 'last seen written');
  assert.ok(ctx.alarm > now, 'next sweep scheduled while sockets remain');
  P.closed(A); // the runtime may still report the close later: no second notice
  assert.equal(B.out.length, 1);
});

test('presence link: friends added and removed live, both sides must agree', () => {
  const now = Date.now(), { ctx, mk } = fakeCtx();
  const P = new Presence(ctx, {});
  const A = mk('AAAAAAAA', { k: 's', c: 'AAAAAAAA', ok: 1, fr: '', s: 'lobby', r: 'ABCDE', m: 'solo', o: 1, at: now, t0: now });
  const B = mk('BBBBBBBB', { k: 's', c: 'BBBBBBBB', ok: 1, fr: '', s: 'match', at: now, t0: now });
  P.link('AAAAAAAA', 'BBBBBBBB', 'f');
  assert.deepEqual(A.out, [{ t: 'fx' }, { t: 'p', c: 'BBBBBBBB', s: 'match' }]);
  assert.deepEqual(B.out, [{ t: 'fx' }, { t: 'p', c: 'AAAAAAAA', s: 'lobby', m: 'solo', r: 'ABCDE' }]);
  assert.equal(A.att.fr, 'BBBBBBBB');
  // a one-sided list (stale attachment) never leaks presence
  B.att.fr = ''; A.out = [];
  P.status(B, B.deserializeAttachment(), { s: 'menu' });
  assert.deepEqual(A.out, []);
  P.link('AAAAAAAA', 'BBBBBBBB', 'x');
  assert.equal(A.att.fr, '');
  assert.deepEqual(A.out, [{ t: 'fx' }, { t: 'p', c: 'BBBBBBBB', s: 'off' }]);
});
