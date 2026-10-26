import test from 'node:test';
import assert from 'node:assert/strict';
import {DshAdapter} from '../src/adapters/dsh.mjs';
import {RelayError} from '../src/util.mjs';

test('DSH retries an explicitly rejected prompt once after refreshing the host',async()=>{
  const adapter=new DshAdapter(),calls=[],discoveries=[];adapter.base='http://127.0.0.1:1';
  adapter.discover=async force=>{discoveries.push({force:!!force,base:adapter.base});return force?'http://127.0.0.1:2':'http://127.0.0.1:1';};
  adapter.raw=async(base,method,args,rpcId)=>{calls.push({base,method,args,rpcId});if(calls.length===1)throw new RelayError('HTTP 401','auth');return {accepted:true};};
  const args={request:{requestId:'unique-request',sessionId:'dedicated'}};
  assert.deepEqual(await adapter.api('session/prompt',args,'unique-request'),{accepted:true});
  assert.equal(calls.length,2);assert.deepEqual(calls.map(call=>call.rpcId),['unique-request','unique-request']);
  assert.equal(calls[1].base,'http://127.0.0.1:2');assert.strictEqual(calls[1].args,args);
  assert.deepEqual(discoveries,[{force:false,base:'http://127.0.0.1:1'},{force:true,base:null}]);
});

test('DSH authentication refresh has a one-retry bound',async()=>{
  const adapter=new DshAdapter();let attempts=0;
  adapter.discover=async()=> 'http://127.0.0.1:1';adapter.raw=async()=>{attempts++;throw new RelayError('HTTP 403','auth');};
  await assert.rejects(adapter.api('session/prompt',{},'request'),error=>error.code==='auth');assert.equal(attempts,2);
});

test('DSH does not resend a prompt whose transport outcome is uncertain',async()=>{
  const adapter=new DshAdapter();let attempts=0,discoveries=0;
  adapter.discover=async()=>{discoveries++;return 'http://127.0.0.1:1';};adapter.raw=async()=>{attempts++;throw new RelayError('timeout','offline',true);};
  await assert.rejects(adapter.api('session/prompt',{},'request'),error=>error.uncertain===true);assert.equal(attempts,1);assert.equal(discoveries,1);
});
