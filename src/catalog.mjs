import {safeError} from './util.mjs';

// Cache discovery only. Binding and sending always use fresh adapter snapshots.
export class CatalogCache {
  constructor(loaders,{ttl=30000,retryAfter=5000,now=Date.now}={}) {
    this.loaders=loaders;this.ttl=ttl;this.retryAfter=retryAfter;this.now=now;this.closed=false;
    this.entries=Object.fromEntries(Object.keys(loaders).map(key=>[key,{data:[],updatedAt:null,attemptedAt:null,error:null,pending:null}]));
  }
  load(key,{force=false}={}) {
    const entry=this.entries[key];
    if(this.closed)return Promise.resolve();
    if(entry.pending)return entry.pending;
    const age=this.now()-(entry.attemptedAt??-Infinity),interval=entry.error?this.retryAfter:this.ttl;
    if(!force&&age<interval)return Promise.resolve();
    entry.attemptedAt=this.now();
    entry.pending=Promise.resolve().then(()=>this.loaders[key]()).then(data=>{
      if(!Array.isArray(data))throw new Error('会话目录格式不正确');
      if(this.closed)return;
      entry.data=data;entry.updatedAt=this.now();entry.error=null;
    }).catch(error=>{if(!this.closed)entry.error=safeError(error);}).finally(()=>{entry.pending=null;});
    return entry.pending;
  }
  refresh({force=false}={}) {return Promise.all(Object.keys(this.entries).map(key=>this.load(key,{force})));}
  async get({partial=false,refresh=false}={}) {
    const hasSnapshot=Object.values(this.entries).every(entry=>entry.updatedAt!==null||entry.error!==null);
    const pending=this.refresh({force:refresh});
    // Keep the original endpoint compatible: its very first response contains
    // the full result. Clients requesting partial=1 can show fast sources now.
    if(!hasSnapshot&&!partial)await pending;
    return this.snapshot();
  }
  snapshot() {
    const sources={},data={},errors=[];
    for(const [key,entry] of Object.entries(this.entries)) {
      data[key]=entry.data;
      sources[key]={updatedAt:entry.updatedAt,loading:!!entry.pending,error:entry.error,stale:entry.updatedAt!==null&&(!!entry.error||this.now()-entry.updatedAt>=this.ttl)};
      if(entry.error)errors.push(`${key}：${entry.error}`);
    }
    return {...data,errors,refreshing:Object.values(sources).some(source=>source.loading),sources,updatedAt:Math.max(0,...Object.values(sources).map(source=>source.updatedAt||0))||null};
  }
  close() {this.closed=true;}
}

export function catalogLoaders(codex,deepseek) {
  return {
    codex:async()=>(await codex.list()).map(t=>({id:t.id,title:t.title,state:t.status,cwd:t.cwd})),
    deepseek:async()=>(await deepseek.list()).map(t=>({id:t.sessionId,title:t.projections?.values?.title||t.sessionId,state:t.running?'running':'idle',cwd:t.cwd})),
    workspaces:()=>deepseek.workspaces(),
    projects:async()=>(await codex.projects()).projects||[],
  };
}
