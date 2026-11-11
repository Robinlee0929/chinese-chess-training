import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseGameTransfer, validateGameTransfer } from './game-transfer/game-transfer.js';
import { createImportedGameReview, selectImportedGameReviewPly, canContinueImportedGame, createImportedContinuationPosition } from './game-transfer/imported-review.js';
import { createGameImportController, readGameImportFile, gameImportErrorMessage } from './game-transfer/import-controller.js';
import { createGameTransferValidationClient } from './game-transfer/worker-client.js';
import { replayGameTimeline } from './game-record.js';
import { GameTransferError } from './game-transfer/contract.js';
import { transfer, terminal, longGame } from './tools/game-transfer-fixtures.mjs';

const bytes = doc => new TextEncoder().encode(JSON.stringify(doc)).buffer;
const file = (doc = transfer(), extra = {}) => ({ name: 'synthetic.json', type: 'application/json', size: bytes(doc).byteLength, bytes: bytes(doc), ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes;reject=no; });return {promise,resolve,reject}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(overrides = {}) {
  let state = { active: true, revision: 1 }, accepted = [], reads = 0, validations = 0;
  const client = { cancel() {}, dispose() {}, async validate(data) { validations++; return parseGameTransfer(data); } };
  const controller = createGameImportController({ context: () => state, accept: review => { accepted.push(review); return true; },
    readFile: async f => { reads++; return f.bytes; }, client, ...overrides });
  return { controller, accepted, state: next => state = next, counts: () => ({ reads, validations }) };
}
for (const mode of ['easy','medium','hard','experimental-b','pvp']) for (const first of ['red','black']) test(`imported ${mode}/${first} timeline retains canonical snapshots without a completed record`, () => {
  const document = { ...longGame(10, first, first === 'red'), mode, playerSide: mode === 'pvp' ? null : 'black' };
  const canonical = validateGameTransfer(document); let review = createImportedGameReview(canonical);
  assert.equal(review.sourceKind,'imported'); assert.equal(review.document.status,'in-progress'); assert.equal(review.record,undefined); assert.equal(review.teachingTarget,undefined);
  const source = review.source, old = review;
  for (let ply=0;ply<=document.moves.length;ply++) {
    review=selectImportedGameReviewPly(review,ply);
    const expected=replayGameTimeline({id:'oracle',createdAt:document.exportedAt,initialPosition:document.initialPosition,moves:document.moves,mode},ply);
    assert.deepEqual(review.snapshot,expected);assert.equal(review.source,source);assert.ok(review.revision>old.revision);assert.equal(canContinueImportedGame(review),true);
    const next=createImportedContinuationPosition(review);assert.deepEqual(next,{board:expected.board,sideToMove:expected.sideToMove});
    next.board[0][0]=null;assert.deepEqual(review.snapshot,expected);
  }
  assert.equal(old.selectedPly,0);assert.throws(()=>{old.document.moves.push({});});assert.equal(canContinueImportedGame({...review}),false);
});
for (const reason of ['checkmate','stalemate','perpetual-check','threefold-repetition','mutual-perpetual-check']) test(`completed imported ${reason} gates only the terminal position`, () => {
  const review=createImportedGameReview(validateGameTransfer(terminal(reason))),last=selectImportedGameReviewPly(review,'last');
  assert.equal(canContinueImportedGame(review),true);assert.equal(canContinueImportedGame(last),false);assert.throws(()=>createImportedContinuationPosition(last));
  assert.equal(last.snapshot.terminal.terminationReason,reason);assert.deepEqual(last.document.result,last.snapshot.terminal);
  assert.equal(selectImportedGameReviewPly(last,'previous').selectedPly,last.totalPlies-1);
});
test('zero-ply completed initial position remains terminal; zero-ply incomplete remains playable',()=>{
  const value=validateGameTransfer(terminal());const zero=transfer({initialPosition:{board:value.replay.board,sideToMove:value.replay.sideToMove},moves:[],status:'completed',result:value.document.result});
  const review=createImportedGameReview(validateGameTransfer(zero));assert.equal(review.totalPlies,0);assert.equal(canContinueImportedGame(review),false);
  assert.equal(canContinueImportedGame(createImportedGameReview(validateGameTransfer(transfer()))),true);
});
test('1,024 canonical plies navigate by bounded data folding without importing rule replay',()=>{
  const doc=longGame(1024,'black');const value=validateGameTransfer(doc);const review=selectImportedGameReviewPly(createImportedGameReview(value),'last');
  assert.deepEqual(review.snapshot,value.replay);assert.equal(review.totalPlies,1024);
  assert.doesNotMatch(readFileSync(new URL('./game-transfer/imported-review.js',import.meta.url),'utf8'),/from ['"].*(game-record|game\.js)|replayGameTimeline\(/);
});
test('preview and confirm are separate; repeated confirm consumes the source once',async()=>{
  const h=harness();assert.equal(h.controller.open(),true);const r=await h.controller.select(file(terminal()));assert.equal(r.status,'ready');assert.equal(h.accepted.length,0);
  assert.equal(h.controller.confirm(),true);assert.equal(h.controller.confirm(),false);assert.equal(h.accepted.length,1);assert.equal(h.accepted[0],r.review);
});
test('duplicate selection of the same File cannot start a second validation',async()=>{
  const pending=deferred(),h=harness({readFile:()=>pending.promise}),f=file();h.controller.open();const p=h.controller.select(f);
  assert.equal((await h.controller.select(f)).status,'ignored');pending.resolve(f.bytes);await p;assert.equal((await h.controller.select(f)).status,'ignored');assert.equal(h.counts().validations,1);
});
for (const action of ['cancel','leave','revision','dispose']) test(`late file read after ${action} never validates or accepts`,async()=>{
  const pending=deferred(),h=harness({readFile:()=>pending.promise});h.controller.open();const f=file(),p=h.controller.select(f);
  if(action==='cancel')h.controller.cancel();else if(action==='dispose')h.controller.dispose();else h.state({active:action!=='leave',revision:action==='revision'?2:1});
  pending.resolve(f.bytes);assert.equal((await p).status,'cancelled');assert.equal(h.controller.confirm(),false);assert.equal(h.counts().validations,0);
});
test('A read/Worker finishing after B cannot replace B preview',async()=>{
  const first=deferred(),second=deferred();let calls=0;
  const h=harness({client:{cancel(){},dispose(){},validate(){return ++calls===1?first.promise:second.promise;}}});h.controller.open();
  const a=h.controller.select(file());await tick();const b=h.controller.select(file(terminal()));await tick();
  second.resolve(validateGameTransfer(terminal()));assert.equal((await b).status,'ready');first.resolve(validateGameTransfer(transfer()));assert.equal((await a).status,'cancelled');
  h.controller.confirm();assert.equal(h.accepted[0].document.status,'completed');
});
for(const action of ['cancel','leave','revision'])test(`verified preview cannot confirm after ${action}`,async()=>{
  const h=harness();h.controller.open();await h.controller.select(file());
  if(action==='cancel')h.controller.cancel();else h.state({active:action!=='leave',revision:2});
  assert.equal(h.controller.confirm(),false);assert.equal(h.accepted.length,0);
});
for(const extra of [{name:'game.txt',type:'text/plain'},{size:1048577},{size:0},{type:'text/html'}])test(`file admission rejects ${JSON.stringify(extra)} before reading`,async()=>{
  const h=harness();h.controller.open();await assert.rejects(h.controller.select(file(transfer(),extra)));assert.deepEqual(h.counts(),{reads:0,validations:0});assert.equal(h.controller.confirm(),false);
});
for(const [label,modify] of [
  ['illegal move',d=>{d.moves=[{from:{r:3,c:0},to:{r:7,c:0}}];}],
  ['false terminal',d=>{d.status='completed';d.result={winner:'red',terminationReason:'checkmate'};}],
  ['version',d=>{d.schemaVersion=2;}],['unknown field',d=>{d.script='alert(1)';}],
])test(`${label} rejects completely and never yields partial preview`,async()=>{
  const d=transfer();modify(d);const h=harness();h.controller.open();await assert.rejects(h.controller.select(file(d)));assert.equal(h.controller.confirm(),false);assert.equal(h.accepted.length,0);
});
test('Chinese error does not expose imported text or an English engine diagnostic',()=>{
  assert.equal(gameImportErrorMessage(new GameTransferError('ILLEGAL_MOVE','illegal',{ply:17})),'第 17 著不合法，尚未載入棋譜。');
  assert.doesNotMatch(gameImportErrorMessage(new Error('<script>hostile</script>')),/script|hostile/);
});
for(const fault of ['incomplete','cyclic','error','messageerror','timeout','cancel'])test(`real Worker client through import controller settles ${fault} and recovers`,async()=>{
  const workers=[],timers=new Map();let clock=0,tid=0;
  class Worker {constructor(){workers.push(this);this.stops=0;}postMessage(m){this.request=m;}terminate(){this.stops++;}}
  const client=createGameTransferValidationClient({WorkerClass:Worker,now:()=>clock,setTimer:(fn,ms)=>{assert.equal(ms,10000);timers.set(++tid,fn);return tid;},clearTimer:id=>timers.delete(id)});
  const h=harness({client});h.controller.open();const p=h.controller.select(file());await tick();const w=workers.at(-1),callback=w.onmessage;
  if(fault==='cancel')h.controller.cancel();else if(fault==='timeout'){clock=10000;[...timers.values()][0]();}
  else if(fault==='error')w.onerror({preventDefault(){}});else if(fault==='messageerror')w.onmessageerror({});
  else{const value=fault==='incomplete'?{document:{},replay:{}}:structuredClone(validateGameTransfer(transfer()));if(fault==='cyclic')value.loop=value;callback({data:{kind:'game-transfer-validation',requestId:w.request.requestId,ok:true,value}});}
  if(fault==='cancel')assert.equal((await p).status,'cancelled');else await assert.rejects(p,e=>e.code===(fault==='timeout'?'VALIDATION_TIMEOUT':fault==='error'?'VALIDATOR_UNAVAILABLE':'INVALID_WORKER_RESPONSE'));
  assert.equal(w.stops,1);assert.equal(w.onmessage,null);assert.equal(w.onerror,null);assert.equal(w.onmessageerror,null);assert.equal(timers.size,0);assert.equal(h.controller.confirm(),false);
  clock=0;h.controller.open();const next=h.controller.select(file());await tick();const fresh=workers.at(-1);
  callback({data:{kind:'game-transfer-validation',requestId:w.request.requestId,ok:true,value:validateGameTransfer(transfer())}});
  fresh.onmessage({data:{kind:'game-transfer-validation',requestId:fresh.request.requestId,ok:true,value:validateGameTransfer(transfer())}});
  assert.equal((await next).status,'ready');assert.equal(h.controller.confirm(),true);assert.equal(h.accepted.length,1);h.controller.dispose();
});
for(const fault of ['success','cancel','timeout','error','throw','result-throw','cleanup-throw'])test(`FileReader ${fault} settles and clears resources`,async()=>{
  let reader,timer,cleared=0;
  class Reader {constructor(){reader=this;this.readyState=0;this.result=new ArrayBuffer(3);}readAsArrayBuffer(){this.readyState=1;if(fault==='throw')throw Error('read');}abort(){this.readyState=2;if(fault==='cleanup-throw')throw Error('abort');}}
  const abort=new AbortController(),p=readGameImportFile({}, {signal:abort.signal,FileReaderClass:Reader,setTimer:(fn,ms)=>{assert.equal(ms,10000);timer=fn;return 1;},clearTimer:()=>cleared++});
  if(fault==='cancel'||fault==='cleanup-throw')abort.abort();else if(fault==='timeout')timer();else if(fault==='error')reader.onerror();
  else if(fault==='result-throw'){Object.defineProperty(reader,'result',{get(){throw Error('result');}});reader.onload();}
  else if(fault==='success'){reader.readyState=2;reader.onload();}
  if(fault==='success')assert.equal((await p).byteLength,3);else await assert.rejects(p);
  assert.equal(cleared,1);assert.equal(reader.onload,null);assert.equal(reader.onerror,null);assert.equal(reader.onabort,null);
});
test('imported runtime guards reject programmatic analysis, coach, puzzle creation and deletion',()=>{
  const source=readFileSync(new URL('./main.js',import.meta.url),'utf8');
  const ctx=vm.createContext({gameReviewSession:{sourceKind:'imported'},btnGameReviewAnalyze:{},btnGameReviewCreatePuzzle:{}});
  for(const name of ['enterGameAnalysis','requestGameReviewAiCandidate','requestGameReviewCoach','changeGameReviewCoachModelProfile','createPuzzleFromGameReview','deleteGameRecordFromLibrary']){
    const match=source.match(new RegExp(`^function ${name}\\([^]*?^}`,'m'));assert.ok(match);vm.runInContext(match[0],ctx);assert.equal(ctx[name](),false,name);
  }
});
