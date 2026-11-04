// shared test bot: drives G.player through playCmd (human-style commands) without touching the seeded RNG
module.exports=`(()=>{ const u0=update; window.update=update=dt=>u0(dt*(window.SPD||8));
  setInterval(()=>{ if(!inputOpen()||window.NOBOT) return; const keep=RNG, I0=G.intel, r0=G.player.roam, g0=G.player._goal; G.intel={}; for(const k in I0) G.intel[k]=new Map(I0[k]); RNG=Math.random; let c; try{ c=bot(); } finally { RNG=keep; G.intel=I0; G.player.roam=r0; G.player._goal=g0; } G.busy=true; G.mode='idle'; playCmd(c); },120);
  function bot(){ const u=G.player;
    if(u.ap>0){
      if(G.M.team>1&&aiMate(u)&&window.PR!==G.round&&Math.random()<0.5){ window.PR=G.round; const P=['move','hold','regroup','push','watch','loot','enemy','fallback','danger'][Math.floor(Math.random()*9)]; return {k:'ping',p:P,x:clamp(u.x+Math.round((Math.random()*2-1)*6),0,MW-1),y:clamp(u.y+Math.round((Math.random()*2-1)*6),0,MH-1)}; }
      if(!u.shot){ const di=u.utils.findIndex(q=>(q.id==='drone'||q.id==='sensor')&&q.ch>0); if(di>=0&&Math.random()<0.3){ const U=UTILS[u.utils[di].id], rg=throwRange(u,U);
        for(let k=0;k<30;k++){ const x=u.x+Math.round((Math.random()*2-1)*rg), y=u.y+Math.round((Math.random()*2-1)*rg); if(inMap(x,y)&&!isFull(x,y)&&Math.hypot(x-u.x,y-u.y)<=rg) return {k:'throw',i:di,x,y}; } } }
      if(!u.shot&&u.ammo>0&&!(u.W.heavy&&u.ap<2)&&Math.random()<0.1){ const ot=objTargets(u); if(ot.length){ const q=ot[Math.floor(Math.random()*ot.length)]; return {k:'obj',x:q.x,y:q.y}; } }
      const dr=adjDoor(u); if(dr&&u.doorR!==G.round&&Math.random()<0.5&&!(dr.o.t<2&&doorBlocked(dr.x,dr.y))) return {k:'door',x:dr.x,y:dr.y};
      if(!u.shot&&u.ammo<u.W.clip&&Math.random()<0.2) return {k:'reload'};
      const a=aiBestAttack(u);
      if(a&&a.score>=8){ if(a.k==='throw') return {k:'throw',i:u.utils.indexOf(a.util),x:a.x,y:a.y}; if(a.k==='sec') return {k:'sec',t:a.t.id,path:a.path}; if(ACTS[a.k]) return {k:'act',a:a.k,t:a.t?a.t.id:null}; if(a.k==='obj') return {k:'obj',x:a.x,y:a.y};
        return {k:'fire',kind:a.k,t:a.t.id,path:a.path}; }
      if(!u.moved){ const mv=aiChooseMove(u); if(mv){ const ap=mv.cost<=u.mob+1e-6?1:2; if(ap<=u.ap) return {k:'move',path:mv.path,ap}; } } }
    return {k:u.ammo>0?'ow':'end'}; } })()`;
