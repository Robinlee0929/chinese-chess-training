import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { initialBoard, legalMoves, hashBoard } from './game.js';
import { createGameRecord, createSessionGameRecord, createGameTimeline, replaySessionGameRecord } from './game-record.js';
import { createGameReview, firstGameReviewPly, createGameRecordLibraryView } from './game-review.js';
import { createGameRecordStore } from './game-record-store.js';
import { createCustomPositionStore, validateCustomPositionEnvelope } from './custom-position-store.js';
import { createCustomPositionIDB } from './custom-position-idb.js';
import { capacityFixture } from './tools/idb-capacity-fixture.mjs';
import { createAsyncSavedPositionSession } from './saved-position-async-session.js';
import { repositoryDouble, testPosition } from './tools/saved-position-session-double.mjs';
import { validateContinuationConfiguration, validateRuntimeContinuationConfiguration } from './game-review-continuation.js';

const root = new URL('.', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8').replace(/\r\n/g, '\n');
const canonicalAsset = text => text.replace(/\r\n/g, '\n').replace(/\?v=[0-9a-f]+/g, '?v=786025ac37');
const sha = text => createHash('sha256').update(text).digest('hex');
test('frozen B has exactly its approved hash; original AI and rules retain baseline content', () => {
  assert.equal(sha(canonicalAsset(read('ai-experimental-b.js'))), 'aaad56881956a3ba25c0a4ab75bbc9123ce5e54efac8beab65805b2656ce7495');
  for (const file of ['ai.js', 'game.js']) {
    const old = execFileSync('git', ['show', `33f24e85e2aa8873145210c7da97bbc704ad2765:${file}`], { cwd: root, encoding: 'utf8' });
    assert.equal(canonicalAsset(read(file)), canonicalAsset(old));
  }
  assert.equal(read('ai-experimental-b.js')
    .replace('1e7 + VAL[v.type]', 'VAL[v.type]')
    .replace('(histH[side][b[m.fr][m.fc].type + (m.tr * 9 + m.tc)] || 0) * 32\n      + pst(b[m.fr][m.fc],m.tr,m.tc)-pst(b[m.fr][m.fc],m.fr,m.fc)',
      'histH[side][b[m.fr][m.fc].type + (m.tr * 9 + m.tc)] || 0')
    .replace('\nexport function metrics(){return {nodes,ttEntries:TT.size};}\n', ''), read('ai.js'));
});

function record(mode = 'experimental-b') {
  const board = Array.from({ length: 10 }, () => Array(9).fill(null));
  for (const [r,c,type,side] of [[9,4,'K','black'],[0,4,'K','red'],[2,3,'R','red'],[2,4,'P','black'],[9,0,'R','red'],[9,8,'R','red']]) board[r][c] = {type,side};
  return {schemaVersion:1,id:'test-'+mode,createdAt:'2026-11-09T00:00:00.000Z',completedAt:'2026-11-09T00:01:00.000Z',initialPosition:{board,sideToMove:'red'},moves:[{from:{r:2,c:3},to:{r:2,c:4}}],mode,result:{winner:'red',terminationReason:'checkmate'}};
}
test('B has an immutable validated terminal replay without passing persistent validation', () => {
  const r = createSessionGameRecord(record());
  assert.equal(r.mode,'experimental-b'); assert.ok(Object.isFrozen(r.initialPosition.board[0]));
  assert.equal(createGameReview(r).snapshot.terminal.winner,'red');
  assert.equal(firstGameReviewPly(createGameReview(r)).snapshot.terminal,null);
  assert.throws(() => createGameRecord(r), {code:'UNSUPPORTED_MODE'});
  assert.throws(() => createGameRecordLibraryView({records:[r],issues:[]}), {code:'UNSUPPORTED_MODE'});
  assert.throws(() => createSessionGameRecord({...record(),result:{winner:'black',terminationReason:'checkmate'}}), {code:'RESULT_WINNER_MISMATCH'});
});
test('all persistent stores and IDB preparation reject B without writing', () => {
  const values = new Map(); let writes = 0;
  const storage = {getItem:k=>values.get(k)??null,setItem:(k,v)=>{writes++;values.set(k,v);}};
  const games = createGameRecordStore({storage}); games.saveGameRecord(record('hard'));
  const before = JSON.stringify([...values]); const priorWrites = writes;
  assert.throws(() => games.saveGameRecord(record()), /mode/i);
  assert.equal(JSON.stringify([...values]),before); assert.equal(writes,priorWrites);
  const positions = createCustomPositionStore({storage, idFactory:()=> 'saved'});
  const p = testPosition(); const input = {title:p.title,initialBoard:p.initialBoard,sideToMove:p.sideToMove,playPreferences:{humanSide:'red',difficulty:'experimental-b'}};
  assert.throws(() => positions.savePosition(input,{expectedRevision:0}), {code:'INVALID_PREFERENCES'});
  positions.savePosition({...input,playPreferences:p.playPreferences},{expectedRevision:0});
  const savedBefore = JSON.stringify([...values]);
  assert.throws(() => positions.updatePlayPreferences('saved',input.playPreferences,{expectedRevision:1}), {code:'INVALID_PREFERENCES'});
  assert.equal(JSON.stringify([...values]),savedBefore);
  const fixture = capacityFixture(1), adapter=createCustomPositionIDB();
  for (const command of [{type:'save',position:input},{type:'preferences',id:'seed-0',preferences:input.playPreferences}]) {
    assert.throws(() => adapter.prepare(fixture,command), {code:'INVALID_PREFERENCES'});
  }
  const polluted=structuredClone(fixture.envelope); polluted.positions[0].playPreferences=input.playPreferences;
  assert.throws(() => validateCustomPositionEnvelope(polluted), {code:'INVALID_PREFERENCES'});
  assert.throws(() => validateContinuationConfiguration(input.playPreferences), /difficulty/);
  assert.equal(validateRuntimeContinuationConfiguration(input.playPreferences).difficulty,'experimental-b');
});

function sessionHarness(availability = () => true) {
  const db=repositoryDouble(), context={session:{},appState:'NORMAL_GAME',editor:null,confirmed:null,hasProgress:false}, starts=[];
  const session=createAsyncSavedPositionSession({repository:db.repository,host:{experimentalOpponentAvailable:availability,context:()=>context,canOpen:()=>true,pause(){},resume(){},start:root=>starts.push(root),loadEditor(){}}});
  return {...db,session,starts,async open(){session.open(); await session.whenReady();}};
}
for(const kind of ['save','preferences','challenge']) test(`B ${kind} cannot enter a persistence operation`,async()=>{
  const h=sessionHarness(); await h.open();
  if(kind==='save'){h.session.close();h.session.openSave(testPosition());await h.session.whenReady();}
  else h.session.select(kind,'saved');
  h.session.edit({difficulty:'experimental-b',title:'B'}); const before=JSON.stringify(h.snapshot);
  assert.equal(await h.session.submit(),false); assert.match(h.session.state().form.error,/僅本次/);
  assert.equal(JSON.stringify(h.snapshot),before);
  assert.equal(h.calls.some(c=>['savePosition','updatePlayPreferences'].includes(c.type)),false);
});
test('existing saved position can challenge B once, without changing preference or revision',async()=>{
  const h=sessionHarness();await h.open();const before=JSON.stringify(h.snapshot);
  h.session.select('challenge','saved');h.session.edit({difficulty:'experimental-b',humanSide:'black'});
  assert.equal(await h.session.submit({once:true}),true);assert.equal(h.starts[0].settings.difficulty,'experimental-b');
  assert.equal(h.starts[0].settings.humanSide,'black');assert.equal(JSON.stringify(h.snapshot),before);
  assert.equal(h.calls.some(c=>c.type==='updatePlayPreferences'),false);
});
for (const availability of [null, () => false]) test(`B once-only challenge rejects ${availability ? 'unready' : 'legacy'} host before repository access`, async () => {
  const h = sessionHarness(availability); await h.open();
  h.session.select('challenge', 'saved'); h.session.edit({difficulty:'experimental-b'});
  const before = JSON.stringify(h.snapshot), calls = h.calls.length;
  assert.equal(await h.session.submit({once:true}), false);
  assert.match(h.session.state().form.error, /尚未準備/);
  assert.equal(h.starts.length, 0); assert.equal(h.calls.length, calls);
  assert.equal(JSON.stringify(h.snapshot), before);
});
test('B once-only challenge rechecks host availability after asynchronous reads', async () => {
  let checks = 0;
  const h = sessionHarness(() => ++checks === 1); await h.open();
  h.session.select('challenge', 'saved'); h.session.edit({difficulty:'experimental-b'});
  const before = JSON.stringify(h.snapshot);
  assert.equal(await h.session.submit({once:true}), false);
  assert.equal(checks, 2); assert.equal(h.starts.length, 0);
  assert.equal(JSON.stringify(h.snapshot), before);
  assert.equal(h.calls.some(c => c.type === 'updatePlayPreferences'), false);
});
test('all four HTML B options fail closed, including the legacy saved-position option unlock', () => {
  const html = read('index.html');
  for (const id of ['modeSel', 'customPlayDifficulty', 'gameReviewContinuationDifficulty', 'savedPositionDifficulty']) {
    const select = html.match(new RegExp(`<select[^>]*id="${id}"[^]*?</select>`))[0];
    assert.match(select, /<option value="experimental-b" disabled>/);
    for (const mode of ['easy', 'medium', 'hard']) {
      const option = select.match(new RegExp(`<option value="${mode}"[^>]*>`))[0];
      assert.doesNotMatch(option, /disabled/);
    }
  }
  assert.match(html, /<optgroup id="savedPositionExperimentalGroup"[^>]* disabled>/);
});

const source=read('main.js');
const functionSource=name=>source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))[0].replaceAll('import.meta.url',JSON.stringify(new URL('main.js',root).href));
function aiHarness(failure) {
  const workers=[],timers=new Map(),moves=[];let n=0;
  const ctx=vm.createContext({experimentalOpponentAvailable:()=>true,board:initialBoard(),turn:'black',mode:'experimental-b',posHistory:[],aiToken:0,aiRequest:null,aiWorker:null,aiModule:null,experimentalAIFailure:null,normalGameRecordSession:{id:'session'},customRematchRequest:null,over:false,busy:false,aiThinking:false,aiMoveStart:0,normalGameActive:()=>true,isAI:()=>true,aiSide:()=> 'black',legalMoves,performance:{now:()=>100},URL,refreshHUD(){},toast(){},setTimeout:f=>{timers.set(++n,f);return n;},clearTimeout:id=>timers.delete(id),doMove:(from,to)=>moves.push({from,to}),Worker:class{constructor(){if(failure==='constructor')throw Error('unavailable');workers.push(this);}postMessage(p){this.payload=p;if(failure==='post')throw Error('post');}terminate(){this.terminated=true;}}});
  for(const name of ['invalidateNormalAI','currentAIRequest','failExperimentalAI','startAIFallback','requestAIMove','maybeAIMove','onAIResult'])vm.runInContext(functionSource(name),ctx);
  const result={from:{r:6,c:0},to:{r:5,c:0}};
  return {ctx,workers,timers,moves,result,flush(){const callbacks=[...timers.values()];timers.clear();callbacks.forEach(f=>f());}};
}
for(const failure of ['constructor','post','error','timeout','search-error','old-worker','illegal']) test(`B ${failure}: retain board, stop worker, never start synchronous fallback`,()=>{
  const h=aiHarness(failure),before=JSON.stringify(h.ctx.board);h.ctx.maybeAIMove();
  const w=h.workers[0];
  if(failure==='error')w.onerror({preventDefault(){}});
  if(failure==='timeout')h.flush();
  if(failure==='search-error')w.onmessage({data:{token:h.ctx.aiToken,error:'search-failed'}});
  if(failure==='old-worker')w.onmessage({data:{kind:'worker-error',token:h.ctx.aiToken,error:'unsupported-request'}});
  if(failure==='illegal'){w.onmessage({data:{token:h.ctx.aiToken,result:{from:{r:0,c:0},to:{r:9,c:8}}}});h.flush();}
  assert.equal(h.ctx.aiModule,null);assert.equal(h.ctx.aiThinking,false);assert.equal(h.moves.length,0);
  assert.equal(JSON.stringify(h.ctx.board),before);assert.equal(h.ctx.experimentalAIFailure,h.ctx.normalGameRecordSession);
  const count=h.workers.length;h.ctx.maybeAIMove();assert.equal(h.workers.length,count,'failure must not retry itself');
  assert.ok(h.workers.every(w=>w.terminated));
});
test('unready B runtime cannot search or replace a configured game even if UI is bypassed', () => {
  const h = aiHarness(); h.ctx.experimentalOpponentAvailable = () => false;
  h.ctx.maybeAIMove(); assert.equal(h.workers.length, 0); assert.equal(h.ctx.aiThinking, false);
  h.ctx.allowExperimentalOpponent = () => false;
  for (const name of ['startConfiguredNormalGame', 'startCustomPositionPlay']) vm.runInContext(functionSource(name), h.ctx);
  const before = JSON.stringify(h.ctx.board);
  assert.equal(h.ctx.startConfiguredNormalGame({}, {difficulty:'experimental-b'}), false);
  assert.equal(h.ctx.startCustomPositionPlay({difficulty:'experimental-b'}), false);
  assert.equal(JSON.stringify(h.ctx.board), before); assert.equal(h.ctx.mode, 'experimental-b');
});
test('single B request, duplicate replies and cancellation cannot create competing or stale moves',()=>{
  const h=aiHarness();h.ctx.maybeAIMove();h.ctx.maybeAIMove();assert.equal(h.workers.length,1);
  const w=h.workers[0],reply=w.onmessage,token=h.ctx.aiToken;
  reply({data:{token,result:h.result}});reply({data:{token,result:h.result}});h.flush();assert.equal(h.moves.length,1);
  h.ctx.invalidateNormalAI();h.ctx.normalGameRecordSession={id:'replacement'};h.ctx.maybeAIMove();
  reply({data:{token,result:h.result}});assert.equal(h.moves.length,1);
  h.ctx.invalidateNormalAI();h.flush();assert.equal(h.moves.length,1);
});
function recordHarness(sessionMode, runtimeMode = sessionMode) {
  const r = record(sessionMode), values = new Map(), notices = [];
  const store = createGameRecordStore({storage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)}});
  store.saveGameRecord(record('hard'));
  const final = replaySessionGameRecord(r, r.moves.length);
  const ctx = vm.createContext({mode:runtimeMode,normalGameModeRevision:1,normalGameRecordError:null,
    gameExportRevision:0,gameExportUI:null,
    normalGameRecordSession:{...r,modeRevision:1},board:structuredClone(final.board),turn:final.sideToMove,
    over:true,completedGameRecordSessionId:null,lastCompletedGameRecord:null,gameRecordNow:()=>r.completedAt,
    history:r.moves,winner:'red',hashBoard,toast:message=>notices.push(message),
    createGameRecord:input=>createSessionGameRecord(JSON.parse(JSON.stringify(input))),replaySessionGameRecord,
    gameRecordStore:store});
  for (const name of ['invalidateGameExport','normalGameRecordTerminationReason','normalGameRecordMatches','failNormalGameRecord','finalizeNormalGameRecord']) vm.runInContext(functionSource(name),ctx);
  return {ctx,notices,values,bytes:()=>JSON.stringify([...values])};
}

for (const mode of ['easy','medium','hard','pvp','experimental-b']) test(`valid ${mode} finalization preserves its record identity and storage policy`,()=>{
  const h=recordHarness(mode),before=h.bytes();
  h.ctx.normalGameRecordSession.id='new-'+mode;
  assert.equal(h.ctx.finalizeNormalGameRecord('將死').mode,mode);
  const once=h.bytes();h.ctx.finalizeNormalGameRecord('將死');assert.equal(h.bytes(),once);
  assert.equal(h.ctx.normalGameRecordError,null);
  if(mode==='experimental-b')assert.equal(h.bytes(),before);else assert.notEqual(h.bytes(),before);
});

for (const [sessionMode,runtimeMode] of [['hard','experimental-b'],['experimental-b','hard'],['easy','medium']]) test(`mismatched ${sessionMode}/${runtimeMode} record fails closed and stays latched`,()=>{
  const h=recordHarness(sessionMode,runtimeMode),before=h.bytes();
  assert.equal(h.ctx.finalizeNormalGameRecord('將死'),null);
  assert.equal(h.ctx.normalGameRecordError.code,'GAME_RECORD_SESSION_MISMATCH');assert.equal(h.bytes(),before);
  assert.equal(h.ctx.lastCompletedGameRecord,null);assert.equal(h.notices.length,1);
  h.ctx.mode=sessionMode;assert.equal(h.ctx.finalizeNormalGameRecord('將死'),null);assert.equal(h.bytes(),before);
});

for (const fault of ['revision','board','session-replaced-during-validation']) test(`record boundary rejects ${fault}`,()=>{
  const h=recordHarness('hard'),before=h.bytes();
  if(fault==='revision')h.ctx.normalGameModeRevision++;
  if(fault==='board')h.ctx.board[0][4]=null;
  if(fault==='session-replaced-during-validation'){
    const create=h.ctx.createGameRecord;h.ctx.createGameRecord=input=>{const r=create(input);h.ctx.normalGameRecordSession={...h.ctx.normalGameRecordSession};return r;};
  }
  assert.equal(h.ctx.finalizeNormalGameRecord('將死'),null);assert.equal(h.bytes(),before);assert.ok(h.ctx.normalGameRecordError);
});

test('mode change rejects modal/non-game/unknown/unready input before any state mutation',()=>{
  let active=true,modal=false,available=true,starts=0;
  const ctx=vm.createContext({mode:'hard',modeSel:{value:'hard'},normalGameRecordSession:{mode:'hard'},
    normalGameActive:()=>active,document:{querySelector:()=>modal?{}:null},allowExperimentalOpponent:()=>available,
    newGame(){starts++;ctx.normalGameRecordSession={mode:ctx.mode};}});
  vm.runInContext(functionSource('changeNormalGameMode'),ctx);
  for(const fault of ['modal','non-game','unknown','unready']){
    modal=fault==='modal';active=fault!=='non-game';available=fault!=='unready';
    const session=ctx.normalGameRecordSession;ctx.modeSel.value=fault==='unknown'?'invalid':'experimental-b';
    assert.equal(ctx.changeNormalGameMode(ctx.modeSel.value),false);assert.equal(ctx.modeSel.value,'hard');
    assert.equal(ctx.mode,'hard');assert.equal(ctx.normalGameRecordSession,session);assert.equal(starts,0);
  }
  active=true;modal=false;available=true;
  for(const mode of ['experimental-b','easy','medium','hard','pvp']){
    assert.equal(ctx.changeNormalGameMode(mode),true);assert.equal(ctx.mode,ctx.normalGameRecordSession.mode);assert.equal(ctx.modeSel.value,mode);
  }
  assert.equal(starts,5);
});
