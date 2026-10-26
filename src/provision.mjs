import {id,sleep,safeError,RelayError} from './util.mjs';

// Explicit creation starts a new pair. Existing bindings change only after both sides are ready.
export async function provisionNewPair({store,codex,deepseek,workspaceId,defaultWorkspacePath,title,roomId}){
  if(title!==undefined&&(typeof title!=='string'||!title.trim()||title.trim().length>80))throw new RelayError('话题名称需要 1 到 80 个字符','input');
  const spaces=await deepseek.workspaces();
  if(workspaceId&&!spaces.some(w=>w.workspaceId===workspaceId))throw new RelayError('指定的工作区不存在','input');
  const workspace=spaces.find(w=>w.workspaceId===workspaceId)||spaces.find(w=>w.path.toLowerCase()===defaultWorkspacePath.toLowerCase())||spaces[0];
  if(!workspace)throw new RelayError('请先在 DSH 添加工作区','config');
  const draft={id:id(),startedAt:Date.now(),workspaceId:workspace.workspaceId,workspace:workspace.path,codexId:null,deepseekId:null,status:'creating'};
  store.set('provisionDraft',draft);
  try{
    const projects=await codex.projects();
    const project=(projects.projects||[]).find(p=>p.path?.toLowerCase()===workspace.path.toLowerCase()&&p.hostId==='local');
    const created=await codex.create({title:'中转会话 Codex',target:project?{type:'project',projectId:project.projectId,environment:{type:'local'}}:undefined});
    draft.codexId=created.id;store.set('provisionDraft',draft);
    let ready;const start=Date.now();
    do{ready=await codex.snapshot(created.id);if(ready.state!=='running')break;await sleep(1200);}while(Date.now()-start<180000);
    if(ready.state==='running'||ready.turns.some(t=>['failed','interrupted','blocked'].includes(t.status)))throw new RelayError('Codex 初始化未完成，请检查新建的原生会话；原绑定保持不变','initializing');
    const ds=await deepseek.create({workspaceId:workspace.workspaceId,title:'中转会话 DeepSeek',onCreated:sessionId=>{draft.deepseekId=sessionId;store.set('provisionDraft',draft);}});
    draft.deepseekId=ds.id;store.set('provisionDraft',draft);
    await deepseek.verifyWorkspace(ds.id,workspace.workspaceId);
    const dsReady=await deepseek.snapshot(ds.id);
    if(dsReady.state==='running')throw new RelayError('新建的 DeepSeek 会话正在运行，请在原应用检查；原绑定保持不变','initializing');
    draft.status='ready';draft.finishedAt=Date.now();
    store.transaction(()=>{
      if(roomId){store.bindRoom(roomId,{codexId:created.id,deepseekId:ds.id,workspaceId:workspace.workspaceId});store.patchRoomOptions(roomId,{paused:true,protocolReady:{},imageCapabilities:{}});if(title)store.renameRoom(roomId,title.trim());}
      else{const room=store.createRoom({title:title?.trim()||'本地协作',codexId:created.id,deepseekId:ds.id,workspaceId:workspace.workspaceId});store.activateRoom(room.id);}
      store.set('channelHistory',[...store.get('channelHistory',[]),draft]);store.set('provisionDraft',null);
      for(const [side,snapshot] of [['codex',ready],['deepseek',dsReady]])for(const t of snapshot.turns)if(['completed','failed','interrupted','blocked'].includes(t.status))store.markSeen(side,snapshot.id||draft[side==='codex'?'codexId':'deepseekId'],'turn:'+t.id);
      store.log('setup',`已新建并连接一对会话：Codex ${created.id}；DeepSeek ${ds.id}。后续消息使用新会话，旧中转记录保留。`);
    });
    return {codexId:created.id,deepseekId:ds.id,workspace:workspace.path,roomId:roomId||store.activeRoomId(),room:store.room(roomId||store.activeRoomId())};
  }catch(e){draft.status='failed';draft.error=safeError(e);store.set('provisionDraft',draft);store.log('setup','新会话创建未完成，原绑定保持不变。'+draft.error);throw e;}
}
