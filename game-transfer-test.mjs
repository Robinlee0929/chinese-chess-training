import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialBoard, applyMove, hashBoard } from './game.js';
import { createGameTimeline, replayGameTimeline } from './game-record.js';
import { createGameRecordStore } from './game-record-store.js';
import { serializePuzzleExport, parsePuzzleImport } from './puzzle-transfer.js';
import { transfer, terminal, longGame, longCompletedGame } from './tools/game-transfer-fixtures.mjs';
import { parseStrictTransferJSON } from './game-transfer/strict-json.js';
import { validateGameTransfer, parseGameTransfer, serializeGameTransfer, serializeGameTransferTXT,
  GAME_TRANSFER_MAX_BYTES, GAME_TRANSFER_MAX_PLIES, GAME_TRANSFER_MAX_DEPTH } from './game-transfer/game-transfer.js';

const rejects = (fn, code) => assert.throws(fn, { code });
const encoded = data => JSON.stringify(data);
const timelineOf = game => ({ id: 'test-only', createdAt: game.exportedAt, initialPosition: game.initialPosition, moves: game.moves, mode: game.mode });

test('V1 constants and exact nine-field contract are stable', () => {
  assert.equal(GAME_TRANSFER_MAX_BYTES, 1048576); assert.equal(GAME_TRANSFER_MAX_PLIES,1024); assert.equal(GAME_TRANSFER_MAX_DEPTH,16);
  assert.deepEqual(Object.keys(parseGameTransfer(encoded(transfer())).document), ['format','schemaVersion','exportedAt','initialPosition','moves','mode','playerSide','status','result']);
});
for (const mode of ['easy','medium','hard','experimental-b','pvp']) {
  for (const side of ['red','black']) test(`${mode}: standard ${side} first, zero and one confirmed ply`, () => {
    const data = transfer({mode, initialPosition:{board:initialBoard(),sideToMove:side}});
    assert.equal(validateGameTransfer(data).replay.sideToMove,side);
    const r=side==='red'?3:6, to=side==='red'?4:5;
    data.moves.push({from:{r,c:4},to:{r:to,c:4}});
    const result = parseGameTransfer(serializeGameTransfer(data));
    assert.equal(result.replay.moveMetadata[0].side,side);
    assert.equal(result.replay.sideToMove,side==='red'?'black':'red');
    assert.equal(result.document.playerSide,null,'unknown player must never be inferred');
  });
  test(`${mode}: completed nonstandard capture round trips`, () => {
    const data=terminal(); data.mode=mode;
    const result=parseGameTransfer(serializeGameTransfer(data));
    assert.deepEqual(result.document,data); assert.deepEqual(result.replay.terminal,data.result);
    assert.deepEqual(result.replay.moveMetadata[0].captured,{type:'P',side:'black'});
  });
}
for (const playerSide of ['red','black',null]) test(`AI playerSide ${playerSide} is preserved, independent of first mover`, () => {
  const data=transfer({playerSide,initialPosition:{board:initialBoard(),sideToMove:'black'}});
  assert.equal(parseGameTransfer(serializeGameTransfer(data)).document.playerSide,playerSide);
});
test('pvp cannot claim fixed player ownership; unsupported side rejected', () => {
  for(const playerSide of ['red','black']) rejects(()=>validateGameTransfer(transfer({mode:'pvp',playerSide})),'PLAYER_SIDE_MODE_MISMATCH');
  rejects(()=>validateGameTransfer(transfer({playerSide:'white'})),'INVALID_PLAYER_SIDE');
});
for (const reason of ['checkmate','stalemate','perpetual-check','threefold-repetition','mutual-perpetual-check']) test(`completed ${reason} agrees with canonical rules`, () => {
  const data=terminal(reason), parsed=parseGameTransfer(serializeGameTransfer(data));
  assert.deepEqual(parsed.replay.terminal,data.result);
});
test('every ply, notation, captures, repetition prefix and turn survive JSON round trip', () => {
  for(const data of [terminal(),terminal('stalemate'),terminal('threefold-repetition'),longGame(32,'black')]) {
    const imported=parseGameTransfer(serializeGameTransfer(data)).document;
    for(let ply=0;ply<=data.moves.length;ply++) assert.deepEqual(replayGameTimeline(timelineOf(imported),ply),replayGameTimeline(timelineOf(data),ply));
  }
});
test('undo exports only surviving legal history and canonical copies are detached', () => {
  const data=longGame(12); data.moves.splice(8);
  const before=structuredClone(data), {document,replay}=validateGameTransfer(data);
  assert.equal(document.moves.length,8); assert.equal(replay.totalPlies,8);
  data.moves[0].to.r=99; data.initialPosition.board[0][4].type='R';
  assert.deepEqual(document,before); assert.ok(Object.isFrozen(document.moves[0].from));
});
test('zero-ply completed position passes only genuine terminal and all initial-position checks', () => {
  const data=terminal(); applyMove(data.initialPosition.board,data.moves[0].from,data.moves[0].to);
  data.initialPosition.sideToMove='black'; data.moves=[];
  assert.equal(validateGameTransfer(data).replay.terminal.terminationReason,'checkmate');
  rejects(()=>validateGameTransfer({...data,status:'in-progress',result:null}),'TERMINAL_INCOMPLETE_GAME');
  const invalid=structuredClone(data); invalid.initialPosition.board[0][4]=null; invalid.initialPosition.board[0][0]={type:'K',side:'red'};
  rejects(()=>validateGameTransfer(invalid),'KING_OUTSIDE_PALACE');
  const wrongCount=structuredClone(data); for(const c of [0,1,2]) wrongCount.initialPosition.board[8][c]={type:'P',side:'black'};
  wrongCount.initialPosition.board[7][0]={type:'P',side:'black'};
  rejects(()=>validateGameTransfer(wrongCount),'PIECE_LIMIT');
});
test('incomplete never becomes Completed GameRecord and cannot hide a terminal', () => {
  const data=transfer(); const {document}=validateGameTransfer(data);
  assert.equal(document.result,null); assert.equal('completedAt' in document,false); assert.equal('id' in document,false);
  rejects(()=>validateGameTransfer({...data,status:'completed',result:{winner:'red',terminationReason:'checkmate'}}),'NONTERMINAL_COMPLETED_GAME');
  rejects(()=>validateGameTransfer({...terminal(),status:'in-progress',result:null}),'TERMINAL_INCOMPLETE_GAME');
  rejects(()=>validateGameTransfer({...data,result:{winner:'red',terminationReason:'checkmate'}}),'UNEXPECTED_RESULT');
});
test('wrong terminal winner/reason and extra post-terminal move are rejected', () => {
  const data=terminal();
  rejects(()=>validateGameTransfer({...data,result:{...data.result,winner:'black'}}),'RESULT_MISMATCH');
  rejects(()=>validateGameTransfer({...data,result:{...data.result,terminationReason:'stalemate'}}),'RESULT_MISMATCH');
  rejects(()=>validateGameTransfer({...data,result:{...data.result,terminationReason:'resignation'}}),'UNSUPPORTED_TERMINATION_REASON');
  data.moves.push({from:{r:9,c:4},to:{r:8,c:4}});
  assert.throws(()=>validateGameTransfer(data),e=>e.code==='MOVE_AFTER_TERMINAL'&&e.ply===2);
});
test('malformed board, kings, side, palace, facing and checked nonmoving side fail', () => {
  const cases=[
    [d=>d.initialPosition.board.pop(),'INVALID_BOARD_ROWS'],
    [d=>d.initialPosition.board[0].pop(),'INVALID_BOARD_COLUMNS'],
    [d=>d.initialPosition.board[0][4]=null,'MISSING_RED_KING'],
    [d=>d.initialPosition.board[1][4]={type:'K',side:'red'},'DUPLICATE_RED_KING'],
    [d=>d.initialPosition.board[0][0].type='Q','INVALID_PIECE_TYPE'],
    [d=>d.initialPosition.sideToMove='white','INVALID_SIDE_TO_MOVE'],
    [d=>{d.initialPosition.board[0][4]=null;d.initialPosition.board[4][0]={type:'K',side:'red'};},'KING_OUTSIDE_PALACE'],
    [d=>{for(let r=1;r<9;r++)d.initialPosition.board[r][4]=null;},'KINGS_FACING'],
  ];
  for(const [mutate,code] of cases){const d=transfer();mutate(d);rejects(()=>validateGameTransfer(d),code);}
  const data=terminal('perpetual-check'); data.initialPosition.sideToMove='red'; data.moves=[];data.status='in-progress';data.result=null;
  rejects(()=>validateGameTransfer(data),'NON_MOVING_SIDE_IN_CHECK');
});
test('illegal steps preserve domain path and ply', () => {
  for(const [move,code] of [
    [{from:{r:4,c:4},to:{r:5,c:4}},'EMPTY_SOURCE'],
    [{from:{r:6,c:4},to:{r:5,c:4}},'WRONG_SIDE'],
    [{from:{r:3,c:4},to:{r:5,c:4}},'ILLEGAL_MOVE'],
    [{from:{r:3,c:4},to:{r:10,c:4}},'COORDINATE_OUT_OF_BOUNDS'],
    [{from:{r:3,c:4},to:{r:4.5,c:4}},'INVALID_COORDINATE'],
  ]) assert.throws(()=>validateGameTransfer(transfer({moves:[move]})),e=>e.code===code&&e.ply===1&&typeof e.path==='string');
});
test('unknown fields at every boundary, missing fields and accessors are rejected', () => {
  for(const mutate of [d=>d.extra=1,d=>delete d.playerSide,d=>d.initialPosition.extra=1,
    d=>d.initialPosition.board[0][4].html='<script/>',d=>d.moves[0].notation='偽造',
    d=>d.moves[0].from.extra=1,d=>d.result.score=100]) {
    const data=terminal();mutate(data);rejects(()=>validateGameTransfer(data),'UNEXPECTED_FIELDS');
  }
  const data=transfer();let called=false;Object.defineProperty(data,'mode',{get(){called=true;return 'hard';},enumerable:true});
  rejects(()=>validateGameTransfer(data),'UNEXPECTED_FIELDS');assert.equal(called,false);
});
test('unsupported envelope variants and invalid exportedAt are rejected', () => {
  for(const [key,value,code] of [['format','chinese-chess-training-puzzles','UNSUPPORTED_FORMAT'],['schemaVersion',2,'UNSUPPORTED_SCHEMA_VERSION'],
    ['mode','analysis','UNSUPPORTED_MODE'],['status','aborted','INVALID_STATUS'],['exportedAt','2026-02-30T00:00:00.000Z','INVALID_EXPORTED_AT']])
    rejects(()=>validateGameTransfer(transfer({[key]:value})),code);
});
test('TXT is derived from replay, includes board, actual black-first order, coordinates and known/unknown player', () => {
  const data=terminal('threefold-repetition');data.playerSide='black';
  const text=serializeGameTransferTXT(data);
  assert.ok(text.startsWith('\uFEFF'));assert.ok(text.endsWith('\n'));
  for(const part of ['玩家棋色：黑方','先行方：黑方','初始棋盤','第 1 著 黑方','(9,4) → (9,5)','結果：和棋；三次重複局面']) assert.ok(text.includes(part),part);
  assert.match(serializeGameTransferTXT(transfer()),/未記錄，不推測/);
  assert.match(serializeGameTransferTXT(transfer({mode:'pvp'})),/雙人對弈，無固定玩家棋色/);
  assert.match(serializeGameTransferTXT(terminal()),/俥六平五.*吃黑方卒/);
  rejects(()=>parseGameTransfer(text),'INVALID_JSON');
});
test('UTF-8 BOM accepted once; malformed UTF-8 and second BOM rejected', () => {
  const text=encoded(transfer());assert.deepEqual(parseGameTransfer(new TextEncoder().encode('\uFEFF'+text)).document,transfer());
  for(const bytes of [[0xc3,0x28],[0xef,0xbb],[0xed,0xa0,0x80]]) rejects(()=>parseGameTransfer(new Uint8Array(bytes)),'INVALID_UTF8');
  rejects(()=>parseGameTransfer('\uFEFF\uFEFF'+text),'INVALID_JSON');
  const bytes=new TextEncoder().encode('x'+text+'x');assert.deepEqual(parseGameTransfer(bytes.subarray(1,bytes.length-1)).document,transfer());
});
test('structured duplicate detection handles escaped keys, nested objects and innocent strings', () => {
  for(const text of ['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{"n":{"r":1,"r":2}}','{"a":1,"\\u0061":1}']) rejects(()=>parseStrictTransferJSON(text),'DUPLICATE_FIELD');
  const text='{"text":"\\\"a\\\":1,\\\"a\\\":2 { } [ ]", "escaped":"\\\\\\\"", "arr":[{"a":1},{"a":2}]}';
  assert.deepEqual(parseStrictTransferJSON(text),JSON.parse(text));
  const proto=parseStrictTransferJSON('{"__proto__":{"polluted":true}}');
  assert.equal(Object.getPrototypeOf(proto),Object.prototype);assert.equal({}.polluted,undefined);
  rejects(()=>parseGameTransfer(encoded({...transfer(),__proto__:null,constructor:{}})),'UNEXPECTED_FIELDS');
});
test('strict JSON syntax rejects malformed literals, escapes, numbers and trailing content', () => {
  for(const text of ['', '{', '[1,]', '{"a":1,}', '{"a" 1}', '{"a":01}', 'true false', 'NaN', 'Infinity', '1e9999','1.','--1','+1','"\\x41"','"\\uGGGG"','"raw\nline"','/*x*/{}']) rejects(()=>parseStrictTransferJSON(text),'INVALID_JSON');
  for(const value of [null,true,false,0,-1,1.25,1e30,'引號 " 和斜線 \\',[],{},[{},['漢字']],{a:1,b:[false,null]}]) assert.deepEqual(parseStrictTransferJSON(JSON.stringify(value)),value);
});
test('depth 16 accepted and 17 rejected including inside ignored/unknown fields', () => {
  assert.ok(parseStrictTransferJSON('['.repeat(16)+'0'+']'.repeat(16)));
  rejects(()=>parseStrictTransferJSON('['.repeat(17)+'0'+']'.repeat(17)),'MAX_DEPTH_EXCEEDED');
  rejects(()=>parseGameTransfer('{"ignored":'+'['.repeat(16)+'0'+']'.repeat(16)+'}'),'MAX_DEPTH_EXCEEDED');
});
test('exact 1 MiB raw UTF-8 accepted, one byte over rejected, no silent trimming', () => {
  const text=encoded(transfer()), padded=text+' '.repeat(GAME_TRANSFER_MAX_BYTES-new TextEncoder().encode(text).byteLength);
  assert.equal(parseGameTransfer(new TextEncoder().encode(padded)).document.moves.length,0);
  rejects(()=>parseGameTransfer(padded+' '),'FILE_TOO_LARGE');
  rejects(()=>parseGameTransfer(new Uint8Array(GAME_TRANSFER_MAX_BYTES+1)),'FILE_TOO_LARGE');
  rejects(()=>parseGameTransfer('漢'.repeat(Math.ceil(GAME_TRANSFER_MAX_BYTES/3))),'FILE_TOO_LARGE');
});
test('1024 real legal plies accepted; 1025 rejected before replay without truncation', () => {
  const data=longGame(1024), result=parseGameTransfer(serializeGameTransfer(data));
  assert.equal(result.replay.totalPlies,1024);assert.deepEqual(result.document.moves,data.moves);
  data.moves.push(data.moves[0]);rejects(()=>validateGameTransfer(data),'TOO_MANY_PLIES');assert.equal(data.moves.length,1025);
});
test('completed 1024-ply game reaches its first terminal exactly at the last ply', () => {
  const data=longCompletedGame(), result=parseGameTransfer(serializeGameTransfer(data));
  assert.equal(result.replay.totalPlies,1024);assert.deepEqual(result.replay.terminal,data.result);
  assert.equal(replayGameTimeline(timelineOf(data),1023).terminal,null);
});
test('GameRecord storage stays unchanged and puzzle JSON remains a separate contract', () => {
  const data=terminal();const values=new Map();let writes=0;
  const store=createGameRecordStore({storage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>{writes++;values.set(k,v);}}});
  const record={...timelineOf(data),schemaVersion:1,completedAt:data.exportedAt,result:data.result};
  store.saveGameRecord(record);const before=JSON.stringify([...values]), count=writes;
  data.mode='experimental-b';parseGameTransfer(serializeGameTransfer(data));serializeGameTransferTXT(data);
  assert.equal(writes,count);assert.equal(JSON.stringify([...values]),before);
  rejects(()=>store.saveGameRecord({...record,mode:'experimental-b'}),'INVALID_GAME_RECORD');assert.equal(writes,count);
  const puzzles=serializePuzzleExport([],{now:()=>data.exportedAt});assert.deepEqual(parsePuzzleImport(puzzles),[]);
  rejects(()=>parseGameTransfer(puzzles),'UNEXPECTED_FIELDS');rejects(()=>parsePuzzleImport(serializeGameTransfer(data)),'INVALID_ROOT');
  for(const file of ['contract.js','strict-json.js','game-transfer.js','worker-client.js','validation-worker.js']) {
    const source=readFileSync(new URL('./game-transfer/'+file,import.meta.url),'utf8');
    assert.doesNotMatch(source,/\b(?:localStorage|sessionStorage|indexedDB|eval|Function)\s*[.(]/);
    assert.doesNotMatch(source,/game-record-store|puzzle-store|ai-worker|ai-experimental/);
  }
});
