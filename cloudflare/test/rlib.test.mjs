// Unit tests for the ranked & battalion helpers (src/rlib.js): node --test test/rlib.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  seasonOf, seasonStart, seasonEnd, tierOf, rdNow, softReset, rateMatch, cleanReport, consensus, humanPlaces, batPoints,
  weekKey, diffFor, cleanBatName, cleanTag, cleanDesc, cleanChat, cleanEmblem, cleanBanner, isProfane, maskProfanity,
  R0, RD0, RD_MAX, SEASON_EPOCH,
} from '../src/rlib.js';

test('seasons: 8 weeks from the epoch, consecutive and covering every day', () => {
  assert.equal(seasonOf(SEASON_EPOCH), 1);
  assert.equal(seasonOf(SEASON_EPOCH - 1), 1, 'never below season 1');
  assert.equal(seasonOf(seasonStart(5)), 5);
  assert.equal(seasonOf(seasonEnd(5) - 1), 5);
  assert.equal(seasonEnd(5), seasonStart(6));
  assert.equal(seasonOf(Date.UTC(2026, 10, 4)), 6);
});

test('tiers and divisions: Bronze .. Stormlord, III (low) to I (high), Stormlord has none', () => {
  const t = r => { const x = tierOf(r); return x.n + (x.div ? ' ' + x.div : ''); };
  assert.equal(t(800), 'Bronze 3'); assert.equal(t(1000), 'Bronze 2'); assert.equal(t(1099), 'Bronze 1');
  assert.equal(t(1100), 'Silver 3'); assert.equal(t(1299), 'Silver 1'); assert.equal(t(1300), 'Gold 3');
  assert.equal(t(1550), 'Platinum 3'); assert.equal(t(1650), 'Platinum 1'); assert.equal(t(1750), 'Diamond 3');
  assert.equal(t(1900), 'Stormlord'); assert.equal(t(2600), 'Stormlord');
});

test('Glicko-lite: winners gain, losers lose, zero-sum for equals, upsets move more, deviation shrinks', () => {
  const two = rateMatch([{ id: 'a', r: 1000, rd: 300, place: 1 }, { id: 'b', r: 1000, rd: 300, place: 2 }]);
  assert.ok(two[0].d > 0 && two[1].d < 0);
  assert.equal(two[0].d, -two[1].d);
  assert.ok(two[0].rd < 300 && two[1].rd < 300);
  const fav = rateMatch([{ id: 'a', r: 1600, rd: 80, place: 1 }, { id: 'b', r: 1200, rd: 80, place: 2 }])[0].d;
  const upset = rateMatch([{ id: 'a', r: 1600, rd: 80, place: 2 }, { id: 'b', r: 1200, rd: 80, place: 1 }])[1].d;
  assert.ok(upset > 5 * fav, 'an upset win is worth much more than an expected one: ' + upset + ' vs ' + fav);
  const tie = rateMatch([{ id: 'a', r: 1000, rd: 100, place: 2 }, { id: 'b', r: 1000, rd: 100, place: 2 }]);
  assert.equal(tie[0].d, 0);
  // a provisional player (high deviation) moves more than a settled one
  const mixed = rateMatch([{ id: 'n', r: 1000, rd: 300, place: 1 }, { id: 'o', r: 1000, rd: 60, place: 2 }]);
  assert.ok(Math.abs(mixed[0].d) > 3 * Math.abs(mixed[1].d));
  // 8 humans: ordered gains, bounded swings
  const eight = rateMatch([1, 2, 3, 4, 5, 6, 7, 8].map(p => ({ id: 'p' + p, r: 1200, rd: 150, place: p })));
  for (let i = 1; i < 8; i++) assert.ok(eight[i].d < eight[i - 1].d);
  assert.ok(eight[0].d > 0 && eight[7].d < 0 && Math.abs(eight[0].d) < 200);
  assert.deepEqual(rateMatch([{ id: 'x', r: 1000, rd: 300, place: 1 }]), [{ id: 'x', r: 1000, rd: 300, d: 0 }]);
});

test('deviation grows while idle; soft reset halves the distance to 1000', () => {
  const now = Date.now();
  assert.equal(rdNow(80, now, now), 80);
  assert.ok(rdNow(80, now - 30 * 86400000, now) > 100);
  assert.equal(rdNow(300, now - 900 * 86400000, now), RD_MAX);
  assert.deepEqual(softReset(null), { r: R0, rd: RD0 });
  assert.deepEqual(softReset({ r: 1800, rd: 70 }), { r: 1400, rd: 200 });
  assert.deepEqual(softReset({ r: 800, rd: 250 }), { r: 900, rd: 250 });
  assert.deepEqual([diffFor(900), diffFor(1300), diffFor(1700)], ['recruit', 'veteran', 'elite']);
});

test('reports: cleaned strictly (every seat placed, known leavers only)', () => {
  const parts = ['AAAAAA', 'BBBBBB'];
  assert.deepEqual(cleanReport({ h: 5, pl: { AAAAAA: 1, BBBBBB: 3 }, left: ['BBBBBB'] }, parts), { h: 5, pl: { AAAAAA: 1, BBBBBB: 3 }, left: ['BBBBBB'], bad: 0 });
  assert.equal(cleanReport({ h: 5, pl: { AAAAAA: 1 } }, parts), null);
  assert.equal(cleanReport({ h: 5, pl: { AAAAAA: 1, BBBBBB: 2, CCCCCC: 3 } }, parts), null);
  assert.equal(cleanReport({ h: 5, pl: { AAAAAA: 0, BBBBBB: 2 } }, parts), null);
  assert.equal(cleanReport({ h: -1, pl: { AAAAAA: 1, BBBBBB: 2 } }, parts), null);
  assert.equal(cleanReport({ h: 5, pl: { AAAAAA: 1, BBBBBB: 2 }, left: ['ZZZZZZ'] }, parts), null);
  assert.equal(cleanReport({ bad: 1 }, parts).bad, 1);
});

test('consensus: majority of all humans at once; after the grace period the majority of reporters; else void', () => {
  const P3 = ['A', 'B', 'C'], r = h => ({ h, pl: { A: 1, B: 2, C: 3 }, left: [], bad: 0 });
  assert.equal(consensus(P3, { A: r(1) }, false).st, 'wait');
  assert.equal(consensus(P3, { A: r(1), B: r(1) }, false).st, 'ok', '2 of 3 agree: decided');
  assert.equal(consensus(P3, { A: r(1), B: r(2) }, false).st, 'wait');
  assert.equal(consensus(P3, { A: r(1), B: r(2), C: r(3) }, false).st, 'void');
  assert.equal(consensus(P3, { A: r(1), B: r(2) }, true).st, 'void', 'a tie after the grace period');
  assert.equal(consensus(P3, { A: r(1) }, true).st, 'ok', 'the only reporter decides after the grace period');
  assert.equal(consensus(P3, {}, true).why, 'noreports');
  const bad = consensus(['A', 'B'], { A: r(1), B: { bad: 1, h: 0, pl: {}, left: [] } }, false);
  assert.deepEqual([bad.st, bad.why], ['void', 'ruleset']);
  const L = { h: 9, pl: { A: 3, B: 1 }, left: ['B'], bad: 0 };
  const ok = consensus(['A', 'B'], { A: L, B: L }, false);
  assert.deepEqual(humanPlaces(['A', 'B'], ok), { A: 3, B: 99 }, 'a leaver is rated last whatever their AI did');
  assert.deepEqual([batPoints(1, 8, false), batPoints(4, 8, false), batPoints(5, 8, false), batPoints(1, 8, true)], [10, 6, 3, 0]);
});

test('weeks start on Monday (UTC)', () => {
  assert.equal(weekKey(Date.UTC(2026, 10, 4, 12)), '2026-11-02'); // a Wednesday
  assert.equal(weekKey(Date.UTC(2026, 10, 2)), '2026-11-02');
  assert.equal(weekKey(Date.UTC(2026, 10, 1, 23, 59)), '2026-10-26'); // Sunday
});

test('battalion names, tags, descriptions, chat: format rules and the profanity filter', () => {
  assert.equal(cleanBatName('  Iron   Wolves '), 'Iron Wolves');
  for (const bad of ['ab', 'x'.repeat(21), 'Iron<Wolves>', '---', 'Sh1t Squad', 'The Fuk Crew']) assert.equal(cleanBatName(bad), null, bad);
  assert.equal(cleanTag('irw'), 'IRW'); assert.equal(cleanTag('ab'), null); assert.equal(cleanTag('ABCDE'), null); assert.equal(cleanTag('A-B'), null);
  assert.equal(cleanTag('KKK'), null); assert.equal(cleanTag('fuk'), null); assert.equal(cleanTag('5H1T'), null);
  assert.ok(isProfane('a$$hole') && isProfane('NIGG3R') && isProfane('b1tch') && isProfane('F U C K') && !isProfane('Grape Squad'));
  assert.equal(maskProfanity('what the fuck, man'), 'what the f***, man');
  assert.equal(maskProfanity('Scunthorpe united'), 'Scunthorpe united', 'no false positive on a common place name');
  assert.equal(cleanChat('  hello\n\tworld\u0007 '), 'hello world');
  assert.equal(cleanChat('x'.repeat(500)).length, 160);
  assert.equal(cleanChat('   '), '');
  assert.equal(cleanDesc('a'.repeat(300)).length, 120);
  assert.equal(cleanEmblem('wolf'), 'wolf'); assert.equal(cleanEmblem('nope'), null);
  assert.equal(cleanBanner('bn_gold'), 'bn_gold'); assert.equal(cleanBanner('../x'), 'bn_std');
});
