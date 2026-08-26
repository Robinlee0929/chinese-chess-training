import assert from 'node:assert/strict';
import { RED, BLACK } from './game.js';
import {
  PuzzleEditorError,
  createEmptyEditorBoard,
  createEditorState,
  placeEditorPiece,
  moveEditorPiece,
  removeEditorPiece,
  setEditorSideToMove,
  validateAuthoredPosition,
  exportAuthoredPosition,
  confirmAuthoredPosition,
} from './puzzle-editor.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓', name);
  } catch (error) {
    failed++;
    console.error('  ✗', name);
    console.error(error);
  }
}

function assertEditorError(fn, code) {
  assert.throws(fn, (error) => error instanceof PuzzleEditorError && error.code === code);
}

function validPositionState() {
  let state = createEditorState();
  state = placeEditorPiece(state, { type: 'K', side: RED }, { r: 0, c: 4 });
  state = placeEditorPiece(state, { type: 'K', side: BLACK }, { r: 9, c: 4 });
  state = placeEditorPiece(state, { type: 'P', side: RED }, { r: 5, c: 4 });
  return state;
}

test('empty board creation', () => {
  const board = createEmptyEditorBoard();
  assert.equal(board.length, 10);
  assert.ok(board.every((row) => row.length === 9 && row.every((cell) => cell === null)));
});

test('place red piece', () => {
  const state = placeEditorPiece(
    createEditorState(),
    { type: 'R', side: RED },
    { r: 4, c: 2 },
  );
  assert.deepEqual(state.board[4][2], { type: 'R', side: RED });
});

test('place black piece', () => {
  const state = placeEditorPiece(
    createEditorState(),
    { type: 'C', side: BLACK },
    { r: 6, c: 7 },
  );
  assert.deepEqual(state.board[6][7], { type: 'C', side: BLACK });
});

test('reject occupied-square placement', () => {
  const state = placeEditorPiece(
    createEditorState(),
    { type: 'R', side: RED },
    { r: 4, c: 2 },
  );
  assertEditorError(
    () => placeEditorPiece(state, { type: 'N', side: BLACK }, { r: 4, c: 2 }),
    'OCCUPIED_SQUARE',
  );
});

test('move piece between coordinates', () => {
  let state = placeEditorPiece(
    createEditorState(),
    { type: 'R', side: RED },
    { r: 4, c: 2 },
  );
  state = moveEditorPiece(state, { r: 4, c: 2 }, { r: 4, c: 8 });
  assert.equal(state.board[4][2], null);
  assert.deepEqual(state.board[4][8], { type: 'R', side: RED });
});

test('editor movement does not require a legal Xiangqi move', () => {
  let state = placeEditorPiece(
    createEditorState(),
    { type: 'K', side: RED },
    { r: 0, c: 4 },
  );
  state = moveEditorPiece(state, { r: 0, c: 4 }, { r: 6, c: 8 });
  assert.deepEqual(state.board[6][8], { type: 'K', side: RED });
});

test('reject move to occupied destination', () => {
  let state = createEditorState();
  state = placeEditorPiece(state, { type: 'R', side: RED }, { r: 4, c: 2 });
  state = placeEditorPiece(state, { type: 'N', side: BLACK }, { r: 4, c: 8 });
  assertEditorError(
    () => moveEditorPiece(state, { r: 4, c: 2 }, { r: 4, c: 8 }),
    'OCCUPIED_DESTINATION',
  );
});

test('remove piece', () => {
  let state = placeEditorPiece(
    createEditorState(),
    { type: 'P', side: BLACK },
    { r: 6, c: 4 },
  );
  state = removeEditorPiece(state, { r: 6, c: 4 });
  assert.equal(state.board[6][4], null);
});

test('coordinate bounds validation', () => {
  assertEditorError(
    () => placeEditorPiece(createEditorState(), { type: 'P', side: RED }, { r: 10, c: 0 }),
    'COORDINATE_OUT_OF_BOUNDS',
  );
  assertEditorError(
    () => removeEditorPiece(createEditorState(), { r: 0, c: -1 }),
    'COORDINATE_OUT_OF_BOUNDS',
  );
});

test('invalid piece type rejected', () => {
  assertEditorError(
    () => placeEditorPiece(createEditorState(), { type: 'Q', side: RED }, { r: 0, c: 0 }),
    'INVALID_PIECE_TYPE',
  );
});

test('invalid piece side rejected', () => {
  assertEditorError(
    () => placeEditorPiece(createEditorState(), { type: 'R', side: 'blue' }, { r: 0, c: 0 }),
    'INVALID_PIECE_SIDE',
  );
});

test('sideToMove red', () => {
  const state = setEditorSideToMove(createEditorState({ sideToMove: BLACK }), RED);
  assert.equal(state.sideToMove, RED);
});

test('sideToMove black', () => {
  const state = setEditorSideToMove(createEditorState(), BLACK);
  assert.equal(state.sideToMove, BLACK);
});

test('exported board is deeply isolated', () => {
  const state = validPositionState();
  const first = exportAuthoredPosition(state);
  first.initialBoard[0][4].type = 'R';
  first.initialBoard[5][4] = null;
  const second = exportAuthoredPosition(state);
  assert.deepEqual(second.initialBoard[0][4], { type: 'K', side: RED });
  assert.deepEqual(second.initialBoard[5][4], { type: 'P', side: RED });
});

test('exactly one red king and black king accepted', () => {
  const state = validPositionState();
  assert.deepEqual(validateAuthoredPosition(state), { ok: true });
  const result = confirmAuthoredPosition(state);
  assert.equal(result.ok, true);
  assert.equal(result.position.sideToMove, RED);
});

test('missing king rejected', () => {
  let state = createEditorState();
  state = placeEditorPiece(state, { type: 'K', side: RED }, { r: 0, c: 4 });
  const result = validateAuthoredPosition(state);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MISSING_BLACK_KING');
});

test('duplicate king rejected', () => {
  let state = validPositionState();
  state = placeEditorPiece(state, { type: 'K', side: RED }, { r: 0, c: 3 });
  const result = validateAuthoredPosition(state);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DUPLICATE_RED_KING');
});

test('editor actions do not mutate their source board', () => {
  const source = createEmptyEditorBoard();
  source[0][4] = { type: 'K', side: RED };
  const before = structuredClone(source);
  let state = createEditorState({ board: source });
  state = placeEditorPiece(state, { type: 'R', side: BLACK }, { r: 8, c: 8 });
  state = moveEditorPiece(state, { r: 0, c: 4 }, { r: 2, c: 2 });
  removeEditorPiece(state, { r: 8, c: 8 });
  assert.deepEqual(source, before);
});

console.log(`\n${passed} puzzle-editor tests passed; ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
