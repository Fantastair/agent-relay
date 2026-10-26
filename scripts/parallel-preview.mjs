// Mock-only scheduler preview: no native sessions, messages or quota calls.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {makeService} from '../src/server.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),sessions=new Map();
const adapters=Object.fromEntries(['codex','deepseek'].map(side=>[side,{
  async snapshot(sessionId){const turns=sessions.get(sessionId)||[];for(const turn of turns)if(turn.status==='inProgress'&&Date.now()>=turn.finishAt){turn.status='completed';turn.outputs=[{id:turn.id+'-out',text:'模拟 '+side+' 已完成：'+sessionId+'\n[relay-stop]'}];}return {id:sessionId,title:'模拟 '+sessionId,state:turns.some(t=>t.status==='inProgress')?'running':'idle',turns};},
  async send(sessionId,text,requestId){const turns=sessions.get(sessionId)||[];turns.push({id:requestId,status:'inProgress',inputs:[{id:requestId+'-in',kind:'user',text,requestId}],outputs:[],finishAt:Date.now()+12000});sessions.set(sessionId,turns);return {nativeTurnId:requestId,requestId};},
  async list(){return [];},async projects(){return {projects:[]};},async workspaces(){return [];},
}]));
const service=await makeService({dataDir:path.join(root,'data-dev','parallel-preview'),adapters});
if(!service.store.get('parallelPreviewSeeded',false)){
  const names=['独立话题 A','独立话题 B','独立话题 C','历史冲突（需换绑）','暂停话题','归档话题'];
  for(let i=0;i<names.length;i++){
    const binding={codexId:'mock-c-'+(i===3?0:i),deepseekId:'mock-d-'+i,workspaceId:'mock-workspace'};
    // The duplicate is an intentional pre-upgrade fixture, not a binding API path.
    const room=i===0?service.store.room(service.store.activeRoomId()):service.store.createRoom({title:names[i],...binding});
    service.store.renameRoom(room.id,names[i]);if(i===0)service.store.bindRoom(room.id,binding);
    service.store.writeRoomOptions(room.id,{paused:i===4,mode:'auto',maxTurns:6});
    if(i===5)service.store.archiveRoom(room.id,true);else if(!service.store.bindingConflicts(room.id).length)service.relay.sendUser('隔离预览任务 '+names[i],undefined,room.id);
  }
  service.store.set('parallelPreviewSeeded',true);
}
service.relay.setScheduler({limit:2,pausedAll:true});
await new Promise((resolve,reject)=>{service.server.once('error',reject);service.server.listen(4332,'127.0.0.1',resolve);});
service.relay.start();await writeFile(path.join(service.dataDir,'fixtures.json'),JSON.stringify({url:'http://127.0.0.1:4332',mockOnly:true,rooms:service.store.rooms()},null,2));
console.log('多话题并行预览 http://127.0.0.1:4332 — 全模拟；先解除总暂停观察并行/排队。');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void service.close().then(()=>process.exit(0)));
