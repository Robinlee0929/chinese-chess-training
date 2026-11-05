import { createCustomPositionRepository } from '../custom-position-repository.js';
import { createCustomPositionIDB, CUSTOM_POSITION_DATABASE } from '../custom-position-idb.js';
import { createCustomPositionMigration } from '../custom-position-migration.js';
import { CUSTOM_POSITION_STORAGE_KEY } from '../custom-position-store.js';
import { initialBoard } from '../game.js';

const emit = (type, fields = {}) => window.trace?.(JSON.stringify({ type, perf: performance.now(), ...fields }));
const nativeTransaction = IDBDatabase.prototype.transaction;
let transactions = [], fault = null, operationCount = 0, activeHandle = null, current = true;
let repository, scope, handles = new Map(), results = new Map(), generation = 0;
const inspectors = [], nativeEvents = [];
const options = { durability: new URLSearchParams(location.search).get('durability') || 'default' };
IDBDatabase.prototype.transaction = function(...args) {
  const tx = nativeTransaction.apply(this,args), n = activeHandle ? ++operationCount : 0;
  const entry = { id: crypto.randomUUID(), n, reads: [], committing: false, terminal: null, operationId: activeHandle?.identity.operationId };
  transactions.push(entry);
  const commit = tx.commit.bind(tx), store = tx.objectStore.bind(tx);
  tx.commit = () => { commit(); entry.committing = true;
    if (n === 2 && fault === 'after-commit') queueMicrotask(() => activeHandle.cancel('test-after-commit'));
  };
  for (const type of ['complete','abort']) tx.addEventListener(type,event=> {
    entry.terminal = type.toUpperCase(); const observed = { id: entry.id, n, terminal: entry.terminal, trusted: event.isTrusted, operationId: entry.operationId };
    nativeEvents.push(observed); emit('native-terminal', observed);
  });
  if (n === 2 && fault === 'suppress-complete') Object.defineProperty(tx,'oncomplete',{set(){},get(){return null;}});
  tx.objectStore = name => {
    const s = store(name), get=s.get.bind(s),put=s.put.bind(s),add=s.add.bind(s);
    s.get = key => { const r=get(key);entry.reads.push(r);
      if(entry.reads.length===2)emit('reads-queued',{id:entry.id,n,operationId:entry.operationId,requests:entry.reads.map(q=>q.readyState)});
      if(n===2 && fault==='precommit')r.addEventListener('success',()=>activeHandle.cancel('test-precommit'),{once:true});
      return r;
    };
    s.put = (value,key) => {
      if(n===2 && fault==='quota' && key==='metadata')throw new DOMException('Injected quota','QuotaExceededError');
      const r=put(value,key);
      if(n===2 && fault==='abort-after-success' && key==='metadata') {r.addEventListener('success',()=>emit('put-success',{id:entry.id,key}));add(value,key);}
      return r;
    }; return s;
  }; return tx;
};
window.addEventListener('error',e=>emit('page-error',{message:e.message}));
window.addEventListener('unhandledrejection',e=>emit('unhandled-rejection',{message:String(e.reason)}));
for(const [target,type]of [[document,'freeze'],[document,'resume'],[window,'pagehide'],[window,'pageshow']]) target.addEventListener(type,e=>emit(type,{trusted:e.isTrusted,persisted:e.persisted??null,phases:inspect().phases}),true);
function newScope() { current=true;const captured=++generation;scope=repository.createScope({isCurrent:()=>current&&captured===generation});activeHandle=null; }
function install() { repository?.dispose();repository=createCustomPositionRepository(options);repository.attachLifecycle();newScope();handles=new Map();results=new Map();fault=null; }
async function reset() {
  repository?.dispose(); for(const a of inspectors.splice(0))a.dispose();
  await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(CUSTOM_POSITION_DATABASE);r.onsuccess=resolve;r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('delete blocked'));});
  localStorage.removeItem(CUSTOM_POSITION_STORAGE_KEY);install(); return true;
}
const fence = s => ({ snapshot:s, storageInstanceId:s.metadata.storageInstanceId, expectedRevision:s.envelope.revision });
function position(side='red') { return {title:'Repository test',initialBoard:initialBoard(),sideToMove:side,playPreferences:{humanSide:'black',difficulty:'easy'}}; }
async function read() { const a=createCustomPositionIDB({initializeEmpty:false,...options});try{return await a.read();}finally{a.dispose();} }
function start(type,args,expected) {
  operationCount=0; const handle=scope[type](...args,expected); activeHandle=handle;
  handles.set(handle.identity.requestId,handle);
  handle.completion.then(result=>{results.set(handle.identity.requestId,result);emit('repository-result',{requestId:handle.identity.requestId,status:result.status,code:result.code,persistence:result.persistence?.status});});
  return {requestId:handle.identity.requestId,operationId:handle.identity.operationId,identity:handle.identity};
}
function inspect() { return {phases:transactions.map(e=>({id:e.id,n:e.n,phase:e.terminal??(e.committing?'committing':'read-pending'),requests:e.reads.map(r=>r.readyState),operationId:e.operationId})),nativeEvents}; }
async function direct(state) {
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(CUSTOM_POSITION_DATABASE,1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try {await new Promise((resolve,reject)=>{const tx=nativeTransaction.call(db,'state','readwrite');tx.objectStore('state').put(state.envelope,'envelope');tx.objectStore('state').put(state.metadata,'metadata');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.commit();});}finally{db.close();}
}
window.poc={position,fence,read,reset,start,inspect,
  direct,
  initialize:()=>scope.initialize().completion,
  list:()=>scope.loadAll().completion,
  get:(id,f)=>scope.getPosition(id,f).completion,
  result:id=>results.get(id), wait:id=>handles.get(id).completion,
  cancel:id=>handles.get(id).cancel(), close:()=>scope.close(), stale:()=>{current=false;},
  apply:id=>scope.canApply(handles.get(id),results.get(id)),
  token:id=>results.get(id)?.token,
  verify:t=>repository.verifyOutcome(t),
  fault:value=>{fault=value;},
  newScope,
  migration:async()=>{const r=await scope.inspectMigration().completion;window.plan=r.plan;return r;},
  confirm:()=>scope.confirmMigration(window.plan,{confirmed:true,legacyWritersStopped:true}).completion,
  legacy:raw=>{localStorage.setItem(CUSTOM_POSITION_STORAGE_KEY,raw);},
  legacyRaw:()=>localStorage.getItem(CUSTOM_POSITION_STORAGE_KEY),
  stage:async()=>{const m=createCustomPositionMigration(options),view=await m.inspect();m.dispose();const a=createCustomPositionIDB({initializeEmpty:false});try {return await a.write(a.prepareMigration(null,{type:'stage',migrationId:view.plan.migrationId,sourceFingerprint:view.plan.sourceFingerprint,envelope:view.plan.envelope},{storageInstanceId:view.plan.storageInstanceId}));}finally{a.dispose();}},
  probe:id=>{const c=new MessageChannel();c.port1.onmessage=()=>{emit('probe',{id});c.port1.close();c.port2.close();};c.port2.postMessage(id);},
};
install(); window.ready=Promise.resolve();
