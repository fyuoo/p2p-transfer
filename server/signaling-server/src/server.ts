import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { MAX_MESSAGE, parseClient, record, validFiles, validId, type Capabilities, type Engine, type Message, type Peer } from '../../../public/signaling.js';
import { TokenStore } from './token-store.js';
import { ADMIN_HTML } from './admin-page.js';
import { issueTurnCredential } from './turn-credential.js';

type Client = Peer & { ws: WebSocket; room: string; alive: boolean; tokenExpiresAt?: number | null; tokenId?: string; expiryTimer?: ReturnType<typeof setTimeout> };
type Transfer = { sender: string; receiver: string; room: string; engine: Engine; expires: number; accepted:boolean };
// ICE server entry, same shape as W3C RTCIceServer: urls may hold multiple entries; TURN must include username + credential.
export type IceServerConfig = { urls: string[]; username?: string; credential?: string; auth?: string; ttlSeconds?: number };
/** Normalized entry: adds a `rest` flag vs. config (credentials are signed per-connection; this flag is never sent to clients). */
export type IceServerEntry = { urls: string[]; username?: string; credential?: string; rest?: boolean; ttlSeconds?: number };
/** Wire form sent to clients, same shape as W3C RTCIceServer. */
export type IceServerWire = { urls: string[]; username: string; credential: string };
export type IceTransportPolicy = 'all' | 'relay';
export interface Options { host?: string; port?: number; token?: string; adminToken?: string; tokenDb?: string; origins?: string[]; iceServers?: IceServerConfig[]; iceTransportPolicy?: string; iceTrickle?: unknown; iceRestart?: boolean; connectionTimeoutSeconds?: number; heartbeatMs?: number; helloMs?: number; maxClients?: number; maxMessages?: number; enableCrossEngine?: boolean; adminFailLimit?: number; adminCooldownMs?: number; turnSecret?: string; turnTtlSeconds?: number }
const ICE_URL = /^(stuns?|turns?):/i;
const isTurnUrl = (url: string) => /^turns?:/i.test(url);
/**
 * Normalize iceServers and drop any "partially configured" entries.
 *
 * A TURN entry missing username/credential is silently dropped by browsers, while the
 * Rust side (webrtc-rs) `RTCIceServer::urls()` returns `ErrNoTurnCredentials` directly —
 * which prevents the **entire PeerConnection** from being established. So drop and warn
 * server-side rather than shipping a half-configured entry to clients.
 */
export function normalizeIceServers(list: IceServerConfig[] | undefined, hasTurnSecret = false): { servers: IceServerEntry[]; dropped: string[] } {
  const servers: IceServerEntry[] = [], dropped: string[] = [];
  for (const item of list ?? []) {
    const raw = item as { urls?: unknown; username?: unknown; credential?: unknown; auth?: unknown; ttlSeconds?: unknown } | null | undefined;
    const urls = Array.isArray(raw?.urls) ? raw.urls.filter((u): u is string => typeof u === 'string' && ICE_URL.test(u)) : [];
    if (!urls.length) { dropped.push('urls 为空或协议不可识别'); continue; }
    // auth:'rest' = managed mode: omit username/credential; credentials are signed per-connection server-side (long-term secret is never exposed).
    if (typeof raw?.auth === 'string' && raw.auth.toLowerCase() === 'rest') {
      const turns = urls.filter(isTurnUrl);
      if (!turns.length) { dropped.push(`${urls.join(' ')}（auth:"rest" 只适用于 TURN 地址）`); continue; }
      // No secret means nothing to sign with: shipping credential-less TURN only makes browsers drop it silently / Rust raise ErrNoTurnCredentials.
      if (!hasTurnSecret) { dropped.push(`${turns.join(' ')}（auth:"rest" 但服务端未配置 SIG_TURN_SECRET）`); continue; }
      const ttl = typeof raw.ttlSeconds === 'number' && Number.isFinite(raw.ttlSeconds) && raw.ttlSeconds > 0 ? Math.floor(raw.ttlSeconds) : undefined;
      servers.push({ urls, rest: true, ttlSeconds: ttl });
      continue;
    }
    const username = typeof raw?.username === 'string' ? raw.username : '';
    const credential = typeof raw?.credential === 'string' ? raw.credential : '';
    const unusable = urls.filter(u => isTurnUrl(u) && !(username && credential));
    const keep = urls.filter(u => !unusable.includes(u));
    if (!keep.length) { dropped.push(`${unusable.join(' ')}（TURN 缺 username/credential）`); continue; }
    // When stun and turn are mixed in one entry, only drop the unusable ones; keep the rest as-is.
    if (unusable.length) dropped.push(`${unusable.join(' ')}（TURN 缺 username/credential，同条目其余地址保留）`);
    servers.push({ urls: keep, username, credential });
  }
  return { servers, dropped };
}
/** Only 'relay' is honored; any unknown value falls back to 'all' — treating a typo as relay would cut off all non-TURN users. */
export function normalizeIceTransportPolicy(raw: unknown): IceTransportPolicy { return raw === 'relay' ? 'relay' : 'all'; }
/** Trickle ICE is on by default: offer/answer are sent right after setLocalDescription, candidates trickle as they arrive.
 * Disabling it (explicit false / 'false' / 0) waits for ICE gathering to finish before sending SDP (candidates inline),
 * but if TURN allocation never settles the connection stalls — that was the root cause of "TURN on → can't connect". */
export function normalizeIceTrickle(raw: unknown): boolean {
  return raw !== false && raw !== 'false' && raw !== 0 && raw !== '0';
}
export async function startServer(options: Options = {}) {
  const clients = new Map<string, Client>();
  const transfers = new Map<string, Transfer>();
  const tokenStore = options.tokenDb ? new TokenStore(options.tokenDb) : undefined;
  const turnSecret = (options.turnSecret ?? '').trim();
  /** Ephemeral credential TTL defaults to 12h: must cover the whole "connect → transfer done" span, because TURN refresh also re-authenticates. */
  const turnTtlSeconds = Number.isFinite(options.turnTtlSeconds) && (options.turnTtlSeconds as number) > 0 ? Math.floor(options.turnTtlSeconds as number) : 43200;
  const ice = normalizeIceServers(options.iceServers, Boolean(turnSecret));
  const icePolicy = normalizeIceTransportPolicy(options.iceTransportPolicy);
  const iceTrickle = normalizeIceTrickle(options.iceTrickle);
  const json=(res:ServerResponse,code:number,body:unknown)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  const readBody=(req:IncomingMessage)=>new Promise<string>(resolve=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>resolve(raw));});
  /** timingSafeEqual throws when lengths differ, so compare lengths first; this guards against side-channel leaks from byte-wise comparison of the admin secret. */
  const sameSecret=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
  // Cooldown after repeated admin auth failures. **Count globally, not per-IP**: behind a reverse proxy the source is always 127.0.0.1,
  // and per-IP buckets are both inaccurate and vulnerable to memory exhaustion via a spoofed X-Forwarded-For. The goal is only to slow down online admin-secret guessing, not precise rate-limiting.
  let adminFails=0, adminBlockedUntil=0;
  async function handleAdmin(req:IncomingMessage,res:ServerResponse,pathname:string,query:URLSearchParams) {
    if(!options.adminToken){json(res,401,{error:'unauthorized'});return;}
    if(Date.now()<adminBlockedUntil){json(res,429,{error:'too many failed attempts'});return;}
    const auth=String(req.headers.authorization??'');
    if(!auth||!sameSecret(auth,`Bearer ${options.adminToken}`)){
      adminFails+=1;
      if(adminFails>=(options.adminFailLimit??10)){adminFails=0;adminBlockedUntil=Date.now()+(options.adminCooldownMs??60000);}
      json(res,401,{error:'unauthorized'});return;
    }
    adminFails=0;
    if(!tokenStore){json(res,503,{error:'token store unavailable'});return;}
    try {
      if(pathname==='/admin/tokens'&&req.method==='GET'){json(res,200,{tokens:tokenStore.list(query.get('status')??undefined)});return;}
      if(pathname==='/admin/tokens'&&req.method==='POST'){
        const days=Number((JSON.parse((await readBody(req))||'{}') as { days?: unknown }).days);
        if(!Number.isInteger(days)||days<1||days>7)throw new Error('days must be 1..7');
        json(res,201,tokenStore.issue(days));return;
      }
      if(pathname==='/admin/tokens/revoke'&&req.method==='POST'){
        const body=JSON.parse((await readBody(req))||'{}') as { id?: unknown; token?: unknown };
        const target=typeof body.id==='string'?{id:body.id}:typeof body.token==='string'?{token:body.token}:undefined;
        if(!target)throw new Error('id or token required');
        const revoked=tokenStore.revoke(target);
        // Not found / already revoked → 404: lets the CLI distinguish "revoked successfully" from "this entry was never active".
        json(res,revoked?200:404,{revoked});return;
      }
      json(res,404,{error:'not found'});
    } catch(e){json(res,400,{error:e instanceof Error?e.message:String(e)});}
  }
  const server = createServer((req,res)=>{
    // Admin endpoints and health checks must be checked before the static fallback: /admin and /healthz are plain HTTP, not WebSocket upgrades.
    const url=new URL(req.url??'/','http://127.0.0.1');
    // The admin page is a pure shell carrying no credentials (the operator types the secret in the browser), so it is served before auth:
    // the browser address bar cannot send an Authorization header; auth only happens on fetches the page issues.
    if(url.pathname==='/admin'||url.pathname==='/admin/'||url.pathname==='/admin/index.html'){
      // This page will hold the admin secret, so add extra response headers: forbid framing, forbid loading external resources,
      // forbid outbound connections, strip the Referer. ⚠️ Scripts and styles are inline, so the CSP still needs 'unsafe-inline';
      // it blocks "external loads / data exfiltration / being framed into someone else's page", not the inline injection itself.
      res.writeHead(200,{
        'content-type':'text/html; charset=utf-8',
        'cache-control':'no-store',
        'x-content-type-options':'nosniff',
        'x-frame-options':'DENY',
        'referrer-policy':'no-referrer',
        'content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(ADMIN_HTML);return;
    }
    if(url.pathname.startsWith('/admin/')){void handleAdmin(req,res,url.pathname,url.searchParams);return;}
    if(url.pathname==='/healthz'){json(res,200,{status:'ok',peers:clients.size});return;}
    json(res,404,{error:'not found'});
  });
  const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE, perMessageDeflate:false,
    verifyClient: ({origin}, done)=>done(!origin || !options.origins?.length || options.origins.includes(origin),403)
  });
  function send(ws:WebSocket,value:unknown):boolean {
    if(ws.readyState!==WebSocket.OPEN)return false;
    const payload=JSON.stringify(value);
    if(ws.bufferedAmount+Buffer.byteLength(payload)>1024*1024){ws.terminate();return false;}
    ws.send(payload,err=>{if(err)ws.terminate();});return true;
  }
  const packet=(type:string,fields:Record<string,unknown>={})=>({version:1,type,...fields});
  /**
   * Sign TURN ephemeral credentials per-connection — this is the key to never exposing the long-term secret:
   * each client gets a distinct username/credential with its own expiry, traceable to the user.
   * uid uses the access-token id (maps to "which token is using the relay"); in static-secret mode it falls back to the connection id.
   */
  function iceFor(client: Client): IceServerWire[] {
    const uid = client.tokenId || client.id.slice(0, 12);
    return ice.servers.map(entry=>{
      if(!entry.rest)return { urls: entry.urls, username: entry.username ?? '', credential: entry.credential ?? '' };
      // Token mode: credentials must not outlive the token — once the token expires the connection is dropped, so a longer credential is meaningless.
      let ttl = entry.ttlSeconds ?? turnTtlSeconds;
      if (client.tokenExpiresAt !== undefined && client.tokenExpiresAt !== null) {
        const remaining = Math.floor((client.tokenExpiresAt - Date.now()) / 1000);
        if (remaining <= 0) return undefined;
        ttl = Math.min(ttl, remaining);
      }
      const signed = issueTurnCredential(turnSecret, uid, ttl);
      return { urls: entry.urls, username: signed.username, credential: signed.credential };
    }).filter((entry): entry is IceServerWire => Boolean(entry));
  }
  // Token expiry = disconnect (the token is both ticket and lease). Use a precise timer instead of waiting for the heartbeat (default 20s),
  // otherwise the connection would linger for another ~30s after the UI countdown hits zero; the heartbeat has a separate backstop.
  function kickExpiredToken(c:Client,at:number){
    if(clients.get(c.id)?.ws!==c.ws)return;
    // Explain the reason before closing: the client shows "reconnect requires a new token" and stops needless reconnects.
    send(c.ws,packet('error',{code:'TOKEN_EXPIRED_WHILE_CONNECTED',expiresAt:at}));
    c.ws.close(1008,'token expired');
  }
  function armExpiry(client:Client,at:number){
    const timer=setTimeout(()=>kickExpiredToken(client,at),Math.max(0,at-Date.now())+5);
    timer.unref?.(); // Don't let a pending expiry timer block process exit
    return timer;
  }
  // All devices in a room are discoverable. Route validation still prevents
  // incompatible transfer protocols from talking to each other.
  const compatible=(a:Client,b:Client)=>a.room===b.room;
  const peer=(c:Client):Peer=>({id:c.id,name:c.name,engine:c.engine,capabilities:c.capabilities});
  const key=(room:string,id:string)=>`${room}:${id}`;
  function task(c:Client,to:Client,id:unknown,kind:string,files?:unknown) {
    if(!validId(id))throw new Error('INVALID_TRANSFER');
    const k=key(c.room,id), old=transfers.get(k);
    if(kind==='invite') {
      if(!validFiles(files))throw new Error('INVALID_FILES');
      if(old)throw new Error('DUPLICATE_TRANSFER');
      if(transfers.size>=4096)throw new Error('TASK_LIMIT');
      transfers.set(k,{sender:c.id,receiver:to.id,room:c.room,engine:(c.capabilities?.wireProtocol ?? c.engine) as Engine,expires:Date.now()+86400000,accepted:false});
    } else {
      if(!old || old.engine!==(c.capabilities?.wireProtocol ?? c.engine) || !((old.sender===c.id && old.receiver===to.id)||(old.receiver===c.id && old.sender===to.id)))throw new Error('TASK_FORBIDDEN');
      if(['accept','reject','answer'].includes(kind) && old.receiver!==c.id)throw new Error('TASK_FORBIDDEN');
      if(kind==='offer' && old.sender!==c.id)throw new Error('TASK_FORBIDDEN');
      if(['offer','answer'].includes(kind) && !old.accepted)throw new Error('TASK_NOT_ACCEPTED');
      if(kind==='accept')old.accepted=true;
      if(kind==='cancel'||kind==='reject')transfers.delete(k);
    }
  }
  function route(c:Client,msg:Message) {
    const target=clients.get(String(msg.to));
    if(!target || !compatible(c,target) || target.id===c.id)throw new Error('PEER_UNAVAILABLE');
    const crossEngine=c.engine!==target.engine;
    // browser-v2 and windows-native-v1 are the two transfer-v2 implementations.
    // Older browser bundles may not yet send capabilities, so use their stable
    // engine identifier as a compatibility fallback during the rollout.
    const transferV2=(client:Client)=>client.capabilities?.wireProtocol==='transfer-v2' || client.engine==='browser-v2' || client.engine==='windows-native-v1';
    const crossReady=!crossEngine || (options.enableCrossEngine && transferV2(c) && transferV2(target));
    if(!crossReady) throw new Error(options.enableCrossEngine?'PROTOCOL_MISMATCH':'CROSS_ENGINE_DISABLED');
    if(msg.type==='signal') {
      const data=msg.data as Record<string,unknown>;
      if(!crossEngine && c.engine==='windows-native-v1') {
        // Trickle ICE candidates (data.candidate is an object with no kind) are only relayed, not fed into the task state machine;
        // the whitelist once only had invite/accept/offer/answer/cancel, so candidates with kind=null were dropped as INVALID_NATIVE_SIGNAL → Rust<->Rust connections failed.
        if(!record(data.candidate)) {
          if(data.engine!==c.engine || !['invite','accept','offer','answer','cancel'].includes(String(data.kind)))throw new Error('INVALID_NATIVE_SIGNAL');
          if(['offer','answer'].includes(String(data.kind)) && (!record(data.sdp)||data.sdp.type!==data.kind||typeof data.sdp.sdp!=='string'))throw new Error('INVALID_SDP');
          task(c,target,data.transferId,String(data.kind),data.files);
        }
      } else {
        const control=['cancel','pause','resume'].includes(String(data.kind));
        if((!crossEngine && data.engine!==undefined) || (!control&&!record(data.sdp)&&!record(data.candidate)))throw new Error('INVALID_BROWSER_SIGNAL');
        if(control) task(c,target,data.transferId,String(data.kind));
      }
      if(!send(target.ws,packet('signal',{from:c.id,data})))throw new Error('PEER_UNAVAILABLE');
    } else {
      task(c,target,msg.transferId,msg.type,msg.files);
      if(!send(target.ws,packet(msg.type,{from:c.id,transferId:msg.transferId,...(msg.type==='invite'?{files:msg.files}:{})})))throw new Error('PEER_UNAVAILABLE');
    }
    send(c.ws,packet('ack',{requestId:msg.requestId}));
  }
  wss.on('connection',(ws)=>{
    if(wss.clients.size>(options.maxClients??128)){ws.close(1013,'capacity');return;}
    let client:Client|undefined, count=0, since=Date.now();
    const hello=setTimeout(()=>ws.terminate(),options.helloMs??10000);
    ws.on('pong',()=>{if(client)client.alive=true;});
    ws.on('error',()=>{});
    ws.on('message',(raw,binary)=>{
      if(Date.now()-since>=1000){since=Date.now();count=0;}
      if(++count>(options.maxMessages??256)){ws.close(1008,'rate limit');return;}
      let requestId:unknown;
      try {
        if(binary)throw new Error('TEXT_ONLY');
        const value=JSON.parse(raw.toString());requestId=value?.requestId;
        const msg=parseClient(value);
        if(msg.type==='hello') {
          if(client)throw new Error('ALREADY_REGISTERED');
          let authorizedRoom=String(msg.room);
          // null = this deployment has no time-limited token (static-secret / token-less), so the client shows "valid indefinitely".
          let tokenExpiresAt:number|null=null, tokenId='';
          if(options.adminToken) {
            const supplied=String(msg.token??'');
            // Report missing / not-found / expired / revoked separately so the UI can give actionable hints (see reason-labels.ts).
            if(!supplied){send(ws,packet('error',{requestId,code:'TOKEN_REQUIRED'}));ws.close(1008,'token required');return;}
            if(!tokenStore){send(ws,packet('error',{requestId,code:'TOKEN_STORE_UNAVAILABLE'}));ws.close(1011,'token store unavailable');return;}
            const issued=tokenStore.resolve(supplied);
            if(!issued.ok){send(ws,packet('error',{requestId,code:issued.code}));ws.close(1008,'token rejected');return;}
            authorizedRoom=issued.room;tokenExpiresAt=issued.expiresAt;tokenId=issued.tokenId;
          } else if(options.token) {
            const expected=createHash('sha256').update(options.token).digest();
            const supplied=createHash('sha256').update(String(msg.token??'')).digest();
            if(!timingSafeEqual(expected,supplied)){send(ws,packet('error',{requestId,code:'UNAUTHORIZED'}));ws.close(1008,'unauthorized');return;}
          }
          // Stable across reconnect/server restart; knowing an id does not allow claiming it.
          const id=createHash('sha256').update(String(msg.sessionKey)).digest('hex');
          if(clients.has(id)){send(ws,packet('error',{requestId,code:'SESSION_IN_USE'}));ws.close(1008,'session in use');return;}
          const capabilities = msg.capabilities as Capabilities | undefined;
          client={id,name:String(msg.name),room:authorizedRoom,engine:msg.engine as Engine,capabilities,ws,alive:true,tokenExpiresAt,tokenId};
          clearTimeout(hello);clients.set(id,client);
          if(tokenExpiresAt)client.expiryTimer=armExpiry(client,tokenExpiresAt);
          send(ws,packet('welcome',{requestId,id,peers:[...clients.values()].filter(c=>c.id!==id&&compatible(c,client!)).map(peer),tokenExpiresAt,serverNow:Date.now(),ice:{servers:iceFor(client),iceTransportPolicy:icePolicy,iceTrickle,iceRestart:options.iceRestart??true,connectionTimeoutSeconds:options.connectionTimeoutSeconds??30}}));
          for(const other of clients.values())if(other.id!==id&&compatible(other,client))send(other.ws,packet('peer-join',peer(client)));
        } else {
          if(!client)throw new Error('HELLO_REQUIRED');
          route(client,msg);
        }
      } catch(e) {send(ws,packet('error',{...(validId(requestId)?{requestId}:{}),code:e instanceof Error?e.message:'INVALID_MESSAGE'}));}
    });
    ws.on('close',()=>{
      clearTimeout(hello);
      if(client)clearTimeout(client.expiryTimer);
      if(!client || clients.get(client.id)?.ws!==ws)return;
      clients.delete(client.id);
      for(const other of clients.values())if(compatible(other,client))send(other.ws,packet('peer-leave',{id:client.id}));
      // Keep bounded task bindings across temporary disconnects; active RTC is independent.
    });
  });
  const heartbeat=setInterval(()=>{
    for(const c of clients.values()) {
      if(c.tokenExpiresAt&&c.tokenExpiresAt<=Date.now()){kickExpiredToken(c,c.tokenExpiresAt);continue;}
      if(!c.alive){c.ws.terminate();continue;}
      c.alive=false;c.ws.ping();send(c.ws,packet('heartbeat'));
    }
    for(const [id,t] of transfers)if(t.expires<Date.now())transfers.delete(id);
  },options.heartbeatMs??20000);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??8787,options.host??'127.0.0.1',resolve);});
  let closed=false;
  return {server,wss,ice:{servers:ice.servers,policy:icePolicy,trickle:iceTrickle,dropped:ice.dropped}, async close(){
    if(closed)return; closed=true; clearInterval(heartbeat);
    for(const ws of [...wss.clients]) { try { ws.terminate(); } catch {} }
    // Close the HTTP listener independently of WebSocketServer's callback.
    // A half-open client must never keep the TCP port occupied on shutdown.
    await new Promise<void>(resolve=>{
      const finish=()=>resolve();
      try { server.close(finish); } catch { finish(); }
      try { wss.close(()=>{}); } catch {}
    });
  }};
}
