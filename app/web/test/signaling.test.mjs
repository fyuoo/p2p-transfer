import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { WebSocket } from 'ws';
import { startServer } from '../../../server/signaling-server/dist/server/signaling-server/src/server.js';
globalThis.WebSocket=WebSocket;
const bundle=await build({entryPoints:['src/signaling/browser.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {BrowserSignaling}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const wait=async predicate=>{const end=Date.now()+6000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,20));}throw new Error('timeout');};
test('real browser client registers, delivers invites and rejects unavailable targets',async t=>{
  const service=await startServer({port:0,token:'secret'});t.after(()=>service.close());
  const url='ws://127.0.0.1:'+service.server.address().port;
  const a=new BrowserSignaling(url,'a','default','secret'),b=new BrowserSignaling(url,'b','default','secret');
  t.after(()=>{a.stop();b.stop();});await a.start();await b.start();
  const aid=(await a.getSelf()).id,bid=(await b.getSelf()).id;
  await wait(async()=> (await a.listPeers()).length===1);
  let received; b.onInvite((from,name,session,files,transferId)=>{received={from,session,files,transferId};});
  await a.sendInvite(bid,[{name:'a.bin',size:1}],'test-task');await wait(()=>!!received);
  assert.equal(received.from,aid);assert.equal(received.transferId,'test-task');
  await assert.rejects(a.sendInvite('offline',[{name:'a.bin',size:1}],'task2'),/PEER_UNAVAILABLE/);
});
test('service restart preserves client identity and does not emit RTC bye',async t=>{
  let service=await startServer({port:0});const port=service.server.address().port;t.after(()=>service.close());
  const a=new BrowserSignaling('ws://127.0.0.1:'+port,'a'),b=new BrowserSignaling('ws://127.0.0.1:'+port,'b');
  t.after(()=>{a.stop();b.stop();});let byes=0,changes=0;a.onBye(()=>byes++);a.onSelfChange(()=>changes++);
  await a.start();await b.start();const aid=(await a.getSelf()).id;await b.getSelf();await wait(async()=> (await a.listPeers()).length===1);
  await service.close();await wait(async()=> (await a.listPeers()).length===0);
  service=await startServer({port});await wait(async()=> (await a.listPeers()).length===1);
  assert.equal((await a.getSelf()).id,aid);assert.equal(byes,0);assert.equal(changes,1);
});
test('stop cancels reconnect and rejects pending requests',async t=>{
  const service=await startServer({port:0});t.after(()=>service.close());
  const a=new BrowserSignaling('ws://127.0.0.1:'+service.server.address().port,'a');await a.start();await a.getSelf();a.stop();
  await assert.rejects(a.sendSignal('peer',{sdp:{type:'offer',sdp:'x'}}),/SIGNAL_OFFLINE/);
  await new Promise(r=>setTimeout(r,1200));assert.equal(service.wss.clients.size,0);
});
