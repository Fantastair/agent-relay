import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {liveTestContext} from '../src/integration-guard.mjs';
test('native integration requires explicit opt-in and cannot run under the Node test runner',()=>{
  assert.equal(liveTestContext({env:{},argv:[]}),null);
  assert.equal(liveTestContext({env:{RELAY_ALLOW_LIVE_TESTS:'1'},argv:[]}),null);
  assert.equal(liveTestContext({env:{NODE_TEST_CONTEXT:'child',RELAY_ALLOW_LIVE_TESTS:'1'},argv:['--live']}),null);
  assert.throws(()=>liveTestContext({env:{RELAY_ALLOW_LIVE_TESTS:'1'},argv:['--live']}),/明确设置/);
  const env={RELAY_ALLOW_LIVE_TESTS:'1',RELAY_TEST_URL:'http://127.0.0.1:4322',RELAY_TEST_DATA_DIR:'D:/independent-test'};
  assert.equal(liveTestContext({env,argv:['--live']}).url,'http://127.0.0.1:4322');
  assert.throws(()=>liveTestContext({env:{...env,RELAY_TEST_URL:'http://127.0.0.1:4319'},argv:['--live']}),/禁止对正式/);
  assert.throws(()=>liveTestContext({env:{...env,RELAY_TEST_DATA_DIR:fileURLToPath(new URL('../data/',import.meta.url))},argv:['--live']}),/禁止对正式/);
  assert.throws(()=>liveTestContext({env:{...env,RELAY_TEST_URL:'https://example.com'},argv:['--live']}),/本机回环/);
});
test('accidentally discovered real test scripts exit before reading credentials or touching the relay',()=>{
  for(const name of ['live-test.mjs','restart-test.mjs']){
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/'+name,import.meta.url))],{encoding:'utf8',env:{...process.env,NODE_TEST_CONTEXT:'child',RELAY_ALLOW_LIVE_TESTS:'1',RELAY_TEST_DATA_DIR:'D:/does-not-exist'}});
    assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/SKIP/);assert.doesNotMatch(result.stderr,/control.key|ENOENT/);
  }
});
