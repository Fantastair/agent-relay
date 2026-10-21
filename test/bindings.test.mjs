import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {CodexAdapter} from '../src/adapters/codex.mjs';
import {Store} from '../src/store.mjs';
import {Relay} from '../src/relay.mjs';
import {RelayError} from '../src/util.mjs';
import {provisionNewPair} from '../src/provision.mjs';

test('deleted business session does not poison control context or hide missing-session error',async()=>{
  const c=new CodexAdapter({sourceThreadId:'control'});c.callerThreadId=preferred=>preferred;
  let calls=0;c.appConnection=async()=>{c.catalog=[{name:'read_thread',namespace:'codex_app'}];return {request:async(_method,p)=>{calls++;assert.equal(p.threadId,'control');assert.equal(p.arguments.threadId,'deleted-target');return {success:false,contentItems:[{type:'inputText',text:'No Codex thread found for threadId: deleted-target'}]};}};};
  await assert.rejects(c.snapshot('deleted-target'),e=>e.code==='missing_session'&&e.message.includes('已删除'));assert.equal(calls,1);
});
test('control caller falls back to an existing thread when its configured context was deleted',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'relay-context-'));try{const file=path.join(dir,'state.sqlite'),db=new DatabaseSync(file);db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,archived INTEGER,updated_at_ms INTEGER)');db.prepare('INSERT INTO threads VALUES(?,?,?)').run('existing',0,100);db.close();const c=new CodexAdapter({stateDb:file,sourceThreadId:'deleted'});assert.equal(c.callerThreadId(),'existing');}finally{await rm(dir,{recursive:true,force:true});}
});
test('ambiguous native create is never automatically repeated',async()=>{
  const c=new CodexAdapter({sourceThreadId:'control'});c.callerThreadId=x=>x;let calls=0;
  c.appConnection=async()=>{c.catalog=[{name:'create_thread',namespace:'codex_app'}];return {request:async()=>{calls++;const e=new RelayError('Codex app tool request failed','rpc_error');e.rpcCode=-32000;throw e;}};};
  await assert.rejects(c.create({title:'test'}),e=>e.uncertain===true);assert.equal(calls,1);
});
function pairHarness(){const store=new Store(':memory:');store.set('codexId','old-c');store.set('deepseekId','old-d');let ci=0,di=0;const codex={projects:async()=>({projects:[]}),create:async()=>({id:'c'+(++ci)}),snapshot:async id=>({id,state:'idle',title:id,turns:[]})};const deepseek={workspaces:async()=>[{workspaceId:'w',path:'D:/work'}],create:async({onCreated})=>{const id='d'+(++di);await onCreated?.(id);return {id};},verifyWorkspace:async()=>{},snapshot:async id=>({id,state:'idle',title:id,turns:[]})};return {store,codex,deepseek};}
test('explicit create always makes a fresh pair and keeps earlier history',async()=>{
  const h=pairHarness();try{const original=h.store.addMessage({sender:'user',text:'keep this'});const args={...h,workspaceId:'w',defaultWorkspacePath:'D:/work'},first=await provisionNewPair(args),second=await provisionNewPair(args);assert.notEqual(first.codexId,second.codexId);assert.notEqual(first.deepseekId,second.deepseekId);assert.notEqual(first.roomId,second.roomId);assert.equal(h.store.get('codexId'),second.codexId);assert.equal(h.store.get('channelHistory').length,2);assert.equal(h.store.state().messages.length,0);assert.equal(h.store.state(original.roomId).messages[0].text,'keep this');assert.equal(h.store.exportHistory().messages.length,1);}finally{h.store.close();}
});
test('partial creation preserves previous binding and records the recoverable draft',async()=>{
  const h=pairHarness();h.deepseek.create=async()=>{throw new Error('DSH offline');};try{await assert.rejects(provisionNewPair({...h,workspaceId:'w',defaultWorkspacePath:'D:/work'}));assert.equal(h.store.get('codexId'),'old-c');assert.equal(h.store.get('deepseekId'),'old-d');assert.equal(h.store.get('provisionDraft').codexId,'c1');}finally{h.store.close();}
});
test('specified pair changes together; invalid target leaves both bindings untouched',async()=>{
  const h=pairHarness(),relay=new Relay(h.store,{codex:h.codex,deepseek:h.deepseek});try{h.deepseek.snapshot=async()=>{throw new RelayError('missing','missing_session');};await assert.rejects(relay.bindPair({codexId:'chosen-c',deepseekId:'missing-d'}));assert.equal(h.store.get('codexId'),'old-c');assert.equal(h.store.get('deepseekId'),'old-d');h.deepseek.snapshot=async id=>({id,state:'idle',title:id,turns:[{id:'old',status:'completed',inputs:[],outputs:[]}]});await relay.bindPair({codexId:'chosen-c',deepseekId:'chosen-d'});assert.equal(h.store.get('codexId'),'chosen-c');assert.equal(h.store.get('deepseekId'),'chosen-d');assert.equal(h.store.get('paused'),true);assert(h.store.seen('deepseek','chosen-d','turn:old'));}finally{h.store.close();}
});
test('binding waits for a background read instead of reporting a non-existent queued task',async()=>{
  const h=pairHarness(),relay=new Relay(h.store,{codex:h.codex,deepseek:h.deepseek});relay.busy.codex=true;
  try{const binding=relay.bindPair({codexId:'chosen-c',deepseekId:'chosen-d'});setTimeout(()=>{relay.busy.codex=false;},20);await binding;assert.equal(h.store.get('codexId'),'chosen-c');assert.equal(relay.busy.codex,false);}finally{h.store.close();}
});
