import { Peer } from './webrtc/peer';
import { Channel, ChannelCallbacks, FileReader } from './webrtc/channel';
import { InviteFile, Signaling, SignalPayload } from './signaling/types';
import { TransferScheduler, delay } from './transfer/scheduler';

export class Session {
  readonly peer: Peer;
  connectionState: RTCPeerConnectionState = 'new';
  dead=false;
  authorization?: (tid:string) => InviteFile[] | undefined;
  private transfers=new Map<string,Channel>();
  private channels=new Set<RTCDataChannel>();
  private aborter=new AbortController();
  private signals=Promise.resolve();
  private congested=false;
  private restartTimer?: ReturnType<typeof setTimeout>;
  // Signaling is only the recovery/control plane. A temporary signaling outage
  // must not tear down an otherwise live WebRTC transfer.
  private signalingAvailable() {
    const probe = (this.sig as Signaling & { isConnected?: () => boolean }).isConnected;
    return probe ? probe() : true;
  }
  // Public: lets the engine probe the actual transfer path after connection (P2P direct / TURN relay).
  getTransportStats=async()=>{
    const report=await this.peer.pc.getStats();
    let selected: any;
    report.forEach(s=>{if(s.type==='transport' && s.selectedCandidatePairId) selected=report.get(s.selectedCandidatePairId);});
    if(!selected) report.forEach(s=>{if(s.type==='candidate-pair' && s.nominated && s.state==='succeeded') selected=s;});
    if(!selected) return {};
    const candidate=(id:string)=>{
      const c=report.get(id);
      return c?{address:c.address??c.ip,port:c.port,protocol:c.protocol,candidateType:c.candidateType}:undefined;
    };
    return {rttMs:typeof selected.currentRoundTripTime==='number'?selected.currentRoundTripTime*1000:undefined,bytesSent:selected.bytesSent,bytesReceived:selected.bytesReceived,local:candidate(selected.localCandidateId),remote:candidate(selected.remoteCandidateId)};
  };
  constructor(public readonly session:string,private sig:Signaling, config:RTCConfiguration,
    role:'leader'|'follower',private makeCallbacks:(tid:string,peer:string)=>ChannelCallbacks,
    private onState:(s:RTCPeerConnectionState)=>void, private scheduler:TransferScheduler,
    private trickle=true) {
    this.peer=new Peer(config,this.trickle,dc=>this.onDataChannel(dc),c=>{
      void this.sig.sendSignal(this.session,{candidate:c.toJSON()}).catch(()=>{
        // A lost candidate can be recovered by a later ICE restart. Do not
        // abort the data channel merely because WS is temporarily offline.
        if(this.connectionState!=='connected' && this.signalingAvailable()) this.close();
      });
    },s=>{
      this.connectionState=s;
      if(s==='disconnected') { clearTimeout(this.restartTimer); this.restartTimer=setTimeout(()=>void this.restartIce(),4000); }
      if(s==='connected') { clearTimeout(this.restartTimer); this.restartTimer=undefined; }
      if(s==='failed'||s==='closed') this.close();
      this.onState(s);
    });
    if(role==='leader') {
      this.track(this.peer.createDataChannel('p2p-ctl'));
      void this.peer.createOffer().then(o=>this.sig.sendSignal(session,{sdp:o})).catch(()=>this.close());
    }
  }
  private async restartIce() {
    if(this.dead || this.connectionState==='connected') return;
    if(!this.signalingAvailable()) {
      this.restartTimer=setTimeout(()=>void this.restartIce(),4000);
      return;
    }
    try { await this.sig.sendSignal(this.session,{sdp:await this.peer.createOffer(true)}); }
    catch {
      if(this.signalingAvailable()) this.close();
      else this.restartTimer=setTimeout(()=>void this.restartIce(),4000);
    }
  }
  private track(dc:RTCDataChannel) { this.channels.add(dc); dc.addEventListener('close',()=>this.channels.delete(dc),{once:true}); }
  private writable=()=>{
    const amount=[...this.channels].reduce((n,c)=>n+c.bufferedAmount,0);
    if(amount>=this.scheduler.limits.highWater) this.congested=true;
    if(amount<=this.scheduler.limits.lowWater) this.congested=false;
    return !this.dead&&!this.congested;
  };
  private onDataChannel(dc:RTCDataChannel) {
    if(dc.label==='p2p-ctl') { this.track(dc); return; }
    const tid=dc.label.startsWith('transfer:')?dc.label.slice(9):'';
    const files=this.authorization?.(tid);
    if(!tid||!files||this.transfers.has(tid)||this.transfers.size>=100) { dc.close(); return; }
    this.track(dc);
    const ch=new Channel(dc,this.makeCallbacks(tid,this.session),tid,{
      peerId:this.session,sender:false,scheduler:this.scheduler,expectedFiles:files,getTransportStats:this.getTransportStats,
      maxMessageSize:this.peer.pc.sctp?.maxMessageSize??65536,writable:this.writable,signal:this.aborter.signal,
    });
    this.transfers.set(tid,ch);
    void ch.done.finally(()=>this.transfers.delete(tid)).catch(()=>{});
  }
  async whenConnected() {
    const deadline=Date.now()+30000;
    while(this.connectionState!=='connected') {
      if(Date.now()>deadline) { this.close(); throw new Error('CONN_TIMEOUT'); }
      await delay(20,this.aborter.signal);
    }
  }
  isUsable() { return !this.dead&&this.connectionState==='connected'; }
  handleSignal(data:SignalPayload):Promise<void> {
    this.signals=this.signals.then(async()=>{
      if(data.sdp) {
        await this.peer.setRemote(data.sdp);
        if(data.sdp.type==='offer') await this.sig.sendSignal(this.session,{sdp:await this.peer.createAnswer()});
      } else if(data.candidate) await this.peer.addIce(data.candidate);
    });
    return this.signals;
  }
  async startTransfer(readers:FileReader[],tid:string,signal?:AbortSignal) {
    await this.whenConnected();
    if(this.transfers.has(tid)) throw new Error('DUPLICATE_TRANSFER');
    const combined = new AbortController();
    const cancel = () => combined.abort(new Error('CANCELLED_OR_DISCONNECTED'));
    signal?.addEventListener('abort',cancel,{once:true});
    this.aborter.signal.addEventListener('abort',cancel,{once:true});
    if(signal?.aborted || this.aborter.signal.aborted) cancel();
    this.makeCallbacks(tid,this.session).onQueued?.();
    let release: (()=>void)|undefined;
    try {
    release=await this.scheduler.acquire(this.session,'send',combined.signal);
    combined.signal.throwIfAborted();
    const dc=this.peer.createDataChannel(`transfer:${tid}`); this.track(dc);
    const ch=new Channel(dc,this.makeCallbacks(tid,this.session),tid,{
      peerId:this.session,sender:true,scheduler:this.scheduler,expectedFiles:[],getTransportStats:this.getTransportStats,
      maxMessageSize:this.peer.pc.sctp?.maxMessageSize??65536,writable:this.writable,signal:combined.signal,admitted:true,
    });
    this.transfers.set(tid,ch);
    await ch.sendFiles(readers);
    } finally {
      this.transfers.delete(tid); release?.();
      signal?.removeEventListener('abort',cancel);this.aborter.signal.removeEventListener('abort',cancel);
    }
  }
  cancel(tid:string) { this.transfers.get(tid)?.abort(); }
  close() {
    if(this.dead) return; this.dead=true; clearTimeout(this.restartTimer); this.aborter.abort(new Error('CONN_DROPPED'));
    for(const ch of this.transfers.values()) ch.abort('CONN_DROPPED');
    this.transfers.clear(); this.peer.pc.close();
  }
}
