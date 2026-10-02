import { InviteFile, PeerInfo, SelfInfo, SignalPayload, Signaling } from './types';
import { MAX_MESSAGE, SIGNAL_VERSION, type Peer } from '../../../../public/signaling';
import { AUTH_ERROR_CODES, reasonLabel } from '../reason-labels';
// Same reason as crypto-compat: random numbers go through the compat layer to avoid module-eval crashes in insecure (http) contexts.
import { uuid } from '../crypto-compat';

export class BrowserSignaling implements Signaling {
  private ws:WebSocket|null=null;
  private selfId='';
  private registered=false;
  private key=uuid().replaceAll('-','')+uuid().replaceAll('-','');
  private peers=new Map<string,Peer>();
  private stopped=true;
  private retryMs=1000;
  // When the token is rejected by the server (missing/invalid/expired/revoked) we stop auto-reconnect:
  // retrying a hundred times would still be rejected, and the status bar would be stuck on "reconnecting"
  // forever, leaving the user unaware that they need to change the token. We store the code (not a boolean)
  // so we can report the specific reason.
  private authCode?:string;
  private retryTimer?:ReturnType<typeof setTimeout>;
  private monitor?:ReturnType<typeof setInterval>;
  private lastSeen=0;
  private pending=new Map<string,{resolve:()=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private inviteCb?:Parameters<Signaling['onInvite']>[0];
  private acceptCb?:Parameters<Signaling['onAccept']>[0];
  private rejectCb?:Parameters<Signaling['onReject']>[0];
  private signalCb?:Parameters<Signaling['onSignal']>[0];
  private peerListCb?:Parameters<Signaling['onPeerList']>[0];
  private selfChangeCb?:Parameters<NonNullable<Signaling['onSelfChange']>>[0];
  private lastNotifiedSelfId?:string;
  private tokenExpiryCb?:Parameters<NonNullable<Signaling['onTokenExpiry']>>[0];
  private statusCb?:(message:string)=>void;
  constructor(private url:string,private name:string,private room='default',private token=''){}
  onStatus(cb:(message:string)=>void){this.statusCb=cb;}
  isConnected(){return this.registered;}
  private emitPeers(){this.peerListCb?.([...this.peers.values()]);}
  async start(){if(!this.stopped)return;this.stopped=false;this.connect();}
  configure(url:string,room:string,token:string,name?:string){
    const parsed=new URL(url);
    if(!['ws:','wss:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error('信令地址无效');
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(room)||token.length>512)throw new Error('房间或令牌无效');
    const normalized=name?.trim();
    if(normalized!==undefined && (!normalized || normalized.length>80))throw new Error('设备名称无效');
    this.stop();this.url=url;this.room=room;this.token=token;if(normalized)this.name=normalized;void this.start();
  }
  private connect(){
    if(this.stopped)return;
    let ws:WebSocket;
    try{ws=new WebSocket(this.url);}catch{this.scheduleReconnect();return;}
    this.ws=ws;this.registered=false;this.lastSeen=Date.now();this.authCode=undefined;
    this.monitor=setInterval(()=>{if(Date.now()-this.lastSeen>(this.registered?60000:10000))ws.close();},5000);
    ws.onopen=()=>ws.send(JSON.stringify({version:SIGNAL_VERSION,type:'hello',requestId:uuid(),sessionKey:this.key,name:this.name,room:this.room,token:this.token,engine:'browser-v2',capabilities:{wireProtocol:'transfer-v2',send:true,receive:true,resume:true,pauseResume:false,folder:false,maxFrameSize:65535}}));
    ws.onmessage=ev=>{
      if(this.ws!==ws)return;
      try{if(typeof ev.data!=='string'||ev.data.length>MAX_MESSAGE)throw new Error();this.lastSeen=Date.now();this.onMessage(JSON.parse(ev.data));}catch{ws.close(1008,'invalid message');}
    };
    ws.onerror=()=>{};
    ws.onclose=()=>{
      if(this.ws!==ws)return;
      clearInterval(this.monitor);this.ws=null;this.registered=false;this.peers.clear();this.emitPeers();
      this.tokenExpiryCb?.(undefined); // Expiry unknown after disconnect (the next welcome on reconnect re-issues it)
      this.failPending();
      // Token rejected: surface the server's specific reason verbatim and stop reconnecting (text in reason-labels.ts).
      this.statusCb?.(this.authCode?reasonLabel(this.authCode):'信令断开，正在重连；已建立的传输继续');
      if(!this.stopped&&!this.authCode)this.scheduleReconnect();
    };
  }
  private scheduleReconnect(){
    clearTimeout(this.retryTimer);
    const wait=this.retryMs+Math.random()*500;this.retryMs=Math.min(30000,this.retryMs*2);
    this.retryTimer=setTimeout(()=>this.connect(),wait);
  }
  private onMessage(msg:any){
    if(msg.version!==SIGNAL_VERSION)throw new Error('版本不兼容');
    if(msg.type==='welcome'){
      if(typeof msg.id!=='string'||!Array.isArray(msg.peers))throw new Error('注册响应无效');
      this.selfId=msg.id;this.registered=true;this.retryMs=1000;this.authCode=undefined;
      // number=expiry timestamp; null=server has token expiry disabled; missing field (legacy server)=undefined.
      // Correct local clock skew with server time, otherwise a wrong local clock would shift the whole countdown.
      const ttl=msg.tokenExpiresAt, skew=(typeof msg.serverNow==='number'?msg.serverNow:Date.now())-Date.now();
      this.tokenExpiryCb?.(typeof ttl==='number'?ttl-skew:ttl===null?null:undefined);
      this.iceConfigCb?.(msg.ice);
      this.peers.clear();for(const p of msg.peers)this.peers.set(p.id,p);
      this.emitPeers();this.statusCb?.('信令已连接 · 浏览器传输');
      // Only notify when the self identity actually changes. A reconnect to the same
      // signaling server keeps the same id, so it must stay transparent to the upper layer
      // (no spurious onSelfChange, and app-engine must not tear down live sessions on a plain welcome).
      if(this.lastNotifiedSelfId!==this.selfId){this.lastNotifiedSelfId=this.selfId;this.selfChangeCb?.({id:this.selfId,name:this.name,port:0,ip:'browser'});}
    }else if(msg.type==='peer-join'){
      this.peers.set(msg.id,msg);this.emitPeers();
    }else if(msg.type==='peer-leave'){
      this.peers.delete(msg.id);this.emitPeers();
    }else if(msg.type==='signal')this.signalCb?.(msg.from,msg.data);
    else if(msg.type==='invite')this.inviteCb?.(msg.from,this.peers.get(msg.from)?.name??'对方',msg.from,msg.files,msg.transferId);
    else if(msg.type==='accept')this.acceptCb?.(msg.from,msg.transferId);
    else if(msg.type==='reject')this.rejectCb?.(msg.from,msg.transferId);
    else if(msg.type==='ack'||msg.type==='error'){
      // Record the auth code first: it decides "no more reconnect", independent of whether this response was already abandoned (onclose reports the reason from it).
      if(msg.type==='error'&&AUTH_ERROR_CODES.includes(msg.code))this.authCode=String(msg.code);
      const pending=this.pending.get(msg.requestId);
      // ⚠️ Only report global status for requests that are **still awaiting acknowledgement**.
      // A late error arriving after ACK timeout (pending cleared) would otherwise write a statusText
      // with nothing newer to overwrite it — the task already ended yet the top bar keeps showing
      // "signaling request failed: …", making the user think the failure is ongoing. An abandoned
      // request's failure reason is reported by the initiator itself (the task card note).
      if(pending){
        clearTimeout(pending.timer);this.pending.delete(msg.requestId);
        if(msg.type==='ack')pending.resolve();
        else{pending.reject(new Error(msg.code));this.statusCb?.('信令请求失败：'+reasonLabel(msg.code));}
      }
    }
  }
  private iceConfigCb?:(config:unknown)=>void;
  onIceConfig(cb:(config:unknown)=>void){this.iceConfigCb=cb;}
  async getSelf():Promise<SelfInfo>{
    const deadline=Date.now()+5000;while(!this.registered&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
    if(!this.registered)throw new Error('未连接信令服务，请检查地址、房间和令牌');
    return {id:this.selfId,name:this.name,port:0,ip:'browser'};
  }
  async listPeers():Promise<PeerInfo[]>{return [...this.peers.values()];}
  async connectPeer(id:string){if(!this.registered||!this.peers.has(id))throw new Error('对端不在线');}
  async acceptPeer(_id:string){}
  async rejectPeer(_id:string){}
  async sendSignal(to:string,data:SignalPayload){await this.send({type:'signal',to,data});}
  async sendInvite(to:string,files:InviteFile[],transferId:string){await this.send({type:'invite',to,files,transferId});}
  async acceptTransfer(to:string,transferId:string){await this.send({type:'accept',to,transferId});}
  async rejectTransfer(to:string,transferId:string){await this.send({type:'reject',to,transferId});}
  private async send(message:Record<string,unknown>):Promise<void>{
    if(!this.registered||!this.ws||this.ws.readyState!==WebSocket.OPEN)throw new Error('SIGNAL_OFFLINE');
    const requestId=uuid(),data=JSON.stringify({...message,version:SIGNAL_VERSION,requestId});
    if(new TextEncoder().encode(data).length>MAX_MESSAGE||this.ws.bufferedAmount>1024*1024||this.pending.size>=128)throw new Error('SIGNAL_BUSY');
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(requestId);reject(new Error('SIGNAL_ACK_TIMEOUT'));},15000);
      this.pending.set(requestId,{resolve,reject,timer});
      try{this.ws!.send(data);}catch(e){clearTimeout(timer);this.pending.delete(requestId);reject(e);}
    });
  }
  private failPending(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('SIGNAL_OFFLINE'));}this.pending.clear();}
  onInvite(cb:Parameters<Signaling['onInvite']>[0]){this.inviteCb=cb;}
  onAccept(cb:Parameters<Signaling['onAccept']>[0]){this.acceptCb=cb;}
  onReject(cb:Parameters<Signaling['onReject']>[0]){this.rejectCb=cb;}
  onSignal(cb:Parameters<Signaling['onSignal']>[0]){this.signalCb=cb;}
  onBye(_cb:Parameters<Signaling['onBye']>[0]){} // Presence loss is not RTC failure.
  onSelfChange(cb:Parameters<NonNullable<Signaling['onSelfChange']>>[0]){this.selfChangeCb=cb;}
  onTokenExpiry(cb:Parameters<NonNullable<Signaling['onTokenExpiry']>>[0]){this.tokenExpiryCb=cb;}
  onPeerList(cb:Parameters<Signaling['onPeerList']>[0]){this.peerListCb=cb;this.emitPeers();}
  stop(){this.stopped=true;clearTimeout(this.retryTimer);clearInterval(this.monitor);const ws=this.ws;this.ws=null;ws?.close();this.registered=false;this.failPending();this.peers.clear();this.emitPeers();this.statusCb?.('信令已断开');}
}
