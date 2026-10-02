import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes,randomUUID,createHash,createHmac } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startServer } from '../dist/server/signaling-server/src/server.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function client(t,url,options={},socketOptions={}){
  const ws=new WebSocket(url,socketOptions);t.after(()=>ws.terminate());
  const queue=[];ws.on('message',raw=>queue.push(JSON.parse(raw.toString())));
  await once(ws,'open');
  function send(value){const requestId=randomUUID();ws.send(JSON.stringify({version:1,requestId,...value}));return requestId;}
  async function next(type,requestId){const end=Date.now()+3000;while(Date.now()<end){const i=queue.findIndex(v=>v.type===type&&(!requestId||v.requestId===requestId));if(i>=0)return queue.splice(i,1)[0];await sleep(5);}throw new Error('timeout '+type);}
  const hello={type:'hello',name:'test',sessionKey:randomBytes(32).toString('hex'),room:'default',engine:'browser-v2',...options};
  const id=send(hello);return {ws,queue,send,next,hello,requestId:id};
}
async function fixture(t,options={}){const service=await startServer({port:0,...options});t.after(()=>service.close());return {service,url:'ws://127.0.0.1:'+service.server.address().port};}
async function registered(t,url,options,socketOptions){const c=await client(t,url,options,socketOptions);c.welcome=await c.next('welcome');c.id=c.welcome.id;return c;}

test('registration, scoped presence, authoritative sender and route acknowledgement',async t=>{
  const {url}=await fixture(t),a=await registered(t,url),b=await registered(t,url);
  assert.equal(b.welcome.peers[0].id,a.id);assert.equal((await a.next('peer-join')).id,b.id);
  const transferId=randomUUID();const req=a.send({type:'invite',to:b.id,from:'spoof',transferId,files:[{name:'a',size:5}]});
  assert.equal((await b.next('invite')).from,a.id);await a.next('ack',req);
  const accept=b.send({type:'accept',to:a.id,transferId});await b.next('ack',accept);assert.equal((await a.next('accept')).from,b.id);
});
test('room is isolated while mixed engines remain visible',async t=>{
  const {url}=await fixture(t),a=await registered(t,url),b=await registered(t,url,{room:'other'}),c=await registered(t,url,{engine:'windows-native-v1'});
  assert.deepEqual(b.welcome.peers,[]);assert.equal(c.welcome.peers[0].engine,'browser-v2');
  const req=a.send({type:'signal',to:c.id,data:{sdp:{type:'offer',sdp:'test'}}});assert.equal((await a.next('error',req)).code,'CROSS_ENGINE_DISABLED');
});
test('cross-engine fallback accepts known transfer-v2 engine pairs when enabled',async t=>{
  const {url}=await fixture(t,{enableCrossEngine:true});
  const a=await registered(t,url,{engine:'browser-v2'}),b=await registered(t,url,{engine:'windows-native-v1'});
  const req=a.send({type:'signal',to:b.id,data:{sdp:{type:'offer',sdp:'test'}}});
  await a.next('ack',req);assert.equal((await b.next('signal')).data.sdp.type,'offer');
});
test('cross-engine transfer-v2 peers share task authorization and SDP relay',async t=>{
  const {url}=await fixture(t,{enableCrossEngine:true});
  const capabilities={wireProtocol:'transfer-v2',send:true,receive:true,resume:true,folder:false,maxFrameSize:65535};
  const a=await registered(t,url,{engine:'browser-v2',capabilities});
  const b=await registered(t,url,{engine:'windows-native-v1',capabilities});
  const transferId=randomUUID();
  const invite=a.send({type:'invite',to:b.id,transferId,files:[{name:'cross.bin',size:1}]});
  await a.next('ack',invite);assert.equal((await b.next('invite')).from,a.id);
  const accept=b.send({type:'accept',to:a.id,transferId});await b.next('ack',accept);await a.next('accept');
  const offer=a.send({type:'signal',to:b.id,data:{sdp:{type:'offer',sdp:'v=0'}}});
  await a.next('ack',offer);assert.equal((await b.next('signal')).data.sdp.type,'offer');
});
test('token authorization and duplicate session cannot evict the original',async t=>{
  const {url}=await fixture(t,{token:'secret'}),bad=await client(t,url,{token:'wrong'});
  assert.equal((await bad.next('error')).code,'UNAUTHORIZED');
  const a=await registered(t,url,{token:'secret'}),dup=await client(t,url,{token:'secret',sessionKey:a.hello.sessionKey});
  assert.equal((await dup.next('error')).code,'SESSION_IN_USE');assert.equal(a.ws.readyState,WebSocket.OPEN);
});
test('task ownership and native acceptance gate',async t=>{
  const {url}=await fixture(t),opts={engine:'windows-native-v1'};
  const a=await registered(t,url,opts),b=await registered(t,url,opts),c=await registered(t,url,opts),transferId=randomUUID();
  const native=(to,kind,extra={})=>({type:'signal',to,data:{engine:opts.engine,transferId,kind,...extra}});
  await a.next('ack',a.send(native(b.id,'invite',{files:[{name:'a',size:0}]})));await b.next('signal');
  let req=c.send(native(a.id,'accept'));assert.equal((await c.next('error',req)).code,'TASK_FORBIDDEN');
  req=a.send(native(b.id,'offer',{sdp:{type:'offer',sdp:'test'}}));assert.equal((await a.next('error',req)).code,'TASK_NOT_ACCEPTED');
  await b.next('ack',b.send(native(a.id,'accept')));await a.next('signal');
  await a.next('ack',a.send(native(b.id,'offer',{sdp:{type:'offer',sdp:'test'}})));assert.equal((await b.next('signal')).data.kind,'offer');
});
test('stable identity survives server restart without persisted server state',async t=>{
  const first=await startServer({port:0});
  const a=await registered(t,'ws://127.0.0.1:'+first.server.address().port);await first.close();
  const {url}=await fixture(t);const second=await registered(t,url,{sessionKey:a.hello.sessionKey});assert.equal(second.id,a.id);
});
test('invalid versions, binary messages, payload and frequency limits',async t=>{
  const {url}=await fixture(t,{maxMessages:5});const a=await registered(t,url);
  let req=a.send({version:999,type:'signal',to:'target',data:{}});assert.equal((await a.next('error',req)).code,'INVALID_MESSAGE');
  a.ws.send(Buffer.from('binary'));assert.equal((await a.next('error')).code,'TEXT_ONLY');
  const closed=once(a.ws,'close');for(let i=0;i<6;i++)a.send({type:'signal',to:'target',data:{}});assert.equal((await closed)[0],1008);
  const b=await registered(t,url);const oversized=once(b.ws,'close');b.ws.send('x'.repeat(262145));assert.equal((await oversized)[0],1009);
});
test('unregistered sockets expire; connection capacity is bounded',async t=>{
  const {url}=await fixture(t,{helloMs:50,maxClients:1});const first=new WebSocket(url);t.after(()=>first.terminate());await once(first,'open');
  const gone=once(first,'close');const second=new WebSocket(url);t.after(()=>second.terminate());const closed=once(second,'close');
  assert.equal((await closed)[0],1013);await gone;
});
test('heartbeat reclaims peers that stop replying',async t=>{
  const {url}=await fixture(t,{heartbeatMs:50});const a=await registered(t,url,{}, {autoPong:false});
  await once(a.ws,'close');assert.equal(a.ws.readyState,WebSocket.CLOSED);
});
test('token failures are reported per cause (missing / unknown / expired / revoked)',async t=>{
  const db=join(tmpdir(),`p2p-tokens-${randomUUID()}.sqlite`);
  t.after(()=>{try{rmSync(db,{force:true});}catch{}});
  const {service,url}=await fixture(t,{adminToken:'admin-secret',tokenDb:db});
  const missing=await client(t,url,{token:''});
  assert.equal((await missing.next('error')).code,'TOKEN_REQUIRED','没填口令不能和「口令过期」混为一谈');
  const unknown=await client(t,url,{token:'definitely-not-issued'});
  assert.equal((await unknown.next('error')).code,'TOKEN_UNKNOWN');
  // Directly mutate the DB to mark a token revoked/expired, verifying the status branch (no revoke API exists; this is a defensive distinction)
  const {DatabaseSync}=await import('node:sqlite');
  const store=new DatabaseSync(db);
  const issued=await (await fetch(`http://127.0.0.1:${service.server.address().port}/admin/tokens`,{method:'POST',headers:{authorization:'Bearer admin-secret','content-type':'application/json'},body:JSON.stringify({days:1})})).json();
  const hash=(v)=>createHash('sha256').update(v).digest('hex');
  store.prepare("UPDATE access_tokens SET status='revoked' WHERE token_hash=?").run(hash(issued.token));
  const revoked=await client(t,url,{token:issued.token});
  assert.equal((await revoked.next('error')).code,'TOKEN_REVOKED');
  store.prepare("UPDATE access_tokens SET status='active',expires_at=? WHERE token_hash=?").run(Date.now()-1000,hash(issued.token));
  const expired=await client(t,url,{token:issued.token});
  assert.equal((await expired.next('error')).code,'TOKEN_EXPIRED');
  store.close();
});
test('connected session is dropped when its token expires mid-connection',async t=>{
  const db=join(tmpdir(),`p2p-tokens-${randomUUID()}.sqlite`);
  t.after(()=>{try{rmSync(db,{force:true});}catch{}});
  const {service,url}=await fixture(t,{adminToken:'admin-secret',tokenDb:db,heartbeatMs:60000});
  const port=service.server.address().port;
  const issued=await (await fetch(`http://127.0.0.1:${port}/admin/tokens`,{method:'POST',headers:{authorization:'Bearer admin-secret','content-type':'application/json'},body:JSON.stringify({days:1})})).json();
  // Make this token expire in 1.2s, then connect immediately with the "not yet expired" token (the issue API only accepts whole days)
  const {DatabaseSync}=await import('node:sqlite');
  const store=new DatabaseSync(db);
  const soon=Date.now()+1200;
  store.prepare('UPDATE access_tokens SET expires_at=? WHERE token_hash=?').run(soon,createHash('sha256').update(issued.token).digest('hex'));
  store.close();
  const c=await client(t,url,{token:issued.token});
  const welcome=await c.next('welcome');
  assert.equal(welcome.tokenExpiresAt,soon,'welcome 下发的到期时刻应与库里一致（前端倒计时依据）');
  const closed=once(c.ws,'close');
  const notice=await c.next('error');
  assert.equal(notice.code,'TOKEN_EXPIRED_WHILE_CONNECTED');
  assert.equal((await closed)[0],1008,'到期应主动断开（用户选择「到期即断」）');
});
test('admin token: expiry is published in welcome, same token shares one room, bad token rejected',async t=>{
  const db=join(tmpdir(),`p2p-tokens-${randomUUID()}.sqlite`);
  t.after(()=>{try{rmSync(db,{force:true});}catch{}});
  const {service,url}=await fixture(t,{adminToken:'admin-secret',tokenDb:db});
  const port=service.server.address().port;
  const issued=await (await fetch(`http://127.0.0.1:${port}/admin/tokens`,{method:'POST',headers:{authorization:'Bearer admin-secret','content-type':'application/json'},body:JSON.stringify({days:2})})).json();
  assert.ok(issued.token,'应下发访问口令');assert.ok(issued.expiresAt>Date.now());
  const a=await registered(t,url,{token:issued.token});
  assert.equal(a.welcome.tokenExpiresAt,issued.expiresAt,'welcome 必须带口令到期时刻（前端倒计时依据）');
  assert.ok(Math.abs(a.welcome.serverNow-Date.now())<5000,'serverNow 用于校正客户端时钟偏差');
  // A second device using the same token → lands in the same internal transfer room (regression point after token-store.resolve changed its return value)
  const b=await registered(t,url,{token:issued.token});
  assert.equal(b.welcome.peers[0].id,a.id);
  // A fabricated token → TOKEN_UNKNOWN (**not** TOKEN_EXPIRED: after the classification refinement the two must stay distinguishable)
  const bad=await client(t,url,{token:'not-a-real-token'});
  assert.equal((await bad.next('error')).code,'TOKEN_UNKNOWN');
});
test('ICE servers reach clients verbatim; half-configured TURN is dropped with a reason',async t=>{
  const {service,url}=await fixture(t,{iceServers:[
    {urls:['stun:1.2.3.4:3478','stun:192.0.2.1:3478']},
    {urls:['turn:1.2.3.4:3478?transport=udp'],username:'u',credential:'p'},
    {urls:['turn:1.2.3.4:3478?transport=tcp']},
    {urls:['turn:5.6.7.8:3478'],credential:'only-credential'},
    {urls:['https://example.com/not-ice']},
  ],iceTransportPolicy:'relay'});
  const a=await registered(t,url);
  assert.deepEqual(a.welcome.ice.servers,[
    {urls:['stun:1.2.3.4:3478','stun:192.0.2.1:3478'],username:'',credential:''},
    {urls:['turn:1.2.3.4:3478?transport=udp'],username:'u',credential:'p'},
  ],'同一组的多条 url 必须原样下发（Rust 侧曾只取 urls[0]）；缺凭据的 TURN 与非法协议直接摘掉');
  assert.equal(a.welcome.ice.iceTransportPolicy,'relay','relay 要原样下达，用于强制走 TURN 验证');
  assert.equal(service.ice.dropped.length,3,'每组被丢弃的都要给出原因，启动时打日志告警');
});
test('unknown iceTransportPolicy falls back to all',async t=>{
  const {url}=await fixture(t,{iceTransportPolicy:'relay-only'});
  const a=await registered(t,url);
  assert.equal(a.welcome.ice.iceTransportPolicy,'all','拼错的值按 relay 处理会让所有非 TURN 用户直接连不上');
});
test('TURN 临时凭据：按连接现签，长期密钥不下发',async t=>{
  const secret='shared-secret-for-test';
  const {url}=await fixture(t,{turnSecret:secret,iceServers:[
    {urls:['stun:1.2.3.4:3478']},
    {urls:['turn:5.6.7.8:3478?transport=udp'],auth:'rest'},
  ]});
  const a=await registered(t,url);
  const [stun,turn]=a.welcome.ice.servers;
  assert.deepEqual(stun,{urls:['stun:1.2.3.4:3478'],username:'',credential:''},'STUN 条目照旧不带凭据');
  const [expiry,uid]=turn.username.split(':');
  const expiresAt=Number(expiry)*1000;
  assert.ok(Number.isInteger(Number(expiry)),'username 首段必须是到期 unix 秒（coturn 靠它判过期）');
  assert.ok(expiresAt>Date.now(),'到期时刻必须在将来，否则 coturn 直接拒绝');
  assert.ok(expiresAt<=Date.now()+12*3600*1000+5000,'默认 TTL 12h');
  assert.ok(uid&&uid.length>0,'冒号后是使用者标识');
  assert.equal(turn.credential,createHmac('sha1',secret).update(turn.username).digest('base64'),'credential 必须等于 base64(HMAC-SHA1(secret, username)) —— coturn 就是拿这个复算的');
  assert.ok(!JSON.stringify(a.welcome.ice).includes(secret),'长期密钥绝不能出现在 welcome 里');
  const b=await registered(t,url);
  assert.notEqual(b.welcome.ice.servers[1].username,a.welcome.ice.servers[1].username,'两条连接必须拿到不同凭据：泄露窗口与使用者追溯都靠它');
});
test('auth:"rest" 缺 SIG_TURN_SECRET 时整组丢弃并说明原因',async t=>{
  const {service,url}=await fixture(t,{iceServers:[{urls:['turn:5.6.7.8:3478'],auth:'rest'}]});
  const a=await registered(t,url);
  assert.deepEqual(a.welcome.ice.servers,[],'没有可签凭据的材料就不能下发：浏览器会静默丢弃、Rust 直接报 ErrNoTurnCredentials');
  assert.equal(service.ice.dropped.length,1);
  assert.match(service.ice.dropped[0],/SIG_TURN_SECRET/);
});
test('token 模式下 TURN 凭据不会活得比访问口令久',async t=>{
  const db=join(tmpdir(),`p2p-turn-${randomUUID()}.sqlite`);
  t.after(()=>{try{rmSync(db,{force:true});}catch{}});
  const {service,url}=await fixture(t,{adminToken:'admin-secret',tokenDb:db,turnSecret:'s',
    iceServers:[{urls:['turn:5.6.7.8:3478'],auth:'rest'}]});
  const issued=await (await fetch(`http://127.0.0.1:${service.server.address().port}/admin/tokens`,{method:'POST',headers:{authorization:'Bearer admin-secret','content-type':'application/json'},body:JSON.stringify({days:7})})).json();
  // Push the token's expiry to 10 minutes out: the credential must shorten with the token (token expiry drops the connection)
  const soon=Date.now()+600000;
  const {DatabaseSync}=await import('node:sqlite');
  const store=new DatabaseSync(db);
  store.prepare('UPDATE access_tokens SET expires_at=? WHERE token_hash=?').run(soon,createHash('sha256').update(issued.token).digest('hex'));
  store.close();
  const a=await registered(t,url,{token:issued.token});
  const expiry=Number(a.welcome.ice.servers[0].username.split(':')[0])*1000;
  assert.ok(expiry>Date.now(),'凭据仍在有效期内');
  assert.ok(expiry<=soon+2000,'凭据不能比口令活得久（口令到期连接被踢，多签的时间只是空头承诺）');
  const uid=a.welcome.ice.servers[0].username.split(':')[1];
  assert.ok(uid&&uid.length>0,'username 冒号后必须有使用者标识');
  // A second device under the same token should get the same uid (uid = token id) —— so relay logs can be aggregated per token
  const b=await registered(t,url,{token:issued.token});
  assert.equal(b.welcome.ice.servers[0].username.split(':')[1],uid,'uid 来自访问口令 id，coturn 日志里能对上「哪条口令在用中继」');
});

test('iceTrickle 默认开启，只认显式关闭',async t=>{
  const {url}=await fixture(t);
  const a=await registered(t,url);
  assert.equal(a.welcome.ice.iceTrickle,true,'默认开启 trickle：TURN 分配不 settle 时 non-trickle 会卡住建连');
  const {url:bUrl}=await fixture(t,{iceTrickle:false});
  const b=await registered(t,bUrl);
  assert.equal(b.welcome.ice.iceTrickle,false,'显式 false 才关（等收集完再发 SDP）');
});

test('admin API：签发 / 列表 / 撤销共用一枚管理口令，列表不回传校验材料',async t=>{
  const db=join(tmpdir(),`p2p-tokens-${randomUUID()}.sqlite`);
  t.after(()=>{try{rmSync(db,{force:true});}catch{}});
  const {service,url}=await fixture(t,{adminToken:'admin-secret',tokenDb:db});
  const origin=`http://127.0.0.1:${service.server.address().port}`;
  const call=(path,init={})=>fetch(origin+path,{headers:{authorization:'Bearer admin-secret','content-type':'application/json'},...init});
  assert.equal((await fetch(origin+'/admin/tokens')).status,401,'没带凭据必须 401');
  assert.equal((await fetch(origin+'/admin/tokens',{headers:{authorization:'Bearer wrong'}})).status,401,'错误凭据必须 401');
  const issued=await (await call('/admin/tokens',{method:'POST',body:JSON.stringify({days:2})})).json();
  const active=await (await call('/admin/tokens?status=active')).json();
  assert.equal(active.tokens.length,1);
  assert.equal(active.tokens[0].room,issued.room);
  assert.ok(!Object.keys(active.tokens[0]).some(k=>k.includes('hash')),'列表不能回传校验材料');
  assert.equal((await call('/admin/tokens',{method:'POST',body:JSON.stringify({days:9})})).status,400,'有效期上限由服务端兜底，不靠 CLI 自觉');
  const revoke=()=>call('/admin/tokens/revoke',{method:'POST',body:JSON.stringify({id:active.tokens[0].id})});
  assert.equal((await (await revoke()).json()).revoked,true);
  assert.equal((await revoke()).status,404,'重复撤销要能与「撤销成功」区分');
  assert.equal((await (await call('/admin/tokens?status=revoked')).json()).tokens.length,1);
  assert.equal((await (await call('/admin/tokens?status=active')).json()).tokens.length,0);
  const denied=await client(t,url,{token:issued.token});
  assert.equal((await denied.next('error')).code,'TOKEN_REVOKED','撤销立即生效（resolve 每次直查数据库，没有内存缓存）');
});

test('admin API：过期口令在列入口径里是 expired、撤销不了；连续鉴权失败会短暂冷却',async t=>{
  const db=join(tmpdir(),`p2p-tokens-${randomUUID()}.sqlite`);
  t.after(()=>{try{rmSync(db,{force:true});}catch{}});
  const {service}=await fixture(t,{adminToken:'admin-secret',tokenDb:db,adminFailLimit:2,adminCooldownMs:300});
  const origin=`http://127.0.0.1:${service.server.address().port}`;
  const call=(path,init={})=>fetch(origin+path,{headers:{authorization:'Bearer admin-secret','content-type':'application/json'},...init});
  const {DatabaseSync}=await import('node:sqlite');
  const store=new DatabaseSync(db);
  store.prepare('INSERT INTO access_tokens VALUES(?,?,?,?,?,?,NULL,NULL,0)').run('stale-id',createHash('sha256').update('stale-token').digest('hex'),'r_stale',Date.now()-1000,'active',Date.now()-86400000);
  store.close();
  assert.equal((await (await call('/admin/tokens?status=active')).json()).tokens.length,0,'过期项不该留在 active 里');
  const stale=await (await call('/admin/tokens?status=expired')).json();
  assert.equal(stale.tokens.length,1,'过期项应被列入口径标记为 expired');
  assert.equal((await call('/admin/tokens/revoke',{method:'POST',body:JSON.stringify({id:'stale-id'})})).status,404,'已失效的口令不该能再撤销');
  await fetch(origin+'/admin/tokens',{headers:{authorization:'Bearer wrong'}});
  await fetch(origin+'/admin/tokens',{headers:{authorization:'Bearer wrong'}});
  assert.equal((await call('/admin/tokens')).status,429,'连续鉴权失败要冷却，拖慢在线猜管理口令');
  await sleep(400);
  assert.equal((await call('/admin/tokens')).status,200,'冷却结束后恢复正常');
});

test('管理页：/admin 免鉴权直接打开，且页面里不含管理口令',async t=>{
  const db=join(tmpdir(),`p2p-tokens-${randomUUID()}.sqlite`);
  t.after(()=>{try{rmSync(db,{force:true});}catch{}});
  const {service}=await fixture(t,{adminToken:'admin-secret',tokenDb:db});
  const origin=`http://127.0.0.1:${service.server.address().port}`;
  for(const path of ['/admin','/admin/']){
    const res=await fetch(origin+path);
    assert.equal(res.status,200,path+' 要能免鉴权打开（浏览器地址栏带不了 Bearer 头）');
    assert.match(res.headers.get('content-type')||'',/^text\/html/,path+' 必须是页面');
    const html=await res.text();
    assert.ok(html.includes('<title>'),path+' 返回的应是页面而不是 JSON');
    assert.ok(html.includes('/admin/tokens'),path+' 页面要自带调用管理接口的脚本');
    assert.ok(!html.includes('admin-secret'),'页面里不能内嵌管理口令');
    assert.equal(res.headers.get('x-frame-options'),'DENY',path+' 不能被嵌框（点击劫持）');
    assert.equal(res.headers.get('referrer-policy'),'no-referrer',path+' 不该把地址带出去');
    assert.match(res.headers.get('content-security-policy')||'',/default-src 'none'/,path+' 要带 CSP');
  }
  // /admin/* outside the page must still be authenticated; don't let this shell route become a wildcard.
  assert.equal((await fetch(origin+'/admin/tokens')).status,401);
});
