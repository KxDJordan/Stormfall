// Browser test of the cloud features against a local Worker (wrangler dev): accounts, cloud save push/pull, conflicts,
// sign in with the account code on a fresh browser (a re-added home-screen app), sign out, offline behaviour, and
// the daily leaderboard (played for real by the test bot).
//   node test/e2e/cloud.cjs        (needs `npm run dev` running, or SF_API=<url>)
const { chromium } = require('playwright');
const { API, openGame, ev } = require('./util.cjs');
const BOT = require('./bot.cjs');
const SHOTS = process.env.SHOTS || '';
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: SHOTS + '/' + n + '.png' }); };
const until = (p, js, ms = 30000) => p.waitForFunction(s => window.__ev && window.__ev(s), js, { timeout: ms, polling: 250 });

(async () => {
  const br = await chromium.launch();
  const vp = { viewport: { width: 390, height: 844 } };

  // ---------- device A: first sync creates the account ----------
  const ctxA = await br.newContext(vp), A = await openGame(ctxA);
  check(await ev(A, 'API_BASE') === API, 'API base defaults to the same origin');
  check(!(await ev(A, 'CLS.auth')), 'no account before any progress');
  await ev(A, 'PROF.xp=1234; PROF.credits=777; saveProf();');
  const t0 = Date.now();
  await until(A, 'CLS.auth&&CLS.rev===1&&!CLS.dirty', 40000);
  check(true, 'progress change -> debounced push created the account and saved rev 1 (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  await ev(A, "go('profile')");
  await A.waitForTimeout(200);
  const pc = await A.textContent('#pCloud');
  check(/Cloud: synced/.test(pc) && /•/.test(pc), 'Profile shows "Cloud: synced ..." and a masked account code');
  await A.click('#pCloud [data-clp=show]');
  const code = await ev(A, 'CLS.code');
  check((await A.textContent('#pCloud .clcode')) === code && /^([0-9A-Z]{5}-){5}[0-9A-Z]{5}$/.test(code), 'Show code reveals ' + code);
  await A.evaluate(() => document.querySelector('#pCloud').scrollIntoView());
  await shot(A, 'cloud_profile');

  // ---------- device B: a fresh browser (re-added home-screen app) signs in with the code ----------
  const ctxB = await br.newContext(vp), B = await openGame(ctxB);
  await B.waitForTimeout(2500);
  check(!(await ev(B, 'CLS.auth')), 'fresh device with no progress does not create an account by itself');
  await ev(B, "go('profile')");
  await B.click('#pCloud [data-clp=in]');
  await B.fill('#clIn', code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o'));
  await B.click('[data-cl=check]');
  await B.waitForFunction(() => /Cloud save:/.test(document.querySelector('#clStat').textContent), null, { timeout: 10000 });
  check(/Level \d+ · 777 CR/.test(await B.textContent('#clStat')), 'sign-in shows the cloud summary: ' + (await B.textContent('#clStat')));
  await shot(B, 'cloud_signin');
  await Promise.all([B.waitForNavigation(), B.click('[data-cl=signin]')]);
  await B.waitForFunction(() => window.__ev);
  if (await B.isVisible('#howClose')) await B.click('#howClose');
  check(await ev(B, 'PROF.xp===1234&&PROF.credits===777'), 'after sign-in + reload, device B has device A\'s progress');
  check(await ev(B, 'CLS.code') === code && await ev(B, 'CLS.rev') === 1, 'device B is on the same account at rev 1');

  // ---------- conflict: both devices change; B keeps its own ----------
  await ev(A, "PROF.credits=1000; saveProf(); CL.lastPush=0; cloudPush('manual')");
  await until(A, 'CLS.rev===2&&!CLS.dirty');
  await ev(B, "PROF.credits=555; saveProf(); CL.lastPush=0; cloudPush('manual')");
  await B.waitForSelector('#cl:not(.hidden) [data-cl=keep]', { timeout: 15000 });
  const cmp = await B.textContent('#clBody');
  check(/This device.*555 CR.*Cloud.*1000 CR/s.test(cmp), 'conflict dialog shows both summaries (device 555 CR, cloud 1000 CR)');
  await shot(B, 'cloud_conflict');
  await B.click('[data-cl=keep]');
  await until(B, 'CLS.rev===3&&!CLS.dirty');
  check(true, '"Keep this device" pushed on top of the cloud copy (rev 3)');
  // A was not changed since its last sync: "Sync now" loads the newer cloud save
  await ev(A, "go('profile')");
  await Promise.all([A.waitForNavigation({ timeout: 15000 }), A.click('#pCloud [data-clp=sync]')]);
  await A.waitForFunction(() => window.__ev);
  if (await A.isVisible('#howClose')) await A.click('#howClose');
  check(await ev(A, 'PROF.credits===555&&CLS.rev===3'), 'device A "Sync now" pulled the newer save without asking (credits 555, rev 3)');

  // ---------- conflict: "Use cloud save" ----------
  await ev(A, "PROF.credits=2; saveProf(); CL.lastPush=0; cloudPush('manual')");
  await until(A, 'CLS.rev===4&&!CLS.dirty');
  await ev(B, "PROF.credits=1; saveProf(); CL.lastPush=0; cloudPush('manual')");
  await B.waitForSelector('#cl:not(.hidden) [data-cl=usecloud]', { timeout: 15000 });
  await Promise.all([B.waitForNavigation(), B.click('[data-cl=usecloud]')]);
  await B.waitForFunction(() => window.__ev);
  if (await B.isVisible('#howClose')) await B.click('#howClose');
  check(await ev(B, 'PROF.credits===2&&CLS.rev===4&&!CLS.dirty'), '"Use cloud save" replaced device B\'s progress (credits 2, rev 4)');

  // ---------- app start pulls ----------
  await ev(A, "PROF.credits=3333; saveProf(); CL.lastPush=0; cloudPush('manual')");
  await until(A, 'CLS.rev===5&&!CLS.dirty');
  await B.reload();
  await B.waitForFunction(() => window.__ev);
  await B.waitForFunction(() => window.__ev && window.__ev('PROF.credits===3333'), null, { timeout: 15000 }).catch(() => {});
  if (await B.isVisible('#howClose')) await B.click('#howClose');
  check(await ev(B, 'PROF.credits===3333&&CLS.rev===5'), 'app start on device B pulled the newer cloud save automatically');

  // ---------- sign out ----------
  await ev(B, "go('profile')");
  await B.click('#pCloud [data-clp=out]');
  check((await B.textContent('#clBody')).includes(code), 'sign-out dialog shows the account code to keep');
  await B.click('[data-cl=signout]');
  const puts = [];
  B.on('request', r => { if (/\/api\/save\/put|\/api\/account/.test(r.url())) puts.push(r.url()); });
  await ev(B, 'PROF.credits=9; saveProf();');
  await B.waitForTimeout(10000);
  check(!(await ev(B, 'CLS.auth')) && await ev(B, 'CLS.out===true&&PROF.credits===9') && puts.length === 0, 'signed out: progress stays, no further uploads or new accounts (' + puts.length + ' requests)');
  check(/off on this device/.test(await B.textContent('#pCloud')), 'Profile says cloud save is off');

  // ---------- daily challenge + global leaderboard (device A plays it with the bot) ----------
  const day = new Date().toISOString().slice(0, 10);
  // two other players already on the board today
  for (const [n, place, kills] of [['RIVAL', 2, 3], ['ROOKIE', 7, 0]]) {
    const acc = await (await fetch(API + '/api/account', { method: 'POST', body: '{}' })).json();
    const r = await fetch(API + '/api/daily/submit', { method: 'POST', body: JSON.stringify({ auth: acc.auth, day, of: 8, place, win: false, kills, dmg: 150, rounds: 12, name: n, cls: 'ranger' }) });
    check(r.status === 200, 'seeded leaderboard entry ' + n);
  }
  await ev(A, "go('menu')");
  await A.click('#bDaily');
  await A.waitForSelector('#dyLb .lbrow', { timeout: 10000 });
  check((await A.$$('#dyLb .lbrow')).length === 2, 'Daily modal shows today\'s leaderboard before playing (2 players)');
  await shot(A, 'daily_modal_before');
  await ev(A, BOT);
  await A.click('[data-dy=go]');
  await until(A, "G.scene==='game'&&G.round>=1&&!!G.daily", 30000);
  const tm = Date.now();
  await A.waitForFunction(() => window.__ev('G.over'), null, { timeout: 600000, polling: 1000 });
  await A.waitForSelector('#eLb .lbrow.me', { timeout: 20000 });
  const res = JSON.parse(await ev(A, 'JSON.stringify(dyLoad().days[dailyKey()])'));
  const lb = await A.textContent('#eLb');
  check(/Global leaderboard/.test(lb) && /\(you\)/.test(lb), 'results screen shows the global leaderboard with your row (match took ' + Math.round((Date.now() - tm) / 1000) + ' s, place #' + res.p + ', score ' + res.s + ')');
  const mine = await ev(A, 'JSON.stringify(CLS.dr[dailyKey()])');
  check(JSON.parse(mine).score === res.s, 'server score equals the game\'s own score (' + mine + ')');
  await A.evaluate(() => document.querySelector('#eLb').scrollIntoView());
  await shot(A, 'daily_results_leaderboard');
  // one per day: a second submission is ignored
  await ev(A, "CLS.dr={}; cloudDailyDone(dailyKey(),Object.assign({},dyLoad().days[dailyKey()],{p:1,win:true,k:7,d:900}))");
  await until(A, '!CLS.pend.length&&!!CLS.dr[dailyKey()]', 15000);
  check(JSON.parse(await ev(A, 'JSON.stringify(CLS.dr[dailyKey()])')).score === res.s, 'a second submission the same day keeps the first score');
  // client cache: reopening the daily window within a minute does not refetch the board
  const tops = [];
  A.on('request', r => { if (/\/api\/daily\/top/.test(r.url())) tops.push(r.url()); });
  await ev(A, "toMenu()");
  for (let i = 0; i < 2; i++) { await A.click('#bDaily'); await A.waitForSelector('#dyLb .lbrow'); await A.click('#dyClose'); }
  check(tops.length === 0, 'leaderboard reads are cached on the client (' + tops.length + ' refetches)');
  const top = await (await fetch(API + '/api/daily/top?day=' + day)).json();
  check(top.total === 3 && top.top.length === 3, 'server board has 3 players: ' + top.top.map(x => x.n + ' ' + x.s).join(', '));

  // ---------- offline: backend unreachable, the game is unaffected ----------
  const ctxC = await br.newContext(vp), C = await openGame(ctxC, { api: 'http://127.0.0.1:9' });
  check(await ev(C, 'API_BASE') === 'http://127.0.0.1:9', 'device C points at a dead backend');
  await ev(C, "PROF.xp=50; saveProf(); CL.lastPush=0; cloudPush('manual')");
  await C.waitForTimeout(1500);
  await ev(C, "go('profile')");
  check(/Offline/.test(await C.textContent('#pCloud')), 'Profile shows Offline: ' + (await C.textContent('#pCloud .bkst')));
  await ev(C, "go('menu')");
  await C.click('#bDaily');
  await C.waitForFunction(() => /offline/.test((document.querySelector('#dyLb') || {}).textContent || ''), null, { timeout: 15000 });
  check(true, 'Daily modal says the leaderboard is offline');
  await C.click('#dyClose');
  await ev(C, "PROF.mode='quick'; saveProf(); refreshMenu();");
  await ev(C, BOT);
  await C.click('#bDeploy'); await C.click('#wrDeploy');
  await until(C, "G.scene==='game'&&G.round>=1", 30000);
  await C.waitForFunction(() => window.__ev('G.over'), null, { timeout: 400000, polling: 1000 });
  await C.waitForSelector('#end:not(.hidden)', { timeout: 15000 });
  const endInfo = await ev(C, "JSON.stringify({end:!$('#end').classList.contains('hidden'),m:PROF.career.matches,res:G.result})");
  check(/"end":true,"m":1/.test(endInfo), 'offline: a full Quick match played to the results screen, rewards saved locally ' + endInfo);
  const offErr = C.errs.filter(e => !/127\.0\.0\.1:9/.test(e));
  check(offErr.length === 0, 'offline: no page errors ' + JSON.stringify(offErr));

  // ---------- meta "off": no backend calls at all ----------
  const ctxD = await br.newContext(vp), D = await openGame(ctxD, { api: 'off' });
  const calls = []; D.on('request', r => { if (/\/api\//.test(r.url())) calls.push(r.url()); });
  await ev(D, "PROF.xp=5; saveProf(); go('profile')");
  await D.waitForTimeout(2000);
  check(await ev(D, "API_BASE===''") && calls.length === 0 && /not available/.test(await D.textContent('#pCloud')), 'sf-api "off": no API calls, Profile explains');

  const errs = [...A.errs, ...B.errs];
  check(errs.length === 0, 'no page errors on A/B ' + JSON.stringify(errs));
  await br.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
