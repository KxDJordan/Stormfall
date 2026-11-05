// Browser test of Ranked against a local Worker (wrangler dev): two players (A, B) open the mode select, pick Solo, tap
// Ranked and Find match (each gets an online account through the app), the matchmaker pairs them, A hosts the room and B
// joins it, the room locks to the ranked rules and starts by itself, both play the match in lockstep through the own
// signaling server (every round's full state hash must match), both report, the server agrees and both ratings change.
// Also: battalion tags on in-match name plates, the results card, the leaderboard and rank badges.
//   node test/e2e/ranked.cjs [solo|duos]   (needs `npm run dev` running, or SF_API=<url>; SHOTS=<dir> for screenshots)
// Duos: each human is on a different team with an AI partner.
const { chromium } = require('playwright');
const { API, routeGame } = require('./util.cjs');
const BOT = require('./bot.cjs');
const SHOTS = process.env.SHOTS || '', MODE = process.argv[2] === 'duos' ? 'duos' : 'solo', SX = MODE === 'solo' ? '' : '_duos';
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: SHOTS + '/' + n + SX + '.png' }); };
const ev = (p, s) => p.evaluate(x => window.__ev(x), s);
const until = (p, js, ms = 20000) => p.waitForFunction(s => window.__ev && window.__ev(s), js, { timeout: ms, polling: 250 });
const post = async (path, b) => { const r = await fetch(API + '/api/' + path, { method: 'POST', body: JSON.stringify(b) }); return { s: r.status, j: await r.json() }; };
const REC = `(()=>{ window.TR=[]; const sp0=stormPhase; stormPhase=async function(){ let gh=0; for(let i=0;i<MW*MH;i++){ const o=G.grid[i], v=o?o.kind+':'+o.t+':'+(o.hp==null?'':o.hp):'-'; for(let k=0;k<v.length;k++) gh=(Math.imul(gh,31)+v.charCodeAt(k))|0; }
  TR.push(G.round+':'+G.units.map(u=>[u.id,u.x,u.y,u.hp,u.shield,u.ammo,u.sAmmo,+u.alive,+u.downed,u.disorient,u.mob,u.W.clip,u.patt,u.satt,u.utils.map(q=>q.ch).join('/')].join(',')).join('|')+'|c'+G.crates.length+'|g'+gh+'|cmd'+JSON.stringify(G.cmd));
  return sp0(); }; })()`;

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
  const A = await page(await br.newContext(vp), 'A'), B = await page(await br.newContext(vp), 'B');
  await ev(A, "LO.name='ALPHA'; saveLO();"); await ev(B, "LO.name='BRAVO'; LO.cls='sharpshooter'; LO=sanitize(LO); saveLO();");

  // ---------- the Ranked entry on the mode select ----------
  await A.click('#bDeploy'); await A.waitForSelector('#modesel:not(.hidden)');
  check(await A.isVisible('#msRk'), 'the mode select offers Ranked for Solo');
  await shot(A, 'ranked_01_modesel');
  await A.click('#msTrack [data-msk=quick]'); await A.waitForTimeout(500);
  check(!(await A.isVisible('#msRk')), 'no Ranked button for Quick (Solo and Duos only)');
  await A.click('#msTrack [data-msk=' + MODE + ']'); await A.waitForTimeout(500);
  await A.click('#msRk'); await A.waitForSelector('#rkSheet.on');
  await shot(A, 'ranked_02_sheet');
  check(!(await ev(A, '!!CLS.auth')), 'no online account yet');

  // ---------- queue: A first (A hosts), then B ----------
  for (const p of [A, B]) { await ev(p, BOT); await ev(p, REC); await ev(p, 'window.NOBOT=1'); }
  const SEEN = `(()=>{ window.TAGSEEN=0; const d=drawUnit; drawUnit=function(c,u){ d(c,u); if(u.ctag&&!u.isPlayer&&u.alive&&!u.downed&&!u.drop){ window.TAGSEEN=Date.now(); window.TAGU=u; } }; })()`;
  for (const p of [A, B]) await ev(p, SEEN);
  await A.click('[data-rka=queue]');
  await until(A, "RK.st==='queue'", 20000);
  check(await ev(A, '!!CLS.auth'), 'Find match created the online account (ranked needs one)');
  await A.waitForTimeout(600); await shot(A, 'ranked_03_searching');
  // A joins a battalion first (through the API with A's account) so its tag shows in the match
  const aAuth = await ev(A, 'CLS.auth');
  const bc = await post('bat/create', { auth: aAuth, name: 'Alpha Squad', tag: 'ALF', bn: 'bn_signal', em: 'wolf' });
  check(bc.s === 200, 'A created battalion [ALF] (API)');
  await ev(A, 'btFetch()'); await until(A, "btTag()==='ALF'", 8000);
  await A.click('[data-rka=cancel]'); await A.click('[data-rka=queue]'); await until(A, "RK.st==='queue'", 20000); // re-queue: the matchmaker snapshots the battalion
  // B gets its account first and joins [ALF] too, so each sees the other's tag in the match
  await ev(B, '(async()=>{ await clEnsureAccount(); await socPublish(true); })()'); await until(B, '!!CLS.auth&&!!SOCS.code', 15000);
  check((await post('bat/join', { auth: await ev(B, 'CLS.auth'), id: bc.j.bat.id })).s === 200, 'B joined [ALF] (API)');
  await ev(B, 'btFetch()'); await until(B, "btTag()==='ALF'", 8000);
  await B.click('#bDeploy'); await B.waitForSelector('#modesel:not(.hidden)'); await B.click('#msTrack [data-msk=' + MODE + ']'); await B.waitForTimeout(500); await B.click('#msRk'); await B.waitForSelector('#rkSheet.on');
  await B.click('[data-rka=queue]');
  await until(B, "RK.st==='matched'||RK.st==='joining'||RK.st==='lobby'", 30000);
  check(await ev(A, 'RK.host') && !(await ev(B, 'RK.host')), 'matched: A hosts, B joins');
  await shot(B, 'ranked_04_match_found');
  await until(A, "NET.host&&NET.code===RK.code", 20000);
  await until(B, "NET.on&&NET.code===RK.code", 30000);
  check(true, 'B joined the host\'s ranked room ' + await ev(A, 'NET.code'));
  await until(A, "$('#rkRoom')!==null", 10000).catch(() => {});
  await shot(A, 'ranked_05_room');
  const rules = await ev(A, "JSON.stringify({m:NET.mode,tm:NET.tm,mut:NET.mut,bots:NET.bots})");
  check(rules.includes('"m":"' + MODE + '"') && /"t":30,"b":0/.test(rules) && /"mut":\[\]/.test(rules) && /"recruit"/.test(rules), 'the room is on the ranked rules: ' + rules);
  // ---------- the match starts by itself ----------
  for (const p of [A, B]) await p.waitForFunction(() => __ev("G.scene==='game'&&$('#roul').classList.contains('hidden')&&G.round>=1"), null, { timeout: 60000 });
  check(await ev(A, 'RK.mtch===G.matchId&&!RK.bad') && await ev(B, 'RK.mtch===G.matchId&&!RK.bad'), 'both see a valid ranked match');
  const roster = await ev(A, "G.units.map(u=>(u.human?'H':'')+u.name+(u.ctag?'['+u.ctag+']':'')+(u.bot?':'+u.diff.key:'')).join(' ')");
  console.log('roster', roster);
  check(/HALPHA\[ALF\]/.test(roster) && /HBRAVO\[ALF\]/.test(roster) && (roster.match(/:recruit/g) || []).length === 6, 'two humans, six Recruit bots (the lobby\'s rating), A tagged [ALF]');
  check(await ev(B, "G.units.some(u=>u.name==='ALPHA'&&u.ctag==='ALF')"), 'B sees A\'s battalion tag on A\'s name plate');
  if (MODE === 'duos') { const tm = await ev(A, "JSON.stringify(G.units.map(u=>(u.human?'H':'b')+u.team))"); check(/^\["H0","b0","H1","b1","b2","b2","b3","b3"\]$/.test(tm), 'Duos: one human per team, each with an AI partner: ' + tm); }
  for (const p of [A, B]) await ev(p, 'window.NOBOT=0');
  await A.waitForTimeout(1500); await shot(A, 'ranked_06_match_hud');
  let tagShot = false;
  for (let i = 0; i < 300; i++) { if (await ev(A, 'G.over') && await ev(B, 'G.over')) break; await A.waitForTimeout(1000);
    if (!tagShot) for (const p of [A, B]) if (!tagShot && await ev(p, 'Date.now()-window.TAGSEEN<400&&!G.over&&!G.playerDead')) {
      await ev(p, 'window.SPD=1; focusOn(TAGU.x,TAGU.y)'); await p.waitForTimeout(700);
      if (await ev(p, 'Date.now()-window.TAGSEEN<300&&!G.over')) { tagShot = true; await shot(p, 'ranked_06_match_tag'); }
      await ev(p, 'window.SPD=8'); } }
  check(tagShot, 'a battalion tag was drawn beside a callsign on the map');
  await until(A, 'G.over', 240000); await until(B, 'G.over', 240000);
  const ta = await ev(A, 'TR'), tb = await ev(B, 'TR');
  let bad = -1; for (let i = 0; i < Math.min(ta.length, tb.length); i++) if (ta[i] !== tb[i]) { bad = i; break; }
  check(bad < 0 && ta.length === tb.length && ta.length > 0, 'match: rounds A ' + ta.length + ' B ' + tb.length + ' ' + (bad < 0 && ta.length === tb.length ? 'IN SYNC every round' : 'DESYNC at ' + bad));
  const ra = await ev(A, 'JSON.stringify(RK.rep)'), rb = await ev(B, 'JSON.stringify(RK.rep)');
  check(ra && ra === rb, 'both reported the same result: ' + ra);
  // ---------- the server agrees, both ratings change ----------
  await until(A, "RK.res&&RK.res.st==='done'", 60000); await until(B, "RK.res&&RK.res.st==='done'", 60000);
  const da = await ev(A, 'RK.res.d'), db = await ev(B, 'RK.res.d');
  check(da !== 0 && db !== 0 && Math.sign(da) !== Math.sign(db), 'both ratings updated: A ' + da + ', B ' + db);
  await A.waitForSelector('#end:not(.hidden) #rkEnd', { timeout: 20000 }); await B.waitForSelector('#end:not(.hidden) #rkEnd', { timeout: 20000 });
  check(/rating/.test(await A.textContent('#rkEnd')), 'the results screen shows the rating change: ' + (await A.textContent('#rkEnd')).replace(/\s+/g, ' '));
  await shot(A, 'ranked_07_result_A'); await shot(B, 'ranked_07_result_B');
  const ma = await post('ranked/me', { auth: aAuth }), mb = await post('ranked/me', { auth: await ev(B, 'CLS.auth') });
  const MA = ma.j.modes[MODE], MB = mb.j.modes[MODE];
  check(MA.n === 1 && MB.n === 1 && MA.r !== 1000 && MB.r !== 1000, 'server: both have 1 ranked ' + MODE + ' match, ratings ' + MA.r + ' / ' + MB.r);
  const rep = JSON.parse(ra), sa = await ev(A, 'RK.sid'), sb = await ev(B, 'RK.sid');
  check((rep.pl[sa] < rep.pl[sb]) === (da > 0) && MA.w === (rep.pl[sa] === 1 ? 1 : 0), 'the better placed human gained (places A ' + rep.pl[sa] + ', B ' + rep.pl[sb] + ')');
  // ---------- battalion points from the ranked result ----------
  const bm = await post('bat/me', { auth: aAuth });
  check(bm.j.bat && bm.j.bat.wk > 0 && bm.j.members.reduce((a, x) => a + x.pts, 0) === bm.j.bat.wk, 'the ranked result earned [ALF] weekly points: ' + (bm.j.bat && bm.j.bat.wk));
  // ---------- Ranked again: back to the queue sheet; the leaderboard ----------
  await A.click('#eAgain'); await A.waitForSelector('#rkSheet.on');
  check(!(await ev(A, 'NET.on')), 'Ranked again left the finished room');
  await until(A, "RKS.me&&RKS.me.modes['" + MODE + "'].n===1", 10000);
  await shot(A, 'ranked_08_after');
  await A.click('#rkSheet [data-rkt=board]'); if (MODE !== 'solo') await A.click('#rkSheet [data-rklb=' + MODE + ']');
  await until(A, "RK.lb['" + MODE + "']&&RK.lb['" + MODE + "'].top", 10000);
  await A.waitForTimeout(300);
  check((await A.textContent('#rkSheetB')).includes('ALPHA') && (await A.textContent('#rkSheetB')).includes('BRAVO'), 'the leaderboard lists both');
  await shot(A, 'ranked_09_leaderboard');
  // ---------- rank badges once placed (5 matches): shown here by setting a placed record locally ----------
  await A.click('#rkSheet [data-rbx].iconbtn');
  await ev(A, "RKS.me.modes.solo=Object.assign({},RKS.me.modes.solo,{r:1342,n:7,w:3,peak:1360}); RKS.me.modes.duos=Object.assign({},RKS.me.modes.duos,{r:1180,n:5,w:1,peak:1190}); rbRefresh(); go('menu');");
  await A.waitForTimeout(400);
  check(await A.isVisible('#rkHome .rkb'), 'a placed player has a rank badge on the Play card name plate (with the battalion tag)');
  await shot(A, 'ranked_10_home_badge');
  await ev(A, "openProfile('overview')"); await A.waitForSelector('#rkProf .rkmc');
  check(/Gold III/.test(await A.textContent('#rkProf')), 'Profile shows the tier: Gold III');
  // season-end rewards for last season's peak tier (granted on the device)
  check(await ev(A, "RKS.me.prev={season:5,solo:{peak:1720,tier:'diamond'}}; rkRewards(); PROF.id.tt.includes('t_rk_diamond')&&PROF.id.tt.includes('t_rk_bronze')&&PROF.id.bn.includes('bn_rk_diamond')&&!PROF.id.bn.includes('bn_rk_storm')"), 'season rewards: titles up to the peak tier (Diamond) and its banner');
  await shot(A, 'ranked_11_profile');
  check(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  await br.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
