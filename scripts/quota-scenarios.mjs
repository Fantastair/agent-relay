// Deterministic UI regression fixture. All quota values are fake; no native I/O.
import path from 'node:path';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {makeService} from '../src/server.mjs';
import {seedPreviewData} from './preview.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),dataDir=path.join(root,'data-dev','quota-scenarios'),scenarioPath=path.join(dataDir,'scenario.json');
await mkdir(dataDir,{recursive:true});await writeFile(scenarioPath,JSON.stringify({mode:'normal'}),'utf8');
const baseAdapter={async list(){return [];},async projects(){return {projects:[]};},async workspaces(){return [];},async snapshot(){return {state:'idle',turns:[],title:'模拟额度场景'};},async send(){throw new Error('场景预览禁止发送原生消息');}};
const adapters={
  codex:{...baseAdapter,async quota(){const {mode}=JSON.parse(await readFile(scenarioPath,'utf8'));if(mode==='failure')throw new Error('模拟Codex查询失败');return {rateLimits:{primary:{usedPercent:mode==='low'?90:30,windowDurationMins:300,resetsAt:Date.now()+3600000}}};}},
  deepseek:{...baseAdapter,async quota(){const {mode}=JSON.parse(await readFile(scenarioPath,'utf8'));return {balance:mode==='normal'?7.92:1.5,currency:'CNY'};}}
};
const service=await makeService({dataDir,adapters,quotaOptions:{ttl:0}});seedPreviewData(service.store);
service.relay.health={codex:{ok:true,state:'idle',title:'模拟额度 · Codex'},deepseek:{ok:true,state:'idle',title:'模拟额度 · DeepSeek'}};
await new Promise((resolve,reject)=>{service.server.once('error',reject);service.server.listen(4330,'127.0.0.1',resolve);});
console.log('http://127.0.0.1:4330 — MOCK quota scenarios; no native delivery');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void service.close().then(()=>process.exit(0)));
