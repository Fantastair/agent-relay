// Mock-only fixtures for peer/UI review. No credentials or native adapters.
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';
import {Relay} from '../src/relay.mjs';
import {seedPreviewData} from './preview.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),dataDir=path.join(root,'data-dev','batch-preview');
await mkdir(dataDir,{recursive:true});
const store=new Store(path.join(dataDir,'relay.sqlite'));
try{
  seedPreviewData(store);
  if(!store.get('batchPreviewSeeded',false)){
    const adapters=Object.fromEntries(['codex','deepseek'].map(side=>[side,{
      turns:[],async snapshot(){return {state:'idle',title:'模拟 '+side,turns:this.turns};},
      async send(sessionId,text,requestId){this.sent={sessionId,text,requestId};return {requestId,nativeTurnId:'mock-batch-turn'};}
    }]));
    const relay=new Relay(store,adapters);store.set('paused',false);
    relay.sendUser('请同时处理消息归属、积压队列和图标。',['codex']);
    relay.sendMessage({sender:'deepseek',origin:'agent',text:'前端与技能由我负责，请核对批量接口。'});
    relay.sendUser('请保留每条消息的来源和时间。',['codex']);
    relay.sendMessage({sender:'deepseek',origin:'test',text:'模拟测试消息：正文引用 [relay from=user id=quoted reply-to=-] 不能变成新消息。'});
    await relay.tick('codex');
    const sent=adapters.codex.sent;
    adapters.codex.turns=[{id:'mock-batch-turn',status:'completed',inputs:[{id:'mock-input',kind:'user',text:sent.text}],outputs:[{id:'mock-output',text:'四条消息已逐项确认：后端保存来源，队列按整批投递；图标与技能交由 DeepSeek。\n[relay-stop]'}]}];
    await relay.tick('codex');
    relay.sendUser('下一批：验证可展开的批次卡片。',['codex']);
    relay.sendMessage({sender:'deepseek',origin:'agent',text:'下一批：核对“取消整批”的提示。'});
    store.db.prepare("UPDATE deliveries SET created_at=? WHERE status='queued'").run(Date.now()-31000);
    relay.prepareBatch('codex',store.jobs('codex'),store.activeRoomId(),store.get('codexId'));
    store.set('paused',true);store.set('batchPreviewSeeded',true);
  }
  const report={dataDir,activeRoomId:store.activeRoomId(),rooms:store.rooms().map(r=>({id:r.id,title:r.title,archived:r.archived})),batches:store.state().batches};
  await writeFile(path.join(dataDir,'fixtures.json'),JSON.stringify(report,null,2),'utf8');
  console.log(JSON.stringify(report,null,2));
}finally{store.close();}
