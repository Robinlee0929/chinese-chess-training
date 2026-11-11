import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transfer, terminal, longGame } from './tools/game-transfer-fixtures.mjs';
import { validateGameTransfer, parseGameTransfer, serializeGameTransferTXT } from './game-transfer/game-transfer.js';
import { captureExportSource, exportSourceIsCurrent } from './game-transfer/export-source.js';
import { createGameExportController, createGameExportDownload, gameExportErrorMessage } from './game-transfer/export-controller.js';

function source(data = transfer({playerSide:'red'})) {
  const {document, replay} = validateGameTransfer(data);
  const session = {id:'private-session',mode:data.mode,modeRevision:1,humanSide:data.playerSide,initialPosition:structuredClone(data.initialPosition)};
  const completedRecord = data.status === 'completed' ? {id:session.id,mode:data.mode,initialPosition:data.initialPosition,moves:data.moves,result:data.result} : null;
  return {kind:'live',available:true,session,mode:data.mode,modeRevision:1,revision:1,humanSide:data.playerSide,
    history:replay.moveMetadata.map(({from,to,captured,notation})=>({from,to,captured,nota:notation})),
    board:structuredClone(replay.board),turn:replay.sideToMove,over:data.status==='completed',winner:data.result?.winner,
    positionHashes:[...replay.positionHashes],repetitionHistory:structuredClone(replay.repetitionHistory),
    completedRecord,completedSessionId:completedRecord?.id};
}
function harness(data, deferred=false) {
  let live=source(data), resolve, reject;
  const downloads=[], requests=[];
  const client={validate(text){requests.push(text);return deferred?new Promise((yes,no)=>{resolve=yes;reject=no;}):Promise.resolve(parseGameTransfer(text));},cancel(){},dispose(){}};
  const c=createGameExportController({readSource:()=>live,client,download:payload=>{downloads.push(payload);return true;},now:()=>transfer().exportedAt});
  return {c,downloads,requests,get live(){return live;},set live(v){live=v;},reply(){resolve(parseGameTransfer(requests.at(-1)));},fail(code){reject(Object.assign(Error('明確錯誤'),{code}));}};
}
for(const mode of ['easy','medium','hard','experimental-b','pvp']) test(`${mode}: zero-ply live download round trip and no private metadata`,async()=>{
  const h=harness(transfer({mode,playerSide:mode==='pvp'?null:'black'}));
  const d=h.c.open('live');assert.equal(d.playerSide,mode==='pvp'?null:'black');
  assert.equal((await h.c.export('json')).status,'downloaded');
  const parsed=parseGameTransfer(h.downloads[0].text);assert.deepEqual(parsed.document,d);
  assert.equal(h.downloads[0].mime,'application/json;charset=utf-8');assert.match(h.downloads[0].filename,/^chinese-chess-game-[\dTZ]+\.json$/);
  assert.doesNotMatch(h.downloads[0].text,/private-session|sessionId|modeRevision|photo|localStorage/);
});
for(const reason of ['checkmate','stalemate','perpetual-check','threefold-repetition','mutual-perpetual-check']) test(`completed ${reason}: canonical result, captures, TXT and JSON`,async()=>{
  const data={...terminal(reason),playerSide:'red'},h=harness(data);
  h.c.open('live');await h.c.export('json');await h.c.export('txt');
  assert.deepEqual(parseGameTransfer(h.downloads[0].text).document,data);
  assert.equal(h.downloads[1].text,serializeGameTransferTXT(data));assert.equal(h.downloads[1].mime,'text/plain;charset=utf-8');
});
test('1024-ply black-first nonstandard timeline is not truncated',async()=>{
  const data={...longGame(1024,'black'),playerSide:'red'},h=harness(data);h.c.open('live');await h.c.export('json');await h.c.export('txt');
  assert.equal(parseGameTransfer(h.downloads[0].text).document.moves.length,1024);
  assert.match(h.downloads[1].text,/第 1 著 黑方/);assert.match(h.downloads[1].text,/第 1024 著 紅方/);
});
test('undo exports only the surviving confirmed history',async()=>{
  const data={...longGame(6),playerSide:'red'};data.moves.length=2;const h=harness(data);h.c.open('live');await h.c.export('json');
  assert.equal(parseGameTransfer(h.downloads[0].text).document.moves.length,2);
});
for(const [name,mutate] of [
  ['animation',s=>s.busy=true],['AI thinking',s=>s.aiThinking=true],['fail-closed',s=>s.recordError={code:'FAIL'}],
  ['inactive',s=>s.available=false],['invalidating',s=>s.invalidating=true],['mode',s=>s.mode='easy'],
  ['mode revision',s=>s.modeRevision++],['player ownership',s=>s.humanSide='black'],['unconfirmed history',s=>s.repetitionHistory=[]],
]) test(`capture refuses ${name}`,()=>{const s=source();mutate(s);assert.throws(()=>captureExportSource(s,transfer().exportedAt));});
test('stable AI Worker failure is not a record failure',async()=>{
  const h=harness(transfer({mode:'experimental-b',playerSide:'red'}));h.live.experimentalAIFailure=true;
  h.c.open('live');assert.equal((await h.c.export('json')).status,'downloaded');
});
test('completed memory record stays exportable when persistent save failed',async()=>{
  const h=harness({...terminal(),mode:'experimental-b',playerSide:'red'});h.live.storageError=true;
  h.c.open('live');assert.equal((await h.c.export('json')).status,'downloaded');
  h.live.recordError={code:'INVALID_RECORD'};assert.throws(()=>h.c.open('live'));
});
test('historical export includes the whole record, not the selected ply; player side stays null',async()=>{
  const h=harness({...terminal('threefold-repetition'),playerSide:'red'}), record=h.live.completedRecord;
  h.live={kind:'review',available:true,sourceKind:'completed',record,stored:true,verifiedPlayerSide:'red',revision:2,selectedPly:2};
  const d=h.c.open('review');h.live.selectedPly=4;assert.equal(h.c.check(),true);await h.c.export('json');
  assert.equal(d.playerSide,null);assert.equal(d.moves.length,8);assert.equal(parseGameTransfer(h.downloads[0].text).document.moves.length,8);
  h.live.sourceKind='live-teaching';assert.throws(()=>h.c.open('review'));
});
for(const [name,mutate] of [
  ['new session reference',s=>s.session={...s.session}],['revision even same board',s=>s.revision++],
  ['mode revision',s=>s.modeRevision++],['same move count different contents',s=>s.board[0][4]=null],
  ['history notation',s=>s.history[0].nota='不同'],['history coordinates',s=>s.history[0]={...s.history[0],to:{r:4,c:8}}],
  ['leaving source',s=>s.available=false],['AI started',s=>s.aiThinking=true],['failure lock',s=>s.recordError={}],
]) test(`pending ${name} never downloads`,async()=>{
  const h=harness({...longGame(1),playerSide:'red'},true);h.c.open('live');const p=h.c.export('json');mutate(h.live);h.reply();
  assert.equal((await p).status,'cancelled');assert.equal(h.downloads.length,0);
});
test('live board/history mismatch is rejected after Worker canonical replay',async()=>{
  const h=harness();h.live.board[3][0]=null;h.c.open('live');await assert.rejects(h.c.export('json'),{code:'EXPORT_POSITION_MISMATCH'});assert.equal(h.downloads.length,0);
});
test('snapshot is immutable and replacing source with same move count cannot reactivate it',()=>{
  const s=source(),snap=captureExportSource(s,transfer().exportedAt);assert.ok(Object.isFrozen(snap.document.initialPosition.board[0]));
  assert.equal(exportSourceIsCurrent(snap,{...s,session:{...s.session}}),false);
});
test('double-click, cancellation, late result and following request have one owner',async()=>{
  const h=harness(undefined,true);h.c.open('live');const old=h.c.export('json');assert.equal((await h.c.export('txt')).status,'ignored');
  h.c.cancel();h.reply();assert.equal((await old).status,'cancelled');assert.equal(h.downloads.length,0);
  h.c.open('live');const p=h.c.export('json');h.reply();assert.equal((await p).status,'downloaded');assert.equal(h.downloads.length,1);
  h.c.cancel();assert.equal(h.downloads.length,1);
});
test('rapid repeated success clicks download each format once per chooser, reopening is explicit new intent',async()=>{
  const h=harness();h.c.open('live');await h.c.export('json');assert.equal((await h.c.export('json')).status,'ignored');
  await h.c.export('txt');assert.equal((await h.c.export('txt')).status,'ignored');assert.equal(h.downloads.length,2);
  h.c.open('live');await h.c.export('json');assert.equal(h.downloads.length,3);
});
for(const code of ['VALIDATION_TIMEOUT','VALIDATOR_UNAVAILABLE','INVALID_WORKER_RESPONSE']) test(`${code} fails without download and can retry`,async()=>{
  const h=harness(undefined,true);h.c.open('live');const p=h.c.export('json');h.fail(code);await assert.rejects(p,{code});assert.equal(h.downloads.length,0);
  const retry=h.c.export('txt');h.reply();assert.equal((await retry).status,'downloaded');
});
test('dispose during validation prevents download and future work',async()=>{
  const h=harness(undefined,true);h.c.open('live');const p=h.c.export('json');h.c.dispose();h.reply();assert.equal((await p).status,'cancelled');assert.throws(()=>h.c.open('live'),{code:'DISPOSED'});
});
test('download owns MIME, name, object URL, cancellation and cleanup',()=>{
  const events=[],timers=new Map();let current=true,clicks=0;
  const d=createGameExportDownload({document:{createElement:()=>({click(){clicks++;},remove(){events.push('remove');}}),body:{append(link){events.push([link.href,link.download]);}}},
    URL:{createObjectURL(blob){events.push(blob.type);return 'blob:owned';},revokeObjectURL(url){events.push(url);}},
    setTimer(fn){timers.set(1,fn);return 1;},clearTimer(id){timers.delete(id);}});
  const payload={text:'{}',filename:'x.json',mime:'application/json;charset=utf-8',isCurrent:()=>current};
  assert.equal(d.download(payload),true);assert.equal(clicks,1);assert.equal(timers.size,1);assert.deepEqual(events[1],['blob:owned','x.json']);
  current=false;assert.equal(d.download(payload),false);assert.equal(clicks,1);d.dispose();assert.equal(timers.size,0);assert.equal(events.at(-1),'blob:owned');
});
test('download rechecks validity after DOM setup and revokes cancelled object URL',()=>{
  let current=true,revoked=0,clicks=0;
  const d=createGameExportDownload({document:{createElement:()=>({click(){clicks++;},remove(){}}),body:{append(){current=false;}}},
    URL:{createObjectURL:()=> 'blob:x',revokeObjectURL(){revoked++;}}});
  assert.equal(d.download({text:'x',filename:'x.txt',mime:'text/plain',isCurrent:()=>current}),false);assert.equal(clicks,0);assert.equal(revoked,1);
});
test('UI path has no synchronous full replay or persistence; mixed-version controls start disabled',()=>{
  for(const file of ['export-source','export-controller','export-format','export-ui']) {
    const text=readFileSync(new URL(`./game-transfer/${file}.js`,import.meta.url),'utf8');
    assert.doesNotMatch(text,/\b(?:replayGameTimeline|replaySessionGameRecord|validateGameTransfer|parseGameTransfer|localStorage|indexedDB)\s*[.(]/);
  }
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  for(const id of ['btnGameExport','btnGameExportEnd','btnGameReviewExport']) assert.match(html,new RegExp(`id="${id}"[^>]+data-game-export="1"[^>]+hidden disabled`));
});
test('rule-engine English failures and unexpected host errors always have Chinese UI text',()=>{
  const d=transfer();d.moves=[{from:{r:3,c:4},to:{r:5,c:4}}];
  let failure;try{validateGameTransfer(d);}catch(error){failure=error;}
  assert.equal(failure.code,'ILLEGAL_MOVE');assert.match(gameExportErrorMessage(failure),/第 1 著無法通過驗證/);
  assert.doesNotMatch(gameExportErrorMessage(failure),/Move|legal/i);
  assert.match(gameExportErrorMessage(new Error('internal diagnostic')),/棋譜驗證失敗/);
});
