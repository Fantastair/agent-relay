import {envelope,parseEnvelope,parseBatchEnvelope,isNativeTurnId} from './util.mjs';

const statuses=['queued','sending','running','unknown','completed','cancelled','failed','blocked'];
const terminal=s=>['completed','failed','interrupted','blocked'].includes(s);
const sameText=(a,b)=>a.replace(/\r\n/g,'\n')===b.replace(/\r\n/g,'\n');

export function deliverySnapshotTargets(store,side,sessionId){
  const targets=new Map();
  for(const d of store.jobs(side,statuses)){
    if(d.sessionId!==sessionId)continue;
    const invalid=d.receipt?.nativeTurnId!=null&&!isNativeTurnId(d.receipt.nativeTurnId);
    if(!invalid&&!['sending','running','unknown'].includes(d.status))continue;
    const requestId=d.batchId||d.id;targets.set(requestId,{requestId,nativeTurnId:isNativeTurnId(d.receipt?.nativeTurnId)?d.receipt.nativeTurnId:null,...(Number.isFinite(d.receipt?.beforeSeq)?{beforeSeq:d.receipt.beforeSeq}:{})});
  }
  return [...targets.values()];
}

export function reconcileMissingReceipts(relay,side,sessionId,snapshot){
  const missing=new Set(snapshot.unresolvedRequestIds||[]),units=new Set();
  for(const d of relay.store.jobs(side,statuses)){
    if(d.sessionId!==sessionId)continue;
    const key=d.batchId||d.id;if(units.has(key))continue;units.add(key);
    const old=d.receipt,invalid=old?.nativeTurnId!=null&&!isNativeTurnId(old.nativeTurnId);
    const age=Date.now()-(old?.acceptedAt??d.updatedAt);
    const unresolved=missing.has(key)&&(snapshot.historyIncomplete||age>=30000||(snapshot.state!=='running'&&age>=2500));
    if(!invalid&&!unresolved)continue;
    const receipt=invalid?{...old,nativeTurnId:null,deliveryMode:null}:old;
    // A manually handled or already completed item is never reopened.
    const status=['sending','running','unknown'].includes(d.status)?'unknown':d.status;
    relay.updateUnit(d,status,{receipt,error:status==='unknown'?'原生轮次暂未归属，正在按请求 ID 回查；不会自动重发':d.error});
  }
}

// A native turn may now contain several independent admissions. Never infer
// membership by splitting a message body or by an intended destination alone.
export function reconcileTurn(relay,side,sessionId,turn,roomId){
  if(!isNativeTurnId(turn.id))return {members:[],delivery:null,batch:null,pending:true};
  // Parallel engines expose a room-scoped jobs() view. The standalone engine
  // also reconciles historical bindings; its exact saved identity owns the room.
  const store=relay.store,candidates=store.jobs(side,statuses).filter(d=>d.sessionId===sessionId);
  const linked=new Map(),add=d=>{if(d&&d.status!=='queued'&&(!isNativeTurnId(d.receipt?.nativeTurnId)||d.receipt.nativeTurnId===turn.id))linked.set(d.id,d);};
  for(const input of turn.inputs){
    const header=parseBatchEnvelope(input.text),single=parseEnvelope(input.text);
    if(header?.side===side){
      const batch=store.batch(header.id);
      if(batch?.side===side&&batch.sessionId===sessionId&&candidates.some(d=>d.batchId===batch.id)&&batch.deliveryIds.length===header.count&&sameText(batch.payload,input.text))for(const d of store.batchDeliveries(batch.id))add(d);
    }
    if(single){
      const d=candidates.find(d=>d.messageId===single.id&&!d.batchId),m=d&&store.message(d.messageId);
      if(m&&single.sender===m.sender&&(sameText(envelope(m),input.text)||sameText(envelope(m,{compact:true}),input.text)))add(d);
    }
    if(input.requestId)for(const d of candidates)if(input.requestId===(d.batchId||d.id)&&(!Number.isFinite(d.receipt?.beforeSeq)||!/^\d+$/.test(input.id)||Number(input.id)>d.receipt.beforeSeq))add(d);
  }
  for(const d of candidates)if(d.receipt?.nativeTurnId===turn.id)add(d);
  const members=candidates.filter(d=>linked.has(d.id));
  {
    const units=new Set();
    for(const d of members){
      const key=d.batchId||d.id;if(units.has(key))continue;units.add(key);
      const old=d.receipt||{},receipt={...old,requestId:key,nativeTurnId:turn.id,acceptedAt:old.acceptedAt??Date.now(),deliveryMode:old.deliveryMode||(old.requestedMode==='steer'&&old.observedActiveTurnId===turn.id?'steer':'start'),...(d.batchId?{batchId:d.batchId}:{})};
      const status=['completed','cancelled'].includes(d.status)?d.status:terminal(turn.status)?turn.status==='completed'?'completed':turn.status==='blocked'?'blocked':'failed':'running';
      const error=status==='failed'||status==='blocked'?`原生轮次 ${turn.status}${turn.reason?'：'+turn.reason:''}`:status==='cancelled'?d.error:null;
      if(d.status!==status||d.error!==error||JSON.stringify(d.receipt)!==JSON.stringify(receipt))relay.updateUnit(d,status,{receipt,error});
    }
  }
  // A stale final snapshot can arrive while an acknowledged steer is not yet
  // visible. Keep the final pending rather than forwarding an incomplete reply.
  const pending=candidates.some(d=>!linked.has(d.id)&&['sending','running','unknown'].includes(d.status)&&d.receipt?.requestedMode==='steer'&&!d.receipt.nativeTurnId&&d.receipt.observedActiveTurnId===turn.id);
  const delivery=members.at(-1),batch=delivery?.batchId&&members.every(d=>d.batchId===delivery.batchId)?store.batch(delivery.batchId):null;
  return {members:members.map(d=>store.delivery(d.id)),delivery:delivery&&store.delivery(delivery.id),batch,pending};
}
