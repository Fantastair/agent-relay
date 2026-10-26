import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {Relay} from '../src/relay.mjs';
import {makeService} from '../src/server.mjs';
import {envelope,batchEnvelope,id} from '../src/util.mjs';

function adapters(){return Object.fromEntries(['codex','deepseek'].map(side=>[side,{
  turns:[],sent:[],async snapshot(sessionId){return {id:sessionId,title:side,state:'idle',turns:this.turns};},
  async send(...args){this.sent.push(args);throw new Error('No native delivery in deletion tests');},
  async list(){return [];},async projects(){return {projects:[]};},async workspaces(){return [];},
}]));}
function harness(file=':memory:'){
  const store=new Store(file),native=adapters();store.set('codexId','c');store.set('deepseekId','d');
  return {store,adapters:native,relay:new Relay(store,native)};
}

test('deleting an archived history removes its graph atomically and preserves other rooms, attachments and binding',async()=>{
  const h=harness();try{
    const old=h.store.activeRoomId(),messages=[h.relay.sendUser('private old one',['codex']),h.relay.sendUser('private old two',['codex'])];
    const jobs=messages.map(m=>h.store.forMessage(m.id,'codex')),batchId=id();
    h.store.createBatch({id:batchId,deliveryIds:jobs.map(d=>d.id),payload:batchEnvelope({id:batchId,side:'codex'},messages)});
    h.store.updateBatch(batchId,'completed');h.store.log('test','private old log',old);
    h.store.addImage({id:'shared-image',filename:'shared.png',mime:'image/png',bytes:4,w:1,h:1,sha256:'test'});
    h.store.markSeen('codex','c','turn:already-read');
    const next=await h.relay.createRoom({title:'keep current'});
    const keep=h.store.addMessage({sender:'user',text:'keep me',meta:{images:[{id:'shared-image'}]}});h.store.root(keep.rootId,20);
    h.relay.updateRoom({roomId:old,archived:true});h.relay.selectRoom(old);h.store.set('paused',false);
    const result=h.relay.deleteRoom({roomId:old});
    assert.deepEqual(result,{ok:true,roomId:old,selectedRoomId:next.id});
    assert.equal(h.store.room(old),null);assert.equal(h.store.room(next.id).parentId,null);
    assert.equal(h.store.activeRoomId(),next.id);assert.equal(h.store.get('codexId'),'c');assert.equal(h.store.get('paused'),false);
    assert.equal(h.store.message(keep.id).text,'keep me');assert(h.store.image('shared-image'));
    assert(h.store.seen('codex','c','turn:already-read'));assert(h.store.deletedRef('batch',batchId));
    const all=h.store.exportHistory();assert.deepEqual(all.messages.map(m=>m.id),[keep.id]);assert.equal(all.batches.length,0);assert.equal(all.deliveries.length,0);
    assert(!all.logs.some(l=>l.room_id===old));
    assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM message_events').get().n,1);
    assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM roots').get().n,1);
    assert.deepEqual(h.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.deepEqual(h.adapters.codex.sent,[]);assert.deepEqual(h.adapters.deepseek.sent,[]);
  }finally{h.store.close();}
});

test('deletion rejects the active room and every unresolved delivery or batch, including unknown states',()=>{
  const h=harness();try{
    const active=h.store.activeRoomId();
    assert.throws(()=>h.relay.deleteRoom({roomId:active}),e=>e.code==='busy'&&/当前投递话题/.test(e.message));
    for(const status of ['queued','sending','running','unknown','blocked','failed','future-status']){
      const room=h.store.createRoom({title:status}),message=h.store.addMessage({sender:'user',text:'retain',roomId:room.id});
      h.store.db.prepare('INSERT INTO deliveries(id,message_id,side,status,created_at,updated_at,room_id,session_id) VALUES(?,?,?,?,?,?,?,?)').run(id(),message.id,'codex',status,1,1,room.id,'c');
      assert.throws(()=>h.relay.deleteRoom({roomId:room.id}),e=>e.code==='busy');assert(h.store.room(room.id));assert(h.store.message(message.id));
    }
    const room=h.store.createRoom({title:'orphan unresolved batch'});
    h.store.db.prepare('INSERT INTO batches(id,side,room_id,session_id,payload,delivery_ids,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id(),'codex',room.id,'c','payload','[]','unknown',1,1);
    assert.throws(()=>h.relay.deleteRoom({roomId:room.id}),e=>e.code==='busy');
    h.relay.changingRoom=true;assert.throws(()=>h.relay.deleteRoom({roomId:room.id}),e=>e.code==='busy');
    assert.throws(()=>h.store.deleteRoom(''),e=>e.code==='input');assert.throws(()=>h.store.deleteRoom('missing'),e=>e.code==='not_found');
  }finally{h.store.close();}
});

test('a mid-delete database failure rolls back messages, deliveries, roots, dedup identities and selected room',async()=>{
  const h=harness();try{
    const m=h.relay.sendUser('retain on failure',['codex']),job=h.store.forMessage(m.id,'codex');h.relay.cancel(job.id);
    const next=await h.relay.createRoom();h.relay.selectRoom(m.roomId);h.store.log('test','retain log',m.roomId);
    h.store.db.exec("CREATE TRIGGER reject_room_delete BEFORE DELETE ON rooms BEGIN SELECT RAISE(ABORT,'simulated deletion failure'); END;");
    assert.throws(()=>h.relay.deleteRoom({roomId:m.roomId}),/simulated deletion failure/);
    assert(h.store.room(m.roomId));assert(h.store.message(m.id));assert(h.store.delivery(job.id));
    assert.equal(h.store.get('selectedRoomId'),m.roomId);assert.equal(h.store.activeRoomId(),next.id);
    assert.equal(h.store.deletedRef('message',m.id),false);assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM roots WHERE id=?').get(m.rootId).n,1);
    assert.deepEqual(h.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{h.store.close();}
});

test('inbox cursors and deleted native identities survive deletion of the newest event and database reopen',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'relay-room-delete-')),file=path.join(dir,'relay.sqlite');let h=harness(file);
  try{
    const message=h.relay.sendUser('cancelled history',['codex']),job=h.store.forMessage(message.id,'codex');
    h.store.updateDelivery(job.id,'cancelled',{receipt:{nativeTurnId:'late-receipt',requestId:job.id}});
    const cursor=h.store.inbox({side:'deepseek',all:true}).latestCursor;
    const next=await h.relay.createRoom();h.relay.deleteRoom({roomId:message.roomId});
    assert.equal(h.store.inbox({side:'deepseek',all:true,after:cursor}).latestCursor,cursor);
    h.store.close();h={store:new Store(file),adapters:adapters()};h.relay=new Relay(h.store,h.adapters);
    const inputs=[
      {id:'late-envelope',inputs:[{kind:'user',text:envelope(message)}]},
      {id:'late-request',inputs:[{kind:'user',text:'text lost by adapter',requestId:job.id}]},
      {id:'late-receipt',inputs:[]},
    ];
    for(const t of inputs)h.relay.ingest('codex','c',{turns:[{...t,status:'completed',outputs:[{id:'out-'+t.id,text:'must not return'}]}]});
    assert.equal(h.store.state(next.id).messages.length,0);assert.equal(h.store.jobs('deepseek').length,0);
    for(const t of inputs)assert(h.store.seen('codex','c','turn:'+t.id));
    const fresh=h.store.addMessage({sender:'user',text:'new event'}),inbox=h.store.inbox({side:'deepseek',all:true,after:cursor});
    assert.deepEqual(inbox.messages.map(m=>m.id),[fresh.id]);assert(Number(inbox.latestCursor)>Number(cursor));
  }finally{h.store.close();await rm(dir,{recursive:true,force:true});}
});

test('a deleted cancelled batch cannot resurrect through its old envelope or request identity',async()=>{
  const h=harness();try{
    const messages=[h.relay.sendUser('one',['codex']),h.relay.sendUser('two',['codex'])],batchId=id();
    const payload=batchEnvelope({id:batchId,side:'codex'},messages);
    h.store.createBatch({id:batchId,deliveryIds:messages.map(m=>h.store.forMessage(m.id,'codex').id),payload});h.store.updateBatch(batchId,'cancelled');
    await h.relay.createRoom();h.relay.deleteRoom({roomId:messages[0].roomId});
    for(const [turnId,input] of [['batch-envelope',{text:payload}],['batch-request',{text:'missing payload',requestId:batchId}]]){
      h.relay.ingest('codex','c',{turns:[{id:turnId,status:'completed',inputs:[{kind:'user',...input}],outputs:[{id:'out',text:'do not import'}]}]});
      assert(h.store.seen('codex','c','turn:'+turnId));
    }
    assert.equal(h.store.state().messages.length,0);assert.equal(h.store.jobs('deepseek').length,0);
  }finally{h.store.close();}
});

test('HTTP deletion enforces local authentication, CSRF and 404/409 contract, and leaves production-style binding untouched',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'relay-delete-http-')),service=await makeService({dataDir:dir,adapters:adapters()});
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+service.server.address().port;
  try{
    const cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0],headers={cookie,origin:base,'x-relay-ui':'1','content-type':'application/json'};
    const post=(body,h=headers)=>fetch(base+'/api/rooms/delete',{method:'POST',headers:h,body:JSON.stringify(body)});
    const active=service.store.activeRoomId(),old=service.store.createRoom({title:'remove'}),other=service.store.createRoom({title:'keep'});
    service.store.addMessage({sender:'user',text:'old',roomId:old.id});service.store.set('selectedRoomId',old.id);
    assert.equal((await post({roomId:old.id},{'content-type':'application/json'})).status,401);
    assert.equal((await post({roomId:old.id},{...headers,origin:'https://other.example'})).status,403);
    assert.equal((await post({roomId:active})).status,409);assert.equal((await post({})).status,400);
    const blocked=service.store.addMessage({sender:'user',text:'queued',roomId:other.id});
    service.store.db.prepare('INSERT INTO deliveries(id,message_id,side,status,created_at,updated_at,room_id,session_id) VALUES(?,?,?,?,?,?,?,?)').run(id(),blocked.id,'codex','unknown',1,1,other.id,'old-native-session');
    assert.equal((await post({roomId:other.id})).status,409);
    const response=await post({roomId:old.id});assert.equal(response.status,200);assert.equal((await response.json()).selectedRoomId,active);
    assert.equal((await post({roomId:old.id})).status,404);assert(service.store.room(other.id));
    const state=await (await fetch(base+'/api/state',{headers:{cookie}})).json();assert.equal(state.roomId,active);assert(!state.rooms.some(r=>r.id===old.id));
    const stale=await fetch(base+'/api/state?roomId='+old.id,{headers:{cookie}});assert.equal(stale.status,200);assert.equal((await stale.json()).roomId,active);
    assert((await (await fetch(base+'/api/health')).json()).features.includes('room-delete-v1'));
  }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});
