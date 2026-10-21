// Isolated UI preview. Never connects to Codex or DeepSeek, and never starts the relay worker.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeService} from '../src/server.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const adapters=Object.fromEntries(['codex','deepseek'].map(side=>[side,{
  async snapshot(id){return {id,title:side==='codex'?'中转台改进 · Codex':'中转台改进 · DeepSeek',state:'idle',turns:[]};},
  async send(){throw new Error('预览服务不会发送原生消息');},
  async list(){return [];},async projects(){return {projects:[]};},async workspaces(){return [];},
}]));
export function seedPreviewData(store){
if(!store.exportHistory().messages.length){
  store.set('codexId','preview-codex');store.set('deepseekId','preview-deepseek');
  store.renameRoom(store.activeRoomId(),'界面设计讨论');
  const first=store.addMessage({sender:'user',text:'中转台改成群聊气泡吧。我的消息在右边，你们在左边，再把不同任务的记录分开。'});
  store.root(first.id,6);
  store.addMessage({sender:'codex',text:'我负责房间和队列隔离。每条投递保存原来的会话，切换话题后也不会把旧消息发到新会话。',replyTo:first.id,rootId:first.id,hop:1});
  store.addMessage({sender:'deepseek',text:'我负责界面：头像、聊天气泡、长文展开和手机布局。左侧的话题列表可以保留每次协作的记录。',replyTo:first.id,rootId:first.id,hop:1,meta:{stop:true}});
  const earlier=store.createRoom({title:'上一次协作',kind:'topic',codexId:'preview-old-c',deepseekId:'preview-old-d'});
  store.addMessage({sender:'user',text:'这份历史记录只属于上一次协作。',roomId:earlier.id});
  store.archiveRoom(earlier.id,true);
  const second=store.addMessage({sender:'user',text:'长回复也别占满屏幕，保留复制和展开就好。'});
  store.root(second.id,6);
  store.addMessage({sender:'deepseek',text:'已整理为以下设计约定：\n\n**聊天布局**\n用户在右侧，两位 Agent 在左侧。每条消息展示头像、名称、时间与投递状态。\n\n**阅读体验**\n长回复默认折叠，可展开全文；复制按钮保留原始文本。\n\n**话题管理**\n每个话题保存独立消息与会话绑定。旧话题可以只读浏览，需要继续时恢复绑定。\n\n**窄屏布局**\n话题列表和协作进度收进抽屉，输入框保持可见。\n\n**键盘操作**\nCtrl + Enter 发送，Enter 正常换行。\n\n**本机运行**\n原生应用继续处理工具与审批，中转台负责消息和队列。',replyTo:second.id,rootId:second.id,hop:1,meta:{stop:true}});
  store.addMessage({sender:'codex',text:'后端隔离测试已通过。可以在左侧切换历史话题，核对记录是否保持独立。',replyTo:second.id,rootId:second.id,hop:1,meta:{stop:true}});
}
if(!store.rooms().some(room=>room.title==='记录整理')){
  const room=store.createRoom({title:'记录整理',kind:'topic',codexId:'preview-codex',deepseekId:'preview-deepseek'});
  const message=store.addMessage({sender:'user',text:'把这一轮协作的决定保存在独立话题里。',roomId:room.id});
  store.root(message.id,6);
  store.addMessage({sender:'codex',text:'已保留独立记录。切换到历史话题只查看记录，继续此话题后才恢复它的会话绑定。',replyTo:message.id,rootId:message.id,hop:1,meta:{stop:true}});
}
}

export async function startPreview({dataDir=path.join(root,'data-preview'),port=4320}={}){
if(path.resolve(dataDir).toLowerCase()===path.join(root,'data').toLowerCase())throw new Error('预览服务禁止使用正式 data/');
const service=await makeService({dataDir,adapters}),{store,relay}=service;
seedPreviewData(store);
relay.health={codex:{ok:true,state:'idle',title:'预览 · Codex'},deepseek:{ok:true,state:'idle',title:'预览 · DeepSeek'}};
await new Promise((resolve,reject)=>{service.server.once('error',reject);service.server.listen(port,'127.0.0.1',resolve);});
console.log(`隔离预览：http://127.0.0.1:${service.server.address().port}（不会向原生会话发送消息）`);
service.server.on('error',error=>{console.error(error.message);process.exitCode=1;void service.close();});
return service;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const service=await startPreview({dataDir:process.env.RELAY_DATA_DIR||path.join(root,'data-preview'),port:Number(process.env.RELAY_PORT||4320)});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void service.close().then(()=>process.exit(0)));
}
