import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function liveTestContext({env=process.env,argv=process.argv}={}){
  if(env.NODE_TEST_CONTEXT||env.RELAY_ALLOW_LIVE_TESTS!=='1'||!argv.includes('--live'))return null;
  if(!env.RELAY_TEST_URL||!env.RELAY_TEST_DATA_DIR)throw new Error('真实联调必须明确设置 RELAY_TEST_URL 和 RELAY_TEST_DATA_DIR');
  const url=new URL(env.RELAY_TEST_URL);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('真实联调仅允许明确的本机回环根地址');
  const dataDir=path.resolve(env.RELAY_TEST_DATA_DIR),production=fileURLToPath(new URL('../data/',import.meta.url));
  if((dataDir.toLowerCase()===path.resolve(production).toLowerCase()||url.port==='4319')&&env.RELAY_ALLOW_PRODUCTION_TESTS!=='1')throw new Error('禁止对正式服务运行联调；正式目标另需明确的 RELAY_ALLOW_PRODUCTION_TESTS=1');
  return {url:url.origin,dataDir};
}
