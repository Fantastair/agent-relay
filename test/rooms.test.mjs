import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.mjs';
import {Relay} from '../src/relay.mjs';
import {envelope} from '../src/util.mjs';
import {makeService} from '../src/server.mjs';
import {startPreview} from '../scripts/preview.mjs';
import {fileURLToPath} from 'node:url';

function harness(){
  const store=new Store(':memory:');
  store.set('codexId','c');store.set('deepseekId','d');store.set('paused',false);
  const adapters=Object.fromEntries(['codex','deepseek'].map(side=>[side,{
    state:'idle',turns:[],sent:[],
    async snapshot(sessionId){return {id:sessionId,title:side,state:this.state,turns:this.turns};},
    async send(sessionId,text,requestId){this.sent.push({sessionId,text,requestId});return {nativeTurnId:requestId};},
    async list(){return [];},async projects(){return {projects:[]};},async workspaces(){return [];},
  }]));
  return {store,adapters,relay:new Relay(store,adapters)};
}

test('preview rejects the production data directory before opening the database',async()=>{
  const production=fileURLToPath(new URL('../data/',import.meta.url));
  await assert.rejects(startPreview({dataDir:production,port:0}),/禁止使用正式/);
});

test('legacy migration preserves identities, receipts, roots, seen and room binding; restart is idempotent',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'relay-rooms-'));
  try{
    const file=path.join(dir,'old.sqlite'),db=new DatabaseSync(file);
    db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO settings VALUES('codexId','"original-c"'),('deepseekId','"original-d"');
      CREATE TABLE messages(id TEXT PRIMARY KEY,sender TEXT NOT NULL,text TEXT NOT NULL,reply_to TEXT,root_id TEXT NOT NULL,hop INTEGER NOT NULL DEFAULT 0,native_key TEXT UNIQUE,meta TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL);
      INSERT INTO messages VALUES('root','user','keep me',NULL,'root',0,NULL,'{}',1);
      CREATE TABLE deliveries(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES messages(id),side TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(message_id,side));
      INSERT INTO deliveries VALUES('delivery','root','codex','sending','{"requestId":"once"}',NULL,1,1,1);
      CREATE TABLE roots(id TEXT PRIMARY KEY,max_turns INTEGER NOT NULL);INSERT INTO roots VALUES('root',4);
      CREATE TABLE seen(side TEXT NOT NULL,session_id TEXT NOT NULL,native_key TEXT NOT NULL,PRIMARY KEY(side,session_id,native_key));
      INSERT INTO seen VALUES('codex','original-c','turn:completed');`);
    db.close();
    let s=new Store(file),roomId=s.activeRoomId();
    assert.equal(s.rooms().length,1);assert.equal(s.room(roomId).kind,'legacy');
    assert.equal(s.message('root').roomId,roomId);assert.equal(s.message('root').text,'keep me');
    assert.equal(s.delivery('delivery').sessionId,'original-c');assert.equal(s.delivery('delivery').roomId,roomId);
    assert.equal(s.delivery('delivery').status,'unknown');assert.equal(s.delivery('delivery').receipt.requestId,'once');
    assert.equal(s.db.prepare('SELECT max_turns FROM roots WHERE id=?').get('root').max_turns,4);
    assert(s.seen('codex','original-c','turn:completed'));s.close();
    s=new Store(file);assert.equal(s.rooms().length,1);assert.equal(s.activeRoomId(),roomId);assert.equal(s.exportHistory().messages.length,1);s.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('new topic isolates messages and exports, keeps bindings and pauses sends',async()=>{
  const h=harness();try{
    const old=h.store.addMessage({sender:'user',text:'old topic'}),room=await h.relay.createRoom({title:'新任务'});
    assert.notEqual(room.id,old.roomId);assert.equal(room.kind,'topic');assert.equal(room.parentId,old.roomId);
    assert.equal(room.codexId,'c');assert.equal(h.store.get('paused'),true);assert.equal(h.relay.state().settings.roomId,room.id);
    assert.equal(h.relay.state().messages.length,0);
    const fresh=h.relay.sendUser('new topic',['codex'],room.id);
    assert.equal(h.store.forMessage(fresh.id,'codex').sessionId,'c');assert.equal(h.store.forMessage(fresh.id,'codex').roomId,room.id);
    assert.deepEqual(h.relay.state(old.roomId).messages.map(m=>m.text),['old topic']);
    assert.equal(h.store.exportHistory(old.roomId).messages.length,1);assert.equal(h.store.exportHistory(old.roomId).deliveries.length,0);
    assert.equal(h.store.exportHistory().messages.length,2);assert.equal(h.store.exportHistory().rooms.length,2);
  }finally{h.store.close();}
});

test('browsing history while busy does not change bindings, pause or queue; old tabs cannot send',async()=>{
  const h=harness();try{
    const oldRoom=h.store.activeRoomId(),next=await h.relay.createRoom({title:'another'});
    h.store.set('paused',false);const m=h.relay.sendUser('running',['codex'],next.id);await h.relay.tick('codex');
    h.relay.selectRoom(oldRoom);const view=h.relay.state();
    assert.equal(view.settings.roomId,oldRoom);assert.equal(view.settings.activeRoomId,next.id);assert(view.readOnly);
    assert.equal(h.store.get('paused'),false);assert.equal(h.store.forMessage(m.id,'codex').status,'running');assert.equal(h.store.get('codexId'),'c');
    assert.throws(()=>h.relay.sendUser('stale tab',['codex'],oldRoom),/历史话题/);
    assert.throws(()=>h.relay.sendUser('implicit stale view',['codex']),/历史话题/);
    await assert.rejects(h.relay.activateRoom(oldRoom),/未完成投递/);
  }finally{h.store.close();}
});

test('every unresolved delivery prevents topic creation and rebinding atomically',async()=>{
  for(const status of ['queued','sending','running','unknown','blocked','failed']){
    const h=harness();try{
      const m=h.relay.sendUser('stay',['codex']),job=h.store.forMessage(m.id,'codex'),roomId=h.store.activeRoomId();h.store.updateDelivery(job.id,status);
      await assert.rejects(h.relay.createRoom(),/未完成投递/);
      await assert.rejects(h.relay.bindPair({codexId:'new-c',deepseekId:'new-d'}),/未完成投递/);
      assert.equal(h.store.rooms().length,1);assert.equal(h.store.activeRoomId(),roomId);assert.equal(h.store.get('codexId'),'c');assert.equal(h.store.delivery(job.id).status,status);
    }finally{h.store.close();}
  }
});

test('native work also prevents switching and invalid room updates cannot partially rename',async()=>{
  const h=harness();try{
    h.adapters.codex.state='running';await assert.rejects(h.relay.createRoom(),/正在工作/);assert.equal(h.store.rooms().length,1);
    const room=h.store.room(h.store.activeRoomId());
    assert.throws(()=>h.relay.updateRoom({roomId:room.id,title:'partial',archived:'yes'}),/归档选项/);
    assert.equal(h.store.room(room.id).title,room.title);
    assert.throws(()=>h.relay.updateRoom({roomId:room.id,archived:true}),/当前投递话题/);
  }finally{h.store.close();}
});

test('creating a topic preserves completed native messages not yet polled without relaying them',async()=>{
  const h=harness();try{
    const original=h.store.activeRoomId();
    h.adapters.codex.turns=[{id:'direct',status:'completed',inputs:[{id:'direct-input',kind:'user',text:'written in native app'}],outputs:[{id:'direct-output',text:'finished just now'}]}];
    const fresh=await h.relay.createRoom({title:'next'});
    assert.equal(h.store.state(fresh.id).messages.length,0);
    assert.deepEqual(h.store.state(original).messages.map(m=>m.text),['written in native app','finished just now']);
    assert.equal(h.store.jobs('deepseek').length,0);assert(h.store.seen('codex','c','turn:direct'));
  }finally{h.store.close();}
});

test('late handled replies stay in their original topic without triggering another agent',async()=>{
  const h=harness();try{
    const m=h.relay.sendUser('old',['codex']),job=h.store.forMessage(m.id,'codex');h.store.updateDelivery(job.id,'unknown');h.relay.resolve(job.id,'handled',true);
    const next=await h.relay.createRoom({title:'next'});
    const snap={state:'idle',turns:[{id:'late',status:'completed',inputs:[{id:'in',kind:'user',text:envelope(m)}],outputs:[{id:'out',text:'late reply'}]}]};
    h.relay.ingest('codex','c',snap);h.relay.ingest('codex','c',snap);
    assert.equal(h.store.state(next.id).messages.length,0);
    const history=h.store.state(m.roomId).messages;assert.equal(history.length,2);assert.equal(history[1].replyTo,m.id);assert.equal(history[1].rootId,m.rootId);
    assert.equal(h.store.jobs('deepseek').length,0);assert.throws(()=>h.relay.forward(history[1].id,'deepseek'),/历史话题/);
    h.adapters.codex.turns=snap.turns;await h.relay.activateRoom(m.roomId);
    assert.equal(h.store.get('paused'),true);assert.equal(h.store.get('codexId'),'c');assert.equal(h.store.state().messages.length,2);
  }finally{h.store.close();}
});

test('resuming an old binding imports a previously unseen late reply before setting its baseline',async()=>{
  const h=harness();try{
    const m=h.relay.sendUser('old',['codex']),job=h.store.forMessage(m.id,'codex');h.store.updateDelivery(job.id,'unknown');h.relay.resolve(job.id,'handled',true);
    await h.relay.bindPair({codexId:'new-c',deepseekId:'new-d'});
    h.adapters.codex.snapshot=async sessionId=>({state:'idle',turns:sessionId==='c'?[{id:'late',status:'completed',inputs:[{kind:'user',text:envelope(m)}],outputs:[{id:'a',text:'arrived later'}]}]:[]});
    await h.relay.activateRoom(m.roomId);
    assert.equal(h.store.state().messages.at(-1).text,'arrived later');assert.equal(h.store.state().messages.at(-1).roomId,m.roomId);
    assert.equal(h.store.jobs('deepseek').length,0);assert.equal(h.store.get('codexId'),'c');
  }finally{h.store.close();}
});

test('immutable delivery target blocks accidental routing when settings are externally changed',async()=>{
  const h=harness();try{
    const m=h.relay.sendUser('never send elsewhere',['codex']),d=h.store.forMessage(m.id,'codex');h.store.set('codexId','wrong-session');
    await h.relay.tick('codex');assert.equal(h.adapters.codex.sent.length,0);assert.equal(h.store.delivery(d.id).status,'blocked');assert.equal(h.store.delivery(d.id).sessionId,'c');assert.equal(h.store.get('paused'),true);
  }finally{h.store.close();}
});

test('HTTP room contract filters history, rejects stale sends and preserves local authentication',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'relay-room-http-')),h=harness();
  const service=await makeService({dataDir:dir,adapters:h.adapters});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+service.server.address().port;
  try{
    const home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];
    const post=async(url,body)=>fetch(base+'/api/'+url,{method:'POST',headers:{cookie,origin:base,'x-relay-ui':'1','content-type':'application/json'},body:JSON.stringify(body)});
    service.store.set('codexId','c');service.store.set('deepseekId','d');const old=service.store.addMessage({sender:'user',text:'retained'});
    let r=await post('rooms',{title:'HTTP topic'});assert.equal(r.status,200);const {room}=await r.json();
    assert.equal((await (await fetch(base+'/api/state?roomId='+old.roomId,{headers:{cookie}})).json()).messages[0].text,'retained');
    assert.equal((await (await fetch(base+'/api/export?roomId='+room.id,{headers:{cookie}})).json()).messages.length,0);
    assert.equal((await (await fetch(base+'/api/export',{headers:{cookie}})).json()).messages.length,1);
    assert.equal((await post('message',{roomId:old.roomId,text:'stale'})).status,400);
    assert.equal((await post('rooms/select',{roomId:old.roomId})).status,200);
    assert.equal((await post('message',{text:'implicit stale'})).status,400);
    assert.equal((await post('rooms/update',{roomId:old.roomId,title:'Renamed',archived:true})).status,200);
    assert(service.store.room(old.roomId).archived);assert.equal(service.store.room(old.roomId).title,'Renamed');
    assert.equal((await post('rooms/activate',{roomId:old.roomId})).status,200);
    assert.equal(service.store.get('paused'),true);assert.equal(service.store.room(old.roomId).archived,false);
    assert.equal((await post('rooms/update',{roomId:old.roomId,title:'x'.repeat(81)})).status,400);
    assert.equal((await fetch(base+'/api/state?roomId=missing',{headers:{cookie}})).status,400);
    assert.equal((await fetch(base+'/api/state?roomId='+old.roomId)).status,401);
  }finally{await service.close();h.store.close();await rm(dir,{recursive:true,force:true});}
});

test('two localhost instances can share a browser cookie jar without replacing each other',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'relay-cookie-')),h=harness(),services=[];
  try{
    for(const name of ['a','b']){const service=await makeService({dataDir:path.join(dir,name),adapters:h.adapters});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));services.push(service);}
    const bases=services.map(s=>'http://127.0.0.1:'+s.server.address().port),cookies=[];
    for(const base of bases)cookies.push((await fetch(base)).headers.get('set-cookie').split(';')[0]);
    assert.notEqual(cookies[0].split('=')[0],cookies[1].split('=')[0]);
    for(const base of bases)assert.equal((await fetch(base+'/api/state',{headers:{cookie:cookies.join('; ')}})).status,200);
  }finally{for(const s of services)await s.close();h.store.close();await rm(dir,{recursive:true,force:true});}
});
