import { startServer, type IceServerConfig } from './server.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
let fileConfig:Record<string,unknown>={};
const configPath=process.env.SIG_CONFIG_FILE||resolve(process.cwd(),'signaling.config.json');
if(existsSync(configPath)) { try { fileConfig=JSON.parse(readFileSync(configPath,'utf8')); } catch(e) { throw new Error(`Invalid signaling config: ${e}`); } }
const value=(key:string, fallback?:string)=>process.env[key]??(typeof fileConfig[key]==='string'?String(fileConfig[key]):fallback);
const port=Number(value('SIG_PORT','8787'));
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid SIG_PORT');
const host=value('SIG_HOST','127.0.0.1')!;
// transfer-v2 is now the shared browser/Windows protocol. Set this to 0 only
// when temporarily isolating rollout environments.
const enableCrossEngine=value('SIG_ENABLE_CROSS_ENGINE','1')!=='0';
const origins=value('SIG_ORIGINS','')?.split(',').map(s=>s.trim()).filter(Boolean);
const iceServers=Array.isArray(fileConfig.iceServers)?fileConfig.iceServers as IceServerConfig[]:[];
// iceTransportPolicy accepts only all|relay; relay is used solely to validate TURN (forces relay-only path).
const iceTransportPolicy=value('SIG_ICE_POLICY', typeof fileConfig.iceTransportPolicy==='string'?fileConfig.iceTransportPolicy:undefined);
// iceTrickle: enabled by default (trickle ICE); only an explicit false/'false'/0 disables it (send SDP only after full gathering).
const iceTrickleRaw=process.env.SIG_ICE_TRICKLE ?? fileConfig.iceTrickle;
const iceTrickle=iceTrickleRaw===false||iceTrickleRaw==='false'||iceTrickleRaw===0||iceTrickleRaw==='0'?false:true;
// Shared secret for TURN ephemeral credentials (same value as coturn's static-auth-secret).
// ⚠️ Read from env only — **do not put it in signaling.config.json**: configuring auth:"rest" is enough; keep the secret in the process environment.
const turnSecret=value('SIG_TURN_SECRET','')!;
const turnTtlSeconds=Number(value('SIG_TURN_TTL','43200'));
const tokenDb=value('SIG_TOKEN_DB',resolve(process.cwd(),'data','tokens.sqlite'))!;
const service=await startServer({host,port,token:value('SIG_TOKEN'),adminToken:value('SIG_ADMIN_TOKEN'),tokenDb,origins,iceServers,iceTransportPolicy,iceTrickle,iceRestart:true,connectionTimeoutSeconds:30,enableCrossEngine,turnSecret,turnTtlSeconds});
console.log(`Signaling listening on ${host}:${port}`);
// When TURN is configured but username/credential are missing, the entry is dropped — surface this, or users only see "configured but not working".
for(const reason of service.ice.dropped)console.warn(`ICE: 已丢弃 1 组不可用的 server —— ${reason}`);
let stopping=false;
for(const event of ['SIGINT','SIGTERM'] as const)process.on(event,()=>{if(!stopping){stopping=true;void service.close().finally(()=>process.exit(0));}});
