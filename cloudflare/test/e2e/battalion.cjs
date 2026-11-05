// Browser test of Battalions against a local Worker (wrangler dev): A creates a battalion through the app (name, tag,
// emblem, banner), B finds it by tag and joins, both chat (lines arrive live through the presence socket), B reports a
// line, A invites B from the battalion page into an online room (the friends invite card, without being friends), the
// leaderboard and the public profile page; plus the name filter and a non-member's view.
//   node test/e2e/battalion.cjs        (needs `npm run dev` running, or SF_API=<url>; SHOTS=<dir> for screenshots)
const { chromium } = require('playwright');
const { API, routeGame } = require('./util.cjs');
const SHOTS = process.env.SHOTS || '';
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: SHOTS + '/' + n + '.png' }); };
const ev = (p, s) => p.evaluate(x => window.__ev(x), s);
const until = (p, js, ms = 20000) => p.waitForFunction(s => window.__ev && window.__ev(s), js, { timeout: ms, polling: 250 });
const TAG = 'W' + String(Date.now() % 1000).padStart(3, '0'); // unique per run (tags are unique server-wide)

(async () => {
  const br = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns,LocalNetworkAccessChecks'] });
  const errs = [];
  const init = () => { window.STORMFALL_PEER = { config: { iceServers: [] } }; };
  async function page(ctx, tag) {
    const p = await ctx.newPage(); await p.addInitScript(init); await routeGame(p);
    p.on('pageerror', e => errs.push(tag + ' pageerror ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION|net::|WebSocket/.test(m.text())) errs.push(tag + ' console ' + m.text()); });
    await p.goto(API + '/'); await p.waitForFunction(() => window.__ev && document.querySelector('#menu'));
    await p.waitForTimeout(300); if (await p.isVisible('#howClose')) await p.click('#howClose');
    return p;
  }
  const vp = { viewport: { width: 390, height: 844 } };
  const A = await page(await br.newContext(vp), "A"), B = await page(await br.newContext(vp), "B"); global.PAGES = [A, B];
  await ev(A, "LO.name='ALPHA'; saveLO(); PROF.xp=9000; saveProf();"); await ev(B, "LO.name='BRAVO'; saveLO();");

  // ---------- A: account through the app, create ----------
  check(await A.isVisible('#bBat'), 'Home has a Battalion button');
  await A.click('#bBat'); await A.waitForSelector('#btSheet.on');
  await shot(A, 'bat_01_intro');
  await A.click('[data-bta=on]'); await A.waitForSelector('#btName', { timeout: 20000 });
  check(await ev(A, '!!CLS.auth&&!!SOCS.code'), 'turning on created the online account and friend code');
  await A.fill('#btName', 'Sh1t Squad'); await A.fill('#btTag', 'OKAY'); await A.click('[data-bta=create]');
  await until(A, "/must be clean/.test($('#btMsg')&&$('#btMsg').textContent)", 8000);
  check(true, 'a profane name is refused: ' + await A.textContent('#btMsg'));
  await A.fill('#btName', 'Iron Wolves ' + TAG.slice(1)); await A.fill('#btTag', TAG.toLowerCase()); await A.fill('#btDesc', 'Hold the line. Daily at 9.');
  await A.click('[data-btem=wolf]'); await A.click('#btSheet [data-btbn=bn_grid]').catch(() => {});
  await A.waitForTimeout(200); await shot(A, 'bat_02_create');
  await A.click('[data-bta=create]');
  await until(A, "BTS.me&&BTS.me.bat&&BTS.me.bat.tag==='" + TAG + "'", 10000);
  check(await ev(A, "BTS.me.role==='l'&&BTS.me.bat.em==='wolf'"), 'A created [' + TAG + '] and leads it');
  await A.waitForTimeout(300); await shot(A, 'bat_03_members_leader');

  // ---------- B: find by tag, profile page, join ----------
  await B.click('#bBat'); await B.waitForSelector('#btSheet.on'); await B.click('[data-bta=on]'); await B.waitForSelector('#btSheet [data-bts=find]', { timeout: 20000 });
  await B.click('[data-bts=find]'); await B.fill('#btFind', TAG.toLowerCase()); await B.click('[data-bta=find]');
  await B.waitForSelector('#btSheet .bthead', { timeout: 10000 });
  check((await B.textContent('#btSheetB')).includes('Hold the line'), 'B found the battalion profile by tag');
  await shot(B, 'bat_04_profile');
  await B.click('#btSheet [data-bta=join]');
  await until(B, "BTS.me&&BTS.me.bat&&BTS.me.bat.tag==='" + TAG + "'", 10000);
  check(await ev(B, "BTS.me.role==='m'&&BTS.me.members.length===2"), 'B joined as a member (2 members)');
  await until(A, "BTS.me.members.length===2", 20000);
  check(true, 'A\'s member list updated live (presence push)');
  await until(A, 'SOC.authed', 20000); await until(B, 'SOC.authed', 20000);

  // ---------- chat ----------
  for (const p of [A, B]) { await p.click('#btSheet [data-btt=chat]'); await p.waitForSelector('#btSay'); }
  await B.fill('#btSay', 'Hey wolves, BRAVO reporting. Ready to fucking roll'); await B.click('[data-bta=say]');
  await until(A, "BT.chat.some(x=>x.n==='BRAVO')", 10000);
  const line = await ev(A, "BT.chat.find(x=>x.n==='BRAVO').m");
  check(/f\*+ roll/.test(line), 'A got B\'s line live, profanity masked: "' + line + '"');
  await A.fill('#btSay', 'Welcome BRAVO! Queue ranked with me at 9.'); await A.click('[data-bta=say]');
  await until(B, "BT.chat.some(x=>x.n==='ALPHA')", 10000);
  check(true, 'B got A\'s reply live');
  await A.waitForTimeout(1700); // one line per 1.5 s: two lines back to back, the second is refused
  await ev(A, "$('#btSay').value='spam'; document.querySelector('#btSheet [data-bta=say]').click(); setTimeout(()=>{ $('#btSay').value='spam again'; document.querySelector('#btSheet [data-bta=say]').click(); },300);");
  await until(A, "/Too fast/.test(($('#btMsg')||{}).textContent||'')", 5000).catch(() => {});
  check(/Too fast/.test(await A.textContent('#btSheetB')), 'chat is rate limited: ' + await ev(A, 'BT.msg+" / "+BT.chat.map(x=>x.m).join("|")'));
  await B.waitForTimeout(500); await shot(B, 'bat_05_chat');
  await B.click('#btChat [data-btl]:not(.me)'); await B.click('[data-bta=rep]');
  await until(B, "/reported/.test(($('#btMsg')||{}).textContent||'')", 8000);
  check(true, 'B reported a message (report hook)');

  // ---------- invite B into A's online room from the battalion page ----------
  await A.click('#btSheet [data-rbx].iconbtn'); await B.click('#btSheet [data-rbx].iconbtn');
  await A.click('#bOnline'); await A.click('#msGo'); await A.waitForSelector('#lobby .wr-code b', { timeout: 15000 });
  const room = await A.textContent('#lobby .wr-code b');
  check(await A.isVisible('#wrRoom [data-btinv]'), 'the waiting room has a Battalion invite button');
  await shot(A, 'bat_06_room');
  await A.click('#wrRoom [data-btinv]'); await A.waitForSelector('#btSheet.on');
  await until(A, "SOC.sent.includes('lobby')&&!!SOC.pres[BTS.me.members.find(x=>x.n==='BRAVO').c]", 10000);
  await ev(A, 'btRender()');
  await A.waitForSelector('#btSheet [data-bta=inv]'); await shot(A, 'bat_07_invite_from_battalion');
  await A.click('#btSheet [data-bta=inv]');
  await B.waitForSelector('#sfInv .ivcard', { timeout: 10000 });
  check((await B.textContent('#sfInv')).includes(room), 'B (a battalion mate, not a friend) got the room invite card');
  await shot(B, 'bat_08_invite_card');
  await B.click('#sfInv [data-ivj]');
  await A.waitForFunction(() => __ev('NET.players.length===2'), null, { timeout: 20000 });
  check(await ev(B, 'NET.code') === room, 'B joined room ' + room + ' through the battalion invite');
  await ev(A, 'netLeave(); closeBat(); go("menu")'); await ev(B, 'netLeave(); go("menu")');

  // ---------- leaderboard, roles, profile card ----------
  await A.click('#bBat'); await A.waitForSelector('#btSheet.on'); await A.click('#btSheet [data-btt=board]');
  await until(A, 'BT.lb&&BT.lb.top', 10000); await A.waitForTimeout(300);
  await shot(A, 'bat_09_leaderboard');
  await A.click('#btSheet [data-btt=members]');
  const bc = await ev(A, "BTS.me.members.find(x=>x.n==='BRAVO').c");
  await A.click('[data-row="' + bc + '"] [data-bta=more]'); await A.click('[data-row="' + bc + '"] [data-bta=promote]');
  await until(A, "BTS.me.members.find(x=>x.n==='BRAVO').role==='o'", 10000);
  check(true, 'A promoted B to officer');
  await until(B, "BTS.me&&BTS.me.role==='o'", 15000);
  check(true, 'B learned it live (bx push)');
  await A.click('#btSheet [data-rbx].iconbtn'); await ev(A, "openProfile('overview')"); await A.waitForSelector('#rkProf .bthead');
  check((await A.textContent('#rkProf')).includes('[' + TAG + ']'), 'Profile shows the battalion and its tag');
  await shot(A, 'bat_10_profile_card');
  check(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  await br.close();
  process.exit(fails ? 1 : 0);
})().catch(async e => { console.error('FAIL', e.message); if (SHOTS && global.PAGES) for (const [i, p] of global.PAGES.entries()) await p.screenshot({ path: SHOTS + '/fail_' + 'AB'[i] + '.png' }).catch(() => {}); process.exit(1); });
