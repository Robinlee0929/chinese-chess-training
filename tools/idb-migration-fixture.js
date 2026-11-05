import { createCustomPositionMigration } from '../custom-position-migration.js';
import { createCustomPositionIDB, CUSTOM_POSITION_DATABASE } from '../custom-position-idb.js';
import { CUSTOM_POSITION_STORAGE_KEY } from '../custom-position-store.js';
window.events=[];window.probes=[];
let manager,adapter,writeFault=null,stopAfterStage=false,changeAfterStage=null,changeAfterActive=null,hideActiveComplete=false,armStage=false,denyRead=false;
let pendingStageOperationId=null;
const transactions=[],nativeTx=IDBDatabase.prototype.transaction;
function emit(type,details={}){const e={type,at:Date.now(),perf:performance.now(),...details};events.push(e);window.trace?.(JSON.stringify(e));if(['pagehide','freeze','native-terminal'].includes(type))navigator.sendBeacon('/journal',JSON.stringify(e));}
IDBDatabase.prototype.transaction=function(...args){
 const tx=nativeTx.apply(this,args),entry={id:crypto.randomUUID(),createdPerf:performance.now(),phase:'read-pending',requests:[],readKeys:[],readCallbacks:0,commitPerf:null,action:null,operationId:pendingStageOperationId};pendingStageOperationId=null;transactions.push(entry);
 emit('tx-created',{id:entry.id,operationId:entry.operationId});
 const commit=tx.commit.bind(tx),abort=tx.abort.bind(tx),objectStore=tx.objectStore.bind(tx);
 tx.commit=()=>{commit();entry.commitPerf=performance.now();entry.phase='committing';emit('commit-called',{id:entry.id,action:entry.action,operationId:entry.operationId});};
 tx.abort=()=>{abort();entry.abortRequested=true;emit('abort-requested',{id:entry.id});};
 tx.addEventListener('complete',e=>{entry.phase='COMPLETE';emit('native-terminal',{id:entry.id,action:entry.action,operationId:entry.operationId,terminal:'COMPLETE',trusted:e.isTrusted});
  if(entry.action==='STAGED'&&stopAfterStage){stopAfterStage=false;manager.suspend('test-interruption');}
  if(entry.action==='STAGED'&&changeAfterStage!==null){localStorage.setItem(CUSTOM_POSITION_STORAGE_KEY,changeAfterStage);changeAfterStage=null;}
  if(entry.action==='ACTIVE'&&changeAfterActive!==null){localStorage.setItem(CUSTOM_POSITION_STORAGE_KEY,changeAfterActive);changeAfterActive=null;}
 });
 tx.addEventListener('abort',e=>{entry.phase='ABORT';emit('native-terminal',{id:entry.id,action:entry.action,operationId:entry.operationId,terminal:'ABORT',trusted:e.isTrusted});});
 if(hideActiveComplete){let handler;Object.defineProperty(tx,'oncomplete',{get:()=>handler,set:fn=>{handler=e=>{if(entry.action!=='ACTIVE')fn(e);};tx.addEventListener('complete',handler);}});}
 tx.objectStore=name=>{const s=objectStore(name),get=s.get.bind(s),put=s.put.bind(s),add=s.add.bind(s);
  s.get=key=>{const r=get(key);entry.requests.push(r);entry.readKeys.push(key);
   r.addEventListener('success',()=>{entry.readCallbacks++;entry.lastReadCallbackPerf=performance.now();});
   // Observation only: no task, timer, await or pause is inserted into the transaction.
   if(entry.operationId&&entry.requests.length===2){entry.readsQueuedPerf=performance.now();emit('stage-reads-queued',{id:entry.id,operationId:entry.operationId,requests:entry.requests.map(q=>q.readyState)});}
   return r;};
  s.put=(value,key)=>{
   if(key==='metadata'&&value.migration){entry.action=value.migration.state;entry.operationId=entry.action==='STAGED'?value.migration.stagedOperationId:value.migration.activatedOperationId;}
   if(key==='metadata'&&writeFault==='quota')throw new DOMException('Injected quota','QuotaExceededError');
   const r=put(value,key);r.addEventListener('success',()=>emit('request-success',{id:entry.id,key,action:entry.action}));
   if(key==='metadata'&&writeFault==='abort')add(value,key);
   return r;
  };return s;
 };return tx;
};
function phases(){return Object.fromEntries(transactions.map(t=>[t.id,{phase:t.phase,action:t.action,operationId:t.operationId,requests:t.requests.map(r=>r.readyState),readKeys:t.readKeys,readCallbacks:t.readCallbacks,createdPerf:t.createdPerf,readsQueuedPerf:t.readsQueuedPerf??null,lastReadCallbackPerf:t.lastReadCallbackPerf??null,commitPerf:t.commitPerf,abortRequested:!!t.abortRequested}]))}
for(const [target,type]of [[document,'freeze'],[document,'resume'],[window,'pagehide'],[window,'pageshow']])target.addEventListener(type,e=>emit(type,{isTrusted:e.isTrusted,persisted:e.persisted??null,wasDiscarded:document.wasDiscarded,phases:phases()}),true);
window.addEventListener('error',e=>emit('page-error',{message:e.message}));window.addEventListener('unhandledrejection',e=>emit('unhandled-rejection',{message:String(e.reason)}));
function build(){manager=createCustomPositionMigration({storage:()=>{if(denyRead)throw new DOMException('Denied','SecurityError');return localStorage;}});manager.attachLifecycle();adapter=createCustomPositionIDB({initializeEmpty:false});adapter.attachLifecycle();}
build();
function probe(id){const channel=new MessageChannel();channel.port1.onmessage=()=>{probes.push(id);emit('probe',{id});channel.port1.close();channel.port2.close();};channel.port2.postMessage(id);}
async function raw(){const request=indexedDB.open(CUSTOM_POSITION_DATABASE,1),db=await new Promise((res,rej)=>{request.onsuccess=()=>res(request.result);request.onerror=()=>rej(request.error);request.onupgradeneeded=()=>request.result.createObjectStore('state');});return new Promise((res,rej)=>{const t=nativeTx.call(db,'state','readonly'),s=t.objectStore('state'),v={};s.get('envelope').onsuccess=e=>v.envelope=e.target.result??null;s.get('metadata').onsuccess=e=>v.metadata=e.target.result??null;t.oncomplete=()=>{db.close();res(v)};t.onabort=()=>{db.close();rej(t.error)}});}
async function direct(s){const request=indexedDB.open(CUSTOM_POSITION_DATABASE,1),db=await new Promise((res,rej)=>{request.onsuccess=()=>res(request.result);request.onerror=()=>rej(request.error)});return new Promise((res,rej)=>{const t=nativeTx.call(db,'state','readwrite');t.objectStore('state').put(s.envelope,'envelope');t.objectStore('state').put(s.metadata,'metadata');t.oncomplete=()=>{db.close();res(true)};t.onabort=()=>{db.close();rej(t.error)};t.commit()});}
async function stageToken(){await adapter.open();const t=adapter.prepareMigration(null,{type:'stage',migrationId:plan.migrationId,sourceFingerprint:plan.sourceFingerprint,envelope:plan.envelope},{storageInstanceId:plan.storageInstanceId});window.stageOperation=t;return t;}
window.poc={manager,adapter,api:{createCustomPositionIDB,CUSTOM_POSITION_DATABASE},raw,direct,probe,inspect:()=>({phases:phases(),probes,events,wasDiscarded:document.wasDiscarded}),
 legacy:raw=>{if(raw===null)localStorage.removeItem(CUSTOM_POSITION_STORAGE_KEY);else localStorage.setItem(CUSTOM_POSITION_STORAGE_KEY,raw);},legacyRaw:()=>localStorage.getItem(CUSTOM_POSITION_STORAGE_KEY),
 plan:async()=>{const r=await manager.inspect();window.plan=r.plan;return r;},confirm:()=>manager.confirmMigration(plan,{confirmed:true,legacyWritersStopped:true}),
 stageToken,stage:()=>{window.stageResult=null;pendingStageOperationId=stageOperation.operationId;adapter.write(stageOperation).then(r=>{pendingStageOperationId=null;window.stageResult=r;emit('stage-outcome',{operationId:stageOperation.operationId,status:r.status,code:r.code,nativeEvent:r.nativeEvent})});return stageOperation.operationId;},
 begin:()=>{window.confirmResult=null;manager.confirmMigration(plan,{confirmed:true,legacyWritersStopped:true}).then(r=>{window.confirmResult=r;emit('migration-outcome',{state:r.state,outcome:r.outcome,code:r.code})});return true;},
 faults:o=>{writeFault=o.writeFault??null;stopAfterStage=!!o.stopAfterStage;changeAfterStage=o.changeAfterStage??null;changeAfterActive=o.changeAfterActive??null;hideActiveComplete=!!o.hideActiveComplete;denyRead=!!o.denyRead;},
 reset:async()=>{manager.dispose();adapter.dispose();await new Promise((res,rej)=>{const r=indexedDB.deleteDatabase(CUSTOM_POSITION_DATABASE);r.onsuccess=res;r.onerror=()=>rej(r.error);r.onblocked=()=>rej(Error('test reset blocked'));});build();poc.manager=manager;poc.adapter=adapter;},
 arm:()=>{armStage=true;},close:()=>{manager.dispose();adapter.dispose();}
};
document.getElementById('leave').addEventListener('click',()=>{if(armStage){armStage=false;poc.stage();}});
window.ready=Promise.resolve(true);
