import { build } from 'esbuild';
import test from 'node:test';
import assert from 'node:assert/strict';
const result = await build({stdin:{contents:`export * from './src/webrtc/channel.ts'; export * from './src/webrtc/protocol.ts'; export * from './src/transfer/scheduler.ts'; export * from './src/transfer/manager.ts'; export * from './src/file/memory.ts';`,resolveDir:process.cwd()},bundle:true,format:'esm',platform:'node',write:false});
const {Channel,IntervalSet,TransferScheduler,TransferManager,MemoryFileReader,CHUNK_SIZE,RECEIVE_WINDOW,DEFAULT_RECEIVE_WINDOW,parseControl,decodeChunk}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class FakeDC extends EventTarget {
  readyState='open'; bufferedAmount=0; onmessage; onclose; onerror; sent=0;
  send(data) {
    if(this.readyState!=='open') throw new Error('CLOSED');
    let copy=typeof data==='string'?data:data.slice(0);
    if(typeof copy!=='string') {this.sent+=copy.byteLength-12;if(this.corrupt){new Uint8Array(copy)[12]^=1;this.corrupt=false;}}
    this.bufferedAmount+=typeof copy==='string'?copy.length:copy.byteLength;
    setTimeout(()=>{this.bufferedAmount=0;this.other.onmessage?.({data:copy});},0);
  }
  close() {
    if(this.readyState==='closed') return;
    this.readyState='closed';this.onclose?.();this.dispatchEvent(new Event('close'));
    setTimeout(()=>{if(this.other.readyState!=='closed'){this.other.readyState='closed';this.other.onclose?.();this.other.dispatchEvent(new Event('close'));}},0);
  }
}
function pair(contents, options={}) {
  const a=new FakeDC(),b=new FakeDC();a.other=b;b.other=a;a.corrupt=options.corrupt;
  const files=contents.map((bytes,i)=>({name:`f${i}`,size:bytes.length,diagnosticMode:options.mode??'full',mime:'application/octet-stream',readAt:async(o,n)=>{await options.readGate?.(o);return bytes.slice(o,o+n);},close:async()=>options.onClose?.()}));
  const writes=[];const events=[];
  files.forEach(f=>{f.frameBytes=options.requestFrame??65536;});
  const sendScheduler=options.sendScheduler??new TransferScheduler({rate:100*1024*1024});
  const recvScheduler=options.recvScheduler??new TransferScheduler();
  const receiver=new Channel(b,{
    writerFactory:async meta=>{
      const data=new Uint8Array(meta.size);writes.push(data);
      return {prepare:async()=>{},writeAt:async(o,bytes)=>{await options.writeGate?.();if(options.diskError)throw new Error('DISK_FULL');data.set(bytes,o);},finalize:async()=>{events.push('finalizing');await options.commitGate?.();events.push('committed');},abort:async()=>events.push('aborted')};
    },onTransferComplete:()=>events.push('recv-done'),onError:e=>events.push(e),
    onDiagnostics:r=>options.onDiagnostics?.(r),
  },options.tid??'test',{peerId:'sender',sender:false,scheduler:recvScheduler,receiveWindowBytes:options.window,expectedFiles:files.map(f=>({name:f.name,size:f.size,diagnosticMode:f.diagnosticMode})),maxMessageSize:65536,writable:()=>true});
  const sender=new Channel(a,{writerFactory:async()=>{throw Error('sender writer');},onDiagnostics:r=>options.onSenderDiagnostics?.(r),onTransferComplete:()=>events.push('send-done')},options.tid??'test',{peerId:'receiver',sender:true,scheduler:sendScheduler,expectedFiles:[],maxMessageSize:options.frameSize??65536,writable:()=>true});
  return {sender,receiver,files,writes,events,a,b,sendScheduler,recvScheduler};
}
test('intervals never merge across holes',()=>{
  const s=new IntervalSet();s.add(0,10);s.add(20,30);assert.equal(s.covers(0,30),false);assert.deepEqual(s.gaps(30),[[10,20]]);s.add(10,20);assert.equal(s.covers(0,30),true);
  const r=new IntervalSet();r.add(20,30);r.add(0,10);assert.equal(r.contiguousTo(),10);
});
test('actual channel transfers empty, nonaligned and multiple files; commits before success',async()=>{
  const content=[new Uint8Array(0),Uint8Array.from({length:CHUNK_SIZE*5+71},(_,i)=>i%251)];
  const p=pair(content,{frameSize:16384});await p.sender.sendFiles(p.files);await p.receiver.done;
  assert.deepEqual(p.writes,content);assert.equal(p.events.filter(e=>e==='committed').length,2);
  assert.ok(p.events.indexOf('send-done')>p.events.lastIndexOf('committed'));
  await sleep(10);assert.equal(p.sendScheduler.snapshot().active,0);assert.equal(p.recvScheduler.snapshot().active,0);
});
test('sender cannot complete before receiver storage commit',async()=>{
  let release;const gate=new Promise(r=>release=r);const p=pair([new Uint8Array(10)],{commitGate:()=>gate});
  const sending=p.sender.sendFiles(p.files);
  const deadline=Date.now()+2000;
  while(!p.events.includes('finalizing')&&Date.now()<deadline) await sleep(10);
  try { assert.ok(p.events.includes('finalizing'));assert.ok(!p.events.includes('send-done')); } finally { release(); }
  release();await sending;
});
test('corruption fails without committing or reporting success',async()=>{
  const p=pair([new Uint8Array(CHUNK_SIZE+19)],{corrupt:true});await assert.rejects(p.sender.sendFiles(p.files));await assert.rejects(p.receiver.done);
  await sleep(10);assert.ok(!p.events.includes('committed'));assert.ok(!p.events.includes('send-done'));assert.ok(p.events.includes('aborted'));
});
test('slow disk bounds in-flight payload to the write-backlog watermark',async()=>{
  const window=DEFAULT_RECEIVE_WINDOW;
  const high=Math.max(2*window,4*RECEIVE_WINDOW); // pendingHigh() for the default 1 MiB window
  const slack=Math.max(CHUNK_SIZE,Math.floor(window/4))+2*CHUNK_SIZE;
  let release;const gate=new Promise(r=>release=r);
  const p=pair([new Uint8Array(high+CHUNK_SIZE)],{writeGate:()=>gate});
  const sending=p.sender.sendFiles(p.files);
  const deadline=Date.now()+3000;
  while(!p.sender.creditWaiter&&Date.now()<deadline) await sleep(10);
  assert.ok(p.sender.creditWaiter,'sender must be blocked by backlog backpressure before the disk gate opens');
  assert.ok(p.a.sent>window,'decoupling lets the sender run ahead of a slow disk instead of stalling at the window');
  assert.ok(p.a.sent<=high+slack,'in-flight stays under the bounded backlog watermark');
  release();await sending;
});
test('cancel unblocks credit wait and releases resources after I/O cleanup',async()=>{
  let release;const gate=new Promise(r=>release=r);const p=pair([new Uint8Array(DEFAULT_RECEIVE_WINDOW*2)],{writeGate:()=>gate});
  const sending=p.sender.sendFiles(p.files);await sleep(50);p.sender.abort();release();await assert.rejects(sending);await assert.rejects(p.receiver.done);await sleep(30);
  assert.equal(p.sendScheduler.snapshot().active,0);assert.equal(p.recvScheduler.snapshot().active,0);
});
test('disk errors never produce completion',async()=>{
  const p=pair([new Uint8Array(CHUNK_SIZE)],{diskError:true});await assert.rejects(p.sender.sendFiles(p.files));assert.ok(!p.events.includes('send-done'));
});
test('admission reserves receive capacity, bounds queues, and cancellation removes waiter',async()=>{
  const s=new TransferScheduler({active:2,queued:1});const a=new AbortController(),b=new AbortController();
  const release=await s.acquire('a','send',a.signal);const queued=s.acquire('b','send',b.signal);
  await assert.rejects(s.acquire('c','recv',new AbortController().signal),/BUSY/);
  b.abort(new Error('cancel'));await assert.rejects(queued);const recv=await s.acquire('a','recv',a.signal);
  assert.equal(s.snapshot().active,2);release();recv();assert.equal(s.snapshot().memory,0);
});
test('task identity binds peer, manifest and destination; early acceptance retained',async()=>{
  const m=new TransferManager();m.create('t','a','send',[{name:'x',size:1}]);m.accept('b','t');assert.equal(m.tasks.get('t').phase,'invited');m.accept('a','t');await m.waitAccept('t');
  assert.throws(()=>m.create('t','a','send',[{name:'x',size:2}]));
  m.create('r','a','recv',[{name:'x',size:1}]);assert.throws(()=>m.authorize('r',null));m.authorize('r',{});assert.ok(m.authorization('a','r'));assert.equal(m.authorization('b','r'),undefined);
});
test('runtime protocol rejects bad versions, short binary frames and traversal',()=>{
  assert.throws(()=>parseControl('{"version":1}'),/VERSION/);assert.throws(()=>decodeChunk(new ArrayBuffer(3)));
  const m=new TransferManager();assert.throws(()=>m.create('x','p','recv',[{name:'../x',size:1}]));
});
test('simultaneous bidirectional tasks share device budgets without deadlock',async()=>{
  const a=new TransferScheduler({rate:100*1048576}),b=new TransferScheduler({rate:100*1048576});
  const pairs=[];
  for(let i=0;i<6;i++) pairs.push(pair([new Uint8Array(CHUNK_SIZE+17)],{
    tid:`duplex-${i}`,sendScheduler:i%2?a:b,recvScheduler:i%2?b:a,
  }));
  await Promise.all(pairs.map(p=>p.sender.sendFiles(p.files)));
  await sleep(30);
  assert.equal(a.snapshot().active,0);assert.equal(b.snapshot().active,0);
  for(const p of pairs) assert.ok(p.events.includes('send-done'));
});
for (const mode of ['network','hash','disk','full']) {
  test(`diagnostic ${mode}: correct hashing/storage and exported timing`,async()=>{
    let report;
    const bytes=new Uint8Array(CHUNK_SIZE+39);
    const p=pair([bytes],{mode,onDiagnostics:r=>report=r});
    await p.sender.sendFiles(p.files);
    assert.equal(p.writes.length,mode==='disk'||mode==='full'?1:0);
    assert.equal(report.mode,mode);assert.equal(report.status,'completed');
    assert.equal(report.payloadBytes,bytes.length);assert.ok(report.elapsedMs>0);
    if(mode==='network'||mode==='disk') assert.equal(report.hashMs,0);else assert.ok(report.hashMs>0);
    if(mode==='network'||mode==='hash') {assert.equal(report.writeMs,0);assert.equal(report.finalizeMs,0);}
  });
}
test('diagnostic hash detects corrupted data without saving',async()=>{
  const p=pair([new Uint8Array(CHUNK_SIZE)],{mode:'hash',corrupt:true});
  await assert.rejects(p.sender.sendFiles(p.files));assert.equal(p.writes.length,0);
});
test('diagnostic disk explicitly skips content hash validation',async()=>{
  const p=pair([new Uint8Array(CHUNK_SIZE)],{mode:'disk',corrupt:true});
  await p.sender.sendFiles(p.files);assert.equal(p.writes[0][0],1);
});
for(const mib of [1,4,8]) test(`${mib} MiB window reserves memory and bounds slow-disk traffic`,async()=>{
  let release;const gate=new Promise(r=>release=r);let senderReport;
  const window=mib*RECEIVE_WINDOW;
  const high=Math.max(2*window,4*RECEIVE_WINDOW); // pendingHigh()
  const slack=Math.max(CHUNK_SIZE,Math.floor(window/4))+2*CHUNK_SIZE;
  const p=pair([new Uint8Array(high+CHUNK_SIZE)],{window,writeGate:()=>gate,onSenderDiagnostics:r=>senderReport=r});
  const sending=p.sender.sendFiles(p.files);
  try {
    const deadline=Date.now()+3000;
    while(p.a.sent<window&&Date.now()<deadline) await sleep(10);
    while(!p.sender.creditWaiter&&Date.now()<deadline) await sleep(10);
    assert.ok(p.sender.creditWaiter,'sender must actually be waiting on backlog backpressure before the disk gate opens');
    assert.ok(p.a.sent>window,'decoupling runs the sender ahead of a slow disk (window is no longer the hard in-flight cap)');
    assert.ok(p.a.sent<=high+slack,'in-flight stays under the bounded backlog watermark');
    assert.equal(p.recvScheduler.snapshot().memory,15*RECEIVE_WINDOW); // taskMemory(8MiB) + 7*RECEIVE_WINDOW reserved up front; constant, covers the adaptive 8 MiB max tier
  } finally {release();}
  await sending;
  assert.equal(senderReport.receiveWindowBytes,window);
  assert.ok(senderReport.creditStalls>0);assert.ok(senderReport.creditWakeups>0);
  assert.ok(senderReport.creditToSendMs>=senderReport.creditResumeMs);
  assert.equal(p.recvScheduler.snapshot().memory,0);
});
test('cancel waits for bounded prefetch before closing source and releasing memory',async()=>{
  let release;const gate=new Promise(r=>release=r);let pending=false,closed=false;
  const p=pair([new Uint8Array(CHUNK_SIZE*3)],{readGate:async o=>{if(o===CHUNK_SIZE){pending=true;await gate;}},onClose:()=>{closed=true;}});
  const sending=p.sender.sendFiles(p.files);void sending.catch(()=>{});
  const deadline=Date.now()+2000;while(!pending&&Date.now()<deadline) await sleep(10);
  p.sender.abort();await sleep(20);
  try {assert.ok(pending);assert.equal(closed,false);assert.equal(p.sendScheduler.snapshot().active,1);} finally {release();}
  await assert.rejects(sending);await assert.rejects(p.receiver.done);
  assert.equal(closed,true);assert.equal(p.sendScheduler.snapshot().memory,0);
});
test('invalid receive window rejected instead of granting unbudgeted data',async()=>{
  const p=pair([new Uint8Array(16)],{window:2*RECEIVE_WINDOW});
  await assert.rejects(p.sender.sendFiles(p.files));await assert.rejects(p.receiver.done);
  assert.equal(p.a.sent,0);
});
for(const size of [16384,32768,65536]) test(`requested ${size} byte frames preserve data and report receiver metrics`,async()=>{
  let report;const data=Uint8Array.from({length:CHUNK_SIZE+137},(_,i)=>i%251);
  const p=pair([data],{requestFrame:size,onDiagnostics:r=>report=r});
  await p.sender.sendFiles(p.files);assert.deepEqual(p.writes[0],data);
  assert.equal(report.frameBytes,size);assert.equal(report.sourceKind,'file');
  assert.equal(report.receivedFrames,Math.ceil(CHUNK_SIZE/(size-12))+1);
  assert.ok(report.receiveProcessingMs>0);assert.equal(report.creditSendCount,2);
});
test('synthetic reader reuses bounded memory and passes hash-mode transfer',async()=>{
  const size=CHUNK_SIZE*3+17;const source=new MemoryFileReader('f0',size);
  const a=await source.readAt(0,CHUNK_SIZE),b=await source.readAt(CHUNK_SIZE,CHUNK_SIZE);
  assert.equal(a.buffer,b.buffer);assert.equal(a.buffer.byteLength,CHUNK_SIZE);
  const p=pair([new Uint8Array(size)],{mode:'hash'});
  source.diagnosticMode='hash';source.frameBytes=16384;
  await p.sender.sendFiles([source]);assert.equal(p.writes.length,0);
});

test('multi-file: next file prepares while previous finalize is still pending (#52)', async () => {
  let release; const gate = new Promise(r => release = r);
  const p = pair([new Uint8Array(CHUNK_SIZE), new Uint8Array(CHUNK_SIZE)], { commitGate: () => gate });
  const sending = p.sender.sendFiles(p.files);
  const deadline = Date.now() + 3000;
  while (!p.events.includes('finalizing') && Date.now() < deadline) await sleep(10);
  assert.ok(p.events.includes('finalizing'), 'file 0 finalize started');
  assert.ok(!p.events.includes('committed'), 'file 0 finalize still parked on the gate');
  // #52: the next file's writer must already be prepared (overlap) instead of waiting for file 0's close
  assert.equal(p.writes.length, 2, 'next file writer prepared while previous finalize pending');
  release();
  await sending; await p.receiver.done;
  assert.equal(p.writes.length, 2);
});
