import { initialBoard } from '../game.js';
import { applyCustomPositionOperation } from '../custom-position-store.js';
const variant = new URLSearchParams(location.search).get('variant');
const api = await import('../custom-position-idb.js'+(variant?'?variant='+variant:''));
const { createCustomPositionIDB, CUSTOM_POSITION_DATABASE } = api;
window.events=[];window.lifecycle=[];window.ops={};window.probes=[];
let currentOp=null, armed=null, failWrites=null, suppressComplete=false, abortRead=false;
const nativeTx=IDBDatabase.prototype.transaction, transactions=[], tokens=new Map();
function emit(type,details={}){const event={type,at:Date.now(),perf:performance.now(),...details};events.push(event);window.trace?.(JSON.stringify(event));if(['pagehide','freeze','native-terminal','outcome'].includes(type))navigator.sendBeacon('/journal',JSON.stringify(event));}
IDBDatabase.prototype.transaction=function(...args){
 const tx=nativeTx.apply(this,args),entry={operationId:currentOp,committing:false,terminal:null,requests:[],id:crypto.randomUUID()};transactions.push(entry);
 const commit=tx.commit.bind(tx),abort=tx.abort.bind(tx),objectStore=tx.objectStore.bind(tx);
 tx.commit=()=>{commit();entry.committing=true;emit('commit-called',{operationId:entry.operationId});};
 tx.abort=()=>{abort();entry.abortRequested=true;emit('abort-requested',{operationId:entry.operationId});};
 tx.addEventListener('complete',event=>{entry.terminal='COMPLETE';emit('native-terminal',{operationId:entry.operationId,terminal:'COMPLETE',trusted:event.isTrusted});});
 tx.addEventListener('abort',event=>{entry.terminal='ABORT';emit('native-terminal',{operationId:entry.operationId,terminal:'ABORT',trusted:event.isTrusted,error:tx.error?.name});});
 if(suppressComplete&&currentOp)Object.defineProperty(tx,'oncomplete',{set(){},get(){return null;}});
 tx.objectStore=name=>{const store=objectStore(name),get=store.get.bind(store),put=store.put.bind(store),add=store.add.bind(store);
  store.get=key=>{const request=get(key);entry.requests.push(request);if(currentOp&&abortRead)request.addEventListener('success',()=>{if(abortRead){abortRead=false;adapter.suspend('test-cancel');}});return request;};
  store.put=(value,key)=>{if(currentOp&&failWrites==='quota'&&key==='metadata')throw new DOMException('Injected quota','QuotaExceededError');const request=put(value,key);request.addEventListener('success',()=>emit('request-success',{operationId:entry.operationId,key}));if(currentOp&&failWrites==='abort'&&key==='metadata')add(value,key);return request;};return store;};
 return tx;
};
function phases(){return Object.fromEntries(transactions.filter(t=>t.operationId).map(t=>[t.operationId,{phase:t.terminal??(t.committing?'committing':'read-pending'),committing:t.committing,requests:t.requests.map(r=>r.readyState),abortRequested:!!t.abortRequested}]));}
for(const [target,type]of [[document,'freeze'],[document,'resume'],[window,'pagehide'],[window,'pageshow']])target.addEventListener(type,event=>{const item={type,persisted:event.persisted??null,isTrusted:event.isTrusted,phases:phases()};lifecycle.push(item);emit(type,item);},true);
window.addEventListener('error',e=>emit('page-error',{message:e.message}));window.addEventListener('unhandledrejection',e=>emit('unhandled-rejection',{message:String(e.reason)}));
const adapter=createCustomPositionIDB({durability:new URLSearchParams(location.search).get('durability')||'default'});adapter.attachLifecycle();
function board(i=0){const b=initialBoard(),pawns=[[3,0],[3,2],[3,6],[3,8],[6,0],[6,2],[6,6],[6,8]];pawns.forEach(([r,c],bit)=>{if(i&(1<<bit))b[r][c]=null;});return b;}
function position(i=0){return{title:'test '+i,initialBoard:board(i),sideToMove:'red',playPreferences:{humanSide:'black',difficulty:'medium'}};}
async function direct(envelope,metadata){const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(CUSTOM_POSITION_DATABASE,1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});await new Promise((resolve,reject)=>{const tx=nativeTx.call(db,'state','readwrite');tx.objectStore('state').put(envelope,'envelope');tx.objectStore('state').put(metadata,'metadata');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.commit();});db.close();}
async function seed(count=1){const state=await adapter.read(),timestamp='2026-11-02T00:00:00.000Z';if(!state.ok)throw Error(state.code);const envelope={version:1,revision:0,positions:Array.from({length:count},(_,i)=>({id:'seed-'+i,...position(i),createdAt:timestamp,updatedAt:timestamp}))};const metadata={version:1,storageInstanceId:crypto.randomUUID(),baseEnvelope:envelope,commits:[],committedOperationIds:[],lastCommit:null};await direct(envelope,metadata);return adapter.read();}
async function prepare(command={type:'rename',id:'seed-0',title:'changed'},options){const state=await adapter.read();if(!state.ok)throw Error(state.code);const t=adapter.prepare(state.snapshot,command,options);tokens.set(t.operationId,t);return t;}
function mutate(value){const id=typeof value==='string'?value:value.operationId,t=tokens.get(id);currentOp=id;ops[id]={token:t};adapter.write(t).then(result=>{ops[id].result=result;currentOp=null;emit('outcome',{operationId:id,status:result.status,code:result.code,nativeEvent:result.nativeEvent});});return{operationId:id};}
function probe(id){const c=new MessageChannel();c.port1.onmessage=()=>{probes.push(id);emit('probe',{id});c.port1.close();c.port2.close();};c.port2.postMessage(id);}
window.poc={adapter,api,position,board,seed,prepare,mutate,probe,direct,
 preview:(snapshot,t)=>{const applied=applyCustomPositionOperation(snapshot.envelope,t.command,{now:()=>t.preparedAt,idFactory:()=>t.positionId}),envelope=structuredClone(applied.envelope);envelope.revision=t.expectedRevision+1;const key=applied.result.position?.id??t.command.id,old=snapshot.envelope.positions.findIndex(p=>p.id===key),next=envelope.positions.findIndex(p=>p.id===key);const r={operation:t,revision:envelope.revision,committedAt:t.preparedAt,delta:{index:old<0?next:old,before:snapshot.envelope.positions[old]??null,after:envelope.positions[next]??null}};return{envelope,metadata:{...snapshot.metadata,commits:[...snapshot.metadata.commits,r],committedOperationIds:[...snapshot.metadata.committedOperationIds,t.operationId],lastCommit:{operationId:t.operationId,revision:envelope.revision,committedAt:t.preparedAt}}};},
 read:()=>adapter.read(),verify:t=>adapter.verifyOutcome(t),resume:()=>adapter.resume(),
 faults:options=>{failWrites=options.failWrites??null;suppressComplete=!!options.suppressComplete;abortRead=!!options.abortRead;},
 inspect:()=>({phases:phases(),lifecycle,probes,operations:ops,visibility:document.visibilityState}),
 arm:t=>{armed=t;},
 foreignWrite:async snapshot=>{const db=await new Promise(resolve=>{const r=indexedDB.open(CUSTOM_POSITION_DATABASE,1);r.onsuccess=()=>resolve(r.result);});await new Promise((resolve,reject)=>{const tx=nativeTx.call(db,'state','readwrite');tx.objectStore('state').put(snapshot.envelope,'envelope');tx.objectStore('state').put(snapshot.metadata,'metadata');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.commit();});db.close();return{status:'COMMITTED'};}
};
document.getElementById('leave').addEventListener('click',()=>{if(armed){mutate(armed);armed=null;}});
window.ready=adapter.open();
