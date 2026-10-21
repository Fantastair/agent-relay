import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {safeError} from './util.mjs';
export function normalizeQuotaSnapshot(snapshot,{now=Date.now(),maxAge=600000}={}){
  const used=snapshot?.usedPercent,checkedAt=snapshot?.checkedAt;
  const rawReset=snapshot?.resetAt,resetAt=typeof rawReset==='number'?(rawReset<1e12?rawReset*1000:rawReset):null;
  if(typeof used!=='number'||!Number.isFinite(used)||used<0||used>100||typeof checkedAt!=='number'||!Number.isFinite(checkedAt)||checkedAt<=0||checkedAt>now+60000||!Number.isFinite(resetAt)||resetAt<=0||snapshot.window!=='5h')return {status:'unknown',note:'Codex 额度快照缺少有效的五小时窗口数据'};
  const stale=now-checkedAt>maxAge||resetAt<=now;
  return {status:stale?'stale':'ok',usedPercent:used,remainingPercent:100-used,window:'5h',checkedAt,resetAt,source:snapshot.source==='codex-app-tools/get_usage_limits'?snapshot.source:'codex-snapshot',...(stale?{note:'额度快照已过期，请由 Codex 重新查询；不能据此判断额度耗尽'}:{})};
}
export async function readQuotaSnapshot(dataDir,options){
  let codex;try{codex=normalizeQuotaSnapshot(JSON.parse(await readFile(path.join(dataDir,'quota','codex.json'),'utf8')),options);}catch{codex={status:'unknown',note:'尚无可读取的 Codex 额度快照'};}
  return {codex,checkedAt:options?.now??Date.now()};
}

export function normalizeLiveQuota(side,value,{now=Date.now()}={}){
  if(side==='codex'){
    const primary=(value?.rateLimitsByLimitId?.codex||value?.rateLimits)?.primary;
    if(primary?.windowDurationMins!==300)throw new Error('Codex 未提供五小时额度窗口');
    const quota=normalizeQuotaSnapshot({usedPercent:primary.usedPercent,window:'5h',checkedAt:now,resetAt:primary.resetsAt,source:'codex-app-tools/get_usage_limits'},{now});
    if(quota.status!=='ok')throw new Error(quota.note||'Codex 额度数据无效');
    return {...quota,live:true,...(typeof value.ordinaryUsageAllowed==='boolean'?{ordinaryUsageAllowed:value.ordinaryUsageAllowed}:{})};
  }
  const raw=value?.balance,balance=typeof raw==='number'?raw:typeof raw==='string'&&raw.trim()?Number(raw):NaN;
  if(!Number.isFinite(balance)||balance<0||typeof value?.currency!=='string'||!/^[A-Z]{3}$/.test(value.currency))throw new Error('DeepSeek 余额格式无效');
  return {status:'ok',balance,currency:value.currency,checkedAt:now,source:'dsh-account',live:true};
}

// Account reads are independent of chat health. One slow/failed provider must
// never hold up the other or make a stale quota look like zero allowance.
export class QuotaCache{
  constructor({dataDir,codex,deepseek,ttl=60000,initialWait=8000,now=Date.now}={}){
    this.dataDir=dataDir;this.adapters={codex,deepseek};this.ttl=ttl;this.initialWait=initialWait;this.now=now;this.closed=false;
    this.entries=Object.fromEntries(['codex','deepseek'].map(side=>[side,{data:{status:'unknown',note:side==='codex'?'尚无可读取的 Codex 额度':'尚无可读取的 DeepSeek 余额'},attemptedAt:null,error:null,pending:null}]));
  }
  load(side){
    const entry=this.entries[side];if(this.closed)return Promise.resolve();if(entry.pending)return entry.pending;
    if(this.now()-(entry.attemptedAt??-Infinity)<this.ttl)return Promise.resolve();entry.attemptedAt=this.now();
    entry.pending=Promise.resolve().then(async()=>{
      if(typeof this.adapters[side]?.quota!=='function')throw new Error('当前适配器未提供额度查询');
      const data=normalizeLiveQuota(side,await this.adapters[side].quota(),{now:this.now()});if(this.closed)return;
      entry.data=data;entry.error=null;
      if(side==='codex'&&this.dataDir){try{await mkdir(path.join(this.dataDir,'quota'),{recursive:true});await writeFile(path.join(this.dataDir,'quota','codex.json'),JSON.stringify(data,null,2),'utf8');}catch{/* Live result stays usable even when snapshot persistence fails. */}}
    }).catch(async error=>{
      if(this.closed)return;entry.error=safeError(error);
      if(entry.data.checkedAt){entry.data={...entry.data,status:'stale',live:false,note:'实时查询失败，显示上次结果：'+entry.error};return;}
      if(side==='codex'&&this.dataDir){const saved=(await readQuotaSnapshot(this.dataDir,{now:this.now()})).codex;if(this.closed)return;if(saved.status!=='unknown'){entry.data={...saved,status:'stale',live:false,note:'实时查询不可用，显示额度快照：'+entry.error};return;}}
      entry.data={status:'unknown',live:false,note:entry.error};
    }).finally(()=>{entry.pending=null;});return entry.pending;
  }
  async get(){
    const first=Object.values(this.entries).some(entry=>entry.attemptedAt===null),pending=Promise.all(['codex','deepseek'].map(side=>this.load(side)));
    if(first){let timer;try{await Promise.race([pending,new Promise(resolve=>{timer=setTimeout(resolve,this.initialWait);})]);}finally{clearTimeout(timer);}}
    return this.snapshot();
  }
  snapshot(){
    const result={checkedAt:this.now(),refreshing:false,sources:{}};
    for(const [side,entry] of Object.entries(this.entries)){
      let quota={...entry.data};if(quota.checkedAt&&(this.now()-quota.checkedAt>600000||(side==='codex'&&quota.resetAt<=this.now())))quota={...quota,status:'stale',live:false,note:quota.note||'额度数据已过期，等待重新查询'};
      result[side]=quota;result.sources[side]={loading:!!entry.pending,error:entry.error,updatedAt:quota.checkedAt||null};result.refreshing||=!!entry.pending;
    }
    return result;
  }
  close(){this.closed=true;}
}
