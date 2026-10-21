import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {Relay} from '../src/relay.mjs';
import {makeService} from '../src/server.mjs';
import {envelope,parseEnvelope} from '../src/util.mjs';

function harness(){const store=new Store(':memory:');store.set('codexId','c');store.set('deepseekId','d');const adapters=Object.fromEntries(['codex','deepseek'].map(side=>[side,{async list(){return [];},async workspaces(){return [];},async projects(){return {projects:[]};},async snapshot(){return {state:'idle',title:side,turns:[]};}}]));return {store,adapters,relay:new Relay(store,adapters)};}

test('agent and test injection retain their sender; repeated text is not treated as a duplicate',()=>{
  const h=harness();try{
    const agent=h.relay.sendMessage({sender:'deepseek',origin:'agent',text:'status update'});
    assert.equal(agent.sender,'deepseek');assert.equal(agent.meta.origin,'agent');assert.deepEqual(agent.meta.targets,['codex']);
    const probe=h.relay.sendMessage({sender:'codex',origin:'test',text:'integration probe',targets:['deepseek']});
    assert.equal(probe.sender,'codex');assert.match(envelope(probe),/origin=test/);assert.equal(parseEnvelope(envelope(probe)).sender,'codex');
    h.relay.sendUser('again');h.relay.sendUser('again');assert.equal(h.store.state().messages.filter(m=>m.text==='again').length,2);
    assert.throws(()=>h.relay.sendMessage({sender:'codex',origin:'console',text:'false user'}),/来源不匹配/);
  }finally{h.store.close();}
});

test('explicit client identity makes retry idempotent and rejects identity reuse for changed contents',()=>{
  const h=harness();try{
    const body={text:'once',sender:'user',origin:'console',clientMessageId:'click-1'},first=h.relay.sendMessage(body),again=h.relay.sendMessage({...body,targets:['deepseek','codex']});
    assert.equal(first.id,again.id);assert.equal(h.store.state().messages.length,1);assert.equal(h.store.state().deliveries.length,2);
    assert.throws(()=>h.relay.sendMessage({...body,text:'something else'}),/不同内容/);assert.equal(h.store.state().messages.length,1);
    const other=h.relay.sendMessage({text:'once',sender:'codex',origin:'agent',clientMessageId:'click-1'});assert.notEqual(other.id,first.id);
  }finally{h.store.close();}
});

test('inbox defaults to the active room while browsing another room; all scope pages without replay',async()=>{
  const h=harness();try{
    const original=h.store.activeRoomId(),old=h.store.addMessage({sender:'user',text:'old room'});
    const active=h.store.createRoom({title:'current',codexId:'c',deepseekId:'d'});h.store.activateRoom(active.id);h.relay.selectRoom(original);
    const first=h.store.addMessage({sender:'user',text:'current room'});h.store.addMessage({sender:'codex',text:'own output'});
    const second=h.store.addMessage({sender:'deepseek',text:'peer output'});
    assert.deepEqual(h.store.inbox({side:'codex'}).messages.map(m=>m.id),[first.id,second.id]);
    const page1=h.store.inbox({side:'codex',all:true,limit:1});assert.equal(page1.messages[0].id,old.id);assert(page1.hasMore);
    const page2=h.store.inbox({side:'codex',all:true,after:page1.nextCursor,limit:1});assert.equal(page2.messages[0].id,first.id);
    const page3=h.store.inbox({side:'codex',all:true,after:page2.nextCursor,limit:1});assert.equal(page3.messages[0].id,second.id);assert(!page3.hasMore);
    assert.equal(h.store.inbox({side:'codex',all:true,after:page3.nextCursor}).messages.length,0);
    assert.deepEqual(h.store.inbox({side:'codex',all:true,after:first.id}).messages.map(m=>m.id),[second.id]);
    assert.throws(()=>h.store.inbox({side:'codex',all:true,after:'missing'}),/不存在/);
  }finally{h.store.close();}
});

test('inbox reads past the timeline limit and keeps a stable cursor across database reopen',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'relay-inbox-'));try{
    const file=path.join(dir,'state.sqlite');let s=new Store(file);
    s.transaction(()=>{for(let i=0;i<530;i++)s.addMessage({sender:'user',text:'message '+i});});
    assert.equal(s.state().messages.length,500);const first=s.inbox({side:'codex',limit:500});assert(first.hasMore);assert.equal(first.messages[0].text,'message 0');
    const bookmark=first.nextCursor;s.close();s=new Store(file);
    const next=s.inbox({side:'codex',after:bookmark,limit:500});assert.equal(next.messages.length,30);assert.equal(next.messages[0].text,'message 500');
    const end=next.nextCursor;s.addMessage({sender:'codex',text:'own'});assert.equal(s.inbox({side:'codex',after:end}).messages.length,0);
    const afterOwn=s.inbox({side:'codex',after:end}).nextCursor;s.addMessage({sender:'deepseek',text:'arrives later'});
    assert.equal(s.inbox({side:'codex',after:afterOwn}).messages[0].text,'arrives later');s.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('compact protocol requires both bound sessions to declare the same loaded version',()=>{
  const h=harness();try{
    const msg=h.relay.sendUser('task');assert.match(envelope(msg),/中转约定/);assert.equal(h.relay.protocolState().mode,'reminder');
    h.relay.confirmProtocol({side:'codex',sessionId:'c',version:'1.1.0'});assert.equal(h.relay.protocolState().mode,'reminder');
    h.relay.confirmProtocol({side:'deepseek',sessionId:'d',version:'1.0.0'});assert.equal(h.relay.protocolState().mode,'reminder');
    h.relay.confirmProtocol({side:'deepseek',sessionId:'d',version:'1.1.0'});assert.equal(h.relay.protocolState().mode,'compact');
    const compact=envelope(msg,{compact:true});assert.equal(compact,`[relay from=user id=${msg.id} reply-to=-]\ntask`);assert.equal(parseEnvelope(compact).id,msg.id);
    h.store.set('deepseekId','different-session');assert.equal(h.relay.protocolState().mode,'reminder');
    assert.throws(()=>h.relay.confirmProtocol({side:'deepseek',sessionId:'d',version:'1.1.0'}),/当前侧/);
  }finally{h.store.close();}
});

test('HTTP enforces human versus tool authors, authenticates inbox and protocol, and exposes unknown quota safely',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'relay-collab-')),h=harness(),service=await makeService({dataDir:dir,adapters:h.adapters});
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+service.server.address().port;
  try{
    service.store.set('codexId','c');service.store.set('deepseekId','d');
    assert((await (await fetch(base+'/api/health')).json()).features.includes('message-attribution-v1'));
    const cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];
    const post=(route,body,tool=false)=>fetch(base+'/api/'+route,{method:'POST',headers:{'content-type':'application/json',...(tool?{authorization:'Bearer '+service.key}:{cookie,origin:base,'x-relay-ui':'1'})},body:JSON.stringify(body)});
    assert.equal((await post('message',{text:'human'})).status,200);
    assert.equal((await post('message',{text:'spoof',sender:'deepseek',origin:'agent'})).status,403);
    assert.equal((await post('message',{text:'implicit tool'},true)).status,403);
    assert.equal((await post('message',{text:'spoof human',sender:'user',origin:'console'},true)).status,403);
    const native=await post('message',{text:'agent',sender:'deepseek',origin:'agent'},true);assert.equal(native.status,200);assert.equal((await native.json()).message.sender,'deepseek');
    assert.equal((await post('message',{text:'test',sender:'codex',origin:'test'},true)).status,200);
    assert.equal((await post('protocol/ready',{side:'codex',sessionId:'c',version:'1.1.0'})).status,403);
    assert.equal((await post('protocol/ready',{side:'codex',sessionId:'c',version:'1.1.0'},true)).status,200);
    assert.equal((await fetch(base+'/api/inbox?as=codex')).status,401);
    const inbox=await (await fetch(base+'/api/inbox?as=codex&limit=1',{headers:{cookie}})).json();assert.equal(inbox.messages.length,1);assert.equal(inbox.scope,'room');
    assert.equal((await fetch(base+'/api/inbox?as=wrong',{headers:{cookie}})).status,400);
    const quota=await (await fetch(base+'/api/quota',{headers:{cookie}})).json();assert.equal(quota.codex.status,'unknown');assert(!JSON.stringify(quota).includes(service.key));
  }finally{await service.close();h.store.close();await rm(dir,{recursive:true,force:true});}
});
