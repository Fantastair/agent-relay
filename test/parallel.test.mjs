import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {ParallelRelay} from '../src/parallel-relay.mjs';
import {makeService} from '../src/server.mjs';
import {RelayError,envelope} from '../src/util.mjs';

function harness(file=':memory:'){
  const store=new Store(file),sessions=new Map(),sent=[];
  const adapters=Object.fromEntries(['codex','deepseek'].map(side=>[side,{
    async snapshot(sessionId){const s=sessions.get(sessionId)||{};if(s.error)throw s.error;await s.wait;return {id:sessionId,title:sessionId,state:s.state||'idle',turns:s.turns||[]};},
    async send(sessionId,text,requestId){const s=sessions.get(sessionId)||{};sent.push({side,sessionId,text,requestId});if(s.sendError)throw s.sendError;return {requestId,nativeTurnId:requestId};},
    async list(){return [];},async workspaces(){return [];},async projects(){return {projects:[]};},
  }]));
  const relay=new ParallelRelay(store,adapters);
  function room(name,{codexId='c-'+name,deepseekId='d-'+name,paused=false}={}){const room=store.createRoom({title:name,codexId,deepseekId});store.writeRoomOptions(room.id,{paused,mode:'auto',maxTurns:20});return room;}
  function finish(message,side='codex',output='done\n[relay-stop]'){
    const delivery=store.forMessage(message.id,side),sessionId=delivery.sessionId,s=sessions.get(sessionId)||{};
    sessions.set(sessionId,{...s,state:'idle',turns:[{id:delivery.receipt?.nativeTurnId||delivery.id,status:'completed',inputs:[{kind:'user',id:'in-'+delivery.id,text:envelope(message),requestId:delivery.id}],outputs:[{id:'out-'+delivery.id,text:output}]}]});
  }
  return {store,relay,sessions,sent,room,finish,adapters};
}

test('four independent topics dispatch concurrently, with independent two-side receipts and replies',async()=>{
  const h=harness();try{
    h.relay.setScheduler({limit:4});const rooms=Array.from({length:4},(_,i)=>h.room('topic-'+i));
    const messages=rooms.map(room=>h.relay.sendUser(room.title,undefined,room.id));
    await Promise.all(['codex','deepseek'].map(side=>h.relay.tick(side)));
    assert.equal(h.sent.length,8);assert.equal(h.relay.concurrency().running,4);
    for(let i=0;i<rooms.length;i++){
      for(const side of ['codex','deepseek'])assert.equal(h.store.forMessage(messages[i].id,side).sessionId,side==='codex'?rooms[i].codexId:rooms[i].deepseekId);
      h.finish(messages[i]);
    }
    await h.relay.tick('codex');
    for(const room of rooms){const replies=h.store.state(room.id).messages;assert.equal(replies.length,2);assert.equal(replies[1].roomId,room.id);assert.equal(replies[1].replyTo,replies[0].id);}
  }finally{h.store.close();}
});

test('a lower concurrency limit drains existing work without interrupting it or admitting a new topic',async()=>{
  const h=harness();try{
    h.relay.setScheduler({limit:3});const rooms=Array.from({length:4},(_,i)=>h.room('r'+i)),messages=rooms.map(r=>h.relay.sendUser('work',['codex'],r.id));
    await h.relay.tick('codex');assert.equal(h.sent.length,3);
    h.relay.setScheduler({limit:1});await h.relay.tick('codex');assert.equal(h.sent.length,3);
    const active=messages.filter(m=>h.store.forMessage(m.id,'codex').status==='running');
    h.finish(active[0]);h.finish(active[1]);await h.relay.tick('codex');assert.equal(h.sent.length,3);
    h.finish(active[2]);await h.relay.tick('codex');assert.equal(h.sent.length,4);assert.equal(h.relay.concurrency().running,1);
  }finally{h.store.close();}
});

test('round robin at completed delivery boundaries prevents a topic with a backlog from starving another',async()=>{
  const h=harness();try{
    h.relay.setScheduler({limit:1});const a=h.room('first'),b=h.room('second');
    const first=h.relay.sendUser('A1',['codex'],a.id);h.relay.sendUser('A2',['codex'],a.id);const other=h.relay.sendUser('B',['codex'],b.id);
    await h.relay.tick('codex');assert.equal(h.sent[0].sessionId,a.codexId);
    h.finish(first);await h.relay.tick('codex');
    assert.equal(h.store.forMessage(other.id,'codex').status,'running');assert.equal(h.sent[1].sessionId,b.codexId);
  }finally{h.store.close();}
});

test('legacy shared bindings preserve queued work and in-flight replies but do not accept or dispatch new work',async()=>{
  const h=harness();try{
    h.relay.setScheduler({limit:4});const a=h.room('a',{codexId:'shared'});
    const ma=h.relay.sendUser('already sent',['codex'],a.id);h.relay.sendUser('queued before migration',['codex'],a.id);
    await h.relay.tick('codex');assert.equal(h.sent.length,1);
    const b=h.room('legacy duplicate',{codexId:'shared'});
    const mb=h.store.addMessage({sender:'user',text:'legacy queue',roomId:b.id});h.relay.context(b.id).enqueue(mb,'deepseek');
    assert.throws(()=>h.relay.sendUser('reject new',['deepseek'],b.id),error=>error.code==='binding_conflict');
    assert.throws(()=>h.relay.forward(ma.id,'deepseek'),error=>error.code==='binding_conflict');
    h.finish(ma,'codex','late reply without stop marker');
    await Promise.all(['codex','deepseek'].map(side=>h.relay.tick(side)));
    assert.equal(h.sent.length,1);assert.equal(h.store.forMessage(ma.id,'codex').status,'completed');
    const state=h.relay.state(a.id);assert.equal(state.room.bindingStatus,'conflict');assert.equal(state.room.runState,'waiting');
    assert.equal(state.room.sharedWith[0].roomId,b.id);assert.deepEqual(state.room.bindingConflicts,[{side:'codex',roomId:b.id,title:b.title}]);
    assert.equal(h.store.jobs('deepseek',undefined,a.id).length,0);assert.equal(h.store.forMessage(mb.id,'deepseek').status,'queued');
    assert.equal(h.store.state(a.id).messages.at(-1).replyTo,ma.id);assert.equal(h.store.roomOptions(a.id).paused,false);
  }finally{h.store.close();}
});

test('new topics have empty native bindings and cannot inherit skill or image declarations',async()=>{
  const h=harness();try{
    const source=h.room('source');h.store.patchRoomOptions(source.id,{maxTurns:12,protocolReady:{codex:{}},imageCapabilities:{deepseek:{}}});
    const room=await h.relay.createRoom({roomId:source.id,title:'empty'});
    assert.equal(room.codexId,null);assert.equal(room.deepseekId,null);assert.equal(room.parentId,source.id);
    assert.equal(h.store.roomOptions(room.id).maxTurns,12);assert.deepEqual(h.store.roomOptions(room.id).protocolReady,{});assert.deepEqual(h.store.roomOptions(room.id).imageCapabilities,{});
    assert.equal(h.relay.state(room.id).room.bindingStatus,'unbound');assert.equal(h.relay.state(room.id).room.runState,'unbound');
    assert.throws(()=>h.relay.sendUser('not yet',undefined,room.id),/尚未绑定/);assert.equal(h.store.state(room.id).messages.length,0);
    await assert.rejects(h.relay.createRoom({roomId:source.id,reuseBindings:true}),/不能复用/);
    assert.equal(h.store.room(source.id).codexId,source.codexId);assert.equal(h.sent.length,0);
  }finally{h.store.close();}
});

test('each native side is exclusive even when its owner is archived',async()=>{
  const h=harness();try{
    const owner=h.room('owner'),target=h.room('target');h.relay.updateRoom({roomId:owner.id,archived:true});
    for(const side of ['codex','deepseek']){
      const bindings={roomId:target.id,codexId:'available-c',deepseekId:'available-d',[side==='codex'?'codexId':'deepseekId']:owner[side==='codex'?'codexId':'deepseekId']};
      await assert.rejects(h.relay.bindPair(bindings),error=>error.code==='binding_conflict'&&error.conflict.side===side&&error.conflict.roomId===owner.id);
      assert.equal(h.store.room(target.id).codexId,target.codexId);assert.equal(h.store.room(target.id).deepseekId,target.deepseekId);
    }
    await h.relay.bindPair({roomId:target.id,codexId:target.codexId,deepseekId:target.deepseekId});
    assert.equal(h.relay.state(target.id).room.bindingStatus,'ready');
  }finally{h.store.close();}
});

test('two simultaneous binding requests cannot both claim a native session',async()=>{
  const h=harness();let release;const wait=new Promise(resolve=>{release=resolve;});let reads=0;
  try{
    const a=h.room('a',{codexId:null,deepseekId:null}),b=h.room('b',{codexId:null,deepseekId:null});
    h.adapters.codex.snapshot=async id=>{reads++;await wait;return {id,state:'idle',turns:[]};};
    const pending=[a,b].map(room=>h.relay.bindPair({roomId:room.id,codexId:'contested',deepseekId:'d-'+room.id}));
    await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,2);release();
    const results=await Promise.allSettled(pending);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    const loser=results.find(result=>result.status==='rejected');assert.equal(loser.reason.code,'binding_conflict');
    const winner=results.find(result=>result.status==='fulfilled').value;assert.equal(loser.reason.conflict.roomId,winner.roomId);
    const unchanged=h.store.rooms().find(room=>[a.id,b.id].includes(room.id)&&room.id!==winner.roomId);
    assert.equal(unchanged.codexId,null);assert.equal(unchanged.deepseekId,null);assert.equal(h.relay.mutations.size,0);
  }finally{release();h.store.close();}
});

test('legacy duplicate bindings survive reopen without modifying records or choosing an owner',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'relay-binding-migration-')),file=path.join(dir,'relay.sqlite');let h=harness(file);
  try{
    const a=h.room('a',{codexId:'legacy'}),b=h.room('b',{codexId:'legacy'}),message=h.store.addMessage({sender:'user',text:'keep history',roomId:a.id});
    h.store.close();h=harness(file);
    for(const room of [a,b]){assert.equal(h.store.room(room.id).codexId,'legacy');assert.equal(h.relay.state(room.id).room.bindingStatus,'conflict');}
    assert.equal(h.store.message(message.id).text,'keep history');assert.equal(h.store.roomOptions(a.id).paused,false);
    await h.relay.tick('codex');assert.equal(h.sent.length,0);
    await h.relay.bindPair({roomId:b.id,codexId:'new-c',deepseekId:b.deepseekId});
    assert.equal(h.relay.state(a.id).room.bindingStatus,'ready');assert.equal(h.relay.state(b.id).room.bindingStatus,'ready');
  }finally{h.store.close();await rm(dir,{recursive:true,force:true});}
});

test('per-topic pause and the global gate preserve independent flags and permit queuing',async()=>{
  const h=harness();try{
    const a=h.room('a'),b=h.room('b',{paused:true});h.relay.setScheduler({pausedAll:true,limit:9});
    h.relay.sendUser('A',['codex'],a.id);h.relay.sendUser('B',['codex'],b.id);await h.relay.tick('codex');assert.equal(h.sent.length,0);
    h.relay.setScheduler({pausedAll:false});await h.relay.tick('codex');assert.equal(h.sent.length,1);assert.equal(h.sent[0].sessionId,a.codexId);
    assert.equal(h.store.roomOptions(b.id).paused,true);assert.equal(h.relay.state(b.id).room.queueLength,1);
    assert.throws(()=>h.relay.setOptions({roomId:a.id,paused:true,mode:'invalid'}),/模式/);assert.equal(h.store.roomOptions(a.id).paused,false);
    assert.throws(()=>h.relay.setScheduler({limit:0,pausedAll:true}),/正整数/);assert.equal(h.store.get('pausedAll'),false);
    assert.throws(()=>h.relay.setOptions({roomId:'missing',paused:true}),e=>e.code==='not_found');
  }finally{h.store.close();}
});

test('a native failure or uncertain idle session blocks only its own topic and shared sessions',async()=>{
  const h=harness();try{
    h.relay.setScheduler({limit:1});const a=h.room('a'),b=h.room('b');h.sessions.set(a.codexId,{sendError:new RelayError('lost receipt','timeout',true)});
    const ma=h.relay.sendUser('A',['codex'],a.id),mb=h.relay.sendUser('B',['codex'],b.id);
    await h.relay.tick('codex');await h.relay.tick('codex');
    assert.equal(h.store.forMessage(ma.id,'codex').status,'unknown');assert.equal(h.store.forMessage(mb.id,'codex').status,'running');
    assert.equal(h.relay.state(a.id).room.runState,'waiting');assert.equal(h.store.roomOptions(b.id).paused,false);
  }finally{h.store.close();}
});

test('switching views does not mutate scheduling, archived topics reject sends, and idle background topics remain writable',async()=>{
  const h=harness();try{
    const a=h.room('a'),b=h.room('b');h.relay.selectRoom(a.id);h.relay.sendUser('B',['codex'],b.id);
    const before=h.store.roomOptions(b.id);h.relay.selectRoom(b.id);assert.deepEqual(h.store.roomOptions(b.id),before);
    assert.equal(h.relay.state(a.id).readOnly,false);await h.relay.tick('codex');assert.equal(h.sent[0].sessionId,b.codexId);
    h.relay.updateRoom({roomId:a.id,archived:true});assert.throws(()=>h.relay.sendUser('no',['codex'],a.id),/归档/);assert.equal(h.relay.state(a.id).room.runState,'idle');
    h.relay.setOptions({roomId:a.id,maxTurns:4});assert.equal(h.store.roomOptions(a.id).maxTurns,4);
  }finally{h.store.close();}
});

test('room-local configuration, immutable delivery targets and unknown receipts survive reopen',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'relay-parallel-')),file=path.join(dir,'relay.sqlite');let h=harness(file);
  try{
    const a=h.room('a'),b=h.room('b',{paused:true});h.relay.setOptions({roomId:a.id,maxTurns:10,mode:'manual'});
    const m=h.relay.sendUser('once',['codex'],a.id),job=h.store.forMessage(m.id,'codex');h.store.updateDelivery(job.id,'sending');
    h.store.close();h=harness(file);
    assert.equal(h.store.roomOptions(a.id).maxTurns,10);assert.equal(h.store.roomOptions(a.id).mode,'manual');assert.equal(h.store.roomOptions(b.id).paused,true);
    assert.equal(h.store.delivery(job.id).status,'unknown');assert.equal(h.store.delivery(job.id).sessionId,a.codexId);
    await h.relay.tick('codex');assert.equal(h.sent.length,0);
  }finally{h.store.close();await rm(dir,{recursive:true,force:true});}
});

test('a stalled native snapshot cannot stop subsequent polling cycles for healthy sessions',async()=>{
  const h=harness();let release;const wait=new Promise(resolve=>{release=resolve;});let first;
  try{
    const slow=h.room('slow'),fast=h.room('fast');h.sessions.set(slow.codexId,{wait});
    h.relay.sendUser('slow',['codex'],slow.id);const m=h.relay.sendUser('fast one',['codex'],fast.id);
    first=h.relay.tick('codex');await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.store.forMessage(m.id,'codex').status,'running');h.finish(m);
    const next=h.relay.sendUser('fast two',['codex'],fast.id);
    await h.relay.tick('codex');assert.equal(h.store.forMessage(next.id,'codex').status,'running');
    assert.equal(h.sent.filter(item=>item.sessionId===fast.codexId).length,2);
  }finally{release();await first;h.store.close();}
});

test('late handled replies are still reconciled into their original topic after that topic receives independent bindings',async()=>{
  const h=harness();try{
    const a=h.room('source'),message=h.relay.sendUser('old native task',['codex'],a.id);
    await h.relay.tick('codex');const delivery=h.store.forMessage(message.id,'codex');
    h.store.updateDelivery(delivery.id,'unknown');h.relay.resolve(delivery.id,'handled',true);
    await h.relay.bindPair({roomId:a.id,codexId:'new-c',deepseekId:'new-d'});
    h.finish(message,'codex','late old reply');await h.relay.tick('codex');
    const history=h.store.state(a.id).messages;assert.equal(history.length,2);assert.equal(history[1].replyTo,message.id);
    assert.equal(h.store.room(a.id).codexId,'new-c');assert.equal(h.store.jobs('deepseek',undefined,a.id).length,0);assert.equal(h.sent.length,1);
  }finally{h.store.close();}
});

test('HTTP per-topic settings and scheduler require explicit routing and retain local CSRF protection',async()=>{
  const h=harness(),dir=await mkdtemp(path.join(tmpdir(),'relay-parallel-http-')),service=await makeService({dataDir:dir,adapters:h.adapters});
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+service.server.address().port;
  try{
    const cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0],headers={cookie,origin:base,'x-relay-ui':'1','content-type':'application/json'};
    const post=(url,body,extra={})=>fetch(base+'/api/'+url,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
    const room=service.store.room(service.store.activeRoomId());
    assert.equal((await post('options',{roomId:room.id,paused:false,mode:'manual'})).status,200);
    assert.equal((await post('options',{roomId:'missing',paused:false})).status,404);
    assert.equal((await post('options',{paused:false})).status,400);
    assert.equal((await post('rooms',{})).status,400);
    assert.equal((await post('scheduler',{limit:12,pausedAll:false})).status,200);
    assert.equal((await post('scheduler',{limit:0,pausedAll:true})).status,400);
    assert.equal((await post('scheduler',{pausedAll:true},{origin:'https://evil.example'})).status,403);
    const state=await (await fetch(base+'/api/state?roomId='+room.id,{headers:{cookie}})).json();
    assert.equal(state.concurrency.limit,12);assert.equal(state.concurrency.pausedAll,false);assert.equal(state.room.mode,'manual');
    assert.deepEqual(state.room.sharedWith,[]);assert.equal(state.room.runState,'unbound');
  }finally{await service.close();h.store.close();await rm(dir,{recursive:true,force:true});}
});

test('provisioning independent sessions updates the requested topic without being blocked by another topic queue',async()=>{
  const h=harness(),dir=await mkdtemp(path.join(tmpdir(),'relay-parallel-provision-'));
  h.adapters.codex.create=async()=>({id:'new-independent-c'});
  h.adapters.deepseek.workspaces=async()=>[{workspaceId:'ws',path:'D:/mock-workspace'}];
  h.adapters.deepseek.create=async({onCreated})=>{await onCreated?.('new-independent-d');return {id:'new-independent-d'};};
  h.adapters.deepseek.verifyWorkspace=async()=>{};
  const service=await makeService({dataDir:dir,adapters:h.adapters});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+service.server.address().port;
  try{
    const target=service.store.activeRoomId(),other=service.store.createRoom({title:'other',codexId:'other-c',deepseekId:'other-d'});
    const pending=service.relay.sendUser('other pending',['codex'],other.id);
    const cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];
    const result=await fetch(base+'/api/provision',{method:'POST',headers:{cookie,origin:base,'x-relay-ui':'1','content-type':'application/json'},body:JSON.stringify({roomId:target,workspaceId:'ws'})});
    assert.equal(result.status,200);assert.equal((await result.json()).roomId,target);
    assert.equal(service.store.rooms().length,2);assert.equal(service.store.room(target).codexId,'new-independent-c');assert.equal(service.store.room(target).deepseekId,'new-independent-d');
    assert.equal(service.store.room(other.id).codexId,'other-c');assert.equal(service.store.forMessage(pending.id,'codex').status,'queued');
    assert.equal(service.store.roomOptions(target).provisionDraft,null);assert.equal(service.store.roomOptions(target).paused,true);
  }finally{await service.close();h.store.close();await rm(dir,{recursive:true,force:true});}
});

test('HTTP binding conflicts identify the occupying topic, including archives, without changing either binding',async()=>{
  const h=harness(),dir=await mkdtemp(path.join(tmpdir(),'relay-binding-http-')),service=await makeService({dataDir:dir,adapters:h.adapters});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.server.address().port;
  try{
    const owner=service.store.room(service.store.activeRoomId());service.store.bindRoom(owner.id,{codexId:'owned-c',deepseekId:'owned-d'});service.store.renameRoom(owner.id,'已归档项目');service.store.archiveRoom(owner.id,true);
    const cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0],headers={cookie,origin:base,'x-relay-ui':'1','content-type':'application/json'};
    const post=(route,body)=>fetch(base+'/api/'+route,{method:'POST',headers,body:JSON.stringify(body)});
    const created=await post('rooms',{roomId:owner.id,title:'new'});assert.equal(created.status,200);const target=(await created.json()).room;
    assert.equal(target.codexId,null);assert.equal(target.deepseekId,null);
    assert.equal((await post('message',{roomId:target.id,text:'unbound'})).status,400);
    for(const side of ['codex','deepseek']){
      const response=await post('bind-pair',{roomId:target.id,codexId:side==='codex'?'owned-c':'free-c',deepseekId:side==='deepseek'?'owned-d':'free-d'});
      assert.equal(response.status,409);const error=await response.json();assert.equal(error.code,'binding_conflict');assert.deepEqual(error.conflict,{side,roomId:owner.id,title:'已归档项目'});
    }
    assert.equal(service.store.room(target.id).codexId,null);assert.equal(service.store.room(owner.id).codexId,'owned-c');
    assert.equal((await post('rooms',{roomId:owner.id,reuseBindings:true})).status,400);
    // A pre-upgrade duplicate is reported, kept intact, and cannot create a new message.
    const legacy=service.store.createRoom({title:'legacy',codexId:'owned-c',deepseekId:'old-d'});
    const rejected=await post('message',{roomId:legacy.id,text:'blocked'});assert.equal(rejected.status,409);assert.equal((await rejected.json()).conflict.roomId,owner.id);
    const view=await (await fetch(base+'/api/state?roomId='+legacy.id,{headers:{cookie}})).json();
    assert.equal(view.room.bindingStatus,'conflict');assert.equal(view.room.codexId,'owned-c');assert.equal(view.messages.length,0);
    assert(view.rooms.some(room=>room.id===owner.id&&room.archived));
  }finally{await service.close();h.store.close();await rm(dir,{recursive:true,force:true});}
});
