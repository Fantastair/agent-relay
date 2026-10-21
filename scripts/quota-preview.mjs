// Real account reads, isolated SQLite, and no native message delivery.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeService} from '../src/server.mjs';
import {CodexAdapter} from '../src/adapters/codex.mjs';
import {DshAdapter} from '../src/adapters/dsh.mjs';
import {seedPreviewData} from './preview.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),codex=new CodexAdapter(),deepseek=new DshAdapter();
const adapters=Object.fromEntries(Object.entries({codex,deepseek}).map(([side,adapter])=>[side,{
  quota:()=>adapter.quota(),close:()=>adapter.close?.(),
  async list(){return [];},async projects(){return {projects:[]};},async workspaces(){return [];},
  async snapshot(){return {state:'idle',turns:[],title:'额度只读预览 · '+side};},
  async send(){throw new Error('额度预览禁止发送原生消息');}
}]));
const service=await makeService({dataDir:path.join(root,'data-dev','quota-preview'),adapters});seedPreviewData(service.store);
service.relay.health={codex:{ok:true,state:'idle',title:'额度只读预览 · Codex'},deepseek:{ok:true,state:'idle',title:'额度只读预览 · DeepSeek'}};
await new Promise((resolve,reject)=>{service.server.once('error',reject);service.server.listen(Number(process.env.RELAY_PORT||4329),'127.0.0.1',resolve);});
console.log('额度只读预览：http://127.0.0.1:'+service.server.address().port+'（真实额度查询，模拟会话，不启动投递）');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void service.close().then(()=>process.exit(0)));
