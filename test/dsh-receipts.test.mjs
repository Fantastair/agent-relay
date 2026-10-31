import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DshAdapter,normalizeDsh} from '../src/adapters/dsh.mjs';
import {Store} from '../src/store.mjs';
import {Relay} from '../src/relay.mjs';
import {envelope,batchEnvelope,id} from '../src/util.mjs';
import {deliverySnapshotTargets} from '../src/turn-deliveries.mjs';

const event=(seq,type,data)=>({event:{seq,type,data}});
const input=(seq,requestId,text='message')=>event(seq,'user/message',{source:{kind:'user',rpcId:requestId},content:[{type:'text',text}]});
const output=(seq,turn,text='done\n[relay-stop]')=>event(seq,'assistant/message',{turn,message:{id:'out-'+seq,content:[{type:'text',text}]}});
function adapter(pages,{running=false,throughSeq=1000}={}){
  const a=new DshAdapter(),calls=[];a.list=async()=>[{sessionId:'d',running,projections:{asOfSeq:throughSeq,values:{title:'test'}}}];
  a.page=async(sid,row)=>{calls.push(row.projections.asOfSeq);return pages[Math.min(calls.length-1,pages.length-1)];};return {a,calls};
}
function harness(file=':memory:'){
  const store=new Store(file);store.set('codexId','c');store.set('deepseekId','d');store.set('paused',true);
  const adapters={codex:{},deepseek:{supportsSteer:true,sent:[],async send(...args){this.sent.push(args);throw Error('No native sends in receipt recovery');},async snapshot(){return {state:'idle',turns:[]};}}};
  const relay=new Relay(store,adapters),m=relay.sendUser('original',['deepseek']),d=store.forMessage(m.id,'deepseek');
  return {store,relay,adapters,m,d};
}
const nativeTurn=(h,status='completed',turnId='6')=>({id:turnId,status,inputs:[{id:'431',kind:'user',requestId:h.d.id,text:envelope(h.m)}],outputs:status==='completed'?[{id:'out',text:'done\n[relay-stop]'}]:[]});

test('a page-head user input is not assigned a placeholder or guessed from the next assistant turn',()=>{
  const t=normalizeDsh([input(431,'old'),event(432,'user/message',{source:{kind:'time-context'},text:'time'}),output(434,6),event(597,'turn/end',{turn:6,reason:{kind:'completed'}})]);
  assert.equal(t.length,1);assert.equal(t[0].id,'6');assert.equal(t[0].partial,true);assert.deepEqual(t[0].inputs,[]);assert.equal(t[0].status,'completed');
  assert.deepEqual(normalizeDsh([input(431,'orphan')]),[]);
});

test('user messages after an explicit end are not attached to the old turn or guessed into the new one',()=>{
  const t=normalizeDsh([event(1,'turn/start',{turn:6}),output(2,6),event(3,'turn/end',{turn:6,reason:'completed'}),input(4,'orphan'),event(5,'turn/start',{turn:7}),input(6,'real'),output(7,7)]);
  assert.deepEqual(t.map(t=>t.inputs.map(i=>i.requestId)),[[],['real']]);
});

test('receipt targets force older pages even when the newest page contains an already-seen turn',async()=>{
  const {a,calls}=adapter([
    {hasMore:true,records:[input(431,'old'),output(434,6),event(597,'turn/end',{turn:6,reason:'completed'}),event(600,'turn/start',{turn:7}),input(602,'latest'),output(604,7),event(605,'turn/end',{turn:7,reason:'completed'})]},
    {hasMore:false,records:[event(428,'turn/start',{turn:6}),event(430,'step/start',{turn:6})]},
  ]);
  const s=await a.snapshot('d',{knownTurn:tid=>tid==='7',receiptTargets:[{requestId:'old',nativeTurnId:null}]});
  assert.deepEqual(calls,[1000,430]);assert.deepEqual(s.unresolvedRequestIds,[]);
  assert.equal(s.turns.find(t=>t.id==='6').inputs[0].requestId,'old');assert.equal(s.turns.find(t=>t.id==='6').partial,false);
});

test('empty, malformed, repeated and exhausted page boundaries report missing ownership without guessing',async()=>{
  for(const pages of [
    [{hasMore:true,records:[]}],
    [{hasMore:true,records:[input(NaN,'missing')]}],
    [{hasMore:true,records:[output(90,7)]},{hasMore:true,records:[output(90,7)]}],
    Array.from({length:12},(_,i)=>({hasMore:true,records:[output(900-i*10,7)]})),
  ]){
    const {a}=adapter(pages);const s=await a.snapshot('d',{knownTurn:()=>false,receiptTargets:[{requestId:'missing'}]});
    assert.equal(s.historyIncomplete,true);assert.deepEqual(s.unresolvedRequestIds,['missing']);assert(s.turns.every(t=>t.id!=='unscoped'));
  }
});

test('a request not yet spliced into a busy turn does not scan history older than its admission watermark',async()=>{
  const {a,calls}=adapter([{hasMore:true,records:[event(40,'turn/start',{turn:2}),output(60,2)]}],{running:true});
  const s=await a.snapshot('d',{knownTurn:()=>true,receiptTargets:[{requestId:'pending',beforeSeq:50}]});
  assert.equal(calls.length,1);assert.deepEqual(s.unresolvedRequestIds,['pending']);assert.equal(s.historyIncomplete,false);
});

test('completed and cancelled records cannot regress through storage or late active snapshots',()=>{
  for(const status of ['completed','cancelled']){
    const h=harness();try{
      h.store.updateDelivery(h.d.id,status,{receipt:{requestId:h.d.id,nativeTurnId:'6',acceptedAt:1}});
      for(const next of ['sending','running','unknown','queued','failed'])h.store.updateDelivery(h.d.id,next,{receipt:{nativeTurnId:'unscoped'}});
      h.relay.ingest('deepseek','d',{state:'running',turns:[nativeTurn(h,'inProgress')]});
      assert.equal(h.store.delivery(h.d.id).status,status);assert.equal(h.store.delivery(h.d.id).nativeTurnId,'6');
      h.store.updateDelivery(h.d.id,status,{receipt:{nativeTurnId:'unscoped'}});assert.equal(h.store.delivery(h.d.id).nativeTurnId,'6');
    }finally{h.store.close();}
  }
});

test('placeholder and blank native turn IDs are never written in new delivery or batch receipts',()=>{
  const h=harness();try{
    for(const invalid of ['unscoped','',' ',null]){h.store.updateDelivery(h.d.id,'unknown',{receipt:{nativeTurnId:invalid,deliveryMode:'start'}});assert.equal(h.store.delivery(h.d.id).receipt.nativeTurnId,null);}
    h.store.updateDelivery(h.d.id,'queued',{receipt:null});
    const m=h.relay.sendUser('second',['deepseek']),other=h.store.forMessage(m.id,'deepseek'),batchId=id();
    h.store.createBatch({id:batchId,deliveryIds:[h.d.id,other.id],payload:batchEnvelope({id:batchId,side:'deepseek'},[h.m,m])});
    h.store.updateBatch(batchId,'completed',{receipt:{nativeTurnId:'unscoped'}});assert.equal(h.store.batch(batchId).receipt.nativeTurnId,null);
    h.store.updateBatch(batchId,'running');assert.equal(h.store.batch(batchId).status,'completed');assert(h.store.batchDeliveries(batchId).every(d=>d.status==='completed'));
  }finally{h.store.close();}
});

test('placeholder snapshots cannot reopen, regroup or complete any real delivery',()=>{
  const h=harness();try{
    h.store.updateDelivery(h.d.id,'running',{receipt:{requestId:h.d.id,nativeTurnId:'6'}});
    h.relay.ingest('deepseek','d',{state:'running',turns:[nativeTurn(h,'inProgress','unscoped')]});
    assert.equal(h.store.delivery(h.d.id).nativeTurnId,'6');assert.equal(h.store.state().messages.length,1);
  }finally{h.store.close();}
});

test('legacy placeholder receipts recover exact native identities without reopening cleared records, including restart',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'dsh-receipt-'));let store;
  try{
    const h=harness(path.join(dir,'relay.sqlite'));store=h.store;
    store.updateDelivery(h.d.id,'cancelled');store.db.prepare('UPDATE deliveries SET receipt=? WHERE id=?').run(JSON.stringify({requestId:h.d.id,nativeTurnId:'unscoped',acceptedAt:1}),h.d.id);
    store.markSeen('deepseek','d','turn:6');
    assert.deepEqual(deliverySnapshotTargets(store,'deepseek','d'),[{requestId:h.d.id,nativeTurnId:null}]);
    h.relay.ingest('deepseek','d',{state:'idle',turns:[nativeTurn(h)]});
    assert.equal(store.delivery(h.d.id).status,'cancelled');assert.equal(store.delivery(h.d.id).nativeTurnId,'6');assert.equal(store.state().messages.length,1);
    store.close();store=new Store(path.join(dir,'relay.sqlite'));
    new Relay(store,h.adapters).ingest('deepseek','d',{state:'running',turns:[nativeTurn(h,'inProgress')]});
    assert.equal(store.delivery(h.d.id).status,'cancelled');assert.equal(store.delivery(h.d.id).nativeTurnId,'6');assert.equal(store.state().messages.length,1);assert.equal(h.adapters.deepseek.sent.length,0);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('unresolved accepted input becomes unknown after bounded grace, blocks new sends and never resends',async()=>{
  const h=harness();try{
    h.store.set('paused',false);h.store.updateDelivery(h.d.id,'running',{receipt:{requestId:h.d.id,nativeTurnId:null,acceptedAt:Date.now()-31000}});
    h.adapters.deepseek.snapshot=async()=>({state:'running',turns:[],unresolvedRequestIds:[h.d.id]});h.relay.sendUser('later',['deepseek']);
    await h.relay.tick('deepseek');await h.relay.tick('deepseek');assert.equal(h.store.delivery(h.d.id).status,'unknown');assert.equal(h.adapters.deepseek.sent.length,0);
  }finally{h.store.close();}
});

test('a young admitted steer stays pending while the native tool runs, and time context is never a second input',()=>{
  const h=harness();try{
    h.store.updateDelivery(h.d.id,'running',{receipt:{requestId:h.d.id,nativeTurnId:null,acceptedAt:Date.now()}});
    h.relay.ingest('deepseek','d',{state:'running',turns:[],unresolvedRequestIds:[h.d.id]});assert.equal(h.store.delivery(h.d.id).status,'running');
    const turns=normalizeDsh([event(1,'turn/start',{turn:71}),input(2,h.d.id),event(3,'user/message',{source:{kind:'time-context'},content:[{type:'text',text:'time'}]}),output(4,71),event(5,'turn/end',{turn:71,reason:'completed'})]);
    assert.equal(turns[0].inputs.length,1);assert.equal(turns[0].inputs[0].requestId,h.d.id);
  }finally{h.store.close();}
});

test('an unresolved gap is reported as unknown immediately, without inventing a destination or losing settled records',()=>{
  const h=harness();try{
    h.store.updateDelivery(h.d.id,'running',{receipt:{requestId:h.d.id,nativeTurnId:null,acceptedAt:Date.now()}});
    h.relay.ingest('deepseek','d',{state:'running',turns:[],historyIncomplete:true,unresolvedRequestIds:[h.d.id]});
    const d=h.store.delivery(h.d.id);assert.equal(d.status,'unknown');assert.equal(d.nativeTurnId,null);
  }finally{h.store.close();}
});
