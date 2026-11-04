// Online lockstep through the backend's own signaling Durable Object (no PeerJS server): two browsers, each driven by a
// bot, play a full online match; every round's full state hash must match on both. Optionally a third browser joins
// as a spectator. The page comes from the local Worker (wrangler dev), so peerOpts() picks <origin>/api/peerjs.
//   node test/e2e/online.cjs <quick|duos|solo> [split] [bots] [spec]    (needs `npm run dev` running)
// Adapted from the project's two-browser lockstep harness (attachments + mastery + team pings).
// Both players carry attachments (and mastery finishes); the bot exercises doors/devices/objects as in t4p, plus:
//  - AI-affecting pings through playCmd ({k:'ping'}) during its own turn when it has an AI teammate
//  - purely visual pings over the network at any time (placePing from a timer)
// usage: node t5.js <mode> [split] [diff]   split=1 in duos: A and B on different teams, each with an AI partner
const {chromium}=require('playwright'); const {API,routeGame}=require('./util.cjs'); const SPEC=process.argv[5]==='spec';
const MODE=process.argv[2]||'quick', SPLIT=process.argv[3]==='1', BOTS=(process.argv[4]||'veteran').split(',').filter(Boolean);
const S=(process.env.SHOTS||require('os').tmpdir())+'/';
const LOADS={A:["specialist","volt","pistol","{volt:{optic:'acog',mag:'speed',under:'stock'},pistol:{optic:'reddot',barrel:'supp',mag:'extmag'}}","m_storm"],
  B:["ranger","shotgun","machpistol","{shotgun:{optic:'reddot',barrel:'supp',mag:'speed',under:'grip'},machpistol:{optic:'reddot',barrel:'comp',mag:'speed'}}","m_tiger"]};
(async()=>{
  const br=await chromium.launch({args:['--disable-features=WebRtcHideLocalIpsWithMdns,LocalNetworkAccessChecks']});
  const init=()=>{ window.STORMFALL_PEER={config:{iceServers:[]}}; /* local test: host candidates only; signaling = the page's own backend */ };
  const errs=[]; global.ERRS=errs; const ext=[], sig=[];
  const mk=async(tag)=>{ const ctx=await br.newContext({viewport:{width:390,height:844}}); const p=await ctx.newPage(); await p.addInitScript(init); await routeGame(p); p.on('request',r=>{ const u=r.url(); if(/peerjs\.com/.test(u)) ext.push(u); if(/\/api\/(peerjs|turn)/.test(u)) sig.push(tag+' '+u.replace(API,'').split('?')[0]); }); p.on('websocket',w=>sig.push(tag+' ws '+w.url().replace(/^ws:\/\/[^/]+/,'').split('&')[0]));
    p.on('pageerror',e=>errs.push(tag+' pageerror '+e.stack.split('\n').slice(0,3).join(' | '))); p.on('console',m=>{ if(m.type()==='error') errs.push(tag+' console '+m.text()); });
    await p.goto(API+'/'); await p.waitForTimeout(500);
    if(await p.isVisible('#howClose')) await p.click('#howClose');
    const L=LOADS[tag]||LOADS.A;
    await p.evaluate(s=>__ev(s),"PROF.xp=60000; PROF.mast={}; for(const k in WEAPONS) PROF.mast[k]=9000; for(const k in SECONDARIES) PROF.mast[k]=9000; PROF.mfin={"+L[1]+":'"+L[4]+"'}; saveProf(); LO.cls='"+L[0]+"'; LO.utils=['drone','sensor','frag'].filter(u=>CLASSES['"+L[0]+"'].utils.includes(u)); LO.weapon='"+L[1]+"'; LO.sec='"+L[2]+"'; LO.att="+L[3]+"; LO=sanitize(LO); saveLO();");
    await p.evaluate(sp=>__ev(`(()=>{ const u0=update; window.update=update=dt=>u0(dt*8); window.TR=[]; window.TT=[]; window.__RC=0; window.SPLIT=${sp}; window.EVN={};
      const s0=seedRNG; seedRNG=function(x){ s0(x); const r=RNG; RNG=function(){ window.__RC++; return r(); }; };
      // split duos: humans in different teams, each with an AI partner (same on every client: applied after cleanSpec)
      const sm=setupMatch; setupMatch=function(lo,mk,net,pre){ if(net&&window.SPLIT&&net.slots&&net.slots.filter(x=>x.h).length===2&&net.slots.length>=4){ const h=net.slots.filter(x=>x.h), b=net.slots.filter(x=>!x.h); net=Object.assign({},net,{slots:[h[0],b[0],h[1]].concat(b.slice(1))}); } return sm(lo,mk,net,pre); };
      const ut=unitTurn; unitTurn=async function(u,m){ window.CUR=u.name+'#'+u.id+(u.isPlayer?'(me)':u.net?'(net)':'(ai)'); TT.push(G.round+' '+u.id+' rc='+window.__RC+' cmd='+JSON.stringify(G.cmd)+' '+G.units.map(v=>[v.x,v.y,v.hp,+v.alive].join(',')).join('|')); return ut(u,m); };
      const sp0=stormPhase; stormPhase=async function(){ let gh=0; for(let i=0;i<MW*MH;i++){ const o=G.grid[i], v=o?o.kind+':'+o.t+':'+(o.hp==null?'':o.hp):'-'; for(let k=0;k<v.length;k++) gh=(Math.imul(gh,31)+v.charCodeAt(k))|0; }
        TR.push(G.round+':'+G.units.map(u=>[u.id,u.x,u.y,u.hp,u.shield,u.ammo,u.sAmmo,+u.alive,+u.downed,u.disorient,u.mob,u.W.clip,u.patt,u.satt,+!!u.frl,u.utils.map(q=>q.ch).join('/'),u.rfKey||''].join(',')).join('|')+'|c'+G.crates.length+'|g'+gh+'|cmd'+JSON.stringify(G.cmd)+'|in'+Object.keys(G.intel).map(k=>k+':'+[...G.intel[k]].map(e=>e[0]+'@'+e[1].x+','+e[1].y+','+e[1].r).join('/')).join(';')+'|rng'+window.__RC);
        return sp0(); };
      const cnt=(n,f)=>function(...a){ EVN[n]=(EVN[n]||0)+1; return f.apply(this,a); };
      doDoor=cnt('door',doDoor); shootObj=cnt('obj',shootObj); deployDevice=cnt('device',deployDevice); doReload=cnt('reload',doReload);
      applyPing=cnt('applyPing',applyPing); showTeamPing=cnt('showPing',showTeamPing); recvPing=cnt('recvPing',recvPing); netSendPing=cnt('sendPing',netSendPing);
      const AIP=['move','hold','regroup','push','watch','loot','enemy','fallback','danger'], VP=Object.keys(PINGS);
      // visual pings any time (placePing routes them: lockstep command on your own turn with an AI mate, else network message)
      setInterval(()=>{ if(!teamMode()||G.over||!G.player.alive||Math.random()>0.6||inputOpen()) return; placePing(VP[Math.floor(Math.random()*VP.length)],Math.floor(Math.random()*MW),Math.floor(Math.random()*MH)); },1500);
      setInterval(()=>{ if(!inputOpen()) return; const keep=RNG, I0=G.intel, r0=G.player.roam, g0=G.player._goal; G.intel={}; for(const k in I0) G.intel[k]=new Map(I0[k]); RNG=Math.random; let c; try{ c=bot(); } finally { RNG=keep; G.intel=I0; G.player.roam=r0; G.player._goal=g0; } G.busy=true; G.mode='idle'; playCmd(c); },120); function bot(){ const u=G.player;
        if(u.ap>0){
          // an order for the AI teammate, at most once per turn, through the command path
          if(aiMate(u)&&window.PR!==G.round&&Math.random()<0.6){ window.PR=G.round; const k=AIP[Math.floor(Math.random()*AIP.length)]; EVN.cmdPing=(EVN.cmdPing||0)+1; return {k:'ping',p:k,x:clamp(u.x+Math.round((Math.random()*2-1)*6),0,MW-1),y:clamp(u.y+Math.round((Math.random()*2-1)*6),0,MH-1)}; }
          const dr=adjDoor(u); if(dr&&u.doorR!==G.round&&Math.random()<0.6&&!(dr.o.t<2&&doorBlocked(dr.x,dr.y))) return {k:'door',x:dr.x,y:dr.y};
          if(!u.shot){ const di=u.utils.findIndex(q=>(q.id==='drone'||q.id==='sensor')&&q.ch>0); if(di>=0&&Math.random()<0.3){ const U=UTILS[u.utils[di].id], rg=throwRange(u,U);
            for(let k=0;k<30;k++){ const x=u.x+Math.round((Math.random()*2-1)*rg), y=u.y+Math.round((Math.random()*2-1)*rg); if(inMap(x,y)&&!isFull(x,y)&&Math.hypot(x-u.x,y-u.y)<=rg) return {k:'throw',i:di,x,y}; } } }
          if(!u.shot&&u.ammo>0&&!(u.W.heavy&&u.ap<2)&&Math.random()<0.15){ const ot=objTargets(u); if(ot.length){ const q=ot[Math.floor(Math.random()*ot.length)]; return {k:'obj',x:q.x,y:q.y}; } }
          // reload early sometimes so the Speed Loader free reload gets used
          if(!u.shot&&u.ammo<u.W.clip&&Math.random()<0.25) return {k:'reload'};
          const a=aiBestAttack(u);
          if(a&&a.score>=8){ if(a.k==='throw') return {k:'throw',i:u.utils.indexOf(a.util),x:a.x,y:a.y}; if(a.k==='sec') return {k:'sec',t:a.t.id,path:a.path}; if(ACTS[a.k]) return {k:'act',a:a.k,t:a.t?a.t.id:null}; if(a.k==='obj') return {k:'obj',x:a.x,y:a.y};
            return {k:'fire',kind:a.k,t:a.t.id,path:a.path}; }
          if(!u.moved){ const mv=aiChooseMove(u); if(mv){ const ap=mv.cost<=u.mob+1e-6?1:2; if(ap<=u.ap) return {k:'move',path:mv.path,ap}; } } }
        return {k:u.ammo>0?'ow':'end'}; } })()`),SPLIT);
    return p; };
  const A=await mk('A'), B=await mk('B');
  await A.click('#bOnline'); await A.click('#msGo'); await A.waitForSelector('#lobby .wr-code b',{timeout:15000});
  const code=await A.textContent('#lobby .wr-code b'); console.log('room',code,'mode',MODE,'split',SPLIT,'bots',BOTS.join(','));
  await B.click('#bOnline'); await B.fill('#onCode',code); await B.click('[data-on=join]');
  await A.waitForFunction(()=>__ev('NET.players.length===2'),null,{timeout:20000});
  await B.waitForSelector('#lobby:not(.hidden) .wr-code',{timeout:10000});
  await A.click('[data-lbmode='+MODE+']'); await B.waitForFunction(m=>__ev('NET.mode==="'+m+'"'),MODE,{timeout:5000});
  // host builds the bot list in the waiting room: fewest bots, add up to the wanted count, then pick each difficulty by tapping
  await A.click('#wrMin'); await A.waitForTimeout(150);
  const per=MODE==='duos'?2:1;
  for(let i=0;i<12;i++){ const n=await A.evaluate(()=>__ev('lbCtx().bots.length')); if(n>=BOTS.length||!(await A.isVisible('[data-badd]'))) break; await A.click('[data-badd]'); await A.waitForTimeout(80); }
  const nb=await A.evaluate(()=>__ev('lbCtx().bots.length'));
  for(let i=0;i<nb;i++){ const d=BOTS[i%BOTS.length]; await A.click('[data-bd="'+i+':'+d+'"]'); await A.waitForTimeout(60); }
  await A.waitForTimeout(400);
  const wA=await A.evaluate(()=>__ev("JSON.stringify(lbCtx().bots)")), wB=await B.evaluate(()=>__ev("JSON.stringify(lbCtx().bots)"));
  console.log('waiting room bots host',wA,'guest',wB,wA===wB?'(match)':'(MISMATCH)','guest read-only:',await B.evaluate(()=>__ev("!document.querySelector('#lobby [data-bd]')&&$('#wrDeploy').classList.contains('hidden')")));
  await A.screenshot({path:S+'room_host_'+MODE+'.png'}); await B.screenshot({path:S+'room_guest_'+MODE+'.png'});
  await A.click('#wrDeploy');
  for(const p of [A,B]) await p.waitForFunction(()=>__ev("G.scene==='game'&&$('#roul').classList.contains('hidden')&&G.round>=1"),null,{timeout:30000});
  const roster=async p=>p.evaluate(()=>__ev("G.units.map(u=>u.name+(u.isPlayer?'*':'')+(u.net?'@':'')+':'+u.team+':'+(u.human?'H':u.diff.key)+'['+u.wid+':'+u.patt+(u.pfin?' '+u.pfin:'')+'/'+u.sid+':'+u.satt+(u.sfin?' '+u.sfin:'')+']').join(' ')"));
  const ra=await roster(A), rb=await roster(B); console.log('A',ra); console.log('B',rb); console.log('roster identical (names/teams/difficulty/gear):', ra.replace(/[*@]/g,'')===rb.replace(/[*@]/g,''));
  const so=await A.evaluate(()=>__ev("JSON.stringify((({host,port,path,key})=>({host,port,path,key}))(NET.peer.options))"));
  console.log('signaling host',so,'| requests:',[...new Set(sig)].join(', '),'| public PeerJS requests:',ext.length);
  if(SPEC){ const C=await mk('C'); await C.click('#bOnline'); await C.fill('#onCode',code); await C.click('[data-on=watch]');
    await C.waitForFunction(()=>__ev("G.scene==='game'&&!!G.watch&&G.watch.kind==='spec'&&G.round>=1"),null,{timeout:60000});
    console.log('spectator joined mid-match: watching round',await C.evaluate(()=>__ev('G.round')),'host round',await A.evaluate(()=>__ev('G.round')));
    global.SPECP=C; }
  let shot=false;
  for(let i=0;i<60;i++){ if(await A.evaluate(()=>__ev('G.over'))&&await B.evaluate(()=>__ev('G.over'))) break; await A.waitForTimeout(5000);
    if(!shot&&MODE==='duos'){ const n=await B.evaluate(()=>__ev("(G.tpings||[]).length")); if(n){ shot=true; await B.screenshot({path:S+'online_'+(SPLIT?'split':'team')+'_B_ping.png'}); await A.screenshot({path:S+'online_'+(SPLIT?'split':'team')+'_A_ping.png'}); } }
    if(i%4===0) console.log('A r'+await A.evaluate(()=>__ev("G.round+' cur='+window.CUR+' alive='+G.units.filter(standing).length"))); }
  await B.waitForFunction(()=>__ev('G.over'),null,{timeout:180000,polling:1000});
  await A.waitForTimeout(3000); await A.screenshot({path:S+'online_end_A_'+MODE+(SPLIT?'_split':'')+'.png'});
  const ta=await A.evaluate(()=>__ev('TR')), tb=await B.evaluate(()=>__ev('TR'));
  let bad=-1; for(let i=0;i<Math.min(ta.length,tb.length);i++) if(ta[i]!==tb[i]){ bad=i; break; }
  console.log('rounds A',ta.length,'B',tb.length, bad<0&&ta.length===tb.length?'IN SYNC every round':'DESYNC at round index '+bad+'\nA '+ta[bad]+'\nB '+tb[bad]);
  if(bad>=0){ const xa=await A.evaluate(()=>__ev('TT')), xb=await B.evaluate(()=>__ev('TT')); for(let i=0;i<Math.min(xa.length,xb.length);i++) if(xa[i]!==xb[i]){ console.log('first turn diff #'+i+'\nprevA '+xa[i-1]+'\nA '+xa[i]+'\nB '+xb[i]); break; } }
  const cmds=new Set(); for(const r of ta){ const m=r.split('|cmd')[1].split('|in')[0]; if(m!=='{}') cmds.add(m); } console.log('distinct team orders seen in round hashes:',cmds.size, [...cmds].slice(0,4).join(' '));
  console.log('result A',JSON.stringify(await A.evaluate(()=>__ev('G.result'))),'result B',JSON.stringify(await B.evaluate(()=>__ev('G.result'))));
  console.log('mastery A',JSON.stringify(await A.evaluate(()=>__ev('JSON.stringify((G.rewarded&&G.rewarded.mast||[]).map(m=>m.k+" "+m.b.l+"->"+m.a.l+" +"+m.gain))'))),'B',JSON.stringify(await B.evaluate(()=>__ev('JSON.stringify((G.rewarded&&G.rewarded.mast||[]).map(m=>m.k+" "+m.b.l+"->"+m.a.l+" +"+m.gain))'))));
  console.log('events A',JSON.stringify(await A.evaluate(()=>__ev('window.EVN'))),'B',JSON.stringify(await B.evaluate(()=>__ev('window.EVN'))));
  if(global.SPECP){ const C=global.SPECP; await C.waitForFunction(()=>__ev('G.over||!G.watch'),null,{timeout:120000,polling:1000}).catch(()=>{});
    console.log('spectator saw the end:',await C.evaluate(()=>__ev("JSON.stringify({over:G.over,round:G.round,winner:G.result&&G.result.winner})"))); }
  console.log('public PeerJS server used:',ext.length?ext:'never');
  console.log('errors',errs.length?errs:'none');
  await br.close();
})().catch(e=>{ console.error('FAIL',e.message,'\nerrs',JSON.stringify(ERRS)); process.exit(1); });
