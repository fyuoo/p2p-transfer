import { InviteFile, validateFiles } from '../webrtc/protocol';

export type TaskPhase = 'invited'|'accepted'|'queued'|'active'|'committing'|'completed'|'failed'|'cancelled';
export type LocalTransferResult = 'pending'|'sending'|'sent'|'saved'|'failed'|'cancelled';
export type RemoteTransferResult = 'unknown'|'receiving'|'saving'|'saved'|'failed'|'cancelled';
export type TransferFileState = 'pending'|'sending'|'sent'|'receiving'|'received'|'writing'|'finalizing'|'saved'|'failed'|'cancelled';
export interface TransferTask {
  id:string; peerId:string; direction:'send'|'recv'; files:InviteFile[];
  phase:TaskPhase; aborter:AbortController; destination?:unknown; error?:string;
  receiveWindowBytes?: number;
  /** Direction-specific outcomes; phase remains a compatibility summary. */
  localResult: LocalTransferResult;
  remoteResult: RemoteTransferResult;
  localError?: string;
  remoteError?: string;
  fileStates: TransferFileState[];
}
/** Task identity/authorization never lives on a PeerConnection. P0-P2 state is session-only. */
export class TransferManager {
  readonly tasks=new Map<string,TransferTask>();
  private accepts=new Map<string,{resolve:()=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(private changed:(task:TransferTask)=>void=()=>{}) {}
  create(id:string,peerId:string,direction:'send'|'recv',files:InviteFile[]) {
    validateFiles(files);
    if(!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('INVALID_TRANSFER_ID');
    const existing=this.tasks.get(id);
    if(existing) {
      if(existing.peerId!==peerId||existing.direction!==direction||JSON.stringify(existing.files)!==JSON.stringify(files)) throw new Error('CONFLICTING_INVITE');
      return existing;
    }
    const live=[...this.tasks.values()].filter(t=>!['completed','failed','cancelled'].includes(t.phase));
    if(live.length>=100) throw new Error('BUSY');
    if(this.tasks.size>=300) {
      for(const [key,t] of this.tasks) { if(['completed','failed','cancelled'].includes(t.phase)) {this.tasks.delete(key);break;} }
    }
    const task:TransferTask={id,peerId,direction,files:files.map(f=>({...f})),phase:'invited',aborter:new AbortController(),localResult:'pending',remoteResult:'unknown',fileStates:files.map(()=>'pending')};
    this.tasks.set(id,task); this.changed(task); return task;
  }
  phase(id:string,phase:TaskPhase,error?:string) {
    const t=this.tasks.get(id); if(!t||['completed','failed','cancelled'].includes(t.phase)) return;
    t.phase=phase; t.error=error; this.changed(t);
  }
  local(id:string,result:LocalTransferResult,error?:string) {
    const t=this.tasks.get(id); if(!t) return;
    t.localResult=result; t.localError=error; this.changed(t);
  }
  remote(id:string,result:RemoteTransferResult,error?:string) {
    const t=this.tasks.get(id); if(!t) return;
    t.remoteResult=result; t.remoteError=error; this.changed(t);
  }
  file(id:string,index:number,state:TransferFileState) {
    const t=this.tasks.get(id); if(!t || !Number.isInteger(index) || index<0 || index>=t.fileStates.length) return;
    t.fileStates[index]=state; this.changed(t);
  }
  waitAccept(id:string,ms=120000) {
    const t=this.tasks.get(id)!;
    if(t.phase==='accepted') return Promise.resolve();
    return new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>this.reject(t.peerId,id,'ACCEPT_TIMEOUT'),ms);
      this.accepts.set(id,{resolve,reject,timer});
    });
  }
  accept(peer:string,id:string) {
    const t=this.tasks.get(id); if(!t||t.peerId!==peer||t.direction!=='send'||t.phase!=='invited') return;
    this.phase(id,'accepted'); const waiter=this.accepts.get(id);
    if(waiter) {clearTimeout(waiter.timer);this.accepts.delete(id);waiter.resolve();}
  }
  reject(peer:string,id:string,reason='USER_REJECT') {
    const t=this.tasks.get(id); if(!t||t.peerId!==peer) return;
    const waiter=this.accepts.get(id); if(waiter) {clearTimeout(waiter.timer);this.accepts.delete(id);waiter.reject(new Error(reason));}
    this.phase(id,'failed',reason); t.aborter.abort(new Error(reason));
  }
  authorize(id:string,destination:unknown) {
    const t=this.tasks.get(id); if(!t||t.direction!=='recv'||t.phase!=='invited'||!destination) throw new Error('INVALID_AUTHORIZATION');
    t.destination=destination; this.phase(id,'accepted');
  }
  authorization(peer:string,id:string) {
    const t=this.tasks.get(id);
    return t&&t.peerId===peer&&t.direction==='recv'&&t.destination&&['accepted','queued','active','committing'].includes(t.phase)?t.files:undefined;
  }
  cancel(id:string) {
    const t=this.tasks.get(id); if(!t) return;
    this.phase(id,'cancelled','USER_CANCEL'); this.reject(t.peerId,id,'USER_CANCEL');
  }
}
