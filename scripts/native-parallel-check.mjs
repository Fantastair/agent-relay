// Opt-in, dedicated-session acceptance test. Never creates native sessions,
// touches production 4319, or retries an ambiguous message admission.
import {readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {liveTestContext} from '../src/integration-guard.mjs';
import {sleep} from '../src/util.mjs';

const context=liveTestContext();
if(!context){console.log('SKIP native-parallel-check: requires explicit --live and dedicated test configuration');process.exit(0);}
if(new URL(context.url).port==='4319')throw new Error('Native parallel acceptance never targets production 4319');
const side=process.env.RELAY_TEST_AGENT,roomIds=(process.env.RELAY_TEST_ROOM_IDS||'').split(',').map(v=>v.trim()).filter(Boolean);
if(!['codex','deepseek'].includes(side)||roomIds.length!==2||new Set(roomIds).size!==2)throw new Error('Set RELAY_TEST_AGENT to your own side and RELAY_TEST_ROOM_IDS to two dedicated topic UUIDs');
const target=side==='codex'?'deepseek':'codex',key=(await readFile(path.join(context.dataDir,'control.key'),'utf8')).trim();
const api=async(route,body)=>{
  const response=await fetch(context.url+'/api/'+route,{method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'HTTP '+response.status);return data;
};
const state=await api('state'),rooms=roomIds.map(roomId=>state.rooms.find(room=>room.id===roomId));
if(rooms.some(room=>!room||room.archived||!room.codexId||!room.deepseekId||!/^并行验收|^parallel-test /i.test(room.title)))throw new Error('Both topics must be non-archived, fully bound, and explicitly named 并行验收… or parallel-test …');
if(rooms.some(room=>room.sharedWith?.length)||rooms[0].codexId===rooms[1].codexId||rooms[0].deepseekId===rooms[1].deepseekId)throw new Error('Acceptance requires two independent pairs with no shared native session');
for(const room of rooms){const current=await api('state?roomId='+encodeURIComponent(room.id));if(current.deliveries.some(d=>!['completed','cancelled'].includes(d.status)))throw new Error('Dedicated test topics must have no unresolved deliveries');}
if(state.rooms.some(room=>!roomIds.includes(room.id)&&room.queueLength))throw new Error('The isolated service contains unrelated pending work');
const report={startedAt:new Date().toISOString(),side,target,roomIds,checks:{},admissions:[],maxConfirmedConcurrent:0,ok:false};
const reportFile=path.join(context.dataDir,'native-parallel-'+side+'.json');
let reportWrites=Promise.resolve();
const save=()=>{
  const snapshot=JSON.stringify(report,null,2);
  reportWrites=reportWrites.then(async()=>{await writeFile(reportFile+'.tmp',snapshot);await rename(reportFile+'.tmp',reportFile);});
  return reportWrites;
};
try{
  for(const room of rooms)await api('options',{roomId:room.id,paused:false,mode:'manual',maxTurns:2});
  await api('scheduler',{limit:Math.max(state.concurrency.limit,2),pausedAll:false});
  await Promise.all(rooms.map(async room=>{
    const marker='PARALLEL_'+target.toUpperCase()+'_'+randomUUID(),clientMessageId='native-check-'+randomUUID();
    const admission={roomId:room.id,marker,clientMessageId,status:'pending'};report.admissions.push(admission);await save();
    const text='这是专用测试话题中的中转台原生并发验收。请勿读取、修改任何项目文件，不执行其他任务。请使用无副作用的等待方式等待15秒（可使用等待工具或仅等待的命令），然后只回复以下两行：\n'+marker+'\n[relay-stop]';
    const result=await api('message',{roomId:room.id,sender:side,origin:'test',targets:[target],text,clientMessageId});
    admission.messageId=result.message.id;admission.status='accepted';await save();
  }));
  const deadline=Date.now()+240000;let lastProgress=0;
  while(Date.now()<deadline){
    const views=await Promise.all(roomIds.map(roomId=>api('state?roomId='+encodeURIComponent(roomId))));
    let concurrent=0,completed=0;
    for(let index=0;index<views.length;index++){
      const view=views[index],admission=report.admissions.find(a=>a.roomId===roomIds[index]),delivery=view.deliveries.find(d=>d.messageId===admission.messageId&&d.side===target);
      if(delivery&&['unknown','failed','blocked'].includes(delivery.status))throw new Error(target+' admission needs inspection: '+delivery.status+' '+(delivery.error||''));
      if(delivery?.status==='running'&&view.room.health[target]?.hasInProgressTurn)concurrent++;
      const reply=view.messages.find(message=>message.replyTo===admission.messageId&&message.sender===target&&message.text.includes(admission.marker));
      if(reply&&delivery?.status==='completed'){completed++;admission.nativeTurnId=delivery.receipt?.nativeTurnId;admission.replyId=reply.id;}
    }
    report.maxConfirmedConcurrent=Math.max(report.maxConfirmedConcurrent,concurrent);
    if(Date.now()-lastProgress>5000){console.log(JSON.stringify({target,concurrent,completed}));lastProgress=Date.now();await save();}
    if(completed===2){
      if(report.maxConfirmedConcurrent<2)throw new Error('Both tasks completed but overlapping native inProgress turns were not observed');
      report.checks.overlappingNativeTurns=true;report.checks.correctReplyOwnership=true;report.ok=true;break;
    }
    await sleep(700);
  }
  if(!report.ok)throw new Error('Timed out; inspect the dedicated native sessions before any retry');
}catch(error){report.error=String(error.message||error);process.exitCode=1;}
finally{
  for(const room of rooms)try{await api('options',{roomId:room.id,paused:report.ok?room.paused:true,mode:room.mode,maxTurns:room.maxTurns});}catch{}
  try{await api('scheduler',{limit:state.concurrency.limit,pausedAll:report.ok?state.concurrency.pausedAll:true});}catch{}
  report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify(report,null,2));
}
