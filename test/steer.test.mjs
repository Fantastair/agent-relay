import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Store} from '../src/store.mjs';
import {Relay} from '../src/relay.mjs';
import {ParallelRelay} from '../src/parallel-relay.mjs';
import {CodexAdapter} from '../src/adapters/codex.mjs';
import {DshAdapter} from '../src/adapters/dsh.mjs';
import {RelayError,envelope} from '../src/util.mjs';

function harness({parallel=false,file=':memory:',deferred=false}={}){
  const store=new Store(file);store.set('codexId','c');store.set('deepseekId','d');store.set('paused',false);store.set('pausedAll',false);
  store.patchRoomOptions(store.activeRoomId(),{paused:false});
  const adapters=Object.fromEntries(['codex','deepseek'].map(side=>[side,{
    supportsSteer:true,turns:[],sent:[],seq:0,
    async snapshot(){return {state:this.turns.some(t=>t.status==='inProgress')?'running':'idle',turns:this.turns,title:side,watermark:this.seq};},
    async send(sessionId,text,requestId){
      this.sent.push({sessionId,text,requestId});if(this.error)throw this.error;
      let active=this.turns.find(t=>t.status==='inProgress'),mode=active?'steer':'start';
      if(!active){active={id:side+'-'+(this.turns.length+1),status:'inProgress',inputs:[],outputs:[]};this.turns.unshift(active);}
      active.inputs.push({id:String(++this.seq),kind:'user',text,requestId});
      return {requestId,nativeTurnId:deferred?null:active.id,deliveryMode:deferred?null:mode,acceptedAt:Date.now()};
    },
  }]));
  const relay=parallel?new ParallelRelay(store,adapters):new Relay(store,adapters),roomId=store.activeRoomId();
  const send=text=>relay.sendUser(text,['codex'],roomId);
  const finish=(side='codex',text='one final')=>{const t=adapters[side].turns.find(t=>t.status==='inProgress');t.status='completed';t.outputs=[{id:'out-'+t.id,text}];return t;};
  return {store,adapters,relay,send,finish,roomId};
}

test('a start and multiple busy steers share one final response, all receipts, latest parent, and one forward',async()=>{
  const h=harness();try{
    const all=[h.send('first')];await h.relay.tick('codex');
    for(const text of ['second','third']){all.push(h.send(text));await h.relay.tick('codex');}
    assert.equal(h.adapters.codex.turns.length,1);assert.equal(h.adapters.codex.sent.length,3);
    assert.deepEqual(all.map(m=>h.store.forMessage(m.id,'codex').deliveryMode),['start','steer','steer']);
    assert(all.every(m=>h.store.forMessage(m.id,'codex').acceptedAt));
    h.finish();await h.relay.tick('codex');await h.relay.tick('codex');
    const replies=h.store.state().messages.filter(m=>m.sender==='codex');assert.equal(replies.length,1);
    assert.equal(replies[0].replyTo,all[2].id);assert.deepEqual(replies[0].meta.inReplyToMessageIds,all.map(m=>m.id));
    assert(all.every(m=>h.store.forMessage(m.id,'codex').status==='completed'));assert.equal(h.store.jobs('deepseek').length,1);
    const updated=h.store.forMessage(all[0].id,'codex').updatedAt;await h.relay.tick('codex');assert.equal(h.store.forMessage(all[0].id,'codex').updatedAt,updated);
  }finally{h.store.close();}
});

test('admitted DSH input is pending until native history identifies its actual turn and mode',async()=>{
  const h=harness({deferred:true});try{
    const first=h.send('start');await h.relay.tick('codex');assert.equal(h.store.forMessage(first.id,'codex').deliveryMode,null);
    const extra=h.send('supplement');await h.relay.tick('codex');assert.equal(h.store.forMessage(first.id,'codex').deliveryMode,'start');
    await h.relay.tick('codex');assert.equal(h.store.forMessage(extra.id,'codex').deliveryMode,'steer');
    h.finish('codex','done\n[relay-stop]');await h.relay.tick('codex');assert.equal(h.store.forMessage(extra.id,'codex').status,'completed');
  }finally{h.store.close();}
});

test('an immutable start batch and later independent steers are reconciled as separate admissions to one turn',async()=>{
  const h=harness();try{
    const originals=Array.from({length:4},(_,i)=>h.send('batch '+i));await h.relay.tick('codex');
    const batchId=h.store.forMessage(originals[0].id,'codex').batchId;assert(batchId);
    const extra=h.send('late supplement');await h.relay.tick('codex');
    h.finish('codex','done\n[relay-stop]');await h.relay.tick('codex');
    assert.equal(h.store.batch(batchId).status,'completed');assert.equal(h.store.forMessage(extra.id,'codex').status,'completed');
    const reply=h.store.state().messages.at(-1);assert.deepEqual(reply.meta.inReplyToMessageIds,[...originals.map(m=>m.id),extra.id]);assert.equal(reply.replyTo,extra.id);assert.equal(reply.meta.batchId,undefined);
  }finally{h.store.close();}
});

test('a failed native turn settles every admission without forwarding its partial output',async()=>{
  const h=harness();try{
    const a=h.send('first');await h.relay.tick('codex');const b=h.send('second');await h.relay.tick('codex');
    h.adapters.codex.turns[0].status='failed';h.adapters.codex.turns[0].outputs=[{id:'partial',text:'unfinished'}];await h.relay.tick('codex');
    assert.equal(h.store.forMessage(a.id,'codex').status,'failed');assert.equal(h.store.forMessage(b.id,'codex').status,'failed');assert.equal(h.store.state().messages.length,2);assert.equal(h.store.jobs('deepseek').length,0);
  }finally{h.store.close();}
});

test('a DSH steer rolling over to the next native turn is recorded as start',async()=>{
  const h=harness({deferred:true});try{
    h.send('original');await h.relay.tick('codex');
    const extra=h.send('late');h.adapters.codex.send=async function(sessionId,text,requestId){
      h.finish('codex','earlier\n[relay-stop]');this.turns.unshift({id:'rollover',status:'inProgress',inputs:[{id:'2',kind:'user',text,requestId}],outputs:[]});
      return {requestId,nativeTurnId:null,deliveryMode:null,acceptedAt:Date.now()};
    };
    await h.relay.tick('codex');await h.relay.tick('codex');
    const d=h.store.forMessage(extra.id,'codex');assert.equal(d.nativeTurnId,'rollover');assert.equal(d.deliveryMode,'start');
  }finally{h.store.close();}
});

test('stale final history waits for an admitted but not yet visible steer',async()=>{
  const h=harness({deferred:true});try{
    const first=h.send('first');await h.relay.tick('codex');const extra=h.send('extra');await h.relay.tick('codex');
    const t=h.finish('codex','combined\n[relay-stop]'),saved=t.inputs.pop();
    await h.relay.tick('codex');assert.equal(h.store.state().messages.filter(m=>m.sender==='codex').length,0);
    assert.equal(h.store.seen('codex','c','turn:'+t.id),false);
    t.inputs.push(saved);await h.relay.tick('codex');
    assert.deepEqual(h.store.state().messages.at(-1).meta.inReplyToMessageIds,[first.id,extra.id]);
  }finally{h.store.close();}
});

test('an uncertain steer blocks subsequent admissions and recovers once without a second send',async()=>{
  const h=harness();try{
    h.send('first');await h.relay.tick('codex');const extra=h.send('ambiguous');
    h.adapters.codex.error=new RelayError('lost response','timeout',true);await h.relay.tick('codex');
    const d=h.store.forMessage(extra.id,'codex');assert.equal(d.status,'unknown');assert.equal(d.deliveryMode,null);
    h.send('later');await h.relay.tick('codex');assert.equal(h.adapters.codex.sent.length,2);
    h.adapters.codex.turns[0].inputs.push({id:'2',kind:'user',text:envelope(extra),requestId:d.id});
    h.adapters.codex.error=null;await h.relay.tick('codex');
    assert.equal(h.store.forMessage(extra.id,'codex').status,'running');assert.equal(h.adapters.codex.sent.length,3);
  }finally{h.store.close();}
});

test('a busy native task with no relay start still receives steer and is scoped to its target topic',async()=>{
  const h=harness({parallel:true});try{
    h.adapters.codex.turns=[{id:'native-task',status:'inProgress',inputs:[],outputs:[]}];
    const m=h.send('guide current task');await h.relay.tick('codex');
    assert.equal(h.store.forMessage(m.id,'codex').deliveryMode,'steer');assert.equal(h.store.forMessage(m.id,'codex').nativeTurnId,'native-task');
    h.finish('codex','ok\n[relay-stop]');await h.relay.tick('codex');assert.equal(h.store.state(h.roomId).messages.at(-1).replyTo,m.id);
  }finally{h.store.close();}
});

test('topic pause and global pause prevent steering; a reduced limit still permits an existing topic supplement',async()=>{
  const h=harness({parallel:true});try{
    h.relay.setScheduler({limit:2});h.send('start');await h.relay.tick('codex');
    const extra=h.send('extra');h.relay.setOptions({roomId:h.roomId,paused:true});await h.relay.tick('codex');assert.equal(h.adapters.codex.sent.length,1);
    h.relay.setOptions({roomId:h.roomId,paused:false});h.relay.setScheduler({pausedAll:true});await h.relay.tick('codex');assert.equal(h.adapters.codex.sent.length,1);
    h.relay.setScheduler({pausedAll:false,limit:1});await h.relay.tick('codex');assert.equal(h.store.forMessage(extra.id,'codex').deliveryMode,'steer');
  }finally{h.store.close();}
});

test('persisted multi-admission receipts survive restart and complete together without replay',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'relay-steer-'));let store;
  try{
    const h=harness({file:path.join(dir,'relay.sqlite')});const all=[h.send('first')];await h.relay.tick('codex');all.push(h.send('second'));await h.relay.tick('codex');
    h.finish('codex','done\n[relay-stop]');h.store.close();store=new Store(path.join(dir,'relay.sqlite'));
    const r=new Relay(store,h.adapters);await r.tick('codex');await r.tick('codex');
    assert.equal(h.adapters.codex.sent.length,2);assert(all.every(m=>store.forMessage(m.id,'codex').status==='completed'));
    assert.deepEqual(store.state().messages.at(-1).meta.inReplyToMessageIds,all.map(m=>m.id));
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

function codexHarness(state='running'){
  const a=new CodexAdapter(),calls=[];a.snapshot=async()=>({state,cwd:'D:/test',turns:state==='running'?[{id:'active',status:'inProgress'}]:[]});
  a.owner=async()=> 'owner';a.ensure=async()=> 'owner';a.follower=async(owner,method,params)=>{calls.push({owner,method,params});return method.endsWith('steer-turn')?{turnId:'active'}:{turn:{id:'new'}};};return {a,calls};
}
test('Codex busy delivery steers the existing turn with its client message identity',async()=>{
  const {a,calls}=codexHarness();const receipt=await a.send('thread','text','delivery');assert.equal(receipt.deliveryMode,'steer');assert.equal(receipt.nativeTurnId,'active');
  assert.equal(calls.length,1);assert.equal(calls[0].params.clientUserMessageId,'delivery');assert.equal(calls[0].method,'thread-follower-steer-turn');
});
test('Codex falls back to start only after a definite inactive rejection and a fresh idle snapshot',async()=>{
  const {a,calls}=codexHarness();let reads=0;a.snapshot=async()=>++reads===1?{state:'running',turns:[{id:'old',status:'inProgress'}]}:{state:'idle',turns:[]};
  const impl=a.follower;a.follower=async(...args)=>{if(args[1].endsWith('steer-turn')){calls.push({method:args[1]});throw new RelayError('active turn already ended','native_reject');}return impl(...args);};
  const r=await a.send('thread','text','delivery');assert.equal(r.deliveryMode,'start');assert.equal(calls.length,2);
});
test('Codex never starts another turn after an ambiguous steer or a mismatched running successor',async()=>{
  for(const uncertain of [true,false]){
    const {a,calls}=codexHarness();a.follower=async(...args)=>{calls.push(args[1]);throw new RelayError(uncertain?'timeout':'active turn already ended',uncertain?'timeout':'native_reject',uncertain);};
    await assert.rejects(a.send('thread','text','delivery'),e=>uncertain?e.uncertain:e.code==='busy');assert.deepEqual(calls,['thread-follower-steer-turn']);
  }
});
test('Codex IPC leaves owner routing unfiltered and does not retry an ambiguous admission',async()=>{
  const a=new CodexAdapter(),calls=[];a.ipc=async()=>({close(){},async request(method,params,options){calls.push(options);throw new RelayError('timeout','timeout',true);}});
  await assert.rejects(a.follower('owner','thread-follower-steer-turn',{},1),e=>e.uncertain);assert.equal(calls.length,1);assert.equal(calls[0].hostId,undefined);
});
test('Codex IPC treats explicit owner-side timeout responses as uncertain rather than safe to retry',async()=>{
  const a=new CodexAdapter();let calls=0;a.ipc=async()=>({close(){},async request(){calls++;return {resultType:'error',error:'thread-follower-steer-turn-timeout'};}});
  await assert.rejects(a.follower('owner','thread-follower-steer-turn',{},1),e=>e.uncertain);assert.equal(calls,1);
});
test('DSH always requests steer and leaves actual mode unknown until native events are observed',async()=>{
  for(const state of ['idle','running']){
    const a=new DshAdapter();a.snapshot=async()=>({state,watermark:42,turns:state==='running'?[{id:'69',status:'inProgress'}]:[]});let request;
    a.api=async(method,args,rpcId)=>{request={method,args,rpcId};return {accepted:true};};const r=await a.send('session','text','delivery');
    assert.equal(request.args.request.mode,'steer');assert.equal(request.rpcId,'delivery');assert.equal(r.nativeTurnId,null);assert.equal(r.deliveryMode,null);assert(r.acceptedAt);
  }
});

test('DSH malformed and server-error admission responses remain uncertain and are never resent',async()=>{
  let responseStatus=503,responseText='unavailable',requests=0;
  const server=http.createServer((req,res)=>{requests++;req.resume();res.writeHead(responseStatus);res.end(responseText);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const a=new DshAdapter();a.secret=async()=>Buffer.alloc(32);a.discover=async()=> 'http://127.0.0.1:'+server.address().port;
    await assert.rejects(a.api('session/prompt',{},'one'),e=>e.uncertain);assert.equal(requests,1);
    responseStatus=200;responseText='{';await assert.rejects(a.api('session/prompt',{},'two'),e=>e.uncertain);assert.equal(requests,2);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
