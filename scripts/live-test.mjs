import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {CodexAdapter} from '../src/adapters/codex.mjs';
import {DshAdapter} from '../src/adapters/dsh.mjs';
import {sleep,parseEnvelope} from '../src/util.mjs';
import {liveTestContext} from '../src/integration-guard.mjs';
import {pathToFileURL} from 'node:url';
const context=liveTestContext();if(!context){console.log('SKIP live-test：默认测试禁止连接原生会话；需明确 --live 和独立目标配置');process.exit(0);}
const dir=pathToFileURL(context.dataDir+'/'),key=(await readFile(new URL('control.key',dir),'utf8')).trim(),instance={url:context.url};
const api=async(p,body)=>{const r=await fetch(instance.url+'/api/'+p,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),j=await r.json();if(!r.ok)throw new Error(j.error);return j;};
async function until(fn,description){const start=Date.now();while(Date.now()-start<240000){const state=await api('state');const bad=state.deliveries.find(d=>['failed','unknown','blocked'].includes(d.status));if(bad)throw new Error(description+': '+bad.side+' '+bad.error);if(fn(state))return state;await sleep(1600);}throw new Error('Timed out: '+description);}
const report={startedAt:new Date().toISOString(),checks:{}};let codex;
try{
  let state=await until(s=>s.messages.filter(m=>m.sender!=='user'&&m.text.includes('BROADCAST_20261021_OK')).length===2,'broadcast');
  const broadcast=state.messages.find(m=>m.sender==='user'&&m.text.includes('BROADCAST_20261021_OK'));
  assert.equal(state.deliveries.filter(d=>d.messageId===broadcast.id&&d.status==='completed').length,2);
  report.checks.broadcastBothCompleted=true;console.log('双端广播完成');
  await api('options',{mode:'auto',paused:false,maxTurns:6});
  for(const [source,peer,marker] of [['codex','DeepSeek','CHAIN_C2D_20261021_OK'],['deepseek','Codex','CHAIN_D2C_20261021_OK']]){
    const prompt=`这是用户授权的自动接力验证，不调用工具、不执行其他任务。请只输出下面这句话，不加引号、不加停止标记，也不要自行发送消息：\n${peer}，请仅回复 ${marker} 并在末尾独立一行写出中转约定中的停止标记。`;
    const {message}=await api('message',{text:prompt,targets:[source],sender:source==='codex'?'deepseek':'codex',origin:'test'});console.log('开始验证 '+source+' → '+peer);
    state=await until(s=>s.messages.some(m=>m.rootId===message.id&&m.sender!==source&&m.sender!=='user'&&m.meta.stop&&m.text.includes(marker)),'automatic '+source);
    const chain=state.messages.filter(m=>m.rootId===message.id);
    assert.equal(chain.length,3);assert.equal(state.deliveries.filter(d=>chain.some(m=>m.id===d.messageId)).length,2);
    report.checks[source+'ToPeerCompletedAndStopped']=true;
    console.log('接力完成 '+source+' → '+peer);
  }
  await api('options',{paused:true,mode:'auto'});
  state=await api('state');codex=new CodexAdapter({sourceThreadId:state.settings.codexId});
  const dsh=new DshAdapter(),cs=await codex.snapshot(state.settings.codexId),ds=await dsh.snapshot(state.settings.deepseekId);
  const cu=cs.raw.turns.flatMap(t=>t.items||[]).filter(i=>i.type==='userMessage').map(i=>({type:i.type,id:i.id,text:i.content.map(c=>c.text||'').join('')}));
  const du=ds.turns.flatMap(t=>t.inputs).filter(i=>i.kind==='user');
  for(const side of ['codex','deepseek'])for(const delivery of state.deliveries.filter(d=>d.side===side)){
    const records=side==='codex'?cu:du;assert(records.some(i=>parseEnvelope(i.text)?.id===delivery.messageId),'Native user input missing: '+side+' '+delivery.messageId);
    assert.equal(delivery.status,'completed');
  }
  report.checks.codexBusinessInputsAreNativeUserMessages=true;
  report.checks.dshBusinessInputsHaveUserSource=true;
  report.checks.noControlTrafficForwarded=state.messages.every(m=>!m.text.includes('[relay-control id='));
  report.channels=state.settings;report.nativeInputCounts={codex:cu.length,deepseek:du.length};report.messageCount=state.messages.length;report.deliveryCount=state.deliveries.length;report.ok=true;
}catch(e){report.ok=false;report.error=e.message;try{await api('options',{paused:true});}catch{}process.exitCode=1;console.error(e.message);}
finally{codex?.close();report.finishedAt=new Date().toISOString();await writeFile(new URL('live-test-report.json',dir),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
