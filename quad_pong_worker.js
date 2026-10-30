export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') === 'websocket') {
      const code = (url.searchParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
      if (!code) return new Response('Missing room', {status:400});
      const id = env.QUAD_PONG_ROOMS.idFromName(code);
      return env.QUAD_PONG_ROOMS.get(id).fetch(request);
    }
    return new Response('QUAD PONG multiplayer server online', {headers:{'content-type':'text/plain;charset=utf-8','access-control-allow-origin':'*'}});
  }
};

export class QuadPongRoom {
  constructor(state, env) {
    this.state = state; this.env = env; this.clients = new Map(); this.roomCode=''; this.hostId='';
    this.cfg={arena:4,cpu:'normal',mode:'classic'}; this.players=[]; this.ball=null; this.powerups=[]; this.stats={returns:0,longest:0,rally:0,maxSpeed:0};
    this.lastScorer=-1; this.status='lobby'; this.lastTick=Date.now(); this.tickTimer=null; this.powerSpawn=4;
  }
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket required',{status:426});
    const url=new URL(request.url); this.roomCode=(url.searchParams.get('room')||'ROOM').toUpperCase();
    const pair=new WebSocketPair(); const client=pair[0], server=pair[1]; server.accept();
    const id=crypto.randomUUID().slice(0,8); const name=(url.searchParams.get('name')||'Player').slice(0,16);
    this.clients.set(id,{ws:server,name,slot:-1,ready:true}); if(!this.hostId)this.hostId=id;
    server.addEventListener('message',e=>this.onMessage(id,e.data)); server.addEventListener('close',()=>this.onClose(id)); server.addEventListener('error',()=>this.onClose(id));
    server.send(JSON.stringify({t:'hello',id,room:this.roomCode,host:id===this.hostId})); this.assignSlots(); this.broadcastLobby();
    return new Response(null,{status:101,webSocket:client});
  }
  onMessage(id,data){ let m; try{m=JSON.parse(data)}catch{return} const c=this.clients.get(id); if(!c)return;
    if(m.t==='config'&&id===this.hostId&&this.status==='lobby'){this.cfg.arena=[2,3,4].includes(+m.arena)?+m.arena:4;this.cfg.mode=['classic','turbo','hot','shrink','ricochet','power','sudden'].includes(m.mode)?m.mode:'classic';this.cfg.cpu=['easy','normal','hard'].includes(m.cpu)?m.cpu:'normal';this.assignSlots();this.broadcastLobby();}
    if(m.t==='start'&&id===this.hostId&&this.status==='lobby')this.startGame();
    if(m.t==='paddle'&&this.status==='game'&&c.slot>=0){let p=this.players[c.slot];if(p&&p.online){let np=Math.max(.11,Math.min(.89,+m.pos||.5));p.vel=Math.max(-1.4,Math.min(1.4,+m.vel||0));p.pos=np;p.lastInput=Date.now();}}
    if(m.t==='rematch'&&id===this.hostId){this.status='lobby';this.broadcastLobby();}
  }
  onClose(id){const wasHost=id===this.hostId;this.clients.delete(id);if(wasHost)this.hostId=this.clients.keys().next().value||''; if(this.status==='game'){let p=this.players.find(x=>x.clientId===id);if(p){p.online=false;p.cpu=true;p.clientId='';p.name='CPU';}} this.assignSlots();this.broadcastLobby();if(!this.clients.size)this.stopTick();}
  assignSlots(){let max=this.cfg.arena;let list=[...this.clients.entries()];list.forEach(([id,c],i)=>c.slot=i<max?i:-1);}
  lobbyData(){let max=this.cfg.arena;let slots=[];for(let i=0;i<max;i++){let entry=[...this.clients.entries()].find(([,c])=>c.slot===i);slots.push(entry?{slot:i,name:entry[1].name,online:true,host:entry[0]===this.hostId,clientId:entry[0]}:{slot:i,name:'CPU',online:false,host:false,clientId:''});}return {t:'lobby',room:this.roomCode,cfg:this.cfg,slots,status:this.status,hostId:this.hostId};}
  broadcastLobby(){this.broadcast(this.lobbyData())}
  broadcast(o){let s=JSON.stringify(o);for(const {ws} of this.clients.values())try{ws.send(s)}catch{}}
  makePlayers(){let active=this.cfg.arena;this.players=[];for(let i=0;i<4;i++){let participating=i<active;let entry=[...this.clients.entries()].find(([,c])=>c.slot===i);this.players.push({i,participating,alive:participating,lives:participating?(this.cfg.mode==='sudden'?1:5):0,score:0,pos:.5,vel:0,size:.22,shield:0,bigUntil:0,online:!!entry,cpu:participating&&!entry,clientId:entry?entry[0]:'',name:entry?entry[1].name:'CPU'});}}
  startGame(){this.makePlayers();this.stats={returns:0,longest:0,rally:0,maxSpeed:0};this.lastScorer=-1;this.powerups=[];this.powerSpawn=3.5;this.status='game';this.resetBall(.8);this.broadcast({t:'start',cfg:this.cfg,players:this.publicPlayers()});this.startTick();}
  publicPlayers(){return this.players.map(p=>({i:p.i,participating:p.participating,alive:p.alive,lives:p.lives,score:p.score,pos:p.pos,vel:p.vel,size:p.size,shield:p.shield,name:p.name,online:p.online,cpu:p.cpu,clientId:p.clientId}))}
  resetBall(delay=.7){this.ball={x:.5,y:.5,vx:0,vy:0,r:.012,active:false,serveAt:Date.now()+delay*1000};this.stats.rally=0;}
  serve(){let a;if(this.cfg.arena===2){let dir=Math.random()<.5?-1:1;a=(Math.random()*.7-.35)+(dir>0?0:Math.PI)}else a=Math.random()*Math.PI*2;let sp=this.cfg.mode==='turbo'?.52:.47;this.ball.vx=Math.cos(a)*sp;this.ball.vy=Math.sin(a)*sp;if(Math.abs(this.ball.vx)<.16)this.ball.vx=Math.sign(this.ball.vx||1)*.2;if(Math.abs(this.ball.vy)<.12&&this.cfg.arena===4)this.ball.vy=Math.sign(this.ball.vy||1)*.15;this.ball.active=true;}
  startTick(){if(this.tickTimer)return;this.lastTick=Date.now();this.tickTimer=setInterval(()=>this.tick(),1000/60)} stopTick(){if(this.tickTimer){clearInterval(this.tickTimer);this.tickTimer=null}}
  cpu(p,b,dt){let four=this.cfg.arena!==2,reaction={easy:2.15,normal:four?4.45:3.65,hard:four?5.8:5.35}[this.cfg.cpu],err={easy:.10,normal:four?.034:.048,hard:.018}[this.cfg.cpu];let relevant=p.i<2?b.y:b.x,vel=p.i<2?b.vy:b.vx,toward=p.i===0?b.vx<0:p.i===1?b.vx>0:p.i===2?b.vy<0:b.vy>0,lead=toward?Math.max(-.10,Math.min(.10,vel*.075)):0,jitter=Math.sin(Date.now()/(four?820:700)+p.i*2)*err,target=Math.max(.10,Math.min(.90,relevant+lead+jitter)),old=p.pos;p.pos+=(target-p.pos)*Math.min(1,dt*reaction);p.vel=(p.pos-old)/Math.max(dt,.001)}
  hit(b,p){let half=p.size/2,off;if(p.i===0&&b.vx<0&&b.x-b.r<.035&&Math.abs(b.y-p.pos)<half+b.r){off=(b.y-p.pos)/half;b.vx=Math.abs(b.vx);b.x=.036+b.r}else if(p.i===1&&b.vx>0&&b.x+b.r>.965&&Math.abs(b.y-p.pos)<half+b.r){off=(b.y-p.pos)/half;b.vx=-Math.abs(b.vx);b.x=.964-b.r}else if(p.i===2&&b.vy<0&&b.y-b.r<.035&&Math.abs(b.x-p.pos)<half+b.r){off=(b.x-p.pos)/half;b.vy=Math.abs(b.vy);b.y=.036+b.r}else if(p.i===3&&b.vy>0&&b.y+b.r>.965&&Math.abs(b.x-p.pos)<half+b.r){off=(b.x-p.pos)/half;b.vy=-Math.abs(b.vy);b.y=.964-b.r}else return false;if(p.i<2)b.vy+=off*.22+p.vel*.045;else b.vx+=off*.22+p.vel*.045;let edge=Math.min(1,Math.abs(off)),slice=Math.min(1,Math.abs(p.vel)/.72),boost=1.025+edge*.10+slice*.10+(edge*slice)*.10+(this.cfg.mode==='turbo'?.055:0),sp=Math.min(this.cfg.mode==='turbo'?1.08:1,Math.hypot(b.vx,b.vy)*boost),ang=Math.atan2(b.vy,b.vx);b.vx=Math.cos(ang)*sp;b.vy=Math.sin(ang)*sp;if(this.cfg.mode==='shrink')p.size=Math.max(.115,p.size-.008);this.lastScorer=p.i;this.stats.returns++;this.stats.rally++;this.stats.longest=Math.max(this.stats.longest,this.stats.rally);this.stats.maxSpeed=Math.max(this.stats.maxSpeed,sp);return true}
  spawnPower(){let r=Math.random(),type=r<.18?'life':r<.43?'big':r<.68?'slow':r<.88?'shield':'blast';this.powerups.push({id:crypto.randomUUID().slice(0,6),x:.22+Math.random()*.56,y:.22+Math.random()*.56,r:.026,type,life:10})}
  collect(u,b){let p=this.players[this.lastScorer];if(!p||!p.alive)p=this.players.find(x=>x.alive);if(!p)return;if(u.type==='life'){if(this.cfg.arena!==2)p.lives=Math.min(7,p.lives+1);else p.shield=Math.min(2,p.shield+1)}else if(u.type==='big'){p.size=Math.min(.32,p.size+.075);p.bigUntil=Date.now()+8000}else if(u.type==='slow'){b.vx*=.72;b.vy*=.72}else if(u.type==='shield')p.shield=Math.min(2,p.shield+1);else if(u.type==='blast'){let sp=Math.min(1.12,Math.hypot(b.vx,b.vy)*1.28),a=Math.atan2(b.vy,b.vx);b.vx=Math.cos(a)*sp;b.vy=Math.sin(a)*sp}}
  goal(side){let v=this.players[side];if(this.cfg.mode==='power'&&v&&v.shield>0){v.shield--;return this.resetBall(.45)}if(this.cfg.arena===2){let s=side===0?1:0;this.players[s].score++;let target=this.cfg.mode==='sudden'?3:7;if(this.players[s].score>=target)return this.finish(this.players[s]);}else{if(!v||!v.participating||!v.alive)return this.resetBall(.45);v.lives-=this.cfg.mode==='hot'&&this.stats.rally>=14?2:1;if(v.lives<=0){v.lives=0;v.alive=false}let alive=this.players.filter(p=>p.participating&&p.alive);if(alive.length===1)return this.finish(alive[0]);}if(this.cfg.mode==='shrink')this.players.forEach(p=>p.size=Math.min(.22,p.size+.035));this.resetBall(.6)}
  finish(p){this.status='finished';this.ball.active=false;this.broadcast({t:'finish',winner:p.i,stats:this.stats,players:this.publicPlayers()});this.stopTick()}
  tick(){if(this.status!=='game')return;let now=Date.now(),dt=Math.min(.033,(now-this.lastTick)/1000);this.lastTick=now;let b=this.ball;if(!b.active){if(now>=b.serveAt)this.serve();this.sendState();return}for(const p of this.players){if(p.alive&&p.cpu)this.cpu(p,b,dt);if(p.bigUntil&&now>p.bigUntil){p.size=Math.max(.22,p.size-.075);p.bigUntil=0}}b.x+=b.vx*dt;b.y+=b.vy*dt;if(this.cfg.mode==='power'){this.powerSpawn-=dt;if(this.powerSpawn<=0&&this.powerups.length<2){this.spawnPower();this.powerSpawn=4.5+Math.random()*4}for(let i=this.powerups.length-1;i>=0;i--){let u=this.powerups[i];u.life-=dt;if(u.life<=0){this.powerups.splice(i,1);continue}if(Math.hypot(b.x-u.x,b.y-u.y)<b.r+u.r){this.collect(u,b);this.powerups.splice(i,1)}}}if(this.cfg.mode==='ricochet'){let bx=.5+Math.sin(now/900)*.12,by=.5,hw=.055,hh=.018;if(Math.abs(b.x-bx)<hw+b.r&&Math.abs(b.y-by)<hh+b.r){let dx=Math.abs(b.x-bx)/hw,dy=Math.abs(b.y-by)/hh;if(dx>dy)b.vx=(b.x<bx?-1:1)*Math.abs(b.vx);else b.vy=(b.y<by?-1:1)*Math.abs(b.vy);b.x+=b.vx*dt*2;b.y+=b.vy*dt*2}}
    if(this.cfg.arena===2){if(b.y-b.r<0){b.y=b.r;b.vy=Math.abs(b.vy)}if(b.y+b.r>1){b.y=1-b.r;b.vy=-Math.abs(b.vy)}this.hit(b,this.players[0]);this.hit(b,this.players[1]);if(b.x<-.03)return this.goal(0);if(b.x>1.03)return this.goal(1)}else{for(let i=0;i<4;i++){let p=this.players[i];if(p.alive)this.hit(b,p);else{if(i===0&&b.x-b.r<0){b.x=b.r;b.vx=Math.abs(b.vx)}if(i===1&&b.x+b.r>1){b.x=1-b.r;b.vx=-Math.abs(b.vx)}if(i===2&&b.y-b.r<0){b.y=b.r;b.vy=Math.abs(b.vy)}if(i===3&&b.y+b.r>1){b.y=1-b.r;b.vy=-Math.abs(b.vy)}}}if(b.x<-.03)return this.goal(0);if(b.x>1.03)return this.goal(1);if(b.y<-.03)return this.goal(2);if(b.y>1.03)return this.goal(3)}this.sendState()}
  sendState(){this.broadcast({t:'state',ts:Date.now(),cfg:this.cfg,ball:this.ball,players:this.publicPlayers(),powerups:this.powerups,stats:this.stats,lastScorer:this.lastScorer})}
}
