import {readdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {homedir} from 'node:os';
import path from 'node:path';
import {FramedPipe} from '../framed-pipe.mjs';
import {id,sleep,controlText,RelayError} from '../util.mjs';
const textOf=x=>typeof x==='string'?x:x?.text||'';
export function normalizeCodex(history){return (history.turns||[]).map(t=>({id:t.id,status:t.status,error:t.error,inputs:(t.items||[]).filter(i=>i.type==='userMessage'||i.type==='functionCallOutput').map(i=>({id:i.id,text:i.type==='userMessage'?(i.content||[]).map(c=>c.text||'').join(''):textOf(i.output),kind:i.type==='userMessage'?'user':'tool'})),outputs:(t.items||[]).filter(i=>i.type==='agentMessage'&&(i.phase==='final_answer'||i.phase==null)).map(i=>({id:i.id,text:i.text||''}))}));}
export class CodexAdapter{
  constructor(config={}){this.config=config;this.pipe=null;this.catalog=null;this.lastDiscover=0;this.supportsSteer=true;}
  callerThreadId(preferred=this.config.sourceThreadId){
    let db;
    try{
      db=new DatabaseSync(this.config.stateDb||path.join(process.env.CODEX_HOME||path.join(homedir(),'.codex'),'state_5.sqlite'),{readOnly:true});
      if(preferred&&db.prepare('SELECT 1 FROM threads WHERE id=?').get(preferred))return preferred;
      const candidate=db.prepare('SELECT id FROM threads WHERE archived=0 ORDER BY updated_at_ms DESC LIMIT 1').get();
      if(candidate)return candidate.id;
    }catch{}
    finally{db?.close();}
    if(preferred)return preferred;
    throw new RelayError('Codex 没有可用的桌面调用上下文，请先在原应用创建一个会话','context_missing');
  }
  async appConnection(){if(this.pipe&&!this.pipe.socket?.destroyed)return this.pipe;if(this.connecting)return this.connecting;this.connecting=this.openAppConnection();try{return await this.connecting;}finally{this.connecting=null;}}
  async openAppConnection(){let candidates=[];if(this.config.appPipe)candidates.push(this.config.appPipe);try{const names=await readdir('\\\\.\\pipe\\');candidates.push(...names.filter(n=>n.startsWith('codex-app-tools-')).map(n=>'\\\\.\\pipe\\'+n));}catch{}candidates=[...new Set(candidates)];if(!candidates.length)throw new RelayError('找不到 Codex 桌面工具管道，请启动 Codex','offline');if(candidates.length>1&&!this.config.appPipe)throw new RelayError('发现多个 Codex 实例，请在配置中指定 appPipe','ambiguous_instance');for(const path of candidates){const p=new FramedPipe(path);try{await p.connect();const c=await p.request('tools/list',{threadStartKind:'all'});if(!Array.isArray(c.tools))throw new Error('Unsupported catalog');this.pipe=p;this.catalog=c.tools;this.lastDiscover=Date.now();return p;}catch{p.close();}}throw new RelayError('无法连接 Codex 桌面工具管道','offline');}
  async tool(name,args,sourceThreadId){
    const readOnly=['list_projects','list_threads','read_thread','get_usage_limits'].includes(name);let p;
    try{
      p=await this.appConnection();const t=this.catalog.find(t=>t.name===name);
      if(!t)throw new RelayError('当前 Codex 缺少工具 '+name,'protocol');
      const result=await p.request('tools/call',{arguments:args,callerSource:'codex',callId:'relay-'+id(),hostId:'local',namespace:t.namespace,threadId:this.callerThreadId(sourceThreadId||this.config.sourceThreadId),tool:name,turnId:'relay-'+id()},{timeout:60000});
      if(!result?.success){const message=(result?.contentItems||[]).map(i=>i.text||'').join('').slice(0,500)||'Codex 桌面工具失败';
        if(/No Codex thread found|thread not found|thread does not exist/i.test(message))throw new RelayError('绑定的 Codex 会话已删除或不可读取。请在设置中绑定已有会话，或创建新的一对；中转历史仍保留。','missing_session');
        throw new RelayError(message,'tool_error');}
      const texts=(result.contentItems||[]).filter(i=>i.type==='inputText').map(i=>i.text);
      if(texts.length===1){try{return JSON.parse(texts[0]);}catch{return texts[0];}}return texts;
    }catch(e){
      if(e.code==='transport'||e.code==='offline'){this.pipe?.close();this.pipe=null;this.catalog=null;}
      if(e.rpcCode===-32000){e.message='Codex 桌面工具未返回结果（'+name+'）。请检查调用上下文和目标会话是否仍存在。';e.uncertain=!readOnly;}
      throw e;
    }
  }
  async ipc(){const p=new FramedPipe('\\\\.\\pipe\\codex-ipc','ipc');await p.connect();return p;}
  async owner(threadId){const p=await this.ipc();try{const r=await p.request('thread-owner-discovery',{hostId:'local',conversationId:threadId},{version:1,timeout:15000});if(r.resultType==='success')return r.handledByClientId;if(r.error==='no-client-found')return null;throw new RelayError('Codex 会话定位失败：'+r.error,'discovery');}finally{p.close();}}
  async list(){const r=await this.tool('list_threads',{limit:50});return [...(r.pinnedThreads||[]),...(r.threads||[])].filter(t=>t.kind==='codex'&&t.hostId==='local');}
  async projects(){const r=await this.tool('list_projects',{});return r;}
  async quota(){return this.tool('get_usage_limits',{});}
  async create({title,target}){const nonce=id();const r=await this.tool('create_thread',{title,target:target||{type:'projectless',directoryName:'agent-relay'},prompt:controlText(nonce)});if(!r.threadId)throw new RelayError('Codex 会话创建未返回 ID，需人工回查，不自动重试','unknown_creation',true);return {id:r.threadId,controlNonce:nonce};}
  async snapshot(threadId,{knownTurn}={}){let cursor,turns=[],first;for(let page=0;page<12;page++){const r=await this.tool('read_thread',{threadId,hostId:'local',turnLimit:10,includeOutputs:false,maxOutputCharsPerItem:0,...cursor?{cursor}:{}});first||=r;turns.push(...(r.turns||[]));if(!r.page?.hasMore||!r.page.nextCursor||!knownTurn||(r.turns||[]).some(t=>knownTurn(t.id)))break;cursor=r.page.nextCursor;if(page===11)throw new RelayError('Codex 历史积压超出本次读取范围，暂停以避免跳过消息','history_gap');}const raw={...first,turns};return {side:'codex',id:threadId,title:first.thread?.title||threadId,cwd:first.thread?.cwd,state:first.thread?.status?.type==='active'?'running':first.thread?.status?.type||'idle',turns:normalizeCodex(raw),raw};}
  async ensure(threadId){let owner=await this.owner(threadId);if(owner)return owner;const nonce=id();await this.tool('send_message_to_thread',{threadId,hostId:'local',prompt:controlText(nonce)});const start=Date.now();while(Date.now()-start<180000){const s=await this.snapshot(threadId);const turn=s.turns.find(t=>t.inputs.some(i=>i.text.includes(`[relay-control id=${nonce}]`)));if(turn?.status==='completed'){owner=await this.owner(threadId);if(owner)return owner;throw new RelayError('Codex 握手完成但持有者不可用','recovery');}if(turn&&['failed','interrupted','blocked'].includes(turn.status))throw new RelayError('Codex 恢复握手未完成，请检查原生会话','recovery');await sleep(1200);}throw new RelayError('Codex 恢复握手超时，请检查原应用；业务消息尚未发送','recovery_timeout');}
  async follower(owner,method,params,version){
    const p=await this.ipc();try{
      // Route to the discovered owner. A top-level hostId filters this owner
      // out on current desktop builds, although discovery uses hostId locally.
      let r=await p.request(method,params,{version,targetClientId:owner,timeout:30000});
      if(method==='thread-follower-start-turn'&&r.resultType==='error'&&r.error==='request-version-mismatch')r=await p.request(method,params,{version:version===2?3:2,targetClientId:owner,timeout:30000});
      if(r.resultType!=='success'){
        const uncertain=r.resultType!=='error'||/timeout|timed out|outcome.?unknown|transport|connection.*(?:lost|closed)/i.test(String(r.error));
        throw new RelayError('Codex 未确认用户输入：'+r.error,uncertain?'unknown_outcome':'native_reject',uncertain);
      }
      return r.result?.result;
    }finally{p.close();}
  }
  async send(threadId,text,requestId){
    let snap=await this.snapshot(threadId);const active=snap.turns.find(t=>t.status==='inProgress');
    const input=[{type:'text',text,text_elements:[]}];
    const intent={requestId,requestedMode:'steer',observedActiveTurnId:active?.id||null};
    try{
      if(snap.state==='running'||active){
        const owner=await this.owner(threadId);if(!owner)throw new RelayError('Codex 运行中但会话持有者不可用，暂不投递','busy');
        try{
          const r=await this.follower(owner,'thread-follower-steer-turn',{conversationId:threadId,input,clientUserMessageId:requestId,restoreMessage:{request:{threadId,input},context:{inheritThreadSettings:true},cwd:snap.cwd}},1);
          if(!r?.turnId)throw new RelayError('Codex 引导响应缺少轮次 ID，需回查','unknown_outcome',true);
          return {...intent,deliveryMode:'steer',nativeTurnId:r.turnId,acceptedAt:Date.now()};
        }catch(e){
          // Only an explicit inactive-turn rejection proves no input was
          // admitted. Transport/timeout errors must never start another turn.
          if(e.uncertain||e.code!=='native_reject'||!/NoActiveTurn|no active turn|active turn already ended|not being streamed/i.test(e.message))throw e;
          snap=await this.snapshot(threadId);
          if(snap.state==='running'||snap.turns.some(t=>t.status==='inProgress'))throw new RelayError('Codex 轮次已变化，重新读取后再引导','busy');
        }
      }
      const owner=await this.ensure(threadId);
      const r=await this.follower(owner,'thread-follower-start-turn',{conversationId:threadId,turnStart:{request:{threadId,input,clientUserMessageId:requestId},context:{inheritThreadSettings:true}}},2);
      if(!r?.turn?.id)throw new RelayError('Codex 用户输入响应缺少轮次 ID，需回查','unknown_outcome',true);
      return {...intent,deliveryMode:'start',nativeTurnId:r.turn.id,acceptedAt:Date.now()};
    }catch(e){e.receipt={...intent,...e.receipt};throw e;}
  }
  close(){this.pipe?.close();}
}
