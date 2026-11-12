import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createGameTransferValidationClient} from './game-transfer/worker-client.js';
import {parseGameTransfer, GameTransferError} from './game-transfer/game-transfer.js';
import {transfer, terminal, longGame, longCompletedGame} from './tools/game-transfer-fixtures.mjs';

const json=JSON.stringify(transfer());
function harness() {
  const workers=[],timers=new Map();let time=0, timerId=0;
  class WorkerDouble {
    constructor(url,options){this.url=url;this.options=options;this.stopped=0;workers.push(this);}
    postMessage(message){this.message=structuredClone(message);}
    terminate(){this.stopped++;}
    success(){this.onmessage?.({data:{kind:'game-transfer-validation',requestId:this.message.requestId,ok:true,value:parseGameTransfer(this.message.input)}});}
  }
  const client=createGameTransferValidationClient({WorkerClass:WorkerDouble,now:()=>time,
    setTimer:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id)});
  return {client,workers,timers,setTime:value=>{time=value;}};
}
test('Worker success validates actual input; isolated module URL, fixed deadline and termination',async()=>{
  const h=harness(),promise=h.client.validate(json),worker=h.workers[0];
  assert.match(worker.url.pathname,/game-transfer\/validation-worker.js$/);
  assert.deepEqual(worker.options,{type:'module',name:'game-transfer-validation'});
  assert.equal([...h.timers.values()][0].ms,10000);
  worker.success();const result=await promise;
  assert.deepEqual(result.document,transfer());assert.ok(Object.isFrozen(result.document.initialPosition.board[0]));
  assert.equal(worker.stopped,1);assert.equal(h.timers.size,0);h.client.dispose();assert.equal(worker.stopped,1);
});
test('cancel terminates worker, rejects once and cannot accept a retained late callback',async()=>{
  const h=harness(),promise=h.client.validate(json),worker=h.workers[0],late=worker.onmessage;
  h.client.cancel();await assert.rejects(promise,{code:'CANCELLED'});
  late({data:{kind:'game-transfer-validation',requestId:1,ok:true,value:parseGameTransfer(json)}});
  assert.equal(worker.stopped,1);assert.equal(h.timers.size,0);
});
test('timeout terminates worker and ignores delayed valid completion',async()=>{
  const h=harness(),promise=h.client.validate(json),worker=h.workers[0],late=worker.onmessage;
  h.setTime(10000);[...h.timers.values()][0].fn();
  await assert.rejects(promise,{code:'VALIDATION_TIMEOUT'});
  late({data:{kind:'game-transfer-validation',requestId:1,ok:true,value:parseGameTransfer(json)}});
  assert.equal(worker.stopped,1);assert.equal(h.timers.size,0);
});
test('deadline is enforced before accepting a message even if timer callback is delayed',async()=>{
  const h=harness(),promise=h.client.validate(json);h.setTime(10001);h.workers[0].success();
  await assert.rejects(promise,{code:'VALIDATION_TIMEOUT'});assert.equal(h.workers[0].stopped,1);
});
test('new validation supersedes prior work; wrong or old IDs never settle the new work',async()=>{
  const h=harness(),first=h.client.validate(json),old=h.workers[0],late=old.onmessage;
  const second=h.client.validate(json),current=h.workers[1];await assert.rejects(first,{code:'CANCELLED'});
  late({data:{kind:'game-transfer-validation',requestId:1,ok:true,value:parseGameTransfer(json)}});
  current.onmessage({data:{kind:'game-transfer-validation',requestId:1,ok:true,value:parseGameTransfer(json)}});
  assert.equal(current.stopped,0);assert.equal(h.timers.size,1);
  current.success();assert.deepEqual((await second).document,transfer());
});
test('AbortSignal supports pre-abort, in-flight abort and safe listener removal after success',async()=>{
  const h=harness(),pre=new AbortController();pre.abort();
  await assert.rejects(h.client.validate(json,{signal:pre.signal}),{code:'CANCELLED'});assert.equal(h.workers.length,0);
  const controller=new AbortController(),promise=h.client.validate(json,{signal:controller.signal});controller.abort();
  await assert.rejects(promise,{code:'CANCELLED'});assert.equal(h.workers[0].stopped,1);
  const next=new AbortController(),success=h.client.validate(json,{signal:next.signal});h.workers[1].success();await success;next.abort();
  assert.equal(h.workers[1].stopped,1);
});
test('dispose invalidates active work and refuses subsequent input',async()=>{
  const h=harness(),promise=h.client.validate(json);h.client.dispose();
  await assert.rejects(promise,{code:'CANCELLED'});await assert.rejects(h.client.validate(json),{code:'DISPOSED'});
  assert.equal(h.workers.length,1);
});
test('constructor and postMessage failures never parse invalid JSON on the main thread',async()=>{
  for(const WorkerClass of [undefined,class {constructor(){throw Error('blocked');}},class {postMessage(){throw Error('clone');}terminate(){}}]){
    const client=createGameTransferValidationClient({WorkerClass});
    await assert.rejects(client.validate('not json'),{code:'VALIDATOR_UNAVAILABLE'});client.dispose();
  }
});
test('Worker load/runtime error and message error are reported without fallback',async()=>{
  for(const type of ['onerror','onmessageerror']){
    const h=harness(),promise=h.client.validate('not json');h.workers[0][type]({preventDefault(){}});
    await assert.rejects(promise,{code:type==='onerror'?'VALIDATOR_UNAVAILABLE':'INVALID_WORKER_RESPONSE'});
    assert.equal(h.workers[0].stopped,1);
  }
});
test('validation errors preserve safe code/path/ply and malformed protocol responses fail closed',async()=>{
  const h=harness(),promise=h.client.validate(json);
  h.workers[0].onmessage({data:{kind:'game-transfer-validation',requestId:1,ok:false,error:{code:'ILLEGAL_MOVE',message:'第 2 著不合法。',ply:2,path:'moves[1]'}}});
  await assert.rejects(promise,e=>e.code==='ILLEGAL_MOVE'&&e.ply===2&&e.path==='moves[1]');
  const next=h.client.validate(json);h.workers[1].onmessage({data:{kind:'game-transfer-validation',requestId:2,ok:true,value:{}}});
  await assert.rejects(next,{code:'INVALID_WORKER_RESPONSE'});
});
test('oversize input is rejected before Worker construction and source bytes are not detached',async()=>{
  const h=harness();await assert.rejects(h.client.validate(new Uint8Array(1048577)),{code:'FILE_TOO_LARGE'});
  await assert.rejects(h.client.validate({}),{code:'INVALID_INPUT'});assert.equal(h.workers.length,0);
  const bytes=new TextEncoder().encode(json),promise=h.client.validate(bytes);h.workers[0].success();await promise;
  assert.equal(bytes.byteLength,json.length);
});
test('actual Worker entry validates and serializes domain failures, rejecting unknown requests',()=>{
  const messages=[];
  const source=readFileSync(new URL('./game-transfer/validation-worker.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'');
  const context=vm.createContext({parseGameTransfer,GameTransferError,self:{postMessage:m=>messages.push(structuredClone(m))}});
  vm.runInContext(source,context);
  context.self.onmessage({data:{kind:'normal-game',requestId:1,input:json}});assert.equal(messages.length,0);
  context.self.onmessage({data:{kind:'validate-game-transfer',requestId:1,input:json}});
  assert.equal(messages[0].ok,true);assert.deepEqual(messages[0].value.document,transfer());
  context.self.onmessage({data:{kind:'validate-game-transfer',requestId:2,input:'{"a":1,"a":2}'}});
  assert.equal(messages[1].ok,false);assert.equal(messages[1].error.code,'DUPLICATE_FIELD');assert.equal('stack' in messages[1].error,false);
});

const goodMessage = (requestId=1, input=json) => ({kind:'game-transfer-validation',requestId,ok:true,value:structuredClone(parseGameTransfer(input))});
function cleaned(h, worker) {
  assert.equal(worker.stopped,1);assert.equal(h.timers.size,0);
  for(const key of ['onmessage','onerror','onmessageerror'])assert.equal(worker[key],null);
}
async function badReply(mutate, input=json) {
  const h=harness(),promise=h.client.validate(input),worker=h.workers[0],late=worker.onmessage;
  const message=goodMessage(1,input);mutate(message);
  assert.doesNotThrow(()=>late({data:message}));
  await assert.rejects(promise,{code:'INVALID_WORKER_RESPONSE'});cleaned(h,worker);
  late({data:goodMessage(1,input)});h.client.cancel();cleaned(h,worker);
  const next=h.client.validate(json);h.workers[1].success();await next;cleaned(h,h.workers[1]);
}

for(const field of ['format','schemaVersion','exportedAt','initialPosition','moves','mode','playerSide','status','result'])
  test('missing document.'+field+' rejects and subsequent request recovers',()=>badReply(m=>delete m.value.document[field]));
for(const field of ['board','sideToMove','selectedPly','totalPlies','moveMetadata','positionHashes','repetitionHistory','terminal'])
  test('missing replay.'+field+' rejects and subsequent request recovers',()=>badReply(m=>delete m.value.replay[field]));

test('reviewer minimal partial-document response rejects',()=>badReply(m=>{
  m.value={document:{format:'chinese-chess-training-game-transfer',schemaVersion:1,moves:[]},replay:{totalPlies:0,moveMetadata:[]}};
}));
for(const [label,mutate] of [
  ['root cycle',m=>m.value.loop=m.value],
  ['known-field cycle',m=>m.value.replay.board[0][0]=m.value],
  ['frozen cycle',m=>{m.value.loop=m.value;Object.freeze(m.value);}],
  ['excessive depth',m=>{let x=m.value;for(let n=0;n<18;n++)x=x.loop={};}],
  ['oversize array',m=>m.value.replay.moveMetadata=new Array(1026)],
  ['over-budget graph',m=>m.value.replay.board=Array(1025).fill(Array(1025).fill(0))],
  ['oversize text',m=>m.value.replay.positionHashes[0]='x'.repeat(1048576)],
  ['sparse array',m=>delete m.value.replay.board[0][0]],
  ['extra array field',m=>m.value.replay.board.extra=1],
  ['exotic object',m=>m.value.replay.board=new Map()],
  ['accessor',m=>Object.defineProperty(m.value.document,'mode',{get(){throw Error('must not execute');},enumerable:true})],
])test(label+' is rejected without pending or leaked request',()=>badReply(mutate));

for(const [label,mutate] of [
  ['wrong kind',m=>m.kind='ai-result'],['missing request ID',m=>delete m.requestId],
  ['wrong request ID type',m=>m.requestId='1'],['nonboolean ok',m=>m.ok=1],
  ['invalid zero request ID',m=>m.requestId=0],
  ['unknown envelope field',m=>m.extra=1],['unknown value field',m=>m.value.extra=1],
  ['unknown document field',m=>m.value.document.extra=1],['unknown replay field',m=>m.value.replay.extra=1],
  ['wrong mode type',m=>m.value.document.mode={}],['unknown mode',m=>m.value.document.mode='analysis'],
  ['wrong status',m=>m.value.document.status='done'],['result on incomplete game',m=>m.value.document.result={}],
  ['invalid piece',m=>m.value.replay.board[0][0].type='Q'],['invalid turn',m=>m.value.replay.sideToMove='white'],
  ['wrong selected ply',m=>m.value.replay.selectedPly=1],['wrong final board',m=>m.value.replay.board[0][0]=null],
  ['wrong initial hash',m=>m.value.replay.positionHashes[0]='.'],
  ['wrong repetition turn',m=>m.value.replay.repetitionHistory[0].key+='black'],
  ['wrong repetition mover',m=>m.value.replay.repetitionHistory[0].mover='red'],
  ['wrong repetition check type',m=>m.value.replay.repetitionHistory[0].check=1],
])test(label+' fails protocol validation',()=>badReply(mutate));

const onePlyJSON=JSON.stringify({...transfer(),moves:[{from:{r:3,c:4},to:{r:4,c:4}}]});
for(const [label,mutate] of [
  ['missing captured',m=>delete m.value.replay.moveMetadata[0].captured],
  ['missing notation',m=>delete m.value.replay.moveMetadata[0].notation],
  ['bad notation type',m=>m.value.replay.moveMetadata[0].notation={}],
  ['unknown metadata field',m=>m.value.replay.moveMetadata[0].extra=1],
  ['wrong coordinate',m=>m.value.replay.moveMetadata[0].to.r=8],
  ['out of range coordinate',m=>m.value.replay.moveMetadata[0].to.r=10],
  ['fractional coordinate',m=>m.value.replay.moveMetadata[0].to.r=4.5],
  ['coordinate extra field',m=>m.value.replay.moveMetadata[0].to.extra=0],
  ['wrong ply',m=>m.value.replay.moveMetadata[0].ply=0],
  ['wrong side',m=>m.value.replay.moveMetadata[0].side='black'],
  ['wrong capture',m=>m.value.replay.moveMetadata[0].captured={type:'P',side:'black'}],
  ['wrong final hash',m=>m.value.replay.positionHashes[1]=m.value.replay.positionHashes[0]],
])test(label+' in replay metadata is rejected',()=>badReply(mutate,onePlyJSON));

test('valid but different source cannot be substituted for the active request',async()=>{
  for(const replacement of [JSON.stringify({...transfer(),mode:'easy'}),onePlyJSON,JSON.stringify({...transfer(),playerSide:'black'})]){
    await badReply(m=>m.value=structuredClone(parseGameTransfer(replacement)));
  }
});
test('mutable caller bytes cannot change the captured source after dispatch',async()=>{
  for(const buffer of [new TextEncoder().encode(json),new TextEncoder().encode(json).buffer]){
    const h=harness(),p=h.client.validate(buffer);
    (buffer instanceof Uint8Array?buffer:new Uint8Array(buffer)).fill(0);
    h.workers[0].success();assert.deepEqual((await p).document,transfer());cleaned(h,h.workers[0]);
  }
});
test('an accessor request ID is rejected without executing its getter',async()=>{
  let calls=0;
  await badReply(m=>Object.defineProperty(m,'requestId',{get(){calls++;return 1;},enumerable:true}));
  assert.equal(calls,0);
});
test('pre-frozen response parents do not leave mutable descendants',async()=>{
  const h=harness(),p=h.client.validate(json),m=goodMessage();Object.freeze(m.value);
  h.workers[0].onmessage({data:m});const value=await p;
  assert.ok(Object.isFrozen(value.document.initialPosition.board[0][0]));cleaned(h,h.workers[0]);
});
test('error payload types and unknown details must also fail closed',async()=>{
  for(const error of [{code:1,message:'bad'},{code:'BAD',message:{}},{code:'BAD',message:'bad',stack:'private'},
    {code:'BAD',message:'bad',path:{}},{code:'BAD',message:'bad',ply:-1}]){
    const h=harness(),p=h.client.validate(json);
    h.workers[0].onmessage({data:{kind:'game-transfer-validation',requestId:1,ok:false,error}});
    await assert.rejects(p,{code:'INVALID_WORKER_RESPONSE'});cleaned(h,h.workers[0]);
  }
});
test('cancel and success races settle once in either order',async()=>{
  for(const first of ['cancel','success']){
    const h=harness();let settlements=0;
    const p=h.client.validate(json).then(()=>{settlements++;return 'success';},e=>{settlements++;return e.code;});
    const w=h.workers[0],reply=w.onmessage;
    if(first==='cancel')h.client.cancel();
    reply({data:goodMessage()});h.client.cancel();reply({data:goodMessage()});
    assert.equal(await p,first==='cancel'?'CANCELLED':'success');assert.equal(settlements,1);cleaned(h,w);
  }
});
test('timeout and reply races settle once in either order, including retained timer',async()=>{
  for(const first of ['timeout','success']){
    const h=harness();let settlements=0;
    const p=h.client.validate(json).then(()=>{settlements++;return 'success';},e=>{settlements++;return e.code;});
    const w=h.workers[0],reply=w.onmessage,timer=[...h.timers.values()][0].fn;
    if(first==='timeout'){h.setTime(10000);timer();}
    reply({data:goodMessage()});h.setTime(10000);timer();reply({data:goodMessage()});
    assert.equal(await p,first==='timeout'?'VALIDATION_TIMEOUT':'success');assert.equal(settlements,1);cleaned(h,w);
  }
});
test('synchronous event access and host error exceptions settle explicitly',async()=>{
  const h=harness(),p=h.client.validate(json);
  assert.doesNotThrow(()=>h.workers[0].onmessage({get data(){throw Error('fault');}}));
  await assert.rejects(p,{code:'INVALID_WORKER_RESPONSE'});cleaned(h,h.workers[0]);
  const q=h.client.validate(json);
  assert.doesNotThrow(()=>h.workers[1].onerror({preventDefault(){throw Error('host');}}));
  await assert.rejects(q,{code:'VALIDATOR_UNAVAILABLE'});cleaned(h,h.workers[1]);
});
test('freezing exception rejects before removing control of active request',async()=>{
  const h=harness(),p=h.client.validate(json),message=goodMessage(),realFreeze=Object.freeze;
  Object.freeze=value=>{if(value===message.value)throw Error('freeze fault');return realFreeze(value);};
  try{assert.doesNotThrow(()=>h.workers[0].onmessage({data:message}));}finally{Object.freeze=realFreeze;}
  await assert.rejects(p,{code:'INVALID_WORKER_RESPONSE'});cleaned(h,h.workers[0]);
  const q=h.client.validate(json);h.workers[1].success();await q;
});
test('cleanup exceptions cannot leave a request pending or skip other cleanup',async()=>{
  const h=harness(),p=h.client.validate(json),w=h.workers[0];
  w.terminate=()=>{w.stopped++;throw Error('host termination fault');};w.success();
  await assert.rejects(p,{code:'INVALID_WORKER_RESPONSE'});cleaned(h,w);
  const q=h.client.validate(json);h.workers[1].success();await q;
});
test('deadline also checked after protocol validation and freezing',async()=>{
  let time=0,worker;
  class W{constructor(){worker=this;}postMessage(){}terminate(){}}
  const c=createGameTransferValidationClient({WorkerClass:W,now:()=>time});
  const p=c.validate(json),message=goodMessage(),realFreeze=Object.freeze;
  Object.freeze=value=>{if(value===message.value)time=10000;return realFreeze(value);};
  try{worker.onmessage({data:message});}finally{Object.freeze=realFreeze;}
  await assert.rejects(p,{code:'VALIDATION_TIMEOUT'});c.dispose();
});
test('bounded protocol preserves BOM, 1 MiB, 1024-ply completed and in-progress results',async()=>{
  for(const game of [transfer(),terminal(),terminal('stalemate'),terminal('perpetual-check'),
    terminal('mutual-perpetual-check'),terminal('threefold-repetition'),longGame(1024,'black'),longCompletedGame()]){
    const text='\uFEFF'+JSON.stringify(game),bytes=new TextEncoder().encode(text+' '.repeat(1048576-new TextEncoder().encode(text).byteLength));
    const h=harness(),p=h.client.validate(bytes);h.workers[0].success();
    assert.deepEqual((await p).document,game);cleaned(h,h.workers[0]);
  }
});
