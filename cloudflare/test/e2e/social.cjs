// Browser test of socials against a local Worker (wrangler dev): two players (A, B) in separate browser contexts get
// accounts through the app (Friends -> Turn on online account), add each other by friend code and by ?friend= link,
// see presence (online / in lobby / in match / offline + last seen), invite each other to an online room (offline
// invite delivered on the next app start, decline, live invite -> Join), play the match in lockstep through the own
// signaling server (every round's full state hash must match), then remove/block, client-side expiry, the in-match
// invite badge, the no-backend fallback and the add-friend rate limit.
//   node test/e2e/social.cjs        (needs `npm run dev` running, or SF_API=<url>; SHOTS=<dir> for screenshots)
const { chromium } = require('playwright');
const { API, routeGame } = require('./util.cjs');
const BOT = require('./bot.cjs');
const SHOTS = process.env.SHOTS || '';
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: SHOTS + '/' + n + '.png' }); };
const ev = (p, s) => p.evaluate(x => window.__ev(x), s);
const until = (p, js, ms = 20000) => p.waitForFunction(s => window.__ev && window.__ev(s), js, { timeout: ms, polling: 250 });
const post = async (path, b) => { const r = await fetch(API + '/api/' + path, { method: 'POST', body: JSON.stringify(b) }); return { s: r.status, j: await r.json() }; };
// records a hash of the full state at every storm phase (once per round), exactly like test/e2e/online.cjs
const REC = `(()=>{ window.TR=[]; const sp0=stormPhase; stormPhase=async function(){ let gh=0; for(let i=0;i<MW*MH;i++){ const o=G.grid[i], v=o?o.kind+':'+o.t+':'+(o.hp==null?'':o.hp):'-'; for(let k=0;k<v.length;k++) gh=(Math.imul(gh,31)+v.charCodeAt(k))|0; }
  TR.push(G.round+':'+G.units.map(u=>[u.id,u.x,u.y,u.hp,u.shield,u.ammo,u.sAmmo,+u.alive,+u.downed,u.disorient,u.mob,u.W.clip,u.patt,u.satt,u.utils.map(q=>q.ch).join('/')].join(',')).join('|')+'|c'+G.crates.length+'|g'+gh+'|cmd'+JSON.stringify(G.cmd));
  return sp0(); }; })()`;

(async () => {
  const br = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns,LocalNetworkAccessChecks'] });
  const errs = [];
  const init = () => { window.STORMFALL_PEER = { config: { iceServers: [] } }; }; // local test: host candidates only
  async function page(ctx, tag, q = '', api) {
    const p = await ctx.newPage(); await p.addInitScript(init); await routeGame(p, api);
    p.on('pageerror', e => errs.push(tag + ' pageerror ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION|net::|WebSocket/.test(m.text())) errs.push(tag + ' console ' + m.text()); });
    await p.goto(API + '/' + q); await p.waitForFunction(() => window.__ev && document.querySelector('#menu'));
    await p.waitForTimeout(300); if (await p.isVisible('#howClose')) await p.click('#howClose');
    return p;
  }
  const vp = { viewport: { width: 390, height: 844 } };
  const ctxA = await br.newContext(vp), ctxB = await br.newContext(vp);
  let A = await page(ctxA, 'A'), B = await page(ctxB, 'B');
  await ev(A, "LO.name='ALPHA'; saveLO();"); await ev(B, "LO.name='BRAVO'; LO.cls='sharpshooter'; LO=sanitize(LO); saveLO();");

  // ---------- accounts through the app ----------
  for (const p of [A, B]) {
    await p.click('#bFriends'); await p.waitForSelector('#frSheet.on');
    if (p === A) await shot(A, 'social_01_turn_on');
    await p.click('[data-fra=on]');
    await p.waitForSelector('#frCode', { timeout: 20000 });
  }
  const codeA = await ev(A, 'SOCS.code'), codeB = await ev(B, 'SOCS.code');
  check(/^[0-9A-Z]{8}$/.test(codeA) && /^[0-9A-Z]{8}$/.test(codeB) && codeA !== codeB, 'each player got an account and a friend code: ' + codeA + ', ' + codeB);
  check(!(await ev(A, 'CLS.code')).replace(/-/g, '').includes(codeA), 'the friend code is not part of the private account code');
  await until(A, 'SOC.authed'); await until(B, 'SOC.authed');
  check(true, 'presence sockets authenticated');
  await shot(A, 'social_02_friends_empty');

  // ---------- add by code, accept ----------
  await A.fill('#frAdd', codeB.toLowerCase().slice(0, 4) + '-' + codeB.slice(4).toLowerCase());
  await A.click('[data-fra=add]');
  await until(A, "/Request sent/.test($('#frMsg').textContent)");
  check(true, 'A sent a request by code (lower case, with dash)');
  await until(B, "SOCS.list&&SOCS.list.inc.length===1", 10000);
  check(true, 'B saw the request live (no reload)');
  await shot(B, 'social_03_request_incoming');
  await B.click('[data-fra=accept]');
  await until(A, "SOCS.list&&SOCS.list.friends.length===1&&SOC.pres['" + codeB + "']&&SOC.pres['" + codeB + "'].s==='menu'");
  await until(B, "SOCS.list&&SOCS.list.friends.length===1&&SOC.pres['" + codeA + "']&&SOC.pres['" + codeA + "'].s==='menu'");
  check(true, 'accepted: both are friends and see each other Online');
  check(/BRAVO/.test(await A.textContent('#frLists')) && /Sharpshooter · Online/.test(await A.textContent('#frLists')), 'A sees BRAVO with class and status');

  // ---------- add by link: C (created through the API) ----------
  const C = (await post('account', {})); const Ca = C.j.auth;
  const codeC = (await post('social/me', { auth: Ca, name: 'charlie', lv: 4, cls: 'ranger' })).j.code;
  await A.close(); A = await page(ctxA, 'A', '?friend=' + codeC.slice(0, 4) + '-' + codeC.slice(4));
  await A.waitForSelector('#frSheet.on'); await until(A, "$('#frAdd')&&$('#frAdd').value.replace('-','')==='" + codeC + "'");
  check(new URL(A.url()).search === '', 'the ?friend= link opened the add-friend prompt (and left the address bar clean)');
  await shot(A, 'social_04_friend_link');
  await A.click('[data-fra=add]'); await until(A, "SOCS.list&&SOCS.list.out.length===1");
  check((await post('social/act', { auth: Ca, code: codeA, a: 'accept' })).j.st === 'f', 'C accepted through the API');
  await until(A, "SOCS.list&&SOCS.list.friends.length===2", 10000);
  check(/CHARLIE/.test(await A.textContent('#frLists')) && /Last seen|Offline/.test(await A.textContent('[data-row="' + codeC + '"]')), 'A sees C as an offline friend (last seen)');
  await until(A, 'SOC.authed');

  // ---------- presence: lobby, offline, back ----------
  await A.click('#frSheet .sheet-head [data-frx]'); await B.click('#frSheet .sheet-head [data-frx]');
  await B.click('#bOnline'); await B.click('[data-on=host]'); await B.waitForSelector('#lobby .wr-code b', { timeout: 15000 });
  const roomB = await B.textContent('#lobby .wr-code b');
  await until(A, "SOC.pres['" + codeB + "']&&SOC.pres['" + codeB + "'].s==='lobby'&&SOC.pres['" + codeB + "'].r==='" + roomB + "'", 10000);
  await A.click('#bFriends'); await A.waitForSelector('[data-row="' + codeB + '"] [data-fra=join]');
  check(true, 'A sees B "In a lobby" with a Join button (room ' + roomB + ')');
  await shot(A, 'social_05_friend_in_lobby');
  await A.click('[data-row="' + codeB + '"] [data-fra=join]');
  await B.waitForFunction(() => __ev('NET.players.length===2'), null, { timeout: 20000 });
  check(await ev(A, 'NET.code') === roomB && !(await A.isVisible('#frSheet')), 'A tapped Join on B in the friends list and joined room ' + roomB);
  await A.waitForSelector('#lobby:not(.hidden) #wrLeave'); await A.click('#wrLeave');
  await B.waitForFunction(() => __ev('NET.players.length===1'), null, { timeout: 20000 });
  await B.click('#wrLeave');
  await until(A, "SOC.pres['" + codeB + "']&&SOC.pres['" + codeB + "'].s==='menu'", 10000);
  check(true, 'B left the room: Online again');
  await A.click('#bFriends'); await A.waitForSelector('#frSheet.on');
  await B.close();
  await until(A, "!SOC.pres['" + codeB + "']", 10000);
  await until(A, "/Last seen/.test($('[data-row=\"" + codeB + "\"]').textContent)", 5000);
  check(true, 'B closed the app: A sees B offline with last seen');
  await shot(A, 'social_06_friend_offline');

  // ---------- offline invite: A hosts, invites B while B is away; B opens the app and sees it ----------
  await A.click('#frSheet .sheet-head [data-frx]');
  await A.click('#bOnline'); await A.click('[data-on=host]'); await A.waitForSelector('#lobby .wr-code b', { timeout: 15000 });
  const room = await A.textContent('#lobby .wr-code b');
  check(await A.isVisible('#wrRoom [data-fr=invite]'), 'the waiting room has an Invite friends button');
  await shot(A, 'social_07_lobby_invite_button');
  await A.click('#wrRoom [data-fr=invite]'); await A.waitForSelector('#frSheet.on');
  await until(A, "SOC.sent.includes('lobby')", 5000);
  await A.click('[data-row="' + codeB + '"] [data-fra=inv]');
  await until(A, "[...document.querySelectorAll('#toasts .toast b')].some(b=>/Invite saved/.test(b.textContent))", 8000);
  check(true, 'invite to offline B was saved (toast "Invite saved")');
  await shot(A, 'social_08_invite_picker');
  B = await page(ctxB, 'B');
  await B.waitForSelector('#sfInv .ivcard', { timeout: 15000 });
  check(/ALPHA invites you/.test(await B.textContent('#sfInv')) && (await B.textContent('#sfInv')).includes(room), 'B opened the app and got the stored invite as a card');
  await shot(B, 'social_09_invite_card');
  await B.click('#sfInv [data-ivd]');
  await until(A, "[...document.querySelectorAll('#toasts .toast b')].some(b=>/declined/.test(b.textContent))", 8000);
  check(!(await B.isVisible('#sfInv .ivcard')), 'B declined: the card is gone and A was told');

  // ---------- client-side expiry ----------
  await ev(B, "socInvAdd({c:'" + codeA + "',n:'ALPHA',r:'" + room + "',m:'solo',exp:Date.now()+2500},true)");
  check(await B.isVisible('#sfInv .ivcard'), 'a short-lived invite shows');
  await B.waitForTimeout(4500);
  check(!(await B.isVisible('#sfInv .ivcard')) && (await ev(B, 'SOCS.inv.length')) === 0, 'and disappears when it expires');

  // ---------- live invite -> Join -> match in lockstep ----------
  await until(A, "SOC.pres['" + codeB + "']", 10000);
  await A.waitForTimeout(400);
  await A.click('[data-row="' + codeB + '"] [data-fra=inv]').catch(async () => { await ev(A, "socInvite('" + codeB + "')"); });
  await B.waitForSelector('#sfInv .ivcard', { timeout: 10000 });
  check(true, 'B (online) got the live invite');
  await B.click('#sfInv [data-ivj]');
  await A.waitForFunction(() => __ev('NET.players.length===2'), null, { timeout: 20000 });
  await B.waitForSelector('#lobby:not(.hidden) .wr-code', { timeout: 10000 });
  check(await ev(B, 'NET.code') === room, 'B joined room ' + room + ' through the invite');
  await A.click('#frSheet .sheet-head [data-frx]').catch(() => {});
  await shot(A, 'social_10_room_joined_host'); await shot(B, 'social_10_room_joined_guest');
  await until(A, "SOC.pres['" + codeB + "']&&SOC.pres['" + codeB + "'].s==='lobby'", 10000);

  for (const p of [A, B]) { await ev(p, BOT); await ev(p, REC); }
  await A.click('[data-lbmode=quick]'); await B.waitForFunction(() => __ev('NET.mode==="quick"'), null, { timeout: 5000 });
  if (await A.isEnabled('#wrFill')) await A.click('#wrFill'); await A.waitForTimeout(200); // quick: 2 humans + 2 bots
  // C watches presence through its own socket (node WebSocket): A must show "in match"
  const cs = new WebSocket(API.replace(/^http/, 'ws') + '/api/social/ws?c=' + codeC), cmsg = [];
  cs.onmessage = e => cmsg.push(JSON.parse(e.data));
  await new Promise(r => { cs.onopen = r; });
  cs.send(JSON.stringify({ t: 'auth', auth: Ca, s: 'menu' }));
  await A.click('#wrDeploy');
  for (const p of [A, B]) await p.waitForFunction(() => __ev("G.scene==='game'&&$('#roul').classList.contains('hidden')&&G.round>=1"), null, { timeout: 30000 });
  for (let i = 0; i < 20 && !cmsg.some(m => m.t === 'p' && m.c === codeA && m.s === 'match') && !(cmsg.find(m => m.t === 'hi') && cmsg.find(m => m.t === 'hi').on[codeA] && cmsg.find(m => m.t === 'hi').on[codeA].s === 'match'); i++) await A.waitForTimeout(500);
  check(cmsg.some(m => m.t === 'p' && m.c === codeA && m.s === 'match') || (cmsg.find(m => m.t === 'hi') || { on: {} }).on[codeA]?.s === 'match', 'a friend (C) sees A "in match" through presence');
  // an invite arriving during a match: a small badge, no card
  await ev(B, "socInvAdd({c:'" + codeA + "',n:'ALPHA',r:'ZZZZZ',m:'duos',exp:Date.now()+60000},true)");
  await B.waitForTimeout(2300);
  check(await B.isVisible('#sfInvBadge') && !(await B.isVisible('#sfInv .ivcard')), 'during a match an invite shows as a badge, not a card');
  await shot(B, 'social_11_match_badge');
  await ev(B, "socInvDrop(()=>true)");
  for (let i = 0; i < 80; i++) { if (await ev(A, 'G.over') && await ev(B, 'G.over')) break; await A.waitForTimeout(3000); }
  await B.waitForFunction(() => __ev('G.over'), null, { timeout: 180000, polling: 1000 });
  await A.waitForTimeout(2500);
  const ta = await ev(A, 'TR'), tb = await ev(B, 'TR');
  let bad = -1; for (let i = 0; i < Math.min(ta.length, tb.length); i++) if (ta[i] !== tb[i]) { bad = i; break; }
  check(bad < 0 && ta.length === tb.length && ta.length > 0, 'match: rounds A ' + ta.length + ' B ' + tb.length + ' ' + (bad < 0 && ta.length === tb.length ? 'IN SYNC every round' : 'DESYNC at ' + bad));
  const so = await ev(A, "JSON.stringify((({host,port,path})=>({host,port,path}))(NET.peer.options))");
  check(/127\.0\.0\.1/.test(so) && /\/api\//.test(so), 'signaling went through the own server ' + so);
  cs.close();
  await shot(A, 'social_12_match_end');

  // ---------- remove and block (after the match, back on the menus) ----------
  await ev(A, 'toMenu(); netLeave();'); await ev(B, 'toMenu(); netLeave();');
  await A.click('#bFriends'); await A.waitForSelector('[data-row="' + codeC + '"]');
  await A.click('[data-row="' + codeC + '"] [data-fra=more]'); await A.click('[data-row="' + codeC + '"] [data-fra=remove]');
  await A.click('[data-row="' + codeC + '"] [data-fra=remove]'); // tap again to confirm
  await until(A, "SOCS.list&&!SOCS.list.friends.some(f=>f.c==='" + codeC + "')", 8000);
  check((await post('social/list', { auth: Ca })).j.friends.length === 0, 'A removed C (both sides)');
  await A.click('[data-row="' + codeB + '"] [data-fra=more]');
  await shot(A, 'social_13_more_actions');
  await A.click('[data-row="' + codeB + '"] [data-fra=block]'); await A.click('[data-row="' + codeB + '"] [data-fra=block]');
  await until(A, "SOCS.list&&SOCS.list.blk.length===1&&SOCS.list.friends.length===0", 8000);
  await until(B, "SOCS.list&&SOCS.list.friends.length===0&&!SOC.pres['" + codeA + "']", 10000);
  check(true, 'A blocked B: B lost A from the list and from presence, live');
  await B.click('#bFriends'); await B.fill('#frAdd', codeA); await B.click('[data-fra=add]');
  await until(B, "/No player with that friend code/.test($('#frMsg').textContent)", 8000);
  check(true, 'B cannot find A any more (same answer as a wrong code)');
  await A.evaluate(() => { const d = document.querySelector('.frblk'); if (d) d.open = true; });
  await shot(A, 'social_14_blocked');

  // ---------- rate limit on friend-code lookups ----------
  let msg = '';
  for (let i = 0; i < 7; i++) { await B.fill('#frAdd', 'ZZZZZZZ' + i); await B.click('[data-fra=add]'); await B.waitForTimeout(400); msg = await B.textContent('#frMsg'); if (/Too many tries/.test(msg)) break; }
  check(/Too many tries/.test(msg), 'friend-code lookups are rate limited: "' + msg + '"');

  // ---------- a player with an account who never opened Friends costs the social backend nothing ----------
  const ctxD = await br.newContext(vp), D = await page(ctxD, 'D'), dreq = [];
  D.on('request', r => { if (/\/api\/social/.test(r.url())) dreq.push(r.url()); });
  D.on('websocket', w => { if (/\/api\/social/.test(w.url())) dreq.push(w.url()); });
  await ev(D, 'PROF.xp=500; saveProf();');
  await until(D, 'CLS.auth&&CLS.rev>=1', 40000); await D.waitForTimeout(5000);
  check(dreq.length === 0, 'account without Friends use: no /api/social calls and no presence socket (' + dreq.length + ')');

  // ---------- no backend (GitHub Pages without the meta, or sf-api="off") ----------
  const ctxN = await br.newContext(vp), N = await page(ctxN, 'N', '?friend=ABCD-EFGH', 'off');
  check(!(await N.isVisible('#bFriends')), 'without a backend the Friends button is hidden');
  await N.waitForSelector('#frSheet.on');
  check(/needs? the Stormfall online service/.test(await N.textContent('#frBody')), 'a friend link explains that Friends need the online service');
  await shot(N, 'social_15_no_backend');
  await N.click('#frSheet .sheet-head [data-frx]'); await N.waitForTimeout(400);
  await shot(N, 'social_16_home_no_backend');
  await shot(A, 'social_17_home_with_friends'); // (A's Friends sheet is open; close it for the Home shot)
  await A.click('#frSheet .sheet-head [data-frx]'); await A.waitForTimeout(300); await shot(A, 'social_17_home_with_friends');

  check(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  await br.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
