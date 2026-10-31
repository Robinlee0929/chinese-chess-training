import assert from 'node:assert/strict';
import test from 'node:test';
import { initialBoard, RED, BLACK, applyMove, inCheck, hasAnyLegalMove } from './game.js';
import { createEmptyEditorBoard, createEditorState, confirmAuthoredPosition } from './puzzle-editor.js';
import { validateCustomPlayPosition } from './custom-position-play.js';

const standard = () => ({ initialBoard: initialBoard(), sideToMove: BLACK });
test('T01/T12: canonical detached board and exact side; no shared rows, pieces or metadata', () => {
  const source = standard();
  source.initialBoard[0][0].metadata = { nested: true };
  const result = validateCustomPlayPosition(source);
  assert.equal(result.ok, true);
  assert.deepEqual(result.position, { board: initialBoard(), sideToMove: BLACK });
  result.position.board[0][0].type = 'P';
  result.position.board[0][1] = null;
  assert.equal(source.initialBoard[0][0].type, 'R');
  assert.equal(source.initialBoard[0][1].type, 'N');
});

for (const [label, change, code] of [
  ['rows', p => p.initialBoard.pop(), 'INVALID_BOARD_ROWS'],
  ['columns', p => p.initialBoard[0].pop(), 'INVALID_BOARD_COLUMNS'],
  ['sparse cell', p => delete p.initialBoard[0][0], 'INVALID_PIECE'],
  ['piece type', p => p.initialBoard[0][0].type = 'X', 'INVALID_PIECE_TYPE'],
  ['piece side', p => p.initialBoard[0][0].side = 'white', 'INVALID_PIECE_SIDE'],
  ['turn', p => p.sideToMove = 'white', 'INVALID_SIDE_TO_MOVE'],
  ['missing turn', p => delete p.sideToMove, 'INVALID_SIDE_TO_MOVE'],
  ['missing red king', p => p.initialBoard[0][4] = null, 'KING_COUNT'],
  ['missing black king', p => p.initialBoard[9][4] = null, 'KING_COUNT'],
  ['duplicate king', p => p.initialBoard[1][4] = { type: 'K', side: RED }, 'KING_COUNT'],
  ['facing kings', p => { p.initialBoard[3][4] = null; p.initialBoard[6][4] = null; }, 'KINGS_FACING'],
  ['red palace', p => { p.initialBoard[4][4] = p.initialBoard[0][4]; p.initialBoard[0][4] = null; }, 'KING_OUTSIDE_PALACE'],
  ['black palace', p => { p.initialBoard[6][3] = p.initialBoard[9][4]; p.initialBoard[9][4] = null; }, 'KING_OUTSIDE_PALACE'],
]) {
  test(`T07: reject ${label} without mutation, with Traditional Chinese explanation`, () => {
    const source = standard(); change(source); const before = structuredClone(source);
    const result = validateCustomPlayPosition(source);
    assert.equal(result.ok, false); assert.equal(result.error.code, code);
    assert.match(result.error.message, /[\u4e00-\u9fff]/);
    assert.deepEqual(source, before);
  });
}
for (const side of [RED, BLACK]) for (const type of ['A', 'B', 'N', 'R', 'C', 'P']) {
  test(`T07: reject excess ${side} ${type}`, () => {
    const source = standard(); source.initialBoard[4][0] = { type, side };
    assert.equal(validateCustomPlayPosition(source).error.code, 'PIECE_LIMIT');
  });
}

function terminalFixture(checkmate) {
  const board = createEmptyEditorBoard();
  board[0][3] = { type: 'K', side: RED };
  board[9][4] = { type: 'K', side: BLACK };
  board[8][0] = { type: 'R', side: RED };
  board[7][5] = { type: 'R', side: RED };
  // Red king covers file 3 by the engine's facing-kings rule.
  if (checkmate) {
    applyMove(board, { r: 7, c: 5 }, { r: 9, c: 0 });
    applyMove(board, { r: 8, c: 0 }, { r: 8, c: 8 });
  }
  return { initialBoard: board, sideToMove: BLACK };
}
for (const mate of [false, true]) test(`T08: reject ${mate ? 'checkmate' : 'stalemate'}`, () => {
  const p = terminalFixture(mate);
  assert.equal(inCheck(p.initialBoard, BLACK), mate);
  assert.equal(hasAnyLegalMove(p.initialBoard, BLACK), false);
  assert.equal(validateCustomPlayPosition(p).error.code, 'TERMINAL_POSITION');
  assert.equal(confirmAuthoredPosition(createEditorState({ board: p.initialBoard, sideToMove: BLACK })).ok, true,
    'puzzle confirmation is deliberately unchanged');
});
test('side in check may start if it can evade; nonmoving side in check is rejected', () => {
  const p = terminalFixture(true); p.initialBoard[8][8] = null;
  assert.equal(hasAnyLegalMove(p.initialBoard, BLACK), true);
  assert.equal(validateCustomPlayPosition(p).ok, true);
  p.sideToMove = RED;
  assert.equal(validateCustomPlayPosition(p).error.code, 'NON_MOVING_SIDE_IN_CHECK');
});
test('missing input and board fail closed', () => {
  for (const p of [null, undefined, {}, { sideToMove: RED }]) assert.equal(validateCustomPlayPosition(p).ok, false);
});
