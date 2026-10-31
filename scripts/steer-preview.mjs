// Mock-only UI acceptance. Never reads native credentials or production data.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {makeService} from '../src/server.mjs';
import {RelayError} from '../src/util.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),sessions=new Map();
const adapters=Object.fromEntries(['codex','deepseek'].map(side=>[side,{
  supportsSteer:true,
  async snapshot(sessionId){const turns=sessions.get(sessionId)||[];return {title:'模拟 '+sessionId,state:turns.some(t=>t.status==='inProgress')?'running':'idle',turns};},
  async send(sessionId,text,requestId){
    if(sessionId.endsWith('-unknown'))throw new RelayError('模拟回执丢失：只回查，不重发','timeout',true);
    if(sessionId.endsWith('-pending'))return {requestId,nativeTurnId:null,deliveryMode:null,acceptedAt:Date.now()};
    const turns=sessions.get(sessionId)||[];let turn=turns.find(t=>t.status==='inProgress'),deliveryMode=turn?'steer':'start';
    if(!turn){turn={id:randomUUID(),status:'inProgress',inputs:[],outputs:[]};turns.unshift(turn);sessions.set(sessionId,turns);}
    turn.inputs.push({id:requestId,requestId,kind:'user',text});
    return {requestId,nativeTurnId:turn.id,deliveryMode,acceptedAt:Date.now()};
  },
  async list(){return [];},async projects(){return {projects:[]};},async workspaces(){return [];},
}]));
const previewName=process.env.RELAY_STEER_PREVIEW_NAME||'steer-preview';
if(!/^[a-zA-Z0-9_-]+$/.test(previewName))throw new Error('Preview name must be a single safe directory name');
const service=await makeService({dataDir:path.join(root,'data-dev',previewName),adapters});
const seeded=service.store.get('steerPreviewSeeded',false);
if(seeded)throw new Error('Preview data already exists; use its running instance or explicitly choose a fresh isolated data directory');
const fixtures=[];service.relay.setScheduler({limit:6,pausedAll:false});
for(const [i,title] of ['实时引导（同轮三条补充）','已完成引导（回复关联四条）','回执待回查','已暂停话题','图片轮次待确认'].entries()){
  const suffix=i===2?'unknown':i===4?'pending':String(i),binding={codexId:'mock-c-'+suffix,deepseekId:'mock-d-'+suffix};
  const room=i===0?service.store.room(service.store.activeRoomId()):service.store.createRoom({title,...binding});
  if(i===0)service.store.bindRoom(room.id,binding);service.store.renameRoom(room.id,title);service.store.patchRoomOptions(room.id,{paused:false,mode:'auto',maxTurns:20});
  const messages=[];
  for(let n=0;n<(i<2?4:1);n++){const m=service.relay.sendUser(n===0?'模拟原始任务':'模拟轮内补充 '+n,['codex'],room.id);messages.push(m.id);await service.relay.tick('codex');}
  if(i===1){const t=sessions.get(binding.codexId)[0];t.status='completed';t.outputs=[{id:randomUUID(),text:'这条最终回复关联原始任务与三条补充。\n[relay-stop]'}];await service.relay.tick('codex');}
  if(i===3)service.relay.setOptions({roomId:room.id,paused:true});
  fixtures.push({roomId:room.id,title,messageIds:messages});
}
service.store.set('steerPreviewSeeded',true);
await new Promise((resolve,reject)=>{service.server.once('error',reject);service.server.listen(4335,'127.0.0.1',resolve);});
service.relay.start();
await writeFile(path.join(service.dataDir,'fixtures.json'),JSON.stringify({url:'http://127.0.0.1:4335',mockOnly:true,rooms:fixtures},null,2));
console.log('引导投递隔离预览 http://127.0.0.1:4335 — 全模拟，不连接原生会话');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void service.close().then(()=>process.exit(0)));
