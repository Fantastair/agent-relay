import {CodexAdapter} from '../src/adapters/codex.mjs';
import {writeFile,readFile} from 'node:fs/promises';
const report={checkedAt:new Date().toISOString(),checks:{}};
for(const [name,sourceThreadId] of [['deleted-source','01a15cb6-753f-76b0-8dd2-1b88adb1a500'],['cold-existing-source','01a15ba8-6689-7972-a2e6-52fd05cad086']]){
  const c=new CodexAdapter({sourceThreadId});try{const projects=await c.projects();report.checks[name]={ok:Array.isArray(projects.projects),resolvedContext:c.callerThreadId()};console.log(name,report.checks[name]);if(name==='deleted-source'){const list=await c.list();report.checks.catalogReadable=list.length>0;try{await c.snapshot(sourceThreadId);throw new Error('Deleted target unexpectedly readable');}catch(e){report.checks.deletedTargetClearError=e.code==='missing_session';if(e.code!=='missing_session')throw e;}}}catch(e){report.checks[name]={ok:false,error:e.message};process.exitCode=1;}finally{c.close();}
}
await writeFile(new URL('../data/context-fix-report.json',import.meta.url),JSON.stringify(report,null,2));console.log(report);
